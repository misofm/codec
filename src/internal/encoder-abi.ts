import * as Effect from "effect/Effect";

import { FlacEncodeError } from "../errors.js";
import { FLAC_ENCODER_LIMITS } from "../wasm.js";

export interface StagedWrite {
  readonly offset: bigint;
  readonly bytes: Uint8Array;
}

interface EncoderExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (pointer: number) => void;
  readonly codec_encoder_new: (
    sampleRate: number,
    channels: number,
    bitsPerSample: number,
    compressionLevel: number,
    blockFrames: number,
  ) => number;
  readonly codec_encoder_init: (encoder: number) => number;
  readonly codec_encoder_process_interleaved: (
    encoder: number,
    pcm: number,
    frames: number,
  ) => number;
  readonly codec_encoder_finish: (encoder: number) => number;
  readonly codec_encoder_state: (encoder: number) => number;
  readonly codec_encoder_delete: (encoder: number) => void;
}

const REQUIRED_EXPORTS = [
  "memory",
  "malloc",
  "free",
  "codec_encoder_new",
  "codec_encoder_init",
  "codec_encoder_process_interleaved",
  "codec_encoder_finish",
  "codec_encoder_state",
  "codec_encoder_delete",
] as const;

export interface EncoderCallBatch {
  readonly writes: ReadonlyArray<StagedWrite>;
  readonly error: FlacEncodeError | undefined;
}

export interface EncoderAbi {
  readonly exports: EncoderExports;
  beginCall(): void;
  endCall(): EncoderCallBatch;
}

const abiError = (detail: string, cause?: unknown): FlacEncodeError =>
  new FlacEncodeError({
    reason: "wasm-abi",
    phase: "instantiate",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const instantiateEncoder = (
  module: WebAssembly.Module,
): Effect.Effect<EncoderAbi, FlacEncodeError> =>
  Effect.try({
    try: () => {
      let memory: WebAssembly.Memory | undefined;
      let writes: Array<StagedWrite> = [];
      let stagedBytes = 0;
      let error: FlacEncodeError | undefined;

      const imports = {
        codec: {
          write: (offset: bigint, pointer: number, length: number): number => {
            if (error !== undefined) return 1;
            if (
              memory === undefined ||
              offset < 0n ||
              !Number.isSafeInteger(pointer) ||
              !Number.isSafeInteger(length) ||
              pointer < 0 ||
              length < 0 ||
              pointer + length > memory.buffer.byteLength
            ) {
              error = abiError(
                "libFLAC supplied an invalid write callback range",
              );
              return 1;
            }
            if (
              stagedBytes + length >
              FLAC_ENCODER_LIMITS.maxStagedBytesPerCall
            ) {
              error = new FlacEncodeError({
                reason: "staged-output-limit",
                phase: "process",
                detail: `one Wasm call exceeded ${FLAC_ENCODER_LIMITS.maxStagedBytesPerCall} staged bytes`,
              });
              return 1;
            }
            if (writes.length >= FLAC_ENCODER_LIMITS.maxStagedWritesPerCall) {
              error = new FlacEncodeError({
                reason: "staged-output-limit",
                phase: "process",
                detail: `one Wasm call exceeded ${FLAC_ENCODER_LIMITS.maxStagedWritesPerCall} staged writes`,
              });
              return 1;
            }
            const bytes = new Uint8Array(length);
            bytes.set(new Uint8Array(memory.buffer, pointer, length));
            writes.push({ offset, bytes });
            stagedBytes += length;
            return 0;
          },
          seek: (offset: bigint): number => {
            if (error !== undefined) return 1;
            if (offset < 0n) {
              error = abiError(
                "libFLAC supplied a negative seek callback offset",
              );
              return 1;
            }
            return 0;
          },
        },
      };

      const instance = new WebAssembly.Instance(module, imports);
      const raw = instance.exports;
      for (const name of REQUIRED_EXPORTS) {
        if (!(name in raw))
          throw abiError(`encoder Wasm is missing export ${name}`);
      }
      if (!(raw.memory instanceof WebAssembly.Memory)) {
        throw abiError("encoder memory export is not WebAssembly.Memory");
      }
      for (const name of REQUIRED_EXPORTS) {
        if (name !== "memory" && typeof raw[name] !== "function") {
          throw abiError(`encoder Wasm export ${name} is not a function`);
        }
      }
      memory = raw.memory;
      if (memory.buffer.byteLength !== FLAC_ENCODER_LIMITS.wasmMemoryBytes) {
        throw abiError(
          `encoder memory is ${memory.buffer.byteLength} bytes; expected ${FLAC_ENCODER_LIMITS.wasmMemoryBytes}`,
        );
      }
      if (
        typeof SharedArrayBuffer !== "undefined" &&
        memory.buffer instanceof SharedArrayBuffer
      ) {
        throw abiError("encoder memory must not be shared");
      }
      try {
        memory.grow(1);
        throw abiError("encoder memory unexpectedly permits growth");
      } catch (cause) {
        if (cause instanceof FlacEncodeError) throw cause;
        if (!(cause instanceof RangeError))
          throw abiError("could not establish fixed encoder memory", cause);
      }

      // Every required function is checked before this structural narrowing.
      const exports = raw as EncoderExports;
      return {
        exports,
        beginCall(): void {
          writes = [];
          stagedBytes = 0;
          error = undefined;
        },
        endCall(): EncoderCallBatch {
          const batch = { writes, error };
          writes = [];
          stagedBytes = 0;
          error = undefined;
          return batch;
        },
      };
    },
    catch: (cause) =>
      cause instanceof FlacEncodeError
        ? cause
        : new FlacEncodeError({
            reason:
              cause instanceof WebAssembly.RuntimeError
                ? "wasm-trap"
                : "wasm-instantiate",
            phase: "instantiate",
            detail: "failed to instantiate or validate encoder Wasm",
            cause,
          }),
  });
