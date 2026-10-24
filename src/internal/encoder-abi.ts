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

// A fixed-memory module rejects growth with RangeError. Growth succeeding, or
// any other exception, means the memory contract cannot be established.
const probeFixedMemory = (
  memory: WebAssembly.Memory,
): FlacEncodeError | undefined => {
  try {
    memory.grow(1);
  } catch (cause) {
    return cause instanceof RangeError
      ? undefined
      : abiError("could not establish fixed encoder memory", cause);
  }
  return abiError("encoder memory unexpectedly permits growth");
};

const validateExports = (
  raw: WebAssembly.Exports,
): Effect.Effect<EncoderExports, FlacEncodeError> => {
  for (const name of REQUIRED_EXPORTS) {
    if (!(name in raw))
      return Effect.fail(abiError(`encoder Wasm is missing export ${name}`));
  }
  const memory = raw.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    return Effect.fail(
      abiError("encoder memory export is not WebAssembly.Memory"),
    );
  }
  for (const name of REQUIRED_EXPORTS) {
    if (name !== "memory" && typeof raw[name] !== "function") {
      return Effect.fail(
        abiError(`encoder Wasm export ${name} is not a function`),
      );
    }
  }
  if (memory.buffer.byteLength !== FLAC_ENCODER_LIMITS.wasmMemoryBytes) {
    return Effect.fail(
      abiError(
        `encoder memory is ${memory.buffer.byteLength} bytes; expected ${FLAC_ENCODER_LIMITS.wasmMemoryBytes}`,
      ),
    );
  }
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    memory.buffer instanceof SharedArrayBuffer
  ) {
    return Effect.fail(abiError("encoder memory must not be shared"));
  }
  const growth = probeFixedMemory(memory);
  if (growth !== undefined) return Effect.fail(growth);
  // Every required export is checked above before this structural narrowing.
  return Effect.succeed(raw as EncoderExports);
};

/**
 * Instantiate one fixed-memory encoder. The imported `write`/`seek` callbacks
 * run synchronously inside Wasm calls, so they stage bounded writes and record
 * the first failure instead of throwing; `endCall` hands both to Effect code.
 */
export const instantiateEncoder = (
  module: WebAssembly.Module,
): Effect.Effect<EncoderAbi, FlacEncodeError> =>
  Effect.suspend(() => {
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

    return Effect.try({
      try: () => new WebAssembly.Instance(module, imports),
      catch: (cause) =>
        new FlacEncodeError({
          reason:
            cause instanceof WebAssembly.RuntimeError
              ? "wasm-trap"
              : "wasm-instantiate",
          phase: "instantiate",
          detail: "failed to instantiate encoder Wasm",
          cause,
        }),
    }).pipe(
      Effect.flatMap((instance) => validateExports(instance.exports)),
      Effect.map((exports): EncoderAbi => {
        memory = exports.memory;
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
      }),
    );
  });
