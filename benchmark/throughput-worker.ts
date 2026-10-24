import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  FLAC_DECODER_WASM_URL,
  FLAC_ENCODER_WASM_URL,
  makeFlacDecoderLayer,
  makeFlacEncoderLayer,
} from "../src/index.js";
import { runThroughput, type SchedulerKind } from "./throughput.js";

const fetchBytes = (url: URL) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Wasm fetch failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  });

onmessage = ({
  data,
}: MessageEvent<{ kinds: Array<SchedulerKind>; rounds: number }>) => {
  const program = Effect.gen(function* () {
    const [encoder, decoder] = yield* Effect.all([
      fetchBytes(FLAC_ENCODER_WASM_URL),
      fetchBytes(FLAC_DECODER_WASM_URL),
    ]);
    const layer = Layer.merge(
      makeFlacEncoderLayer(encoder),
      makeFlacDecoderLayer(decoder),
    );
    const receipts = [];
    for (const kind of data.kinds)
      for (let round = 0; round < data.rounds; round++)
        receipts.push(yield* runThroughput(kind).pipe(Effect.provide(layer)));
    return receipts;
  });
  Effect.runPromise(program).then(
    (receipts) => postMessage({ receipts }),
    (error: unknown) =>
      postMessage({
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      }),
  );
};
