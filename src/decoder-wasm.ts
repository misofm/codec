import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FlacDecodeError } from "./decoder-errors.js";
import { compilePinnedWasm } from "./internal/wasm-asset.js";

export const FLAC_DECODER_WASM_URL = new URL(
  "../wasm/flac-decoder.wasm",
  import.meta.url,
);

// Updated only by the explicit reproducible Wasm build command.
export const FLAC_DECODER_WASM_SHA256 =
  "70caf38185675dff89498e89f98171d49ec6f143a56c6895088d93c35e2018cd";

export const FLAC_DECODER_LIMITS = {
  maxInputChunkBytes: 256 * 1024,
  maxOutputBlockBytes: 384 * 1024,
  maxMetadataBytes: 16 * 1024 * 1024,
  defaultMaxMetadataBytes: 1024 * 1024,
  wasmMemoryBytes: 2 * 1024 * 1024,
  wasmStackBytes: 64 * 1024,
  asyncifyStackBytes: 64 * 1024,
  maxProgresslessCalls: 64,
  maxAssetBytes: 256 * 1024,
  maxTotalFrames: (1n << 36n) - 1n,
} as const;

export interface FlacDecoderService {
  readonly module: WebAssembly.Module;
}

/** A Layer-scoped, compiled decoder module shared by independent decode calls. */
export class FlacDecoder extends Context.Service<
  FlacDecoder,
  FlacDecoderService
>()("@misofm/codec/FlacDecoder") {}

const EXPECTED_IMPORTS = ["codec.read:function"] as const;
const EXPECTED_EXPORTS = [
  "asyncify_get_state:function",
  "asyncify_start_rewind:function",
  "asyncify_start_unwind:function",
  "asyncify_stop_rewind:function",
  "asyncify_stop_unwind:function",
  "codec_decoder_abi_version:function",
  "codec_decoder_allocator_free_calls:function",
  "codec_decoder_allocator_live_bytes:function",
  "codec_decoder_allocator_peak_heap_bytes:function",
  "codec_decoder_allocator_peak_live_bytes:function",
  "codec_decoder_allocator_realloc_calls:function",
  "codec_decoder_bits_per_sample:function",
  "codec_decoder_callback_error:function",
  "codec_decoder_channels:function",
  "codec_decoder_decoded_bytes_high:function",
  "codec_decoder_decoded_bytes_low:function",
  "codec_decoder_decoded_frames_high:function",
  "codec_decoder_decoded_frames_low:function",
  "codec_decoder_delete:function",
  "codec_decoder_finish:function",
  "codec_decoder_init:function",
  "codec_decoder_maximum_block_frames:function",
  "codec_decoder_md5_present:function",
  "codec_decoder_minimum_block_frames:function",
  "codec_decoder_new:function",
  "codec_decoder_output_frame_offset_high:function",
  "codec_decoder_output_frame_offset_low:function",
  "codec_decoder_output_frames:function",
  "codec_decoder_output_length:function",
  "codec_decoder_output_ptr:function",
  "codec_decoder_process_single:function",
  "codec_decoder_release_output:function",
  "codec_decoder_sample_rate:function",
  "codec_decoder_state:function",
  "codec_decoder_streaminfo_frames_high:function",
  "codec_decoder_streaminfo_frames_known:function",
  "codec_decoder_streaminfo_frames_low:function",
  "codec_decoder_total_frames_high:function",
  "codec_decoder_total_frames_known:function",
  "codec_decoder_total_frames_low:function",
  "free:function",
  "malloc:function",
  "memory:memory",
] as const;

export const loadFlacDecoderFromBytes = (
  bytes: Uint8Array,
): Effect.Effect<FlacDecoderService, FlacDecodeError> =>
  compilePinnedWasm(bytes, {
    label: "decoder",
    maxBytes: FLAC_DECODER_LIMITS.maxAssetBytes,
    sha256: FLAC_DECODER_WASM_SHA256,
    expectedImports: EXPECTED_IMPORTS,
    expectedExports: EXPECTED_EXPORTS,
    compileError: (detail, cause) =>
      new FlacDecodeError({
        reason: "wasm-compile",
        phase: "load",
        detail,
        ...(cause === undefined ? {} : { cause }),
      }),
    abiError: (detail) =>
      new FlacDecodeError({ reason: "wasm-abi", phase: "load", detail }),
  }).pipe(Effect.map((module) => ({ module })));

/** Compile and validate trusted decoder Wasm bytes once for a Layer lifetime. */
export const makeFlacDecoderLayer = (
  bytes: Uint8Array,
): Layer.Layer<FlacDecoder, FlacDecodeError> =>
  Layer.effect(FlacDecoder, loadFlacDecoderFromBytes(bytes));
