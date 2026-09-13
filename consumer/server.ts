import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FlacEncoderLive, FlacDecoderLive } from "@misofm/codec/node";
import { scenarios } from "./scenarios.js";

const result = await Effect.runPromise(
  scenarios.pipe(Effect.provide(Layer.merge(FlacEncoderLive, FlacDecoderLive))),
);
console.log(
  JSON.stringify({
    runtime: process.versions.bun
      ? `Bun ${process.versions.bun}`
      : `Node ${process.version}`,
    ...result,
  }),
);
