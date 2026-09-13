import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { decodeFlac } from "../src/decode.js";
import { FlacDecodeError } from "../src/decoder-errors.js";
import {
  FlacDecoder,
  FLAC_DECODER_LIMITS,
  loadFlacDecoderFromBytes,
  type FlacDecoderService,
} from "../src/decoder-wasm.js";
import { encodeFlac, type RandomAccessByteSink } from "../src/encode.js";
import { PcmFormat } from "../src/format.js";
import {
  instantiateDecoder,
  type DecoderAbi,
  type DecoderPhase,
} from "../src/internal/decoder-abi.js";
import {
  FlacEncoder,
  loadFlacEncoderFromBytes,
  type FlacEncoderService,
} from "../src/wasm.js";

const BLOCK_FRAMES = 4_096;
const BLOCK_COUNT = 96;
const INPUT_FRAGMENT_PATTERN = [1, 31, 4_093, 65_521] as const;

interface LongFixture {
  readonly encoded: Uint8Array;
  readonly format: PcmFormat;
  readonly frames: number;
  readonly pcmBytes: number;
  readonly pcmSha256: string;
}

interface TrackedDecoder {
  readonly abi: DecoderAbi;
  readonly baselineLiveBytes: number;
  decoder: number;
  deleted: boolean;
}

interface AllocatorSample {
  readonly liveBytes: number;
  readonly peakLiveBytes: number;
  readonly peakHeapBytes: number;
  readonly memoryBytes: number;
}

let decoderService: FlacDecoderService;
let fixture: LongFixture;

const canonicalPcm24 = (samples: Int32Array): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 3);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]!;
    bytes[index * 3] = value;
    bytes[index * 3 + 1] = value >> 8;
    bytes[index * 3 + 2] = value >> 16;
  }
  return bytes;
};

const makeLongFixture = (
  encoder: FlacEncoderService,
): Effect.Effect<LongFixture, unknown> => {
  const format = new PcmFormat({
    sampleRate: 44_100,
    channels: 2,
    bitsPerSample: 24,
  });
  const block = new Int32Array(BLOCK_FRAMES * format.channels);
  let random = 0x1234_5678;
  for (let index = 0; index < block.length; index += 1) {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    block[index] = random >> 8;
  }
  const canonicalBlock = canonicalPcm24(block);
  const digest = createHash("sha256");
  for (let index = 0; index < BLOCK_COUNT; index += 1)
    digest.update(canonicalBlock);

  const frames = BLOCK_FRAMES * BLOCK_COUNT;
  const storage = new Uint8Array(frames * format.channels * 3 + 128 * 1_024);
  let finalLength = 0;
  const sink: RandomAccessByteSink<never, never> = {
    writeAt: (offset, bytes) =>
      Effect.sync(() => storage.set(bytes, Number(offset))),
    resize: (length) =>
      Effect.sync(() => {
        finalLength = Number(length);
      }),
  };
  const source = Stream.unfold(0, (index) =>
    Effect.succeed(
      index < BLOCK_COUNT ? ([block, index + 1] as const) : undefined,
    ),
  );
  return encodeFlac(source, sink, {
    format,
    expectedFrames: BigInt(frames),
  }).pipe(
    Effect.provideService(FlacEncoder, encoder),
    Effect.map(() => ({
      encoded: storage.slice(0, finalLength),
      format,
      frames,
      pcmBytes: canonicalBlock.byteLength * BLOCK_COUNT,
      pcmSha256: digest.digest("hex"),
    })),
  );
};

const nextFragment = (
  encoded: Uint8Array,
): Effect.Effect<Uint8Array | null> => {
  let offset = 0;
  let fragment = 0;
  return Effect.sync(() => {
    if (offset === encoded.byteLength) return null;
    const requested =
      INPUT_FRAGMENT_PATTERN[fragment % INPUT_FRAGMENT_PATTERN.length]!;
    const end = Math.min(offset + requested, encoded.byteLength);
    const bytes = encoded.subarray(offset, end);
    offset = end;
    fragment += 1;
    return bytes;
  });
};

const fragmentedSource = (encoded: Uint8Array): Stream.Stream<Uint8Array> =>
  Stream.unfold({ offset: 0, fragment: 0 }, ({ offset, fragment }) => {
    if (offset === encoded.byteLength) return Effect.succeed(undefined);
    const requested =
      INPUT_FRAGMENT_PATTERN[fragment % INPUT_FRAGMENT_PATTERN.length]!;
    const end = Math.min(offset + requested, encoded.byteLength);
    return Effect.succeed([
      encoded.subarray(offset, end),
      { offset: end, fragment: fragment + 1 },
    ] as const);
  });

const directFailure = (phase: DecoderPhase, result: number): FlacDecodeError =>
  new FlacDecodeError({
    reason: "invalid-stream",
    phase,
    detail: `direct pinned decoder returned ${result} during ${phase}`,
  });

const withTrackedDecoder = <A, E, R>(
  use: (resource: TrackedDecoder) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FlacDecodeError, R> =>
  Effect.acquireUseRelease(
    instantiateDecoder(decoderService.module).pipe(
      Effect.map((abi) => ({
        abi,
        baselineLiveBytes: abi.exports.codec_decoder_allocator_live_bytes(),
        decoder: 0,
        deleted: false,
      })),
    ),
    use,
    (resource) =>
      Effect.sync(() => {
        try {
          resource.abi.normalize();
          if (!resource.deleted && resource.decoder !== 0)
            resource.abi.exports.codec_decoder_delete(resource.decoder);
        } finally {
          resource.deleted = true;
          resource.decoder = 0;
          resource.abi.dispose();
        }
      }),
  );

const createDecoder = (
  resource: TrackedDecoder,
  expectedFrames: number,
): Effect.Effect<void, FlacDecodeError> =>
  Effect.gen(function* () {
    const decoder = resource.abi.exports.codec_decoder_new(
      FLAC_DECODER_LIMITS.defaultMaxMetadataBytes,
      fixture.format.sampleRate,
      fixture.format.channels,
      fixture.format.bitsPerSample,
      expectedFrames >>> 0,
      Math.floor(expectedFrames / 0x1_0000_0000),
      1,
      1,
    );
    if (
      !Number.isSafeInteger(decoder) ||
      decoder <= 0 ||
      decoder >= resource.abi.exports.memory.buffer.byteLength
    ) {
      return yield* new FlacDecodeError({
        reason: "allocation-failed",
        phase: "instantiate",
        detail: "direct pinned decoder allocation failed",
      });
    }
    resource.decoder = decoder;
  });

const driveDecoder = (
  resource: TrackedDecoder,
  input: Effect.Effect<Uint8Array | null>,
): Effect.Effect<
  {
    readonly frames: number;
    readonly bytes: number;
    readonly sha256: string;
    readonly allocator: ReadonlyArray<AllocatorSample>;
    readonly liveAfterDelete: number;
    readonly freeCallsAfterDelete: number;
  },
  FlacDecodeError
> =>
  Effect.gen(function* () {
    const { abi, decoder } = resource;
    const initialized = yield* abi.invoke(
      "metadata",
      () => abi.exports.codec_decoder_init(decoder),
      input,
    );
    if (initialized !== 0) return yield* directFailure("metadata", initialized);

    const digest = createHash("sha256");
    const allocator: Array<AllocatorSample> = [];
    let frames = 0;
    let bytes = 0;
    let progressless = 0;
    for (;;) {
      const result = yield* abi.invoke(
        "frame",
        () => abi.exports.codec_decoder_process_single(decoder),
        input,
      );
      if (result === 0) {
        progressless += 1;
        if (progressless > FLAC_DECODER_LIMITS.maxProgresslessCalls)
          return yield* directFailure("frame", result);
        continue;
      }
      progressless = 0;
      if (result === 2) break;
      if (result !== 1) return yield* directFailure("frame", result);

      const outputLength = abi.exports.codec_decoder_output_length(decoder);
      const outputFrames = abi.exports.codec_decoder_output_frames(decoder);
      const outputPointer = abi.exports.codec_decoder_output_ptr(decoder);
      if (
        outputLength <= 0 ||
        outputFrames <= 0 ||
        outputPointer <= 0 ||
        outputPointer > abi.exports.memory.buffer.byteLength - outputLength
      ) {
        return yield* directFailure("frame", -1);
      }
      digest.update(
        new Uint8Array(abi.exports.memory.buffer, outputPointer, outputLength),
      );
      frames += outputFrames;
      bytes += outputLength;
      abi.exports.codec_decoder_release_output(decoder);
      allocator.push({
        liveBytes: abi.exports.codec_decoder_allocator_live_bytes(),
        peakLiveBytes: abi.exports.codec_decoder_allocator_peak_live_bytes(),
        peakHeapBytes: abi.exports.codec_decoder_allocator_peak_heap_bytes(),
        memoryBytes: abi.exports.memory.buffer.byteLength,
      });
    }

    const finished = yield* abi.invoke(
      "finish",
      () => abi.exports.codec_decoder_finish(decoder),
      input,
    );
    if (finished !== 0) return yield* directFailure("finish", finished);
    abi.exports.codec_decoder_delete(decoder);
    resource.deleted = true;
    resource.decoder = 0;
    return {
      frames,
      bytes,
      sha256: digest.digest("hex"),
      allocator,
      liveAfterDelete: abi.exports.codec_decoder_allocator_live_bytes(),
      freeCallsAfterDelete: abi.exports.codec_decoder_allocator_free_calls(),
    };
  });

beforeAll(async () => {
  const [encoderBytes, decoderBytes] = await Promise.all([
    readFile(new URL("../wasm/flac-encoder.wasm", import.meta.url)),
    readFile(new URL("../wasm/flac-decoder.wasm", import.meta.url)),
  ]);
  const [encoder, decoder] = await Promise.all([
    Effect.runPromise(loadFlacEncoderFromBytes(encoderBytes)),
    Effect.runPromise(loadFlacDecoderFromBytes(decoderBytes)),
  ]);
  decoderService = decoder;
  fixture = await Effect.runPromise(makeLongFixture(encoder));
});

describe("decoder resource lifecycle", () => {
  test("keeps the actual pinned allocator steady during a long hash-only decode", async () => {
    const result = await Effect.runPromise(
      withTrackedDecoder((resource) =>
        Effect.gen(function* () {
          yield* createDecoder(resource, fixture.frames);
          const decoded = yield* driveDecoder(
            resource,
            nextFragment(fixture.encoded),
          );
          return { resource, decoded };
        }),
      ),
    );

    expect(result.decoded.frames).toBe(fixture.frames);
    expect(result.decoded.bytes).toBe(fixture.pcmBytes);
    expect(result.decoded.sha256).toBe(fixture.pcmSha256);
    expect(result.decoded.allocator.length).toBe(BLOCK_COUNT);
    const warm = result.decoded.allocator[2]!;
    for (const sample of result.decoded.allocator.slice(3)) {
      expect(sample.liveBytes).toBeLessThanOrEqual(warm.liveBytes);
      expect(sample.peakLiveBytes).toBe(warm.peakLiveBytes);
      expect(sample.peakHeapBytes).toBe(warm.peakHeapBytes);
      expect(sample.memoryBytes).toBe(FLAC_DECODER_LIMITS.wasmMemoryBytes);
    }
    expect(warm.peakLiveBytes).toBeLessThan(
      FLAC_DECODER_LIMITS.wasmMemoryBytes,
    );
    expect(warm.peakHeapBytes).toBeLessThan(
      FLAC_DECODER_LIMITS.wasmMemoryBytes,
    );
    expect(result.decoded.liveAfterDelete).toBe(
      result.resource.baselineLiveBytes,
    );
    expect(
      result.resource.abi.exports.codec_decoder_allocator_live_bytes(),
    ).toBe(0);
    expect(
      result.resource.abi.exports.codec_decoder_allocator_free_calls(),
    ).toBe(result.decoded.freeCallsAfterDelete + 1);
  });

  test("returns the actual pinned allocator to zero after truncated failure", async () => {
    let observed: DecoderAbi | undefined;
    const exit = await Effect.runPromise(
      Effect.exit(
        withTrackedDecoder((resource) =>
          Effect.gen(function* () {
            observed = resource.abi;
            yield* createDecoder(resource, fixture.frames);
            yield* driveDecoder(
              resource,
              nextFragment(
                fixture.encoded.subarray(0, fixture.encoded.length - 1),
              ),
            );
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toBeInstanceOf(FlacDecodeError);
    expect(observed?.exports.codec_decoder_allocator_live_bytes()).toBe(0);
  });

  test("returns the actual pinned allocator to zero when input waiting is interrupted", async () => {
    let observed: DecoderAbi | undefined;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const exit = yield* Effect.exit(
          withTrackedDecoder((resource) =>
            Effect.gen(function* () {
              observed = resource.abi;
              yield* createDecoder(resource, fixture.frames);
              let pulls = 0;
              const input = Effect.suspend(() => {
                pulls += 1;
                return pulls === 1
                  ? Effect.succeed(fixture.encoded.subarray(0, 42))
                  : Effect.andThen(
                      Deferred.succeed(waiting, undefined),
                      Effect.never,
                    );
              });
              const fiber = yield* Effect.forkChild(
                resource.abi.invoke(
                  "metadata",
                  () =>
                    resource.abi.exports.codec_decoder_init(resource.decoder),
                  input,
                ),
              );
              yield* Deferred.await(waiting);
              yield* Fiber.interrupt(fiber);
              return yield* Fiber.join(fiber);
            }),
          ),
        );
        return exit;
      }),
    );
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(
      true,
    );
    expect(observed?.exports.codec_decoder_allocator_live_bytes()).toBe(0);
  });

  test("finalizes public sources once after success, failure, and cancellation", async () => {
    const finalizers = { success: 0, failure: 0, cancellation: 0 };
    const successDigest = createHash("sha256");
    let complete = false;
    await Effect.runPromise(
      decodeFlac(
        fragmentedSource(fixture.encoded).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              finalizers.success += 1;
            }),
          ),
        ),
      ).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "Pcm") successDigest.update(event.bytes);
            if (event._tag === "Complete") complete = true;
          }),
        ),
        Effect.provideService(FlacDecoder, decoderService),
      ),
    );
    expect(successDigest.digest("hex")).toBe(fixture.pcmSha256);
    expect(complete).toBe(true);

    const sourceFailure = new Error("lifecycle source failure");
    const failed = await Effect.runPromise(
      Effect.exit(
        decodeFlac(
          Stream.concat(
            Stream.make(fixture.encoded.subarray(0, 42)),
            Stream.fail(sourceFailure),
          ).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                finalizers.failure += 1;
              }),
            ),
          ),
        ).pipe(
          Stream.runDrain,
          Effect.provideService(FlacDecoder, decoderService),
        ),
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    if (Exit.isFailure(failed))
      expect(Cause.squash(failed.cause)).toBe(sourceFailure);

    const cancelled = await Effect.runPromise(
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const source = Stream.concat(
          Stream.make(fixture.encoded.subarray(0, 42)),
          Stream.fromEffect(
            Effect.andThen(Deferred.succeed(waiting, undefined), Effect.never),
          ),
        ).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              finalizers.cancellation += 1;
            }),
          ),
        );
        const fiber = yield* Effect.forkChild(
          decodeFlac(source).pipe(
            Stream.runDrain,
            Effect.provideService(FlacDecoder, decoderService),
          ),
        );
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(
      Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause),
    ).toBe(true);
    expect(finalizers).toEqual({ success: 1, failure: 1, cancellation: 1 });
  });
});
