import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";

import {
  decodeFlac,
  encodeFlac,
  PcmFormat,
  type RandomAccessByteSink,
} from "../src/index.js";

/**
 * A synthetic in-memory encode/decode workload for measuring codec overhead
 * outside libFLAC itself: mainly how often the fiber hands control back to the
 * scheduler. It has no I/O, so every scheduler yield is visible.
 */
export interface ThroughputOptions {
  readonly seconds: number;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly bitsPerSample: 16 | 24;
  readonly decodeFragmentBytes: number;
}

export interface PhaseReceipt {
  readonly milliseconds: number;
  readonly realtime: number;
  readonly schedulerDispatches: number;
  /** Longest interval without a scheduler dispatch: the worst-case wait for other fibers, timers, and interruption. */
  readonly longestDispatchGapMs: number;
}

export interface ThroughputReceipt {
  readonly scheduler: SchedulerKind;
  readonly options: ThroughputOptions;
  readonly frames: number;
  readonly blocks: number;
  readonly flacBytes: number;
  readonly pcmBytes: number;
  readonly encode: PhaseReceipt;
  readonly decode: PhaseReceipt;
}

/**
 * `default` reproduces Effect's own MixedScheduler dispatch (setImmediate when
 * the host has it, otherwise setTimeout(0)) while counting each dispatch.
 * `message` dispatches through a MessageChannel, the workaround a browser
 * consumer would otherwise have to install.
 */
export type SchedulerKind = "default" | "message";

export const defaultThroughputOptions: ThroughputOptions = {
  seconds: 240,
  sampleRate: 48_000,
  channels: 2,
  bitsPerSample: 24,
  decodeFragmentBytes: 64 * 1_024,
};

const BLOCK_FRAMES = 4_096;
const DISTINCT_BLOCKS = 64;

type Dispatch = (task: () => void) => () => void;

const hostDispatch: Dispatch =
  "setImmediate" in globalThis
    ? (task) => {
        const handle = globalThis.setImmediate(task);
        return () => globalThis.clearImmediate(handle);
      }
    : (task) => {
        const handle = setTimeout(task, 0);
        return () => clearTimeout(handle);
      };

const messageDispatch = (): Dispatch => {
  const channel = new MessageChannel();
  const pending: Array<() => void> = [];
  channel.port1.onmessage = () => pending.shift()?.();
  return (task) => {
    let cancelled = false;
    pending.push(() => {
      if (!cancelled) task();
    });
    channel.port2.postMessage(null);
    return () => {
      cancelled = true;
    };
  };
};

export const makeCountingScheduler = (kind: SchedulerKind) => {
  let dispatches = 0;
  let last = performance.now();
  let longestGap = 0;
  const dispatch = kind === "default" ? hostDispatch : messageDispatch();
  const layer = Layer.succeed(
    Scheduler.Scheduler,
    new Scheduler.MixedScheduler("async", (task) => {
      dispatches += 1;
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      return dispatch(() => {
        last = performance.now();
        task();
      });
    }),
  );
  return {
    layer,
    take: () => {
      const now = performance.now();
      const value = {
        dispatches,
        longestGapMs: Math.max(longestGap, now - last),
      };
      dispatches = 0;
      longestGap = 0;
      last = now;
      return value;
    },
  };
};

const synthesizeBlocks = (options: ThroughputOptions): Array<Int32Array> => {
  const amplitude = 2 ** (options.bitsPerSample - 1) * 0.4;
  const noise = 2 ** (options.bitsPerSample - 1) * 0.002;
  let state = 0x2545f491;
  const blocks: Array<Int32Array> = [];
  for (let blockIndex = 0; blockIndex < DISTINCT_BLOCKS; blockIndex++) {
    const block = new Int32Array(BLOCK_FRAMES * options.channels);
    for (let frame = 0; frame < BLOCK_FRAMES; frame++) {
      const t = (blockIndex * BLOCK_FRAMES + frame) / options.sampleRate;
      for (let channel = 0; channel < options.channels; channel++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const tone =
          0.5 * Math.sin(2 * Math.PI * (110 + 20 * channel) * t) +
          0.3 * Math.sin(2 * Math.PI * 440.5 * t + channel) +
          0.2 * Math.sin(2 * Math.PI * 1_975 * t * (1 + 0.01 * Math.sin(t)));
        block[frame * options.channels + channel] = Math.round(
          tone * amplitude + (state / 2 ** 31) * noise,
        );
      }
    }
    blocks.push(block);
  }
  return blocks;
};

function* pcmSource(
  blocks: ReadonlyArray<Int32Array>,
  frames: number,
  channels: number,
): Generator<Int32Array> {
  for (let start = 0, index = 0; start < frames; start += BLOCK_FRAMES) {
    const block = blocks[index++ % blocks.length]!;
    const length = Math.min(BLOCK_FRAMES, frames - start);
    yield length === BLOCK_FRAMES
      ? block
      : block.subarray(0, length * channels);
  }
}

class GrowableSink implements RandomAccessByteSink<never, never> {
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

const now = Effect.sync(() => performance.now());

export const runThroughput = (
  kind: SchedulerKind,
  options: ThroughputOptions = defaultThroughputOptions,
) =>
  Effect.gen(function* () {
    const scheduler = makeCountingScheduler(kind);
    const format = new PcmFormat({
      sampleRate: options.sampleRate,
      channels: options.channels,
      bitsPerSample: options.bitsPerSample,
    });
    const frames = Math.round(options.seconds * options.sampleRate);
    const blocks = synthesizeBlocks(options);
    const sink = new GrowableSink();

    scheduler.take();
    const encodeStart = yield* now;
    const encoded = yield* encodeFlac(
      Stream.fromIterable(pcmSource(blocks, frames, options.channels)),
      sink,
      { format, expectedFrames: BigInt(frames) },
    ).pipe(Effect.provide(scheduler.layer));
    const encodeMs = (yield* now) - encodeStart;
    const encodeDispatches = scheduler.take();

    const flac = sink.bytes.subarray(0, sink.length);
    const fragments: Array<Uint8Array> = [];
    for (let at = 0; at < flac.length; at += options.decodeFragmentBytes)
      fragments.push(flac.subarray(at, at + options.decodeFragmentBytes));
    let pcmBytes = 0;
    const decodeStart = yield* now;
    yield* decodeFlac(Stream.fromIterable(fragments), {
      expectedFrames: encoded.frames,
    }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "Pcm") pcmBytes += event.bytes.length;
        }),
      ),
      Effect.provide(scheduler.layer),
    );
    const decodeMs = (yield* now) - decodeStart;
    const decodeDispatches = scheduler.take();

    const round = (value: number) => Math.round(value * 10) / 10;
    const receipt: ThroughputReceipt = {
      scheduler: kind,
      options,
      frames,
      blocks: Math.ceil(frames / BLOCK_FRAMES),
      flacBytes: flac.length,
      pcmBytes,
      encode: {
        milliseconds: round(encodeMs),
        realtime: round((options.seconds * 1_000) / encodeMs),
        schedulerDispatches: encodeDispatches.dispatches,
        longestDispatchGapMs: round(encodeDispatches.longestGapMs),
      },
      decode: {
        milliseconds: round(decodeMs),
        realtime: round((options.seconds * 1_000) / decodeMs),
        schedulerDispatches: decodeDispatches.dispatches,
        longestDispatchGapMs: round(decodeDispatches.longestGapMs),
      },
    };
    return receipt;
  });
