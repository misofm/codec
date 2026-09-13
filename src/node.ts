import { readFile } from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FlacEncodeError } from "./errors.js";
import { FlacDecodeError } from "./decoder-errors.js";
import {
  FlacDecoder,
  FLAC_DECODER_WASM_URL,
  loadFlacDecoderFromBytes,
} from "./decoder-wasm.js";
import {
  FlacEncoder,
  FLAC_ENCODER_WASM_URL,
  loadFlacEncoderFromBytes,
} from "./wasm.js";

/** Load, compile, and validate the package encoder asset using Node/Bun file I/O. */
export const loadFlacEncoder = Effect.tryPromise({
  try: (signal) => readFile(FLAC_ENCODER_WASM_URL, { signal }),
  catch: (cause) =>
    new FlacEncodeError({
      reason: "wasm-compile",
      phase: "load",
      detail: `could not read encoder Wasm asset at ${FLAC_ENCODER_WASM_URL.href}`,
      cause,
    }),
}).pipe(Effect.flatMap(loadFlacEncoderFromBytes));

/** Node/Bun Layer that loads the packaged encoder Wasm asset once. */
export const FlacEncoderLive: Layer.Layer<FlacEncoder, FlacEncodeError> =
  Layer.effect(FlacEncoder, loadFlacEncoder);

/** Load, compile, and validate the package decoder asset using Node/Bun file I/O. */
export const loadFlacDecoder = Effect.tryPromise({
  try: (signal) => readFile(FLAC_DECODER_WASM_URL, { signal }),
  catch: (cause) =>
    new FlacDecodeError({
      reason: "wasm-compile",
      phase: "load",
      detail: `could not read decoder Wasm asset at ${FLAC_DECODER_WASM_URL.href}`,
      cause,
    }),
}).pipe(Effect.flatMap(loadFlacDecoderFromBytes));

/** Node/Bun Layer that loads the packaged decoder Wasm asset once. */
export const FlacDecoderLive: Layer.Layer<FlacDecoder, FlacDecodeError> =
  Layer.effect(FlacDecoder, loadFlacDecoder);
