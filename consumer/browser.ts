import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeFlacEncoderLayer,
  makeFlacDecoderLayer,
  FLAC_ENCODER_WASM_URL,
  FLAC_DECODER_WASM_URL,
} from "@misofm/codec";
import { scenarios } from "./scenarios.js";

try {
  const [encoder, decoder] = await Promise.all(
    [FLAC_ENCODER_WASM_URL, FLAC_DECODER_WASM_URL].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Wasm fetch failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  const layer = Layer.merge(
    makeFlacEncoderLayer(encoder!),
    makeFlacDecoderLayer(decoder!),
  );
  const result = await Effect.runPromise(scenarios.pipe(Effect.provide(layer)));
  postMessage(result);
} catch (error) {
  postMessage({ error: error instanceof Error ? error.stack : String(error) });
}
