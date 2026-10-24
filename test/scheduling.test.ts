import { describe, expect, test } from "bun:test";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";

import {
  decodeFlac,
  encodeFlac,
  PcmFormat,
  type RandomAccessByteSink,
} from "../src/index.js";
import { FlacDecoderLive, FlacEncoderLive } from "../src/node.js";

// Browsers dispatch Effect's default scheduler through setTimeout(0), clamped to
// at least 4 ms, so every dispatch during a CPU-bound encode or decode is idle
// time. These tests count dispatches with an in-memory source and sink, where no
// I/O hides them, and catch a per-block yield coming back.

const BLOCK_FRAMES = 4_096;
const BLOCKS = 256;
const format = new PcmFormat({
  sampleRate: 48_000,
  channels: 2,
  bitsPerSample: 16,
});

const countingScheduler = () => {
  const counter = { dispatches: 0 };
  const layer = Layer.succeed(
    Scheduler.Scheduler,
    new Scheduler.MixedScheduler("async", (task) => {
      counter.dispatches += 1;
      const handle = setImmediate(task);
      return () => clearImmediate(handle);
    }),
  );
  return { counter, layer };
};

/** A clock whose monotonic time advances by `stepNanos` on every read. */
const steppingClock = (stepNanos: bigint): Clock.Clock => {
  let now = 0n;
  const monotonic = () => (now += stepNanos);
  return {
    currentTimeMillisUnsafe: () => Number(monotonic() / 1_000_000n),
    currentTimeMillis: Effect.sync(() => Number(monotonic() / 1_000_000n)),
    currentTimeNanosUnsafe: monotonic,
    currentTimeNanos: Effect.sync(monotonic),
    monotonicTimeNanosUnsafe: monotonic,
    monotonicTimeNanos: Effect.sync(monotonic),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const handle = setTimeout(
          () => resume(Effect.void),
          Duration.toMillis(duration),
        );
        return Effect.sync(() => clearTimeout(handle));
      }),
  };
};

const pcmBlock = (() => {
  const block = new Int32Array(BLOCK_FRAMES * format.channels);
  for (let index = 0; index < block.length; index++)
    block[index] = Math.round(8_000 * Math.sin(index / 37));
  return block;
})();

class MemorySink implements RandomAccessByteSink<never, never> {
  bytes = new Uint8Array(1 << 20);
  length = 0;
  readonly writeAt = (offset: bigint, bytes: Uint8Array) =>
    Effect.sync(() => {
      const end = Number(offset) + bytes.length;
      if (end > this.bytes.length) {
        const grown = new Uint8Array(Math.max(end, this.bytes.length * 2));
        grown.set(this.bytes.subarray(0, this.length));
        this.bytes = grown;
      }
      this.bytes.set(bytes, Number(offset));
      if (end > this.length) this.length = end;
    });
  readonly resize = (length: bigint) =>
    Effect.sync(() => {
      this.length = Number(length);
    });
}

const encodeBlocks = (blocks: number) => {
  const sink = new MemorySink();
  return encodeFlac(
    Stream.fromIterable(Array.from({ length: blocks }, () => pcmBlock)),
    sink,
    { format, expectedFrames: BigInt(blocks * BLOCK_FRAMES) },
  ).pipe(Effect.as(sink));
};

describe("cooperative scheduling", () => {
  test("encoding does not dispatch the scheduler once per block", async () => {
    const { counter, layer } = countingScheduler();
    const sink = await Effect.runPromise(
      encodeBlocks(BLOCKS).pipe(
        Effect.provide(layer),
        Effect.provide(FlacEncoderLive),
      ),
    );
    expect(sink.length).toBeGreaterThan(0);
    // The runtime still yields after its operation budget during a long,
    // fully synchronous encode, but far less often than once per block.
    expect(counter.dispatches).toBeGreaterThan(0);
    expect(counter.dispatches).toBeLessThanOrEqual(BLOCKS / 16);
  });

  test("encoding yields at least once per 100 ms time slice", async () => {
    const run = (stepNanos: bigint) => {
      const { counter, layer } = countingScheduler();
      return encodeBlocks(32).pipe(
        Effect.provideService(Clock.Clock, steppingClock(stepNanos)),
        // Isolate the time slice from the runtime's operation budget.
        Effect.provideService(
          Scheduler.MaxOpsBeforeYield,
          Number.MAX_SAFE_INTEGER,
        ),
        Effect.provide(layer),
        Effect.provide(FlacEncoderLive),
        Effect.map(() => counter.dispatches),
      );
    };
    // Every clock read advances 150 ms, so each block crosses a 100 ms slice.
    expect(await Effect.runPromise(run(150_000_000n))).toBe(32);
    // At 60 ms per read, a slice is crossed on every second block.
    expect(await Effect.runPromise(run(60_000_000n))).toBe(16);
    // A clock that never crosses a slice adds no dispatches of its own.
    expect(await Effect.runPromise(run(0n))).toBe(0);
  });

  test("decoding does not dispatch the scheduler once per frame", async () => {
    const sink = await Effect.runPromise(
      encodeBlocks(BLOCKS).pipe(Effect.provide(FlacEncoderLive)),
    );
    const flac = sink.bytes.subarray(0, sink.length);
    const fragments: Array<Uint8Array> = [];
    for (let at = 0; at < flac.length; at += 64 * 1_024)
      fragments.push(flac.subarray(at, at + 64 * 1_024));
    const { counter, layer } = countingScheduler();
    let pcmEvents = 0;
    await Effect.runPromise(
      decodeFlac(Stream.fromIterable(fragments)).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "Pcm") pcmEvents += 1;
          }),
        ),
        Effect.provide(layer),
        Effect.provide(FlacDecoderLive),
      ),
    );
    expect(pcmEvents).toBe(BLOCKS);
    expect(counter.dispatches).toBeLessThanOrEqual(BLOCKS / 4);
  });

  test("a CPU-bound encode of an endless in-memory source stays interruptible", async () => {
    let pulled = 0;
    const endless = Stream.fromIterable({
      *[Symbol.iterator]() {
        for (;;) {
          pulled += 1;
          yield pcmBlock;
        }
      },
    });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          encodeFlac(endless, new MemorySink(), { format }),
        );
        // This timer can only fire once the encoding fiber yields.
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(FlacEncoderLive)),
    );
    expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
    expect(pulled).toBeGreaterThan(0);
  });
});
