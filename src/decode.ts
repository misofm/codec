import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { FlacDecodeError } from "./decoder-errors.js";
import { PcmFormat } from "./format.js";
import {
  instantiateDecoder,
  type DecoderAbi,
  type DecoderPhase,
} from "./internal/decoder-abi.js";
import { FlacDecoder, FLAC_DECODER_LIMITS } from "./decoder-wasm.js";

export interface FlacDecodeOptions {
  readonly expectedFormat?: PcmFormat;
  readonly expectedFrames?: bigint;
  /** Maximum size of each source element. Defaults to the fixed 256 KiB input-slot limit. */
  readonly maxInputChunkBytes?: number;
  /** Maximum bytes libFLAC may read while parsing metadata. Defaults to 1 MiB. */
  readonly maxMetadataBytes?: number;
}

export interface FlacMetadata {
  readonly _tag: "Metadata";
  readonly format: PcmFormat;
  readonly minimumBlockFrames: number;
  readonly maximumBlockFrames: number;
  /** STREAMINFO total samples, absent when the encoded value is zero (unknown). */
  readonly totalFrames?: bigint;
  readonly md5Present: boolean;
}

export interface FlacPcm {
  readonly _tag: "Pcm";
  readonly format: PcmFormat;
  readonly frameOffset: bigint;
  readonly frames: number;
  /** Canonical interleaved signed PCM, packed little-endian at `format.bitsPerSample`. */
  readonly bytes: Uint8Array;
}

export interface FlacDecodeComplete {
  readonly _tag: "Complete";
  readonly format: PcmFormat;
  readonly frames: bigint;
  readonly bytes: bigint;
  readonly md5Checked: boolean;
  readonly md5Verified: boolean;
}

export type FlacDecodeEvent = FlacMetadata | FlacPcm | FlacDecodeComplete;

interface CheckedOptions {
  readonly expectedFormat: PcmFormat | undefined;
  readonly expectedFrames: bigint | undefined;
  readonly maxInputChunkBytes: number;
  readonly maxMetadataBytes: number;
}

interface DecoderResource {
  readonly abi: DecoderAbi;
  readonly decoder: number;
}

const invalidOptions = (detail: string): FlacDecodeError =>
  new FlacDecodeError({
    reason: "invalid-options",
    phase: "metadata",
    detail,
  });

const checkOptions = (
  options: unknown,
): Effect.Effect<CheckedOptions, FlacDecodeError> =>
  Effect.gen(function* () {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      return yield* invalidOptions("decoder options must be an object");
    }
    const values = options as Readonly<Record<string, unknown>>;
    const maxInputChunkBytes =
      values.maxInputChunkBytes ?? FLAC_DECODER_LIMITS.maxInputChunkBytes;
    const maxMetadataBytes =
      values.maxMetadataBytes ?? FLAC_DECODER_LIMITS.defaultMaxMetadataBytes;
    const expectedFrames = values.expectedFrames;
    if (
      typeof maxInputChunkBytes !== "number" ||
      !Number.isSafeInteger(maxInputChunkBytes) ||
      maxInputChunkBytes < 1 ||
      maxInputChunkBytes > FLAC_DECODER_LIMITS.maxInputChunkBytes
    ) {
      return yield* invalidOptions(
        `maxInputChunkBytes must be an integer from 1 through ${FLAC_DECODER_LIMITS.maxInputChunkBytes}`,
      );
    }
    if (
      typeof maxMetadataBytes !== "number" ||
      !Number.isSafeInteger(maxMetadataBytes) ||
      maxMetadataBytes < 42 ||
      maxMetadataBytes > FLAC_DECODER_LIMITS.maxMetadataBytes
    ) {
      return yield* invalidOptions(
        `maxMetadataBytes must be an integer from 42 through ${FLAC_DECODER_LIMITS.maxMetadataBytes}`,
      );
    }
    if (
      expectedFrames !== undefined &&
      (typeof expectedFrames !== "bigint" ||
        expectedFrames < 0n ||
        expectedFrames > FLAC_DECODER_LIMITS.maxTotalFrames)
    ) {
      return yield* invalidOptions(
        `expectedFrames must be from 0 through ${FLAC_DECODER_LIMITS.maxTotalFrames}`,
      );
    }
    const expectedFormat =
      values.expectedFormat === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(PcmFormat)(
            values.expectedFormat,
          ).pipe(
            Effect.mapError(() =>
              invalidOptions(
                "expectedFormat is outside the supported PCM format",
              ),
            ),
          );
    return {
      expectedFormat,
      expectedFrames,
      maxInputChunkBytes,
      maxMetadataBytes,
    };
  });

const uint64 = (low: number, high: number): bigint =>
  (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);

const low32 = (value: bigint): number => Number(value & 0xffff_ffffn);
const high32 = (value: bigint): number => Number((value >> 32n) & 0xffff_ffffn);

const abiOperation = <A>(
  phase: DecoderPhase,
  detail: string,
  operation: () => A,
): Effect.Effect<A, FlacDecodeError> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      new FlacDecodeError({
        reason: "wasm-trap",
        phase,
        detail,
        cause,
      }),
  });

const decoderFailure = (
  resource: DecoderResource,
  phase: DecoderPhase,
  detail: string,
  result: number,
): FlacDecodeError => {
  const { exports } = resource.abi;
  let callbackError: number;
  let nativeState: number;
  try {
    callbackError = exports.codec_decoder_callback_error(resource.decoder);
    nativeState = exports.codec_decoder_state(resource.decoder);
  } catch (cause) {
    return new FlacDecodeError({
      reason: "wasm-trap",
      phase,
      detail: "decoder diagnostics trapped after a failed operation",
      cause,
    });
  }
  let reason: FlacDecodeError["reason"] = "invalid-stream";
  if (nativeState === 8) reason = "allocation-failed";
  else if (callbackError === 2) reason = "metadata-limit";
  else if (
    callbackError === 20 ||
    callbackError === 21 ||
    callbackError === 104
  )
    reason = "invalid-metadata";
  else if (callbackError === 22 || callbackError === 23)
    reason = "expected-metadata-mismatch";
  else if (callbackError === 11) reason = "frame-position-mismatch";
  else if (callbackError === 12 || (phase === "finish" && result === -2))
    reason = "frame-count-mismatch";
  else if (callbackError === 102) reason = "crc-mismatch";
  else if (phase === "finish" && result === -3 && callbackError === 0)
    reason = "md5-mismatch";
  return new FlacDecodeError({
    reason,
    phase,
    detail: `${detail} (native result ${result})`,
    nativeState,
    callbackError,
  });
};

const makeDecodeStream = <E, R>(
  input: Stream.Stream<Uint8Array, E, R>,
  options: CheckedOptions,
): Stream.Stream<FlacDecodeEvent, E | FlacDecodeError, R | FlacDecoder> =>
  Stream.transformPullBracket(
    input.pipe(Stream.rechunk(1)),
    (inputPull, _scope, resourceScope) =>
      Effect.gen(function* () {
        const service = yield* FlacDecoder;
        const abi = yield* instantiateDecoder(service.module);
        let decoder = 0;
        let released = false;
        const releaseDecoder = (): void => {
          if (released) return;
          released = true;
          let trapped = false;
          let firstCause: unknown;
          const attempt = (operation: () => void): void => {
            try {
              operation();
            } catch (cause) {
              if (!trapped) firstCause = cause;
              trapped = true;
            }
          };
          attempt(() => abi.normalize());
          const ownedDecoder = decoder;
          decoder = 0;
          if (ownedDecoder !== 0)
            attempt(() => abi.exports.codec_decoder_delete(ownedDecoder));
          attempt(() => abi.dispose());
          if (trapped) throw firstCause;
        };
        yield* Scope.addFinalizer(
          resourceScope,
          Effect.sync(() => {
            try {
              releaseDecoder();
            } catch {
              // The decode result already carries any primary Wasm failure.
            }
          }),
        );

        const expectedFrames = options.expectedFrames ?? 0n;
        const expectedFormat = options.expectedFormat;
        decoder = yield* abiOperation(
          "instantiate",
          "decoder Wasm trapped while allocating libFLAC state",
          () =>
            abi.exports.codec_decoder_new(
              options.maxMetadataBytes,
              expectedFormat?.sampleRate ?? 0,
              expectedFormat?.channels ?? 0,
              expectedFormat?.bitsPerSample ?? 0,
              low32(expectedFrames),
              high32(expectedFrames),
              expectedFormat === undefined ? 0 : 1,
              options.expectedFrames === undefined ? 0 : 1,
            ),
        );
        if (
          !Number.isSafeInteger(decoder) ||
          decoder <= 0 ||
          decoder >= abi.exports.memory.buffer.byteLength
        ) {
          return yield* new FlacDecodeError({
            reason: "allocation-failed",
            phase: "instantiate",
            detail: "could not allocate the fixed-memory libFLAC decoder",
          });
        }

        let state: "metadata" | "frames" | "done" = "metadata";
        let format: PcmFormat | undefined;
        let minimumBlockFrames = 0;
        let maximumBlockFrames = 0;
        let md5Present = false;
        let emittedFrames = 0n;
        let emittedBytes = 0n;
        let progresslessCalls = 0;
        const pullInput: Effect.Effect<Uint8Array | null, E, R> =
          inputPull.pipe(
            Pull.matchEffect({
              onSuccess: (chunks) => Effect.succeed(chunks[0]!),
              onFailure: (cause) => Effect.failCause(cause),
              onDone: () => Effect.succeed(null),
            }),
          );
        const nextInput: Effect.Effect<
          Uint8Array | null,
          E | FlacDecodeError,
          R
        > = Effect.gen(function* () {
          for (;;) {
            const bytes = yield* pullInput;
            if (bytes === null) return null;
            const phase = state === "metadata" ? "metadata" : "frame";
            if (!(bytes instanceof Uint8Array)) {
              return yield* new FlacDecodeError({
                reason: "invalid-stream",
                phase,
                detail: "FLAC input elements must be Uint8Array values",
              });
            }
            if (bytes.byteLength > options.maxInputChunkBytes) {
              return yield* new FlacDecodeError({
                reason: "input-chunk-too-large",
                phase,
                detail: `input chunk is ${bytes.byteLength} bytes; maximum is ${options.maxInputChunkBytes}`,
              });
            }
            if (bytes.byteLength !== 0) return bytes;
          }
        });

        const outputPull = Effect.gen(function* () {
          if (state === "done") return yield* Cause.done();
          if (state === "metadata") {
            const result = yield* abi.invoke(
              "metadata",
              () => abi.exports.codec_decoder_init(decoder),
              nextInput,
            );
            if (result !== 0) {
              return yield* decoderFailure(
                { abi, decoder },
                "metadata",
                "libFLAC rejected FLAC metadata",
                result,
              );
            }
            const metadataValues = yield* abiOperation(
              "metadata",
              "decoder Wasm trapped while reporting STREAMINFO",
              () => ({
                sampleRate: abi.exports.codec_decoder_sample_rate(decoder),
                channels: abi.exports.codec_decoder_channels(decoder),
                bitsPerSample:
                  abi.exports.codec_decoder_bits_per_sample(decoder),
                minimumBlockFrames:
                  abi.exports.codec_decoder_minimum_block_frames(decoder),
                maximumBlockFrames:
                  abi.exports.codec_decoder_maximum_block_frames(decoder),
                md5Present: abi.exports.codec_decoder_md5_present(decoder),
                totalFramesKnown:
                  abi.exports.codec_decoder_streaminfo_frames_known(decoder),
                totalFramesLow:
                  abi.exports.codec_decoder_streaminfo_frames_low(decoder),
                totalFramesHigh:
                  abi.exports.codec_decoder_streaminfo_frames_high(decoder),
              }),
            );
            minimumBlockFrames = metadataValues.minimumBlockFrames;
            maximumBlockFrames = metadataValues.maximumBlockFrames;
            if (
              !Number.isSafeInteger(minimumBlockFrames) ||
              !Number.isSafeInteger(maximumBlockFrames) ||
              minimumBlockFrames < 16 ||
              maximumBlockFrames < minimumBlockFrames ||
              maximumBlockFrames > 65_535 ||
              (metadataValues.md5Present !== 0 &&
                metadataValues.md5Present !== 1) ||
              (metadataValues.totalFramesKnown !== 0 &&
                metadataValues.totalFramesKnown !== 1)
            ) {
              return yield* new FlacDecodeError({
                reason: "wasm-abi",
                phase: "metadata",
                detail: "decoder returned invalid STREAMINFO scalars or flags",
              });
            }
            format = yield* Schema.decodeUnknownEffect(PcmFormat)({
              sampleRate: metadataValues.sampleRate,
              channels: metadataValues.channels,
              bitsPerSample: metadataValues.bitsPerSample,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new FlacDecodeError({
                    reason: "wasm-abi",
                    phase: "metadata",
                    detail: "decoder returned an unsupported PCM format",
                    cause,
                  }),
              ),
            );
            md5Present = metadataValues.md5Present === 1;
            const totalFramesKnown = metadataValues.totalFramesKnown === 1;
            const totalFrames = uint64(
              metadataValues.totalFramesLow,
              metadataValues.totalFramesHigh,
            );
            if (
              totalFramesKnown &&
              totalFrames > FLAC_DECODER_LIMITS.maxTotalFrames
            ) {
              return yield* new FlacDecodeError({
                reason: "wasm-abi",
                phase: "metadata",
                detail:
                  "decoder returned an out-of-range STREAMINFO frame count",
              });
            }
            const metadata: FlacMetadata = {
              _tag: "Metadata",
              format,
              minimumBlockFrames,
              maximumBlockFrames,
              ...(totalFramesKnown ? { totalFrames } : {}),
              md5Present,
            };
            state = "frames";
            return [metadata] as readonly [FlacDecodeEvent];
          }

          for (;;) {
            const result = yield* abi.invoke(
              "frame",
              () => abi.exports.codec_decoder_process_single(decoder),
              nextInput,
            );
            if (result === 1) {
              progresslessCalls = 0;
              const output = yield* abiOperation(
                "frame",
                "decoder Wasm trapped while reporting PCM output",
                () => ({
                  length: abi.exports.codec_decoder_output_length(decoder),
                  frames: abi.exports.codec_decoder_output_frames(decoder),
                  pointer: abi.exports.codec_decoder_output_ptr(decoder),
                  offset: uint64(
                    abi.exports.codec_decoder_output_frame_offset_low(decoder),
                    abi.exports.codec_decoder_output_frame_offset_high(decoder),
                  ),
                }),
              );
              const expectedLength =
                output.frames * format!.channels * (format!.bitsPerSample / 8);
              if (
                !Number.isSafeInteger(output.length) ||
                !Number.isSafeInteger(output.frames) ||
                !Number.isSafeInteger(output.pointer) ||
                output.length <= 0 ||
                output.frames <= 0 ||
                output.frames > maximumBlockFrames ||
                output.offset !== emittedFrames ||
                output.length !== expectedLength ||
                output.length > FLAC_DECODER_LIMITS.maxOutputBlockBytes ||
                output.pointer <= 0 ||
                output.pointer >
                  abi.exports.memory.buffer.byteLength - output.length
              ) {
                return yield* new FlacDecodeError({
                  reason: "wasm-abi",
                  phase: "frame",
                  detail:
                    "decoder returned an invalid bounded PCM output range",
                });
              }
              const bytes = yield* abiOperation(
                "frame",
                "decoder Wasm trapped while copying PCM output",
                () =>
                  Uint8Array.from(
                    new Uint8Array(
                      abi.exports.memory.buffer,
                      output.pointer,
                      output.length,
                    ),
                  ),
              );
              const event: FlacPcm = {
                _tag: "Pcm",
                format: format!,
                frameOffset: output.offset,
                frames: output.frames,
                bytes,
              };
              yield* abiOperation(
                "frame",
                "decoder Wasm trapped while releasing PCM output",
                () => abi.exports.codec_decoder_release_output(decoder),
              );
              emittedFrames += BigInt(output.frames);
              emittedBytes += BigInt(output.length);
              return [event] as readonly [FlacDecodeEvent];
            }
            if (result === 0) {
              progresslessCalls += 1;
              if (
                progresslessCalls > FLAC_DECODER_LIMITS.maxProgresslessCalls
              ) {
                return yield* new FlacDecodeError({
                  reason: "invalid-stream",
                  phase: "frame",
                  detail: `decoder made no observable progress for ${progresslessCalls} bounded calls`,
                });
              }
              yield* Effect.yieldNow;
              continue;
            }
            if (result !== 2) {
              return yield* decoderFailure(
                { abi, decoder },
                "frame",
                "libFLAC rejected an audio frame",
                result,
              );
            }

            const finish = yield* abi.invoke(
              "finish",
              () => abi.exports.codec_decoder_finish(decoder),
              nextInput,
            );
            if (finish !== 0) {
              return yield* decoderFailure(
                { abi, decoder },
                "finish",
                "libFLAC could not verify the completed stream",
                finish,
              );
            }
            const completed = yield* abiOperation(
              "finish",
              "decoder Wasm trapped while reporting completion",
              () => ({
                frames: uint64(
                  abi.exports.codec_decoder_decoded_frames_low(decoder),
                  abi.exports.codec_decoder_decoded_frames_high(decoder),
                ),
                bytes: uint64(
                  abi.exports.codec_decoder_decoded_bytes_low(decoder),
                  abi.exports.codec_decoder_decoded_bytes_high(decoder),
                ),
              }),
            );
            if (
              completed.frames > FLAC_DECODER_LIMITS.maxTotalFrames ||
              completed.frames !== emittedFrames ||
              completed.bytes !== emittedBytes
            ) {
              return yield* new FlacDecodeError({
                reason: "wasm-abi",
                phase: "finish",
                detail: "decoder completion counters do not match emitted PCM",
              });
            }
            const complete: FlacDecodeComplete = {
              _tag: "Complete",
              format: format!,
              frames: completed.frames,
              bytes: completed.bytes,
              md5Checked: md5Present,
              md5Verified: md5Present,
            };
            yield* abiOperation(
              "finish",
              "decoder cleanup trapped after successful verification",
              releaseDecoder,
            );
            state = "done";
            return [complete] as readonly [FlacDecodeEvent];
          }
        });
        return outputPull;
      }),
  );

/**
 * Incrementally decode an ordinary native-FLAC byte stream. The returned Stream
 * pulls at most one bounded input element at each Asyncify suspension and emits
 * one bounded PCM block at a time. A `Complete` event is the only verified
 * success signal; early stream cancellation emits none and releases the Wasm
 * decoder through the stream scope.
 */
export const decodeFlac = <E, R>(
  input: Stream.Stream<Uint8Array, E, R>,
  options: FlacDecodeOptions = {},
): Stream.Stream<FlacDecodeEvent, E | FlacDecodeError, R | FlacDecoder> => {
  return Stream.unwrap(
    checkOptions(options).pipe(
      Effect.map((checked) => makeDecodeStream(input, checked)),
    ),
  );
};
