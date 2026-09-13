import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import {
  decodeFlac,
  encodeFlac,
  PcmFormat,
  type RandomAccessByteSink,
} from "@misofm/codec";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

export const scenarios = Effect.gen(function* () {
  let verifiedFrames = 0;
  let verifiedBytes = 0;
  let lastFlac = new Uint8Array();
  for (const bitsPerSample of [16, 24] as const) {
    for (const channels of [1, 2] as const) {
      const frames = 8193;
      const pcm = new Int32Array(frames * channels);
      const expected = new Uint8Array(pcm.length * (bitsPerSample / 8));
      let state = 0x12345678;
      for (let i = 0; i < pcm.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const value = state >> (32 - bitsPerSample);
        pcm[i] = value;
        for (let byte = 0; byte < bitsPerSample / 8; byte++)
          expected[i * (bitsPerSample / 8) + byte] = value >> (8 * byte);
      }
      // Deliberately bounded test artifact; production consumers supply a file sink.
      const storage = new Uint8Array(expected.length + 65536);
      let resized = -1;
      let resizeCalls = 0;
      const sink: RandomAccessByteSink<never, never> = {
        writeAt: (offset, bytes) =>
          Effect.sync(() => storage.set(bytes, Number(offset))),
        resize: (length) =>
          Effect.sync(() => {
            resized = Number(length);
            resizeCalls++;
          }),
      };
      const pcmBlocks: Int32Array[] = [];
      for (let start = 0; start < frames; start += 997)
        pcmBlocks.push(
          pcm.slice(start * channels, Math.min(frames, start + 997) * channels),
        );
      const format = new PcmFormat({
        sampleRate: 44100,
        channels,
        bitsPerSample,
      });
      const result = yield* encodeFlac(Stream.fromIterable(pcmBlocks), sink, {
        format,
        expectedFrames: BigInt(frames),
      });
      assert(result.frames === BigInt(frames), "encoded frame count");
      assert(
        result.streamInfo.totalFrames === BigInt(frames),
        "final STREAMINFO sample count",
      );
      assert(
        resizeCalls === 1 && resized === Number(result.bytes),
        "sink final resize",
      );
      const encoded = storage.slice(0, resized);
      lastFlac = encoded;
      const fragments: Uint8Array[] = [];
      for (let cursor = 0; cursor < encoded.length; ) {
        const size = cursor < 42 ? 1 : 509;
        fragments.push(encoded.slice(cursor, cursor + size));
        cursor += size;
      }
      let cursor = 0;
      let metadata = 0;
      let complete = 0;
      yield* Stream.runForEach(
        decodeFlac(Stream.fromIterable(fragments)),
        (event) =>
          Effect.sync(() => {
            if (event._tag === "Metadata") {
              assert(cursor === 0 && metadata === 0, "metadata ordering");
              assert(
                event.format.sampleRate === 44100 &&
                  event.format.channels === channels &&
                  event.format.bitsPerSample === bitsPerSample,
                "decoded format",
              );
              metadata++;
            } else if (event._tag === "Pcm") {
              assert(metadata === 1 && complete === 0, "PCM event ordering");
              assert(
                event.frameOffset ===
                  BigInt(cursor / ((channels * bitsPerSample) / 8)),
                "PCM frame position",
              );
              assert(
                event.bytes.length ===
                  (event.frames * channels * bitsPerSample) / 8,
                "PCM block shape",
              );
              for (const byte of event.bytes)
                assert(
                  byte === expected[cursor++],
                  `PCM mismatch at byte ${cursor - 1}`,
                );
            } else {
              assert(
                event._tag === "Complete" &&
                  event.md5Checked &&
                  event.md5Verified,
                "embedded PCM MD5 verified",
              );
              assert(
                event.frames === BigInt(frames) &&
                  event.bytes === BigInt(expected.length),
                "verified completion counts",
              );
              complete++;
            }
          }),
      );
      assert(
        metadata === 1 && complete === 1,
        "one metadata and verified completion event",
      );
      assert(cursor === expected.length, "all canonical PCM bytes decoded");
      verifiedFrames += frames;
      verifiedBytes += expected.length;
    }
  }

  let finalized = 0;
  const waiting = yield* Deferred.make<void>();
  const pendingSource = Stream.concat(
    Stream.make(lastFlac.slice(0, 42)),
    Stream.fromEffect(
      Effect.andThen(Deferred.succeed(waiting, undefined), Effect.never),
    ),
  ).pipe(
    Stream.ensuring(
      Effect.sync(() => {
        finalized++;
      }),
    ),
  );
  const pending = yield* Effect.forkChild(
    Stream.runDrain(decodeFlac(pendingSource)),
  );
  yield* Deferred.await(waiting);
  yield* Fiber.interrupt(pending);
  const interrupted = yield* Fiber.await(pending);
  assert(
    Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause),
    "decode wait interruption preserved",
  );
  assert(finalized === 1, "interrupted source released exactly once");

  const truncated = yield* Effect.exit(
    Stream.runDrain(decodeFlac(Stream.make(lastFlac.slice(0, -1)))),
  );
  assert(
    Exit.isFailure(truncated) &&
      Cause.hasFails(truncated.cause) &&
      !Cause.hasDies(truncated.cause),
    "truncation must be a typed failure",
  );

  return {
    formats: 4,
    verifiedFrames,
    verifiedBytes,
    cancellation: true,
    truncation: true,
  };
});
