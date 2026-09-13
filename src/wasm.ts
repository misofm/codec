import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FlacEncodeError } from "./errors.js";

export const FLAC_ENCODER_WASM_URL = new URL(
  "../wasm/flac-encoder.wasm",
  import.meta.url,
);

// Updated only by the explicit reproducible Wasm build command.
export const FLAC_ENCODER_WASM_SHA256 =
  "90da75c73784e7184ea6c27d3ea9509f74df2eda405d8ddc8f964d78a16a273e";

export const FLAC_ENCODER_LIMITS = {
  maxInputBlockFrames: 4_096,
  maxStagedBytesPerCall: 256 * 1_024,
  maxStagedWritesPerCall: 64,
  maxMetadataPrefixBytes: 4 * 1_024,
  maxAssetBytes: 256 * 1_024,
  wasmMemoryBytes: 16 * 1_024 * 1_024,
  wasmStackBytes: 256 * 1_024,
  compressionLevel: 8,
  encoderBlockFrames: 4_096,
  maxTotalFrames: (1n << 36n) - 1n,
} as const;

export interface FlacEncoderService {
  readonly module: WebAssembly.Module;
}

/** A Layer-scoped, compiled encoder module shared by independent encode calls. */
export class FlacEncoder extends Context.Service<
  FlacEncoder,
  FlacEncoderService
>()("@misofm/codec/FlacEncoder") {}

const EXPECTED_IMPORTS = [
  "codec.seek:function",
  "codec.write:function",
] as const;
const EXPECTED_EXPORTS = [
  "__em_lib_deps__em_malloc_deps:global",
  "codec_encoder_delete:function",
  "codec_encoder_finish:function",
  "codec_encoder_init:function",
  "codec_encoder_new:function",
  "codec_encoder_process_interleaved:function",
  "codec_encoder_state:function",
  "free:function",
  "malloc:function",
  "memory:memory",
] as const;

const digestHex = (bytes: ArrayBuffer): Promise<string> =>
  globalThis.crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    );

const compileEncoder = (
  bytes: Uint8Array,
): Effect.Effect<FlacEncoderService, FlacEncodeError> =>
  Effect.tryPromise({
    try: async () => {
      if (bytes.byteLength > FLAC_ENCODER_LIMITS.maxAssetBytes) {
        throw new Error(
          `encoder asset is ${bytes.byteLength} bytes; maximum is ${FLAC_ENCODER_LIMITS.maxAssetBytes}`,
        );
      }
      const owned = new Uint8Array(bytes.byteLength);
      owned.set(bytes);
      const hash = await digestHex(owned.buffer);
      if (hash !== FLAC_ENCODER_WASM_SHA256) {
        throw new Error(
          `encoder asset SHA-256 ${hash} does not match pinned ${FLAC_ENCODER_WASM_SHA256}`,
        );
      }
      return WebAssembly.compile(owned.buffer);
    },
    catch: (cause) =>
      new FlacEncodeError({
        reason: "wasm-compile",
        phase: "load",
        detail: "WebAssembly.compile rejected the encoder asset",
        cause,
      }),
  }).pipe(
    Effect.flatMap((module) => {
      const imports = WebAssembly.Module.imports(module)
        .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
        .sort();
      if (JSON.stringify(imports) !== JSON.stringify(EXPECTED_IMPORTS)) {
        return Effect.fail(
          new FlacEncodeError({
            reason: "wasm-abi",
            phase: "load",
            detail: `unexpected encoder imports: ${imports.join(", ")}`,
          }),
        );
      }
      const exports = WebAssembly.Module.exports(module)
        .map(({ name, kind }) => `${name}:${kind}`)
        .sort();
      if (JSON.stringify(exports) !== JSON.stringify(EXPECTED_EXPORTS)) {
        return Effect.fail(
          new FlacEncodeError({
            reason: "wasm-abi",
            phase: "load",
            detail: `unexpected encoder exports: ${exports.join(", ")}`,
          }),
        );
      }
      return Effect.succeed({ module });
    }),
  );

/** Compile and validate trusted encoder Wasm bytes once for a Layer lifetime. */
export const makeFlacEncoderLayer = (
  bytes: Uint8Array,
): Layer.Layer<FlacEncoder, FlacEncodeError> =>
  Layer.effect(FlacEncoder, compileEncoder(bytes));

export const loadFlacEncoderFromBytes = compileEncoder;
