import { expect, test } from "bun:test";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  encodeFlac,
  FlacEncodeError,
  FlacEncoder,
  PcmFormat,
  PcmInputError,
  type FlacEncodeResult,
  type RandomAccessByteSink,
} from "../src/index.js";

class SourceError extends Data.TaggedError("SourceError") {}
class SinkError extends Data.TaggedError("SinkError") {}
class SourceRequirement extends Context.Service<
  SourceRequirement,
  { readonly pcm: Int32Array }
>()("test/SourceRequirement") {}
class SinkRequirement extends Context.Service<
  SinkRequirement,
  { readonly write: true }
>()("test/SinkRequirement") {}

const source = Stream.concat(
  Stream.fromEffect(SourceRequirement.pipe(Effect.map(({ pcm }) => pcm))),
  Stream.fail(new SourceError()),
);
const sink: RandomAccessByteSink<SinkError, SinkRequirement> = {
  writeAt: () =>
    SinkRequirement.pipe(Effect.flatMap(() => Effect.fail(new SinkError()))),
  resize: () =>
    SinkRequirement.pipe(Effect.flatMap(() => Effect.fail(new SinkError()))),
};
const operation = encodeFlac(source, sink, {
  format: new PcmFormat({ sampleRate: 44_100, channels: 2, bitsPerSample: 24 }),
});

type Success<T> =
  T extends Effect.Effect<infer A, unknown, unknown> ? A : never;
type Failure<T> =
  T extends Effect.Effect<unknown, infer E, unknown> ? E : never;
type Requirements<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type Assert<T extends true> = T;

type _Success = Assert<Equal<Success<typeof operation>, FlacEncodeResult>>;
type _Failure = Assert<
  Equal<
    Failure<typeof operation>,
    SourceError | SinkError | PcmInputError | FlacEncodeError
  >
>;
type _Requirements = Assert<
  Equal<
    Requirements<typeof operation>,
    SourceRequirement | SinkRequirement | FlacEncoder
  >
>;

if (false) {
  // @ts-expect-error channel count is constrained by the PcmFormat Schema
  new PcmFormat({ sampleRate: 44_100, channels: 3, bitsPerSample: 24 });

  // @ts-expect-error PCM input must use signed Int32Array blocks
  encodeFlac(Stream.make(new Uint16Array()), sink, {
    format: new PcmFormat({
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 16,
    }),
  });

  // @ts-expect-error a random-access sink must implement final resize
  const incompleteSink: RandomAccessByteSink<never, never> = {
    writeAt: () => Effect.void,
  };
  void incompleteSink;
}

test("public encoder types retain caller failures and requirements", () => {
  expect(operation).toBeDefined();
});
