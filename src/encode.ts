import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { FlacEncodeError, PcmInputError } from "./errors.js";
import { PcmFormat } from "./format.js";
import {
  instantiateEncoder,
  type EncoderAbi,
  type StagedWrite,
} from "./internal/encoder-abi.js";
import { FlacEncoder, FLAC_ENCODER_LIMITS } from "./wasm.js";

export interface RandomAccessByteSink<E, R> {
  readonly writeAt: (
    offset: bigint,
    bytes: Uint8Array,
  ) => Effect.Effect<void, E, R>;
  readonly resize: (length: bigint) => Effect.Effect<void, E, R>;
}

export interface FlacEncodeOptions {
  readonly format: PcmFormat;
  readonly expectedFrames?: bigint;
}

export interface FlacStreamInfo {
  readonly minimumBlockFrames: number;
  readonly maximumBlockFrames: number;
  readonly minimumFrameBytes: number;
  readonly maximumFrameBytes: number;
  readonly totalFrames: bigint;
  readonly md5Hex: string;
}

export interface FlacEncodeResult {
  readonly format: PcmFormat;
  readonly frames: bigint;
  readonly bytes: bigint;
  readonly streamInfo: FlacStreamInfo;
}

interface EncoderResource {
  readonly abi: EncoderAbi;
  readonly encoder: number;
  readonly input: number;
  released: boolean;
}

interface CheckedEncodeOptions {
  readonly format: PcmFormat;
  readonly expectedFrames: bigint | undefined;
}

const readUint16 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const readUint24 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 16) |
  ((bytes[offset + 1] ?? 0) << 8) |
  (bytes[offset + 2] ?? 0);

const readUint32LittleEndian = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)) >>>
  0;

const invalidStreamInfo = (detail: string): FlacEncodeError =>
  new FlacEncodeError({
    reason: "invalid-streaminfo",
    phase: "validate",
    detail,
  });

const parseStreamInfo = (
  prefix: Uint8Array,
  prefixPresent: Uint8Array,
  format: PcmFormat,
  frames: bigint,
): Effect.Effect<FlacStreamInfo, FlacEncodeError> => {
  for (let index = 0; index < 42; index++)
    if (prefixPresent[index] !== 1)
      return Effect.fail(
        invalidStreamInfo(
          "final output did not contain a complete 42-byte FLAC STREAMINFO prefix",
        ),
      );
  if (
    prefix[0] !== 0x66 ||
    prefix[1] !== 0x4c ||
    prefix[2] !== 0x61 ||
    prefix[3] !== 0x43 ||
    (prefix[4]! & 0x7f) !== 0 ||
    readUint24(prefix, 5) !== 34
  ) {
    return Effect.fail(
      invalidStreamInfo(
        "final output has an invalid native-FLAC STREAMINFO header",
      ),
    );
  }

  // This pinned profile emits STREAMINFO followed by one terminal, empty-comment
  // VORBIS_COMMENT block. Walk the declared metadata chain and require all bytes
  // to have arrived so a malformed backend cannot return a truncated FLAC as a
  // successful encode.
  if ((prefix[4]! & 0x80) !== 0)
    return Effect.fail(
      invalidStreamInfo(
        "STREAMINFO unexpectedly terminated the metadata chain",
      ),
    );
  for (let index = 42; index < 46; index++)
    if (prefixPresent[index] !== 1)
      return Effect.fail(
        invalidStreamInfo("final output omitted the VORBIS_COMMENT header"),
      );
  if (prefix[42] !== 0x84)
    return Effect.fail(
      invalidStreamInfo(
        "metadata after STREAMINFO is not the terminal VORBIS_COMMENT block",
      ),
    );
  const commentLength = readUint24(prefix, 43);
  const metadataEnd = 46 + commentLength;
  if (commentLength < 8 || metadataEnd > prefix.length)
    return Effect.fail(
      invalidStreamInfo(
        `VORBIS_COMMENT length ${commentLength} exceeds the bounded metadata profile`,
      ),
    );
  for (let index = 46; index < metadataEnd; index++)
    if (prefixPresent[index] !== 1)
      return Effect.fail(
        invalidStreamInfo("final output contained a truncated VORBIS_COMMENT"),
      );
  const vendorLength = readUint32LittleEndian(prefix, 46);
  if (
    vendorLength > commentLength - 8 ||
    50 + vendorLength + 4 !== metadataEnd ||
    readUint32LittleEndian(prefix, 50 + vendorLength) !== 0
  )
    return Effect.fail(
      invalidStreamInfo(
        "VORBIS_COMMENT does not match the pinned zero-user-comment profile",
      ),
    );

  let packed = 0n;
  for (let index = 18; index < 26; index++)
    packed = (packed << 8n) | BigInt(prefix[index]!);
  const streamSampleRate = Number(packed >> 44n);
  const streamChannels = Number((packed >> 41n) & 0x7n) + 1;
  const streamBits = Number((packed >> 36n) & 0x1fn) + 1;
  const totalFrames = packed & FLAC_ENCODER_LIMITS.maxTotalFrames;
  if (
    streamSampleRate !== format.sampleRate ||
    streamChannels !== format.channels ||
    streamBits !== format.bitsPerSample ||
    totalFrames !== frames
  ) {
    return Effect.fail(
      new FlacEncodeError({
        reason: "streaminfo-mismatch",
        phase: "validate",
        detail: `STREAMINFO reported ${streamSampleRate} Hz/${streamChannels} ch/${streamBits} bit/${totalFrames} frames; encoded ${format.sampleRate} Hz/${format.channels} ch/${format.bitsPerSample} bit/${frames} frames`,
      }),
    );
  }

  const minimumBlockFrames = readUint16(prefix, 8);
  const maximumBlockFrames = readUint16(prefix, 10);
  const minimumFrameBytes = readUint24(prefix, 12);
  const maximumFrameBytes = readUint24(prefix, 15);
  if (
    minimumBlockFrames !== FLAC_ENCODER_LIMITS.encoderBlockFrames ||
    maximumBlockFrames !== FLAC_ENCODER_LIMITS.encoderBlockFrames
  )
    return Effect.fail(
      invalidStreamInfo(
        `STREAMINFO block sizes ${minimumBlockFrames}/${maximumBlockFrames} do not match the ${FLAC_ENCODER_LIMITS.encoderBlockFrames}-frame profile`,
      ),
    );
  if (
    frames > 0n &&
    (minimumFrameBytes === 0 ||
      maximumFrameBytes < minimumFrameBytes ||
      maximumFrameBytes > FLAC_ENCODER_LIMITS.maxStagedBytesPerCall)
  )
    return Effect.fail(
      invalidStreamInfo(
        `STREAMINFO frame sizes ${minimumFrameBytes}/${maximumFrameBytes} are incoherent`,
      ),
    );

  return Effect.succeed({
    minimumBlockFrames,
    maximumBlockFrames,
    minimumFrameBytes,
    maximumFrameBytes,
    totalFrames,
    md5Hex: Array.from(prefix.subarray(26, 42), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  });
};

const validateOptions = (
  options: unknown,
): Effect.Effect<CheckedEncodeOptions, PcmInputError> => {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    return Effect.fail(
      new PcmInputError({
        reason: "invalid-format",
        detail: "encoder options must be an object",
      }),
    );
  }
  const values = options as Readonly<Record<string, unknown>>;
  const expectedFrames = values.expectedFrames;
  if (
    expectedFrames !== undefined &&
    (typeof expectedFrames !== "bigint" ||
      expectedFrames < 0n ||
      expectedFrames > FLAC_ENCODER_LIMITS.maxTotalFrames)
  ) {
    return Effect.fail(
      new PcmInputError({
        reason: "invalid-format",
        detail: `expectedFrames must be between 0 and ${FLAC_ENCODER_LIMITS.maxTotalFrames}`,
      }),
    );
  }
  return Schema.decodeUnknownEffect(PcmFormat)(values.format).pipe(
    Effect.map((format) => ({ format, expectedFrames })),
    Effect.mapError(
      (error) =>
        new PcmInputError({
          reason: "invalid-format",
          detail: error.message,
        }),
    ),
  );
};

const validateBlock = (
  block: Int32Array,
  format: PcmFormat,
  blockIndex: number,
  framesSoFar: bigint,
  expectedFrames: bigint | undefined,
): Effect.Effect<number, PcmInputError> => {
  if (!(block instanceof Int32Array)) {
    return Effect.fail(
      new PcmInputError({
        reason: "invalid-format",
        detail: "PCM blocks must be Int32Array values",
        blockIndex,
      }),
    );
  }
  if (block.length === 0) {
    return Effect.fail(
      new PcmInputError({
        reason: "empty-block",
        detail: "PCM blocks must be non-empty",
        blockIndex,
      }),
    );
  }
  if (block.length % format.channels !== 0) {
    return Effect.fail(
      new PcmInputError({
        reason: "misaligned-block",
        detail: `PCM block length ${block.length} is not aligned to ${format.channels} channels`,
        blockIndex,
      }),
    );
  }
  const blockFrames = block.length / format.channels;
  if (blockFrames > FLAC_ENCODER_LIMITS.maxInputBlockFrames) {
    return Effect.fail(
      new PcmInputError({
        reason: "block-too-large",
        detail: `PCM block has ${blockFrames} frames; maximum is ${FLAC_ENCODER_LIMITS.maxInputBlockFrames}`,
        blockIndex,
      }),
    );
  }
  if (framesSoFar + BigInt(blockFrames) > FLAC_ENCODER_LIMITS.maxTotalFrames) {
    return Effect.fail(
      new PcmInputError({
        reason: "too-many-frames",
        detail: `native FLAC STREAMINFO can represent at most ${FLAC_ENCODER_LIMITS.maxTotalFrames} frames`,
        blockIndex,
      }),
    );
  }
  if (
    expectedFrames !== undefined &&
    framesSoFar + BigInt(blockFrames) > expectedFrames
  ) {
    return Effect.fail(
      new PcmInputError({
        reason: "frame-count-mismatch",
        detail: `block ${blockIndex} would exceed expected frame count ${expectedFrames}`,
        blockIndex,
        expectedFrames,
        actualFrames: framesSoFar + BigInt(blockFrames),
      }),
    );
  }
  const minimum = -(2 ** (format.bitsPerSample - 1));
  const maximum = 2 ** (format.bitsPerSample - 1) - 1;
  for (let sampleIndex = 0; sampleIndex < block.length; sampleIndex++) {
    const value = block[sampleIndex]!;
    if (value < minimum || value > maximum) {
      return Effect.fail(
        new PcmInputError({
          reason: "sample-out-of-range",
          detail: `sample ${value} is outside signed PCM${format.bitsPerSample} range ${minimum}…${maximum}`,
          blockIndex,
          sampleIndex,
          value,
        }),
      );
    }
  }
  return Effect.succeed(blockFrames);
};

const nativeFailure = (
  abi: EncoderAbi,
  encoder: number,
  reason: "encoder-init" | "encoder-process" | "encoder-finish",
  phase: "init" | "process" | "finish",
): FlacEncodeError => {
  let nativeState: number | undefined;
  try {
    nativeState = abi.exports.codec_encoder_state(encoder);
  } catch {
    // The primary operation already failed; state is diagnostic only.
  }
  return new FlacEncodeError({
    reason,
    phase,
    detail: `libFLAC ${phase} returned failure`,
    ...(nativeState === undefined ? {} : { nativeState }),
  });
};

const releaseEncoder = (
  resource: EncoderResource,
): Effect.Effect<void, FlacEncodeError> =>
  Effect.try({
    try: () => {
      if (resource.released) return;
      resource.released = true;
      let trapped = false;
      let firstCause: unknown;
      try {
        resource.abi.exports.free(resource.input);
      } catch (cause) {
        trapped = true;
        firstCause = cause;
      }
      try {
        resource.abi.exports.codec_encoder_delete(resource.encoder);
      } catch (cause) {
        if (!trapped) firstCause = cause;
        trapped = true;
      }
      if (trapped) throw firstCause;
    },
    catch: (cause) =>
      new FlacEncodeError({
        reason: "wasm-trap",
        phase: "finish",
        detail: "encoder cleanup trapped after successful finalization",
        cause,
      }),
  });

/**
 * Incrementally encode bounded right-justified interleaved PCM to native FLAC.
 *
 * The Effect is lazy. It awaits every staged random-access write before pulling
 * another PCM block. Synchronous Wasm calls are bounded but cannot be interrupted
 * mid-call; interruption is observed before the next call/pull/write. A failed or
 * interrupted operation may leave partial sink bytes, and the caller owns cleanup.
 */
export const encodeFlac = <EI, RI, EO, RO>(
  source: Stream.Stream<Int32Array, EI, RI>,
  sink: RandomAccessByteSink<EO, RO>,
  options: FlacEncodeOptions,
): Effect.Effect<
  FlacEncodeResult,
  EI | EO | PcmInputError | FlacEncodeError,
  RI | RO | FlacEncoder
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const checkedOptions = yield* validateOptions(options);
      const { format, expectedFrames } = checkedOptions;
      const service = yield* FlacEncoder;
      const abi = yield* instantiateEncoder(service.module);
      const metadataPrefix = new Uint8Array(
        FLAC_ENCODER_LIMITS.maxMetadataPrefixBytes,
      );
      const metadataPrefixPresent = new Uint8Array(
        FLAC_ENCODER_LIMITS.maxMetadataPrefixBytes,
      );
      let highWaterMark = 0n;

      const drainWrites = (
        writes: ReadonlyArray<StagedWrite>,
      ): Effect.Effect<void, EO, RO> =>
        Effect.forEach(
          writes,
          (write) =>
            sink.writeAt(write.offset, write.bytes).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  const end = write.offset + BigInt(write.bytes.length);
                  if (end > highWaterMark) highWaterMark = end;
                  if (
                    write.offset <
                      BigInt(FLAC_ENCODER_LIMITS.maxMetadataPrefixBytes) &&
                    end > 0n
                  ) {
                    const sourceStart =
                      write.offset < 0n ? Number(-write.offset) : 0;
                    const targetStart = Number(
                      write.offset < 0n ? 0n : write.offset,
                    );
                    const count = Math.min(
                      write.bytes.length - sourceStart,
                      FLAC_ENCODER_LIMITS.maxMetadataPrefixBytes - targetStart,
                    );
                    if (count > 0) {
                      metadataPrefix.set(
                        write.bytes.subarray(sourceStart, sourceStart + count),
                        targetStart,
                      );
                      metadataPrefixPresent.fill(
                        1,
                        targetStart,
                        targetStart + count,
                      );
                    }
                  }
                }),
              ),
            ),
          { discard: true },
        );

      const resource = yield* Effect.acquireRelease(
        Effect.try({
          try: (): EncoderResource => {
            abi.beginCall();
            const memoryBytes = abi.exports.memory.buffer.byteLength;
            const encoder = abi.exports.codec_encoder_new(
              format.sampleRate,
              format.channels,
              format.bitsPerSample,
              FLAC_ENCODER_LIMITS.compressionLevel,
              FLAC_ENCODER_LIMITS.encoderBlockFrames,
            );
            if (
              !Number.isSafeInteger(encoder) ||
              encoder <= 0 ||
              encoder % 4 !== 0 ||
              encoder >= memoryBytes
            )
              throw new FlacEncodeError({
                reason: encoder === 0 ? "encoder-create" : "wasm-abi",
                phase: "init",
                detail:
                  encoder === 0
                    ? "libFLAC could not allocate/configure an encoder"
                    : "encoder returned an invalid state pointer",
              });
            const inputBytes =
              FLAC_ENCODER_LIMITS.maxInputBlockFrames *
              format.channels *
              Int32Array.BYTES_PER_ELEMENT;
            const input = abi.exports.malloc(inputBytes);
            if (
              !Number.isSafeInteger(input) ||
              input <= 0 ||
              input % Int32Array.BYTES_PER_ELEMENT !== 0 ||
              input > memoryBytes - inputBytes
            ) {
              try {
                abi.exports.codec_encoder_delete(encoder);
              } catch {
                // The invalid allocation is the primary typed failure.
              }
              throw new FlacEncodeError({
                reason: input === 0 ? "allocation-failed" : "wasm-abi",
                phase: "init",
                detail:
                  input === 0
                    ? "Wasm could not allocate the bounded PCM input buffer"
                    : "encoder returned an invalid PCM input pointer",
              });
            }
            return { abi, encoder, input, released: false };
          },
          catch: (cause) =>
            cause instanceof FlacEncodeError
              ? cause
              : new FlacEncodeError({
                  reason: "wasm-trap",
                  phase: "init",
                  detail: "encoder allocation trapped",
                  cause,
                }),
        }),
        (owned) =>
          Effect.sync(() => {
            if (owned.released) return;
            owned.released = true;
            try {
              owned.abi.exports.free(owned.input);
            } catch {
              // Finalization is best-effort for a caller-supplied malformed ABI.
            }
            try {
              owned.abi.exports.codec_encoder_delete(owned.encoder);
            } catch {
              // Finalization is best-effort for a caller-supplied malformed ABI.
            }
          }),
      );

      resource.abi.beginCall();
      const initStatus = yield* Effect.try({
        try: () => resource.abi.exports.codec_encoder_init(resource.encoder),
        catch: (cause) =>
          new FlacEncodeError({
            reason: "wasm-trap",
            phase: "init",
            detail: "encoder initialization trapped",
            cause,
          }),
      });
      const initBatch = resource.abi.endCall();
      if (initBatch.error !== undefined) return yield* initBatch.error;
      if (initStatus !== 0)
        return yield* nativeFailure(
          resource.abi,
          resource.encoder,
          "encoder-init",
          "init",
        );
      yield* drainWrites(initBatch.writes);

      let frames = 0n;
      let blockIndex = 0;
      yield* Stream.runForEach(source, (block) =>
        Effect.gen(function* () {
          const blockFrames = yield* validateBlock(
            block,
            format,
            blockIndex,
            frames,
            expectedFrames,
          );
          yield* Effect.try({
            try: () =>
              new Int32Array(
                resource.abi.exports.memory.buffer,
                resource.input,
                block.length,
              ).set(block),
            catch: (cause) =>
              new FlacEncodeError({
                reason: "wasm-abi",
                phase: "process",
                detail: `could not copy PCM block ${blockIndex} into encoder memory`,
                cause,
              }),
          });
          resource.abi.beginCall();
          const processStatus = yield* Effect.try({
            try: () =>
              resource.abi.exports.codec_encoder_process_interleaved(
                resource.encoder,
                resource.input,
                blockFrames,
              ),
            catch: (cause) =>
              new FlacEncodeError({
                reason: "wasm-trap",
                phase: "process",
                detail: `encoder process call ${blockIndex} trapped`,
                cause,
              }),
          });
          const batch = resource.abi.endCall();
          if (batch.error !== undefined) return yield* batch.error;
          if (processStatus !== 1) {
            return yield* nativeFailure(
              resource.abi,
              resource.encoder,
              "encoder-process",
              "process",
            );
          }
          yield* drainWrites(batch.writes);
          frames += BigInt(blockFrames);
          blockIndex += 1;
          yield* Effect.yieldNow;
        }),
      );

      if (expectedFrames !== undefined && frames !== expectedFrames) {
        return yield* new PcmInputError({
          reason: "frame-count-mismatch",
          detail: `source produced ${frames} frames; expected ${expectedFrames}`,
          expectedFrames,
          actualFrames: frames,
        });
      }

      resource.abi.beginCall();
      const finishStatus = yield* Effect.try({
        try: () => resource.abi.exports.codec_encoder_finish(resource.encoder),
        catch: (cause) =>
          new FlacEncodeError({
            reason: "wasm-trap",
            phase: "finish",
            detail: "encoder finish trapped",
            cause,
          }),
      });
      const finishBatch = resource.abi.endCall();
      if (finishBatch.error !== undefined) return yield* finishBatch.error;
      if (finishStatus !== 1) {
        return yield* nativeFailure(
          resource.abi,
          resource.encoder,
          "encoder-finish",
          "finish",
        );
      }
      yield* drainWrites(finishBatch.writes);
      const streamInfo = yield* parseStreamInfo(
        metadataPrefix,
        metadataPrefixPresent,
        format,
        frames,
      );
      yield* sink.resize(highWaterMark);
      yield* releaseEncoder(resource);

      return { format, frames, bytes: highWaterMark, streamInfo };
    }),
  );
