import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { FlacDecodeError } from "../decoder-errors.js";
import { FLAC_DECODER_LIMITS } from "../decoder-wasm.js";

export type DecoderPhase = "instantiate" | "metadata" | "frame" | "finish";

export interface DecoderExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (pointer: number) => void;
  readonly asyncify_start_unwind: (data: number) => void;
  readonly asyncify_stop_unwind: () => void;
  readonly asyncify_start_rewind: (data: number) => void;
  readonly asyncify_stop_rewind: () => void;
  readonly asyncify_get_state: () => number;
  readonly codec_decoder_abi_version: () => number;
  readonly codec_decoder_new: (...arguments_: ReadonlyArray<number>) => number;
  readonly codec_decoder_init: (decoder: number) => number;
  readonly codec_decoder_process_single: (decoder: number) => number;
  readonly codec_decoder_finish: (decoder: number) => number;
  readonly codec_decoder_delete: (decoder: number) => void;
  readonly codec_decoder_output_ptr: (decoder: number) => number;
  readonly codec_decoder_output_length: (decoder: number) => number;
  readonly codec_decoder_output_frames: (decoder: number) => number;
  readonly codec_decoder_output_frame_offset_low: (decoder: number) => number;
  readonly codec_decoder_output_frame_offset_high: (decoder: number) => number;
  readonly codec_decoder_release_output: (decoder: number) => void;
  readonly codec_decoder_sample_rate: (decoder: number) => number;
  readonly codec_decoder_channels: (decoder: number) => number;
  readonly codec_decoder_bits_per_sample: (decoder: number) => number;
  readonly codec_decoder_minimum_block_frames: (decoder: number) => number;
  readonly codec_decoder_maximum_block_frames: (decoder: number) => number;
  readonly codec_decoder_total_frames_low: (decoder: number) => number;
  readonly codec_decoder_total_frames_high: (decoder: number) => number;
  readonly codec_decoder_total_frames_known: (decoder: number) => number;
  readonly codec_decoder_streaminfo_frames_low: (decoder: number) => number;
  readonly codec_decoder_streaminfo_frames_high: (decoder: number) => number;
  readonly codec_decoder_streaminfo_frames_known: (decoder: number) => number;
  readonly codec_decoder_md5_present: (decoder: number) => number;
  readonly codec_decoder_decoded_frames_low: (decoder: number) => number;
  readonly codec_decoder_decoded_frames_high: (decoder: number) => number;
  readonly codec_decoder_decoded_bytes_low: (decoder: number) => number;
  readonly codec_decoder_decoded_bytes_high: (decoder: number) => number;
  readonly codec_decoder_callback_error: (decoder: number) => number;
  readonly codec_decoder_state: (decoder: number) => number;
  readonly codec_decoder_allocator_live_bytes: () => number;
  readonly codec_decoder_allocator_peak_live_bytes: () => number;
  readonly codec_decoder_allocator_peak_heap_bytes: () => number;
  readonly codec_decoder_allocator_free_calls: () => number;
  readonly codec_decoder_allocator_realloc_calls: () => number;
}

const REQUIRED_EXPORTS = [
  "memory",
  "malloc",
  "free",
  "asyncify_start_unwind",
  "asyncify_stop_unwind",
  "asyncify_start_rewind",
  "asyncify_stop_rewind",
  "asyncify_get_state",
  "codec_decoder_abi_version",
  "codec_decoder_new",
  "codec_decoder_init",
  "codec_decoder_process_single",
  "codec_decoder_finish",
  "codec_decoder_delete",
  "codec_decoder_output_ptr",
  "codec_decoder_output_length",
  "codec_decoder_output_frames",
  "codec_decoder_output_frame_offset_low",
  "codec_decoder_output_frame_offset_high",
  "codec_decoder_release_output",
  "codec_decoder_sample_rate",
  "codec_decoder_channels",
  "codec_decoder_bits_per_sample",
  "codec_decoder_minimum_block_frames",
  "codec_decoder_maximum_block_frames",
  "codec_decoder_total_frames_low",
  "codec_decoder_total_frames_high",
  "codec_decoder_total_frames_known",
  "codec_decoder_streaminfo_frames_low",
  "codec_decoder_streaminfo_frames_high",
  "codec_decoder_streaminfo_frames_known",
  "codec_decoder_md5_present",
  "codec_decoder_decoded_frames_low",
  "codec_decoder_decoded_frames_high",
  "codec_decoder_decoded_bytes_low",
  "codec_decoder_decoded_bytes_high",
  "codec_decoder_callback_error",
  "codec_decoder_state",
  "codec_decoder_allocator_live_bytes",
  "codec_decoder_allocator_peak_live_bytes",
  "codec_decoder_allocator_peak_heap_bytes",
  "codec_decoder_allocator_free_calls",
  "codec_decoder_allocator_realloc_calls",
] as const;

const ASYNCIFY_NORMAL = 0;
const ASYNCIFY_UNWINDING = 1;
const ASYNCIFY_REWINDING = 2;
const ASYNCIFY_DATA_BYTES = 8;

const wasmError = (
  reason: "wasm-abi" | "wasm-instantiate" | "wasm-trap" | "allocation-failed",
  phase: DecoderPhase,
  detail: string,
  cause?: unknown,
): FlacDecodeError =>
  new FlacDecodeError({
    reason,
    phase,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export interface DecoderAbi {
  readonly exports: DecoderExports;
  readonly invoke: <E, R>(
    phase: DecoderPhase,
    call: () => number,
    nextInput: Effect.Effect<Uint8Array | null, E, R>,
  ) => Effect.Effect<number, E | FlacDecodeError, R>;
  readonly normalize: () => void;
  readonly dispose: () => void;
}

const instantiateError = (detail: string, cause?: unknown): FlacDecodeError =>
  wasmError("wasm-instantiate", "instantiate", detail, cause);

const validateExports = (
  raw: WebAssembly.Exports,
): Effect.Effect<DecoderExports, FlacDecodeError> =>
  Effect.gen(function* () {
    for (const name of REQUIRED_EXPORTS) {
      if (!(name in raw))
        return yield* instantiateError(`missing decoder Wasm export: ${name}`);
      if (name !== "memory" && typeof raw[name] !== "function") {
        return yield* instantiateError(
          `decoder Wasm export is not a function: ${name}`,
        );
      }
    }
    // Every required function export is checked above.
    const exports = raw as DecoderExports;
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      return yield* instantiateError(
        "decoder memory export is not WebAssembly.Memory",
      );
    }
    const abiVersion = yield* Effect.try({
      try: () => exports.codec_decoder_abi_version(),
      catch: (cause) =>
        instantiateError("decoder Wasm trapped while reporting its ABI", cause),
    });
    if (abiVersion !== 1) {
      return yield* instantiateError(`unsupported decoder ABI ${abiVersion}`);
    }
    if (memory.buffer.byteLength !== FLAC_DECODER_LIMITS.wasmMemoryBytes) {
      return yield* instantiateError(
        `decoder memory is ${memory.buffer.byteLength} bytes; expected ${FLAC_DECODER_LIMITS.wasmMemoryBytes}`,
      );
    }
    if (
      typeof SharedArrayBuffer !== "undefined" &&
      memory.buffer instanceof SharedArrayBuffer
    ) {
      return yield* instantiateError("decoder memory must be non-shared");
    }
    if (growsMemory(memory)) {
      return yield* instantiateError("decoder memory is growable");
    }
    return exports;
  });

// Fixed memory rejects growth; any exception counts as a refusal.
const growsMemory = (memory: WebAssembly.Memory): boolean => {
  try {
    memory.grow(1);
    return true;
  } catch {
    return false;
  }
};

/** Allocate and describe the Asyncify data/stack region; returns its pointer. */
const allocateAsyncifyStack = (
  exports: DecoderExports,
): Effect.Effect<number, FlacDecodeError> =>
  Effect.try({
    try: () =>
      exports.malloc(
        ASYNCIFY_DATA_BYTES + FLAC_DECODER_LIMITS.asyncifyStackBytes,
      ),
    catch: (cause) =>
      instantiateError(
        "decoder Wasm trapped while allocating the Asyncify stack",
        cause,
      ),
  }).pipe(
    Effect.flatMap((pointer) => {
      const allocationBytes =
        ASYNCIFY_DATA_BYTES + FLAC_DECODER_LIMITS.asyncifyStackBytes;
      if (
        !Number.isSafeInteger(pointer) ||
        pointer <= 0 ||
        pointer > exports.memory.buffer.byteLength - allocationBytes
      ) {
        return Effect.fail(
          instantiateError("could not allocate the Asyncify stack"),
        );
      }
      const stackStart = pointer + ASYNCIFY_DATA_BYTES;
      const data = new DataView(exports.memory.buffer);
      data.setUint32(pointer, stackStart, true);
      data.setUint32(
        pointer + 4,
        stackStart + FLAC_DECODER_LIMITS.asyncifyStackBytes,
        true,
      );
      return Effect.succeed(pointer);
    }),
  );

/**
 * Instantiate one fixed-memory decoder. The only suspension point is the
 * imported synchronous read callback; `invoke` moves that suspension into the
 * caller's Effect pull without owning or nesting a runtime.
 *
 * The caller owns `dispose`, which frees the Asyncify stack; prefer
 * `acquireDecoderAbi`, which registers it with the current scope.
 */
export const instantiateDecoder = (
  module: WebAssembly.Module,
): Effect.Effect<DecoderAbi, FlacDecodeError> =>
  Effect.suspend(() => {
    let decoderExports: DecoderExports | undefined;
    let slot: Uint8Array | undefined;
    let slotOffset = 0;
    let eof = false;
    let asyncifyData = 0;
    let disposed = false;

    // Foreign callback boundary: runs synchronously inside a Wasm call, so it
    // signals failure by throwing, which surfaces as a trap from `invoke`.
    const read = (pointer: number, maximumBytes: number): number => {
      const exports = decoderExports;
      if (exports === undefined)
        throw new Error("decoder read before instantiation");
      const state = exports.asyncify_get_state();
      if (state === ASYNCIFY_REWINDING) exports.asyncify_stop_rewind();
      if (state !== ASYNCIFY_NORMAL && state !== ASYNCIFY_REWINDING) {
        throw new Error(`decoder read in invalid Asyncify state ${state}`);
      }
      if (slot !== undefined) {
        if (
          !Number.isSafeInteger(pointer) ||
          !Number.isSafeInteger(maximumBytes) ||
          pointer < 0 ||
          maximumBytes <= 0 ||
          pointer + maximumBytes > exports.memory.buffer.byteLength
        ) {
          throw new Error("libFLAC supplied an invalid read callback range");
        }
        const length = Math.min(maximumBytes, slot.byteLength - slotOffset);
        new Uint8Array(exports.memory.buffer, pointer, length).set(
          slot.subarray(slotOffset, slotOffset + length),
        );
        slotOffset += length;
        if (slotOffset === slot.byteLength) {
          slot = undefined;
          slotOffset = 0;
        }
        return length;
      }
      if (eof) return 0;
      if (state === ASYNCIFY_REWINDING) {
        throw new Error("decoder resumed without an input slot or EOF");
      }
      exports.asyncify_start_unwind(asyncifyData);
      return -1;
    };

    const normalize = (): void => {
      const state = decoderExports!.asyncify_get_state();
      if (state === ASYNCIFY_UNWINDING) decoderExports!.asyncify_stop_unwind();
      else if (state === ASYNCIFY_REWINDING)
        decoderExports!.asyncify_stop_rewind();
    };

    const invoke = <E, R>(
      phase: DecoderPhase,
      call: () => number,
      nextInput: Effect.Effect<Uint8Array | null, E, R>,
    ): Effect.Effect<number, E | FlacDecodeError, R> =>
      Effect.gen(function* () {
        let rewind = false;
        for (;;) {
          const outcome = yield* Effect.try({
            try: () => {
              try {
                if (rewind) decoderExports!.asyncify_start_rewind(asyncifyData);
                const result = call();
                const state = decoderExports!.asyncify_get_state();
                if (state === ASYNCIFY_UNWINDING) {
                  decoderExports!.asyncify_stop_unwind();
                  return { result, suspended: true } as const;
                }
                if (state !== ASYNCIFY_NORMAL) {
                  normalize();
                  throw new Error(`decoder stopped in Asyncify state ${state}`);
                }
                return { result, suspended: false } as const;
              } catch (cause) {
                normalize();
                throw cause;
              }
            },
            catch: (cause) =>
              wasmError(
                "wasm-trap",
                phase,
                `decoder Wasm trapped during ${phase}`,
                cause,
              ),
          });
          if (!outcome.suspended) return outcome.result;
          const input = yield* nextInput;
          if (input === null) {
            eof = true;
          } else {
            slot = input;
            slotOffset = 0;
          }
          rewind = true;
        }
      });

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      normalize();
      if (asyncifyData !== 0) decoderExports!.free(asyncifyData);
      asyncifyData = 0;
      slot = undefined;
    };

    return Effect.gen(function* () {
      const instance = yield* Effect.tryPromise({
        try: () => WebAssembly.instantiate(module, { codec: { read } }),
        catch: (cause) =>
          instantiateError(
            "could not instantiate the decoder Wasm module",
            cause,
          ),
      });
      const exports = yield* validateExports(instance.exports);
      decoderExports = exports;
      asyncifyData = yield* allocateAsyncifyStack(exports);
      return { exports, invoke, normalize, dispose };
    });
  });

/**
 * Instantiate a decoder whose Asyncify stack is released when the current scope
 * closes. Release is best-effort: a trap while releasing is ignored, because a
 * primary result, failure, or interruption already exists. Callers that must
 * observe cleanup traps call `dispose` themselves first; it is idempotent.
 */
export const acquireDecoderAbi = (
  module: WebAssembly.Module,
): Effect.Effect<DecoderAbi, FlacDecodeError, Scope.Scope> =>
  Effect.acquireRelease(instantiateDecoder(module), (abi) =>
    Effect.ignore(
      Effect.try({ try: () => abi.dispose(), catch: (cause) => cause }),
    ),
  );
