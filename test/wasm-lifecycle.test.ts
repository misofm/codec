import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { decodeFlac } from "../src/decode.js";
import {
  FlacDecoder,
  FLAC_DECODER_LIMITS,
  FLAC_DECODER_WASM_SHA256,
  loadFlacDecoderFromBytes,
  type FlacDecoderService,
} from "../src/decoder-wasm.js";
import { encodeFlac } from "../src/encode.js";
import { PcmFormat } from "../src/format.js";
import { acquireDecoderAbi } from "../src/internal/decoder-abi.js";
import {
  FlacEncoder,
  FLAC_ENCODER_LIMITS,
  FLAC_ENCODER_WASM_SHA256,
  loadFlacEncoderFromBytes,
} from "../src/wasm.js";

let encoderBytes: Uint8Array;
let decoderBytes: Uint8Array;
let decoder: FlacDecoderService;
let encoded: Uint8Array;

const originalInstantiate = WebAssembly.instantiate;

afterEach(() => {
  WebAssembly.instantiate = originalInstantiate;
});

beforeAll(async () => {
  [encoderBytes, decoderBytes] = await Promise.all([
    readFile(new URL("../wasm/flac-encoder.wasm", import.meta.url)).then(
      (bytes) => new Uint8Array(bytes),
    ),
    readFile(new URL("../wasm/flac-decoder.wasm", import.meta.url)).then(
      (bytes) => new Uint8Array(bytes),
    ),
  ]);
  const encoder = await Effect.runPromise(
    loadFlacEncoderFromBytes(encoderBytes),
  );
  decoder = await Effect.runPromise(loadFlacDecoderFromBytes(decoderBytes));

  const format = new PcmFormat({
    sampleRate: 44_100,
    channels: 2,
    bitsPerSample: 16,
  });
  const block = new Int32Array(4_096 * 2);
  for (let index = 0; index < block.length; index += 1)
    block[index] = ((index * 7_919) % 60_000) - 30_000;
  const storage = new Uint8Array(1 << 20);
  let length = 0;
  await Effect.runPromise(
    encodeFlac(
      Stream.make(block, block, block, block),
      {
        writeAt: (offset, bytes) =>
          Effect.sync(() => storage.set(bytes, Number(offset))),
        resize: (size) =>
          Effect.sync(() => {
            length = Number(size);
          }),
      },
      { format },
    ).pipe(Effect.provideService(FlacEncoder, encoder)),
  );
  encoded = storage.slice(0, length);
});

/** Capture the exports of every decoder instance created while `run` executes. */
const captureDecoderInstances = (): Array<WebAssembly.Exports> => {
  const captured: Array<WebAssembly.Exports> = [];
  WebAssembly.instantiate = ((
    ...arguments_: Parameters<typeof WebAssembly.instantiate>
  ) =>
    (
      originalInstantiate as (
        ...values: typeof arguments_
      ) => Promise<WebAssembly.Instance>
    )(...arguments_).then((instance) => {
      captured.push(instance.exports);
      return instance;
    })) as typeof WebAssembly.instantiate;
  return captured;
};

const liveBytes = (exports: WebAssembly.Exports): number =>
  (exports.codec_decoder_allocator_live_bytes as () => number)();

test("asset checks report accurate details with the wasm-compile reason", async () => {
  const modifiedDecoder = Uint8Array.from(decoderBytes);
  modifiedDecoder[modifiedDecoder.byteLength - 1]! ^= 1;
  const decoderHash = await Effect.runPromise(
    Effect.flip(loadFlacDecoderFromBytes(modifiedDecoder)),
  );
  expect(decoderHash).toMatchObject({ reason: "wasm-compile", phase: "load" });
  expect(decoderHash.detail).toMatch(
    new RegExp(
      `^decoder asset SHA-256 [0-9a-f]{64} does not match pinned ${FLAC_DECODER_WASM_SHA256}$`,
    ),
  );
  expect(decoderHash.cause).toBeUndefined();

  const decoderSize = await Effect.runPromise(
    Effect.flip(
      loadFlacDecoderFromBytes(
        new Uint8Array(FLAC_DECODER_LIMITS.maxAssetBytes + 1),
      ),
    ),
  );
  expect(decoderSize).toMatchObject({
    reason: "wasm-compile",
    phase: "load",
    detail: `decoder asset is ${FLAC_DECODER_LIMITS.maxAssetBytes + 1} bytes; maximum is ${FLAC_DECODER_LIMITS.maxAssetBytes}`,
  });

  const modifiedEncoder = Uint8Array.from(encoderBytes);
  modifiedEncoder[modifiedEncoder.byteLength - 1]! ^= 1;
  const encoderHash = await Effect.runPromise(
    Effect.flip(loadFlacEncoderFromBytes(modifiedEncoder)),
  );
  expect(encoderHash).toMatchObject({ reason: "wasm-compile", phase: "load" });
  expect(encoderHash.detail).toMatch(
    new RegExp(
      `^encoder asset SHA-256 [0-9a-f]{64} does not match pinned ${FLAC_ENCODER_WASM_SHA256}$`,
    ),
  );

  const encoderSize = await Effect.runPromise(
    Effect.flip(
      loadFlacEncoderFromBytes(
        new Uint8Array(FLAC_ENCODER_LIMITS.maxAssetBytes + 1),
      ),
    ),
  );
  expect(encoderSize).toMatchObject({
    reason: "wasm-compile",
    phase: "load",
    detail: `encoder asset is ${FLAC_ENCODER_LIMITS.maxAssetBytes + 1} bytes; maximum is ${FLAC_ENCODER_LIMITS.maxAssetBytes}`,
  });
});

test("a scoped decoder ABI frees its Asyncify stack when interrupted", async () => {
  let exports: WebAssembly.Exports | undefined;
  let liveWhileOpen = 0;
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const abi = yield* acquireDecoderAbi(decoder.module);
            exports = abi.exports;
            liveWhileOpen = liveBytes(abi.exports);
            yield* Deferred.succeed(opened, undefined);
            return yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(opened);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }),
  );
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(liveWhileOpen).toBeGreaterThan(0);
  expect(liveBytes(exports!)).toBe(0);
});

test("decodeFlac releases all decoder memory on success, failure, and interruption", async () => {
  const captured = captureDecoderInstances();

  const events = await Effect.runPromise(
    Stream.runCollect(decodeFlac(Stream.make(encoded))).pipe(
      Effect.provideService(FlacDecoder, decoder),
    ),
  );
  expect(events.at(-1)?._tag).toBe("Complete");

  const truncated = await Effect.runPromise(
    Effect.exit(
      Stream.runDrain(
        decodeFlac(Stream.make(encoded.subarray(0, encoded.length - 1))),
      ).pipe(Effect.provideService(FlacDecoder, decoder)),
    ),
  );
  expect(Exit.isFailure(truncated)).toBe(true);

  const interrupted = await Effect.runPromise(
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const source = Stream.concat(
        Stream.make(encoded.subarray(0, 4_096)),
        Stream.fromEffect(
          Effect.andThen(Deferred.succeed(waiting, undefined), Effect.never),
        ),
      );
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(decodeFlac(source)).pipe(
          Effect.provideService(FlacDecoder, decoder),
        ),
      );
      yield* Deferred.await(waiting);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }),
  );
  expect(
    Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause),
  ).toBe(true);

  expect(captured).toHaveLength(3);
  for (const exports of captured) expect(liveBytes(exports)).toBe(0);
});
