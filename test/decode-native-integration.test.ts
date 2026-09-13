import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import { decodeFlac } from "../src/decode.js";
import { makeFlacDecoderLayer } from "../src/decoder-wasm.js";
import { PcmFormat } from "../src/format.js";
import { FlacDecodeError } from "../src/decoder-errors.js";
import { FlacDecoderLive } from "../src/node.js";

const nativeFlac = process.env.CODEC_NATIVE_FLAC;

/*
 * Independent fixture: native libFLAC 1.5.0 `flac -8 --lax
 * --blocksize=65535` over 65,535 stereo PCM24 frames generated from xorshift
 * seed 1234567. It proves that an encoded frame larger than the 256 KiB host
 * input slot resumes across many Asyncify pulls.
 */
test.skipIf(nativeFlac === undefined)(
  "decodes a maximum-size FLAC block across bounded input pulls",
  async () => {
    expect(existsSync(nativeFlac!)).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), "codec-max-block-"));
    try {
      const rawPath = join(directory, "max-block.raw");
      const fixturePath = join(directory, "max-block.flac");
      const raw = new Uint8Array(65_535 * 2 * 3);
      let state = 1234567;
      for (let index = 0; index < raw.length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        raw[index] = state & 0xff;
      }
      await writeFile(rawPath, raw);
      const process = Bun.spawn(
        [
          nativeFlac!,
          "--totally-silent",
          "-8",
          "--lax",
          "--blocksize=65535",
          "--no-padding",
          "--no-seektable",
          "--force-raw-format",
          "--endian=little",
          "--sign=signed",
          "--channels=2",
          "--bps=24",
          "--sample-rate=44100",
          `--output-name=${fixturePath}`,
          rawPath,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const stderr = new Response(process.stderr).text();
      expect(await process.exited, await stderr).toBe(0);
      const [encoded, decoderBytes] = await Promise.all([
        readFile(fixturePath),
        readFile(new URL("../wasm/flac-decoder.wasm", import.meta.url)),
      ]);
      const fragments: Array<Uint8Array> = [];
      expect(encoded.byteLength).toBeGreaterThan(256 * 1024);
      for (let offset = 0; offset < encoded.byteLength; offset += 997) {
        fragments.push(
          encoded.subarray(offset, Math.min(offset + 997, encoded.byteLength)),
        );
      }
      const format = new PcmFormat({
        sampleRate: 44_100,
        channels: 2,
        bitsPerSample: 24,
      });
      const digest = createHash("sha256");
      let pcmBytes = 0;
      let complete = false;
      await Effect.runPromise(
        Stream.runForEach(
          decodeFlac(Stream.fromIterable(fragments), {
            expectedFormat: format,
            expectedFrames: 65_535n,
          }),
          (event) =>
            Effect.sync(() => {
              if (event._tag === "Pcm") {
                digest.update(event.bytes);
                pcmBytes += event.bytes.byteLength;
              } else if (event._tag === "Complete") {
                complete =
                  event.md5Checked &&
                  event.md5Verified &&
                  event.frames === 65_535n;
              }
            }),
        ).pipe(Effect.provide(makeFlacDecoderLayer(decoderBytes))),
      );
      expect(pcmBytes).toBe(393_210);
      expect(digest.digest("hex")).toBe(
        "dfe5d44b7eab5437879b3f91a9c4d5443c263ed0e33dab15399dccc38bfe9443",
      );
      expect(complete).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(nativeFlac === undefined)(
  "native 8 kHz audio survives every byte split and rejects every strict prefix",
  async () => {
    const raw = new Uint8Array(64);
    for (let index = 0; index < raw.length; index += 2) {
      const sample = ((index * 401) ^ (index << 7)) & 0xffff;
      raw[index] = sample;
      raw[index + 1] = sample >>> 8;
    }
    const process = Bun.spawn(
      [
        nativeFlac!,
        "--silent",
        "--force-raw-format",
        "--endian=little",
        "--sign=signed",
        "--channels=1",
        "--bps=16",
        "--sample-rate=8000",
        "--blocksize=16",
        "--no-padding",
        "--stdout",
        "-",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    process.stdin.write(raw);
    process.stdin.end();
    const [status, output, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
    ]);
    expect(status, stderr).toBe(0);
    const encoded = new Uint8Array(output);
    expect(encoded.length).toBeLessThan(256);
    const format = new PcmFormat({
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const decode = (parts: ReadonlyArray<Uint8Array>) =>
          decodeFlac(Stream.fromIterable(parts), {
            expectedFormat: format,
            expectedFrames: 32n,
          }).pipe(Stream.runCollect);
        const reference = yield* decode([encoded]);
        const decoded = Uint8Array.from(
          reference.flatMap((event) =>
            event._tag === "Pcm" ? Array.from(event.bytes) : [],
          ),
        );
        expect(decoded).toEqual(raw);
        for (let boundary = 0; boundary <= encoded.length; boundary++) {
          const actual = yield* decode([
            encoded.subarray(0, boundary),
            encoded.subarray(boundary),
          ]);
          expect(actual).toEqual(reference);
        }
        for (let boundary = 0; boundary < encoded.length; boundary++) {
          const exit = yield* Effect.exit(
            decode([encoded.subarray(0, boundary)]),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBe(false);
            expect(Cause.squash(exit.cause)).toBeInstanceOf(FlacDecodeError);
          }
        }
      }).pipe(Effect.provide(FlacDecoderLive)),
    );
  },
);
