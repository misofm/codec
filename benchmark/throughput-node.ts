import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FlacDecoderLive, FlacEncoderLive } from "../src/node.js";
import { runThroughput, type SchedulerKind } from "./throughput.js";

const kinds = (process.argv[2] ?? "default").split(",") as Array<SchedulerKind>;
const rounds = Number(process.argv[3] ?? "3");

const program = Effect.gen(function* () {
  const receipts = [];
  for (const kind of kinds)
    for (let round = 0; round < rounds; round++)
      receipts.push(yield* runThroughput(kind));
  return receipts;
}).pipe(Effect.provide(Layer.merge(FlacEncoderLive, FlacDecoderLive)));

const receipts = await Effect.runPromise(program);
console.log(
  JSON.stringify({
    runtime: process.versions.bun
      ? `Bun ${process.versions.bun}`
      : `Node ${process.version}`,
    receipts,
  }),
);
// A MessageChannel scheduler port can keep Bun alive after the work finishes.
process.exit(0);
