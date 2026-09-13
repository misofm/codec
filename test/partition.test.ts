import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  decodeFlac,
  encodeFlac,
  PcmFormat,
  type RandomAccessByteSink,
} from "../src/index.js";
import { FlacDecoderLive, FlacEncoderLive } from "../src/node.js";

const format = new PcmFormat({
  sampleRate: 44_100,
  channels: 2,
  bitsPerSample: 24,
});

// Small deterministic fixtures may be collected in tests; the codec itself streams.
const encode = (
  blocks: ReadonlyArray<Int32Array>,
  frames: number,
  pcmFormat = format,
) => {
  let output = new Uint8Array();
  const sink: RandomAccessByteSink<never, never> = {
    writeAt: (offset, bytes) =>
      Effect.sync(() => {
        const end = Number(offset) + bytes.byteLength;
        if (end > output.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(output);
          output = grown;
        }
        output.set(bytes, Number(offset));
      }),
    resize: (size) =>
      Effect.sync(() => {
        output = output.slice(0, Number(size));
      }),
  };
  return encodeFlac(Stream.fromIterable(blocks), sink, {
    format: pcmFormat,
    expectedFrames: BigInt(frames),
  }).pipe(Effect.map((result) => ({ output, result })));
};

const canonical = (pcm: Int32Array, bits: 16 | 24 = 24) => {
  const width = bits / 8;
  const output = new Uint8Array(pcm.length * width);
  for (let index = 0; index < pcm.length; index++) {
    const value = pcm[index]!;
    for (let byte = 0; byte < width; byte++)
      output[index * width + byte] = (value >>> (byte * 8)) & 255;
  }
  return output;
};

test("silence, impulse, extrema, random, partial and empty vectors round-trip in every PCM shape", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const channels of [1, 2] as const) {
        for (const bitsPerSample of [16, 24] as const) {
          const pcmFormat = new PcmFormat({
            sampleRate: 44_100,
            channels,
            bitsPerSample,
          });
          const frames = 8193;
          const pcm = new Int32Array(frames * channels);
          const maximum = 2 ** (bitsPerSample - 1) - 1;
          let state = 0x13579bdf;
          // One constant-silence frame, a sparse impulse frame, and a partial tail.
          for (let channel = 0; channel < channels; channel++) {
            pcm[(4096 + channel * 17) * channels + channel] = maximum;
            pcm[(4097 + channel * 17) * channels + channel] = -maximum - 1;
          }
          for (let index = 8176 * channels; index < pcm.length; index++) {
            state = (Math.imul(state, 1664525) + 1013904223) | 0;
            pcm[index] = state >> (32 - bitsPerSample);
          }
          const { output } = yield* encode(
            [
              pcm.subarray(0, 4096 * channels),
              pcm.subarray(4096 * channels, 8192 * channels),
              pcm.subarray(8192 * channels),
            ],
            frames,
            pcmFormat,
          );
          const events = yield* decodeFlac(Stream.make(output), {
            expectedFormat: pcmFormat,
            expectedFrames: BigInt(frames),
          }).pipe(Stream.runCollect);
          const actual = Uint8Array.from(
            events.flatMap((event) =>
              event._tag === "Pcm" ? Array.from(event.bytes) : [],
            ),
          );
          expect(actual).toEqual(canonical(pcm, bitsPerSample));
          expect(events.at(-1)).toMatchObject({
            _tag: "Complete",
            frames: BigInt(frames),
            md5Checked: true,
            md5Verified: true,
          });

          const empty = yield* encode([], 0, pcmFormat);
          const emptyEvents = yield* decodeFlac(Stream.make(empty.output), {
            expectedFormat: pcmFormat,
            expectedFrames: 0n,
          }).pipe(Stream.runCollect);
          expect(emptyEvents.map((event) => event._tag)).toEqual([
            "Metadata",
            "Complete",
          ]);
          expect(emptyEvents.at(-1)).toMatchObject({
            _tag: "Complete",
            frames: 0n,
            bytes: 0n,
            md5Checked: true,
            md5Verified: true,
          });
        }
      }
    }).pipe(Effect.provide(FlacEncoderLive), Effect.provide(FlacDecoderLive)),
  );
});

test("every legal two-part PCM boundary produces the same finalized FLAC", async () => {
  const pcm = Int32Array.from({ length: 34 }, (_, index) =>
    index % 2 === 0 ? index * 71_321 - 1_000_000 : 8_388_607 - index * 213_877,
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const reference = yield* encode([pcm], 17);
      for (let boundary = 1; boundary < 17; boundary++) {
        const actual = yield* encode(
          [pcm.subarray(0, boundary * 2), pcm.subarray(boundary * 2)],
          17,
        );
        expect(actual.output).toEqual(reference.output);
        expect(actual.result).toEqual(reference.result);
      }
    }).pipe(Effect.provide(FlacEncoderLive)),
  );
});

test("every encoded byte boundary preserves metadata, exact PCM, and completion", async () => {
  const pcm = Int32Array.from({ length: 34 }, (_, index) =>
    index % 3 === 0
      ? -8_388_608
      : index % 3 === 1
        ? 8_388_607
        : index * 471_239 - 8_000_000,
  );
  const expected = canonical(pcm);
  await Effect.runPromise(
    Effect.gen(function* () {
      const { output } = yield* encode([pcm], 17);
      const decode = (parts: ReadonlyArray<Uint8Array>) =>
        decodeFlac(Stream.fromIterable(parts), {
          expectedFormat: format,
          expectedFrames: 17n,
        }).pipe(Stream.runCollect);
      const reference = yield* decode([output]);
      expect(reference.map((event) => event._tag)).toEqual([
        "Metadata",
        "Pcm",
        "Complete",
      ]);
      const event = reference[1]!;
      expect(event._tag).toBe("Pcm");
      if (event._tag === "Pcm") expect(event.bytes).toEqual(expected);
      for (let boundary = 1; boundary < output.byteLength; boundary++) {
        const actual = yield* decode([
          output.subarray(0, boundary),
          output.subarray(boundary),
        ]);
        expect(actual).toEqual(reference);
      }
    }).pipe(Effect.provide(FlacEncoderLive), Effect.provide(FlacDecoderLive)),
  );
});
