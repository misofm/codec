import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  encodeFlac,
  FlacEncodeError,
  FLAC_ENCODER_LIMITS,
  makeFlacEncoderLayer,
  PcmFormat,
  PcmInputError,
  type FlacEncodeOptions,
  type RandomAccessByteSink,
} from "../src/index.js";
import { FlacEncoderLive } from "../src/node.js";

class MemorySink<E = never, R = never> implements RandomAccessByteSink<E, R> {
  bytes = new Uint8Array();
  readonly writes: Array<{
    readonly offset: bigint;
    readonly bytes: Uint8Array;
  }> = [];
  resizeCalls = 0;

  readonly writeAt = (
    offset: bigint,
    bytes: Uint8Array,
  ): Effect.Effect<void, E, R> =>
    Effect.sync(() => {
      this.writes.push({ offset, bytes: Uint8Array.from(bytes) });
      const end = Number(offset) + bytes.length;
      if (end > this.bytes.length) {
        const grown = new Uint8Array(end);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      this.bytes.set(bytes, Number(offset));
    }) as Effect.Effect<void, E, R>;

  readonly resize = (length: bigint): Effect.Effect<void, E, R> =>
    Effect.sync(() => {
      this.resizeCalls += 1;
      this.bytes = this.bytes.slice(0, Number(length));
    }) as Effect.Effect<void, E, R>;
}

const pcmBytes = (pcm: Int32Array, bitsPerSample: 16 | 24): Uint8Array => {
  const bytesPerSample = bitsPerSample / 8;
  const bytes = new Uint8Array(pcm.length * bytesPerSample);
  for (let index = 0; index < pcm.length; index++) {
    const value = pcm[index]! >>> 0;
    for (let byte = 0; byte < bytesPerSample; byte++) {
      bytes[index * bytesPerSample + byte] = (value >>> (byte * 8)) & 0xff;
    }
  }
  return bytes;
};

const md5 = (bytes: Uint8Array): string =>
  createHash("md5").update(bytes).digest("hex");

const format16 = new PcmFormat({
  sampleRate: 44_100,
  channels: 2,
  bitsPerSample: 16,
});
const format24 = new PcmFormat({
  sampleRate: 192_000,
  channels: 1,
  bitsPerSample: 24,
});

const run = <A, E>(
  effect: Effect.Effect<A, E, import("../src/index.js").FlacEncoder>,
) => Effect.runPromise(effect.pipe(Effect.provide(FlacEncoderLive)));

const deterministicPcm = (samples: number, bits: 16 | 24): Int32Array => {
  const result = new Int32Array(samples);
  let state = 0x12345678;
  const shift = 32 - bits;
  for (let index = 0; index < samples; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    result[index] = state >> shift;
  }
  return result;
};

describe("encodeFlac", () => {
  test("encodes finalized PCM16 STREAMINFO and canonical MD5", async () => {
    const pcm = deterministicPcm(2 * 4_096, 16);
    const sink = new MemorySink();
    const result = await run(
      encodeFlac(Stream.make(pcm), sink, {
        format: format16,
        expectedFrames: 4_096n,
      }),
    );

    expect(new TextDecoder().decode(sink.bytes.subarray(0, 4))).toBe("fLaC");
    expect(result.frames).toBe(4_096n);
    expect(result.bytes).toBe(BigInt(sink.bytes.length));
    expect(result.streamInfo.totalFrames).toBe(4_096n);
    expect(result.streamInfo.md5Hex).toBe(md5(pcmBytes(pcm, 16)));
    expect(result.streamInfo.minimumBlockFrames).toBe(4_096);
    expect(result.streamInfo.maximumBlockFrames).toBe(4_096);
    expect(sink.resizeCalls).toBe(1);
    expect(sink.writes.some((write) => write.offset === 4n)).toBe(true);
  });

  test("encodes PCM24 extrema and a partial final block", async () => {
    const random = deterministicPcm(4_097, 24);
    random[0] = -8_388_608;
    random[1] = 8_388_607;
    const sink = new MemorySink();
    const result = await run(
      encodeFlac(
        Stream.make(random.subarray(0, 4_096), random.subarray(4_096)),
        sink,
        { format: format24, expectedFrames: 4_097n },
      ),
    );

    expect(result.frames).toBe(4_097n);
    expect(result.streamInfo.md5Hex).toBe(md5(pcmBytes(random, 24)));
    expect(result.streamInfo.minimumBlockFrames).toBe(4_096);
    expect(result.streamInfo.maximumBlockFrames).toBe(4_096);
    expect(sink.resizeCalls).toBe(1);
  });

  test("defines an empty source as a valid zero-frame FLAC", async () => {
    const sink = new MemorySink();
    const result = await run(
      encodeFlac(Stream.empty, sink, {
        format: format16,
        expectedFrames: 0n,
      }),
    );

    expect(result.frames).toBe(0n);
    expect(result.streamInfo.totalFrames).toBe(0n);
    expect(result.streamInfo.md5Hex).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(sink.resizeCalls).toBe(1);
  });

  test("rejects oversized and out-of-depth blocks before processing them", async () => {
    const cases = [
      {
        pcm: new Int32Array((FLAC_ENCODER_LIMITS.maxInputBlockFrames + 1) * 2),
        reason: "block-too-large",
      },
      { pcm: Int32Array.of(0, 32_768), reason: "sample-out-of-range" },
      { pcm: Int32Array.of(0), reason: "misaligned-block" },
      { pcm: new Int32Array(), reason: "empty-block" },
    ] as const;

    for (const fixture of cases) {
      const sink = new MemorySink();
      const error = await run(
        Effect.flip(
          encodeFlac(Stream.make(fixture.pcm), sink, {
            format: format16,
          }),
        ),
      );
      expect(error).toBeInstanceOf(PcmInputError);
      expect((error as PcmInputError).reason).toBe(fixture.reason);
      expect(sink.resizeCalls).toBe(0);
      expect(sink.writes.filter((write) => write.offset === 4n)).toHaveLength(
        1,
      );
    }
  });

  test("lazily rejects malformed runtime options with a typed error", async () => {
    const malformed = [
      null,
      { format: null },
      { format: format16, expectedFrames: 1 },
      { format: format16, expectedFrames: Number.NaN },
      { format: format16, expectedFrames: "1" },
    ] as const;

    for (const options of malformed) {
      const make = () =>
        encodeFlac(
          Stream.empty,
          new MemorySink(),
          options as unknown as FlacEncodeOptions,
        );
      expect(make).not.toThrow();
      const exit = await Effect.runPromiseExit(
        make().pipe(Effect.provide(FlacEncoderLive)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(PcmInputError);
      }
    }
  });

  test("stops before processing a block that overshoots expectedFrames", async () => {
    let pulled = 0;
    const source = Stream.fromIterable([
      Int32Array.of(1, 2, 3, 4),
      Int32Array.of(5, 6),
      Int32Array.of(7, 8),
    ]).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          pulled += 1;
        }),
      ),
    );
    const sink = new MemorySink();
    const error = await run(
      Effect.flip(
        encodeFlac(source, sink, {
          format: format16,
          expectedFrames: 2n,
        }),
      ),
    );

    expect(error).toBeInstanceOf(PcmInputError);
    expect((error as PcmInputError).reason).toBe("frame-count-mismatch");
    expect(pulled).toBe(2);
    expect(sink.resizeCalls).toBe(0);
    expect(sink.writes.filter((write) => write.offset === 4n)).toHaveLength(1);
  });

  test("preserves source and sink failures by identity", async () => {
    const sourceFailure = { _tag: "SourceFailure" as const };
    const sinkFailure = { _tag: "SinkFailure" as const };

    const sourceError = await run(
      Effect.flip(
        encodeFlac(Stream.fail(sourceFailure), new MemorySink(), {
          format: format16,
        }),
      ),
    );
    expect(sourceError).toBe(sourceFailure);

    const failingSink: RandomAccessByteSink<typeof sinkFailure, never> = {
      writeAt: () => Effect.fail(sinkFailure),
      resize: () => Effect.void,
    };
    const sinkError = await run(
      Effect.flip(
        encodeFlac(Stream.empty, failingSink, {
          format: format16,
        }),
      ),
    );
    expect(sinkError).toBe(sinkFailure);
  });

  test("awaits sink backpressure before pulling PCM", async () => {
    let release!: () => void;
    let reportBlocked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      reportBlocked = resolve;
    });
    let first = true;
    let pulled = 0;
    const memory = new MemorySink();
    const sink: RandomAccessByteSink<never, never> = {
      writeAt: (offset, bytes) => {
        if (first) {
          first = false;
          reportBlocked();
          return Effect.promise(() => gate).pipe(
            Effect.andThen(memory.writeAt(offset, bytes)),
          );
        }
        return memory.writeAt(offset, bytes);
      },
      resize: memory.resize,
    };
    const source = Stream.fromEffect(
      Effect.sync(() => {
        pulled += 1;
        return Int32Array.of(0, 0);
      }),
    );

    const running = run(
      encodeFlac(source, sink, { format: format16, expectedFrames: 1n }),
    );
    await blocked;
    expect(pulled).toBe(0);
    release();
    await running;
    expect(pulled).toBe(1);
  });

  test("interruption stops a pending source without final resize or late writes", async () => {
    const sink = new MemorySink();
    const program = encodeFlac(Stream.never, sink, { format: format16 }).pipe(
      Effect.provide(FlacEncoderLive),
    );
    const fiber = Effect.runFork(program);
    await Bun.sleep(10);
    const before = sink.writes.length;
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    await Bun.sleep(10);
    expect(sink.writes.length).toBe(before);
    expect(sink.resizeCalls).toBe(0);
  });

  test("isolates concurrent encoder instances", async () => {
    const a = deterministicPcm(2 * 257, 16);
    const b = deterministicPcm(2 * 4_096, 16);
    b.reverse();
    const sinkA = new MemorySink();
    const sinkB = new MemorySink();
    const [resultA, resultB] = await Promise.all([
      run(
        encodeFlac(Stream.make(a), sinkA, {
          format: format16,
          expectedFrames: 257n,
        }),
      ),
      run(
        encodeFlac(Stream.make(b), sinkB, {
          format: format16,
          expectedFrames: 4_096n,
        }),
      ),
    ]);

    expect(resultA.streamInfo.md5Hex).toBe(md5(pcmBytes(a, 16)));
    expect(resultB.streamInfo.md5Hex).toBe(md5(pcmBytes(b, 16)));
    expect(resultA.streamInfo.md5Hex).not.toBe(resultB.streamInfo.md5Hex);
  });

  test("rejects corrupt or unpinned Wasm bytes through FlacEncodeError", async () => {
    const sink = new MemorySink();
    const exit = await Effect.runPromiseExit(
      encodeFlac(Stream.empty, sink, {
        format: format16,
      }).pipe(
        Effect.provide(makeFlacEncoderLayer(Uint8Array.of(0, 97, 115, 109))),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(FlacEncodeError);
      expect((error as FlacEncodeError).reason).toBe("wasm-compile");
    }
  });
});
