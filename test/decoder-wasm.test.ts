import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import * as Effect from "effect/Effect";

import {
  FLAC_DECODER_LIMITS,
  FLAC_DECODER_WASM_SHA256,
  loadFlacDecoderFromBytes,
} from "../src/decoder-wasm.js";

test("loads only the pinned bounded decoder module", async () => {
  const bytes = new Uint8Array(
    await readFile(new URL("../wasm/flac-decoder.wasm", import.meta.url)),
  );
  const service = await Effect.runPromise(loadFlacDecoderFromBytes(bytes));
  expect(WebAssembly.Module.imports(service.module)).toEqual([
    { module: "codec", name: "read", kind: "function" },
  ]);
  expect(bytes.byteLength).toBeLessThanOrEqual(
    FLAC_DECODER_LIMITS.maxAssetBytes,
  );
  expect(FLAC_DECODER_WASM_SHA256).toHaveLength(64);
});

test("rejects modified and oversized decoder assets before instantiation", async () => {
  const bytes = new Uint8Array(
    await readFile(new URL("../wasm/flac-decoder.wasm", import.meta.url)),
  );
  bytes[bytes.byteLength - 1]! ^= 1;
  const modified = await Effect.runPromise(
    Effect.flip(loadFlacDecoderFromBytes(bytes)),
  );
  expect(modified).toMatchObject({
    _tag: "FlacDecodeError",
    reason: "wasm-compile",
    phase: "load",
  });

  const oversized = new Uint8Array(FLAC_DECODER_LIMITS.maxAssetBytes + 1);
  const tooLarge = await Effect.runPromise(
    Effect.flip(loadFlacDecoderFromBytes(oversized)),
  );
  expect(tooLarge).toMatchObject({
    _tag: "FlacDecodeError",
    reason: "wasm-compile",
    phase: "load",
  });
});
