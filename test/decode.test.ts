import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  decodeFlac,
  type FlacDecodeEvent,
  type FlacDecodeOptions,
} from "../src/decode.js";
import { FlacDecodeError } from "../src/decoder-errors.js";
import { makeFlacDecoderLayer } from "../src/decoder-wasm.js";
import type { FlacDecoder } from "../src/decoder-wasm.js";
import { encodeFlac, type RandomAccessByteSink } from "../src/encode.js";
import { PcmFormat } from "../src/format.js";
import { makeFlacEncoderLayer } from "../src/wasm.js";
import type { FlacEncoder } from "../src/wasm.js";

interface Fixture {
  readonly encoded: Uint8Array;
  readonly pcm: Int32Array;
  readonly canonical: Uint8Array;
  readonly format: PcmFormat;
  readonly frames: number;
}

let fixture: Fixture;
let run: <A, E>(effect: Effect.Effect<A, E, FlacDecoder>) => Promise<A>;
let runEncoder: <A, E>(effect: Effect.Effect<A, E, FlacEncoder>) => Promise<A>;

const makeFixture = (
  frames: number,
  format = new PcmFormat({
    sampleRate: 44_100,
    channels: 2,
    bitsPerSample: 24,
  }),
): Effect.Effect<Fixture, unknown, import("../src/wasm.js").FlacEncoder> => {
  const pcm = new Int32Array(frames * format.channels);
  const width = format.bitsPerSample / 8;
  const canonical = new Uint8Array(pcm.length * width);
  let state = 0x1234_5678;
  for (let index = 0; index < pcm.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = state >> (32 - format.bitsPerSample);
    pcm[index] = value;
    for (let byte = 0; byte < width; byte++) {
      canonical[index * width + byte] = value >> (byte * 8);
    }
  }
  const storage = new Uint8Array(canonical.byteLength + 128 * 1024);
  let finalLength = 0;
  const sink: RandomAccessByteSink<never, never> = {
    writeAt: (offset, bytes) =>
      Effect.sync(() => storage.set(bytes, Number(offset))),
    resize: (length) =>
      Effect.sync(() => {
        finalLength = Number(length);
      }),
  };
  const blocks: Array<Int32Array> = [];
  for (let frame = 0; frame < frames; frame += 997) {
    blocks.push(
      pcm.slice(
        frame * format.channels,
        Math.min(frame + 997, frames) * format.channels,
      ),
    );
  }
  return encodeFlac(Stream.fromIterable(blocks), sink, {
    format,
    expectedFrames: BigInt(frames),
  }).pipe(
    Effect.map(() => ({
      encoded: storage.slice(0, finalLength),
      pcm,
      canonical,
      format,
      frames,
    })),
  );
};

const fragment = (bytes: Uint8Array): ReadonlyArray<Uint8Array> => {
  const chunks: Array<Uint8Array> = [];
  let cursor = 0;
  let state = 0x5eed_1234;
  while (cursor < bytes.byteLength) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const length = cursor < 42 ? 1 : 1 + ((state >>> 0) % 509);
    chunks.push(
      bytes.slice(cursor, Math.min(cursor + length, bytes.byteLength)),
    );
    cursor += length;
  }
  return chunks;
};

const optionalMetadataEnd = (encoded: Uint8Array): number =>
  46 +
  ((encoded[43] ?? 0) << 16) +
  ((encoded[44] ?? 0) << 8) +
  (encoded[45] ?? 0);

const replaceOptionalMetadata = (
  encoded: Uint8Array,
  type: number,
  payload: Uint8Array,
): Uint8Array => {
  const audio = encoded.subarray(optionalMetadataEnd(encoded));
  const result = new Uint8Array(42 + 4 + payload.byteLength + audio.byteLength);
  result.set(encoded.subarray(0, 42));
  result[42] = 0x80 | type;
  result[43] = payload.byteLength >>> 16;
  result[44] = payload.byteLength >>> 8;
  result[45] = payload.byteLength;
  result.set(payload, 46);
  result.set(audio, 46 + payload.byteLength);
  return result;
};

const duplicateOptionalMetadata = (encoded: Uint8Array): Uint8Array => {
  const end = optionalMetadataEnd(encoded);
  const block = encoded.slice(42, end);
  block[0]! &= 0x7f;
  const result = new Uint8Array(encoded.byteLength + block.byteLength);
  result.set(encoded.subarray(0, 42));
  result.set(block, 42);
  result.set(encoded.subarray(42), 42 + block.byteLength);
  return result;
};

const duplicateStreamInfo = (encoded: Uint8Array): Uint8Array => {
  const block = encoded.slice(4, 42);
  const result = new Uint8Array(encoded.byteLength + block.byteLength);
  result.set(encoded.subarray(0, 42));
  result.set(block, 42);
  result.set(encoded.subarray(42), 42 + block.byteLength);
  return result;
};

const optionalBeforeStreamInfo = (encoded: Uint8Array): Uint8Array => {
  const application = Uint8Array.of(2, 0, 0, 4, 0x54, 0x45, 0x53, 0x54);
  const streamInfo = encoded.slice(4, 42);
  streamInfo[0]! |= 0x80;
  const audio = encoded.subarray(optionalMetadataEnd(encoded));
  const result = new Uint8Array(
    4 + application.byteLength + streamInfo.byteLength + audio.byteLength,
  );
  result.set(encoded.subarray(0, 4));
  result.set(application, 4);
  result.set(streamInfo, 4 + application.byteLength);
  result.set(audio, 4 + application.byteLength + streamInfo.byteLength);
  return result;
};

const collectPcm = (events: ReadonlyArray<FlacDecodeEvent>): Uint8Array => {
  const length = events.reduce(
    (sum, event) => sum + (event._tag === "Pcm" ? event.bytes.byteLength : 0),
    0,
  );
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const event of events) {
    if (event._tag !== "Pcm") continue;
    bytes.set(event.bytes, offset);
    offset += event.bytes.byteLength;
  }
  return bytes;
};

const decodeExit = (chunks: ReadonlyArray<Uint8Array>) =>
  run(Effect.exit(Stream.runCollect(decodeFlac(Stream.fromIterable(chunks)))));

beforeAll(async () => {
  const [encoderBytes, decoderBytes] = await Promise.all([
    readFile(new URL("../wasm/flac-encoder.wasm", import.meta.url)),
    readFile(new URL("../wasm/flac-decoder.wasm", import.meta.url)),
  ]);
  const encoderLayer = makeFlacEncoderLayer(encoderBytes);
  const decoderLayer = makeFlacDecoderLayer(decoderBytes);
  run = <A, E>(effect: Effect.Effect<A, E, FlacDecoder>) =>
    Effect.runPromise(effect.pipe(Effect.provide(decoderLayer)));
  runEncoder = <A, E>(effect: Effect.Effect<A, E, FlacEncoder>) =>
    Effect.runPromise(effect.pipe(Effect.provide(encoderLayer)));
  fixture = await runEncoder(makeFixture(8_193));
});

describe("decodeFlac", () => {
  test("accepts the supported 8 kHz and 192 kHz format boundaries", async () => {
    const formats = [
      new PcmFormat({
        sampleRate: 8_000,
        channels: 1,
        bitsPerSample: 16,
      }),
      new PcmFormat({
        sampleRate: 192_000,
        channels: 2,
        bitsPerSample: 24,
      }),
    ];
    for (const format of formats) {
      const boundary = await runEncoder(makeFixture(257, format));
      const events = await run(
        Stream.runCollect(
          decodeFlac(Stream.make(boundary.encoded), {
            expectedFormat: format,
            expectedFrames: 257n,
          }),
        ),
      );
      expect(events[0]).toMatchObject({ _tag: "Metadata", format });
      expect(collectPcm(events)).toEqual(boundary.canonical);
      expect(events.at(-1)).toMatchObject({ _tag: "Complete", frames: 257n });
    }
  });

  test("decodes byte-fragmented input into bounded canonical PCM and verified completion", async () => {
    const events = await run(
      Stream.runCollect(
        decodeFlac(Stream.fromIterable(fragment(fixture.encoded)), {
          expectedFormat: fixture.format,
          expectedFrames: BigInt(fixture.frames),
        }),
      ),
    );
    expect(events[0]?._tag).toBe("Metadata");
    expect(events.at(-1)).toMatchObject({
      _tag: "Complete",
      frames: BigInt(fixture.frames),
      bytes: BigInt(fixture.canonical.byteLength),
      md5Checked: true,
      md5Verified: true,
    });
    let expectedOffset = 0n;
    for (const event of events) {
      if (event._tag !== "Pcm") continue;
      expect(event.frameOffset).toBe(expectedOffset);
      expect(event.bytes.byteLength).toBeLessThanOrEqual(384 * 1024);
      expectedOffset += BigInt(event.frames);
    }
    expect(collectPcm(events)).toEqual(fixture.canonical);
  });

  test("runs independent repeat and concurrent subscriptions", async () => {
    const source = Stream.fromIterable(fragment(fixture.encoded));
    const results = await run(
      Effect.all(
        [
          Stream.runCollect(decodeFlac(source)),
          Stream.runCollect(decodeFlac(source)),
          Stream.runCollect(decodeFlac(source)),
        ],
        { concurrency: 3 },
      ),
    );
    for (const events of results) {
      expect(collectPcm(events)).toEqual(fixture.canonical);
      expect(events.at(-1)?._tag).toBe("Complete");
    }
  });

  test("accepts an absent STREAMINFO MD5 without claiming verification", async () => {
    const encoded = Uint8Array.from(fixture.encoded);
    encoded.fill(0, 26, 42);
    const events = await run(
      Stream.runCollect(decodeFlac(Stream.make(encoded))),
    );
    expect(events[0]).toMatchObject({ _tag: "Metadata", md5Present: false });
    expect(events.at(-1)).toMatchObject({
      _tag: "Complete",
      md5Checked: false,
      md5Verified: false,
    });
    expect(collectPcm(events)).toEqual(fixture.canonical);
  });

  test("accepts validated padding and application metadata without retaining it", async () => {
    const cases = [
      replaceOptionalMetadata(fixture.encoded, 1, new Uint8Array()),
      replaceOptionalMetadata(
        fixture.encoded,
        2,
        Uint8Array.of(0x54, 0x45, 0x53, 0x54),
      ),
    ];
    for (const encoded of cases) {
      const events = await run(
        Stream.runCollect(decodeFlac(Stream.make(encoded))),
      );
      expect(collectPcm(events)).toEqual(fixture.canonical);
      expect(events.at(-1)?._tag).toBe("Complete");
    }
  });

  test("rejects malformed, reserved, duplicate, and misordered metadata", async () => {
    const cases = [
      replaceOptionalMetadata(fixture.encoded, 4, new Uint8Array()),
      replaceOptionalMetadata(fixture.encoded, 5, new Uint8Array()),
      replaceOptionalMetadata(fixture.encoded, 6, new Uint8Array()),
      replaceOptionalMetadata(fixture.encoded, 127, new Uint8Array()),
      duplicateOptionalMetadata(fixture.encoded),
      duplicateStreamInfo(fixture.encoded),
      optionalBeforeStreamInfo(fixture.encoded),
    ];
    for (const encoded of cases) {
      const exit = await decodeExit(fragment(encoded));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "FlacDecodeError",
          reason: "invalid-metadata",
        });
      }
    }
  });

  test("reports fixed-memory refusal for oversized retained metadata", async () => {
    const payload = new Uint8Array(1_900_000);
    payload.set([0x54, 0x45, 0x53, 0x54]);
    const encoded = replaceOptionalMetadata(fixture.encoded, 2, payload);
    const chunks: Array<Uint8Array> = [];
    for (let offset = 0; offset < encoded.byteLength; offset += 128 * 1024) {
      chunks.push(encoded.subarray(offset, offset + 128 * 1024));
    }
    const exit = await run(
      Effect.exit(
        Stream.runDrain(
          decodeFlac(Stream.fromIterable(chunks), {
            maxMetadataBytes: 2 * 1024 * 1024,
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "FlacDecodeError",
        reason: "allocation-failed",
      });
    }
  });

  test("reports MD5 and frame CRC corruption as distinct typed failures", async () => {
    const badMd5 = Uint8Array.from(fixture.encoded);
    badMd5[26]! ^= 1;
    const md5Exit = await decodeExit([badMd5]);
    expect(Exit.isFailure(md5Exit)).toBe(true);
    if (Exit.isFailure(md5Exit)) {
      expect(Cause.squash(md5Exit.cause)).toMatchObject({
        _tag: "FlacDecodeError",
        reason: "md5-mismatch",
      });
    }

    const badCrc = Uint8Array.from(fixture.encoded);
    badCrc[badCrc.byteLength - 1]! ^= 1;
    const crcExit = await decodeExit([badCrc]);
    expect(Exit.isFailure(crcExit)).toBe(true);
    if (Exit.isFailure(crcExit)) {
      expect(Cause.squash(crcExit.cause)).toMatchObject({
        _tag: "FlacDecodeError",
        reason: "crc-mismatch",
      });
    }
  });

  test("rejects truncation, buffered and delayed trailing bytes, and concatenated streams", async () => {
    const trailing = Uint8Array.from([...fixture.encoded, 0, 1, 2, 3]);
    const cases: ReadonlyArray<ReadonlyArray<Uint8Array>> = [
      [fixture.encoded.slice(0, -1)],
      [trailing],
      [fixture.encoded, Uint8Array.of(0, 1, 2, 3)],
      [fixture.encoded, fixture.encoded],
    ];
    for (const chunks of cases) {
      const exit = await decodeExit(chunks);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toBeInstanceOf(FlacDecodeError);
    }
  });

  test("fails mismatched expected metadata and explicit input/metadata bounds", async () => {
    const mismatch = await run(
      Effect.exit(
        Stream.runDrain(
          decodeFlac(Stream.make(fixture.encoded), {
            expectedFrames: BigInt(fixture.frames + 1),
          }),
        ),
      ),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    if (Exit.isFailure(mismatch)) {
      expect(Cause.squash(mismatch.cause)).toMatchObject({
        reason: "expected-metadata-mismatch",
      });
    }

    const oversized = await decodeExit([new Uint8Array(256 * 1024 + 1)]);
    expect(Exit.isFailure(oversized)).toBe(true);
    if (Exit.isFailure(oversized)) {
      expect(Cause.squash(oversized.cause)).toMatchObject({
        reason: "input-chunk-too-large",
      });
    }

    const extendedMetadata = new Uint8Array(fixture.encoded.byteLength + 104);
    extendedMetadata.set(fixture.encoded.subarray(0, 42));
    extendedMetadata[4]! &= 0x7f;
    extendedMetadata.set([0x81, 0, 0, 100], 42);
    extendedMetadata.set(fixture.encoded.subarray(42), 146);
    const metadataLimit = await run(
      Effect.exit(
        Stream.runDrain(
          decodeFlac(Stream.make(extendedMetadata), { maxMetadataBytes: 80 }),
        ),
      ),
    );
    expect(Exit.isFailure(metadataLimit)).toBe(true);
    if (Exit.isFailure(metadataLimit)) {
      expect(Cause.squash(metadataLimit.cause)).toMatchObject({
        reason: "metadata-limit",
      });
    }
  });

  test("lazily rejects malformed runtime options with a typed error", async () => {
    const malformed = [
      null,
      { expectedFormat: null },
      { expectedFrames: 1 },
      { expectedFrames: 1.5 },
      { expectedFrames: Number.NaN },
      { expectedFrames: "1" },
    ] as const;

    for (const options of malformed) {
      const make = () =>
        decodeFlac(Stream.empty, options as unknown as FlacDecodeOptions);
      expect(make).not.toThrow();
      const exit = await run(Effect.exit(Stream.runDrain(make())));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "FlacDecodeError",
          reason: "invalid-options",
        });
      }
    }
  });

  test("preserves interruption while awaiting input and releases the source once", async () => {
    const result = await run(
      Effect.gen(function* () {
        let finalized = 0;
        let complete = false;
        const waiting = yield* Deferred.make<void>();
        const source = Stream.concat(
          Stream.make(fixture.encoded.slice(0, 42)),
          Stream.fromEffect(
            Effect.andThen(Deferred.succeed(waiting, undefined), Effect.never),
          ),
        ).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              finalized += 1;
            }),
          ),
        );
        const fiber = yield* Effect.forkChild(
          decodeFlac(source).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event._tag === "Complete") complete = true;
              }),
            ),
            Stream.runDrain,
          ),
        );
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        return { exit, finalized, complete };
      }),
    );
    expect(
      Exit.isFailure(result.exit) && Cause.hasInterrupts(result.exit.cause),
    ).toBe(true);
    expect(result.finalized).toBe(1);
    expect(result.complete).toBe(false);
  });

  test("early take closes the decoder and never emits Complete", async () => {
    let finalized = 0;
    const events = await run(
      decodeFlac(
        Stream.fromIterable(fragment(fixture.encoded)).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              finalized += 1;
            }),
          ),
        ),
      ).pipe(Stream.take(1), Stream.runCollect),
    );
    expect(events.map((event) => event._tag)).toEqual(["Metadata"]);
    expect(finalized).toBe(1);
  });

  test("does not pull the whole encoded source while downstream is stalled", async () => {
    const fragments = fragment(fixture.encoded);
    let pulled = 0;
    const source = Stream.unfold(0, (index) =>
      Effect.succeed(
        index < fragments.length
          ? ([fragments[index]!, index + 1] as const)
          : undefined,
      ),
    ).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          pulled += 1;
        }),
      ),
    );
    const events = await run(
      decodeFlac(source).pipe(Stream.take(2), Stream.runCollect),
    );
    expect(events.map((event) => event._tag)).toEqual(["Metadata", "Pcm"]);
    expect(pulled).toBeGreaterThan(0);
    expect(pulled).toBeLessThan(fragments.length);
  });
});
