import * as Clock from "effect/Clock";
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

// Hand control back to the caller's Effect scheduler at least this often while
// encoding. The fiber runtime also yields after its own operation budget
// (`Scheduler.MaxOpsBeforeYield`). Yielding after every block instead cost one
// scheduler dispatch per 4,096 frames, which browsers clamp to at least 4 ms
// (setTimeout), so a 4-minute stereo track spent seconds idle in a worker.
const ENCODE_TIME_SLICE_NANOS = 100_000_000n;

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

type EncoderPhase = "init" | "process" | "finish";

const NATIVE_FAILURE_REASON = {
  init: "encoder-init",
  process: "encoder-process",
  finish: "encoder-finish",
} as const;

const encoderTrap = (
  phase: EncoderPhase,
  detail: string,
  cause: unknown,
): FlacEncodeError =>
  new FlacEncodeError({ reason: "wasm-trap", phase, detail, cause });

const nativeFailure = (
  resource: EncoderResource,
  phase: EncoderPhase,
): FlacEncodeError => {
  let nativeState: number | undefined;
  try {
    nativeState = resource.abi.exports.codec_encoder_state(resource.encoder);
  } catch {
    // The primary operation already failed; state is diagnostic only.
  }
  return new FlacEncodeError({
    reason: NATIVE_FAILURE_REASON[phase],
    phase,
    detail: `libFLAC ${phase} returned failure`,
    ...(nativeState === undefined ? {} : { nativeState }),
  });
};

/**
 * Make one bounded libFLAC call and collect the output it staged. Fails with the
 * first callback error, then a trap, then a native status other than `success`.
 */
const callEncoder = (
  resource: EncoderResource,
  phase: EncoderPhase,
  success: number,
  trapDetail: string,
  call: (exports: EncoderAbi["exports"], encoder: number) => number,
): Effect.Effect<ReadonlyArray<StagedWrite>, FlacEncodeError> =>
  Effect.try({
    try: () => {
      resource.abi.beginCall();
      const status = call(resource.abi.exports, resource.encoder);
      return { status, batch: resource.abi.endCall() };
    },
    catch: (cause) => encoderTrap(phase, trapDetail, cause),
  }).pipe(
    Effect.flatMap(({ status, batch }) =>
      batch.error !== undefined
        ? Effect.fail(batch.error)
        : status !== success
          ? Effect.fail(nativeFailure(resource, phase))
          : Effect.succeed(batch.writes),
    ),
  );

const createEncoder = (
  abi: EncoderAbi,
  format: PcmFormat,
): Effect.Effect<EncoderResource, FlacEncodeError> =>
  Effect.gen(function* () {
    const inputBytes =
      FLAC_ENCODER_LIMITS.maxInputBlockFrames *
      format.channels *
      Int32Array.BYTES_PER_ELEMENT;
    const { encoder, memoryBytes } = yield* Effect.try({
      try: () => {
        abi.beginCall();
        return {
          memoryBytes: abi.exports.memory.buffer.byteLength,
          encoder: abi.exports.codec_encoder_new(
            format.sampleRate,
            format.channels,
            format.bitsPerSample,
            FLAC_ENCODER_LIMITS.compressionLevel,
            FLAC_ENCODER_LIMITS.encoderBlockFrames,
          ),
        };
      },
      catch: (cause) =>
        encoderTrap("init", "encoder allocation trapped", cause),
    });
    if (
      !Number.isSafeInteger(encoder) ||
      encoder <= 0 ||
      encoder % 4 !== 0 ||
      encoder >= memoryBytes
    ) {
      return yield* new FlacEncodeError({
        reason: encoder === 0 ? "encoder-create" : "wasm-abi",
        phase: "init",
        detail:
          encoder === 0
            ? "libFLAC could not allocate/configure an encoder"
            : "encoder returned an invalid state pointer",
      });
    }
    const input = yield* Effect.try({
      try: () => abi.exports.malloc(inputBytes),
      catch: (cause) =>
        encoderTrap("init", "encoder allocation trapped", cause),
    });
    if (
      !Number.isSafeInteger(input) ||
      input <= 0 ||
      input % Int32Array.BYTES_PER_ELEMENT !== 0 ||
      input > memoryBytes - inputBytes
    ) {
      // The invalid allocation is the primary typed failure.
      yield* Effect.ignore(
        Effect.try({
          try: () => abi.exports.codec_encoder_delete(encoder),
          catch: (cause) => cause,
        }),
      );
      return yield* new FlacEncodeError({
        reason: input === 0 ? "allocation-failed" : "wasm-abi",
        phase: "init",
        detail:
          input === 0
            ? "Wasm could not allocate the bounded PCM input buffer"
            : "encoder returned an invalid PCM input pointer",
      });
    }
    return { abi, encoder, input, released: false };
  });

/**
 * Free the PCM input buffer and delete the encoder once. Both are attempted;
 * the first trap is reported. A successful encode surfaces it, while the scope
 * finalizer ignores it because a primary failure or interruption already exists.
 */
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
      encoderTrap(
        "finish",
        "encoder cleanup trapped after successful finalization",
        cause,
      ),
  });

/**
 * Incrementally encode bounded right-justified interleaved PCM to native FLAC.
 *
 * The Effect is lazy. It awaits every staged random-access write before pulling
 * another PCM block. Synchronous Wasm calls are bounded but cannot be interrupted
 * mid-call. Interruption, timers, and other fibers are serviced whenever the fiber
 * yields: at asynchronous source/sink waits, after the runtime's operation budget
 * (`Scheduler.MaxOpsBeforeYield`), and at least once per 100 ms of encoding. A
 * failed or interrupted operation may leave partial sink bytes, and the caller
 * owns cleanup.
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
        createEncoder(abi, format),
        (owned) => Effect.ignore(releaseEncoder(owned)),
      );

      yield* drainWrites(
        yield* callEncoder(
          resource,
          "init",
          0,
          "encoder initialization trapped",
          (exports, encoder) => exports.codec_encoder_init(encoder),
        ),
      );

      let frames = 0n;
      let blockIndex = 0;
      let sliceStart = yield* Clock.monotonicTimeNanos;
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
          yield* drainWrites(
            yield* callEncoder(
              resource,
              "process",
              1,
              `encoder process call ${blockIndex} trapped`,
              (exports, encoder) =>
                exports.codec_encoder_process_interleaved(
                  encoder,
                  resource.input,
                  blockFrames,
                ),
            ),
          );
          frames += BigInt(blockFrames);
          blockIndex += 1;
          const now = yield* Clock.monotonicTimeNanos;
          if (now - sliceStart >= ENCODE_TIME_SLICE_NANOS) {
            yield* Effect.yieldNow;
            sliceStart = yield* Clock.monotonicTimeNanos;
          }
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

      yield* drainWrites(
        yield* callEncoder(
          resource,
          "finish",
          1,
          "encoder finish trapped",
          (exports, encoder) => exports.codec_encoder_finish(encoder),
        ),
      );
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
