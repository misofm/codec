import * as Effect from "effect/Effect";

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

/**
 * Instantiate one fixed-memory decoder. The only suspension point is the
 * imported synchronous read callback; `invoke` moves that suspension into the
 * caller's Effect pull without owning or nesting a runtime.
 */
export const instantiateDecoder = (
  module: WebAssembly.Module,
): Effect.Effect<DecoderAbi, FlacDecodeError> =>
  Effect.tryPromise({
    try: async () => {
      let decoderExports: DecoderExports | undefined;
      let slot: Uint8Array | undefined;
      let slotOffset = 0;
      let eof = false;
      let asyncifyData = 0;
      let disposed = false;

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

      const instance = await WebAssembly.instantiate(module, {
        codec: { read },
      });
      const raw = instance.exports;
      for (const name of REQUIRED_EXPORTS) {
        if (!(name in raw))
          throw new Error(`missing decoder Wasm export: ${name}`);
        if (name !== "memory" && typeof raw[name] !== "function") {
          throw new Error(`decoder Wasm export is not a function: ${name}`);
        }
      }
      decoderExports = raw as DecoderExports;
      if (!(decoderExports.memory instanceof WebAssembly.Memory)) {
        throw new Error("decoder memory export is not WebAssembly.Memory");
      }
      if (decoderExports.codec_decoder_abi_version() !== 1) {
        throw new Error(
          `unsupported decoder ABI ${decoderExports.codec_decoder_abi_version()}`,
        );
      }
      if (
        decoderExports.memory.buffer.byteLength !==
        FLAC_DECODER_LIMITS.wasmMemoryBytes
      ) {
        throw new Error(
          `decoder memory is ${decoderExports.memory.buffer.byteLength} bytes`,
        );
      }
      if (
        typeof SharedArrayBuffer !== "undefined" &&
        decoderExports.memory.buffer instanceof SharedArrayBuffer
      ) {
        throw new Error("decoder memory must be non-shared");
      }
      try {
        decoderExports.memory.grow(1);
        throw new Error("decoder memory is growable");
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message === "decoder memory is growable"
        )
          throw cause;
      }

      const allocationBytes =
        ASYNCIFY_DATA_BYTES + FLAC_DECODER_LIMITS.asyncifyStackBytes;
      asyncifyData = decoderExports.malloc(allocationBytes);
      if (asyncifyData === 0)
        throw new Error("could not allocate the Asyncify stack");
      const stackStart = asyncifyData + ASYNCIFY_DATA_BYTES;
      const data = new DataView(decoderExports.memory.buffer);
      data.setUint32(asyncifyData, stackStart, true);
      data.setUint32(
        asyncifyData + 4,
        stackStart + FLAC_DECODER_LIMITS.asyncifyStackBytes,
        true,
      );

      const normalize = (): void => {
        const state = decoderExports!.asyncify_get_state();
        if (state === ASYNCIFY_UNWINDING)
          decoderExports!.asyncify_stop_unwind();
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
                  if (rewind)
                    decoderExports!.asyncify_start_rewind(asyncifyData);
                  const result = call();
                  const state = decoderExports!.asyncify_get_state();
                  if (state === ASYNCIFY_UNWINDING) {
                    decoderExports!.asyncify_stop_unwind();
                    return { result, suspended: true } as const;
                  }
                  if (state !== ASYNCIFY_NORMAL) {
                    normalize();
                    throw new Error(
                      `decoder stopped in Asyncify state ${state}`,
                    );
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
      return { exports: decoderExports, invoke, normalize, dispose };
    },
    catch: (cause) =>
      cause instanceof FlacDecodeError
        ? cause
        : wasmError(
            "wasm-instantiate",
            "instantiate",
            "could not instantiate the decoder Wasm module",
            cause,
          ),
  });
