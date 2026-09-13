import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  encodeFlac,
  PcmFormat,
  type RandomAccessByteSink,
} from "../src/index.js";
import { FlacEncoderLive } from "../src/node.js";

const nativeFlac = process.env.CODEC_NATIVE_FLAC;

const rawPcm = (pcm: Int32Array, bits: 16 | 24): Uint8Array => {
  const width = bits / 8;
  const bytes = new Uint8Array(pcm.length * width);
  for (let index = 0; index < pcm.length; index++) {
    const value = pcm[index]! >>> 0;
    for (let byte = 0; byte < width; byte++)
      bytes[index * width + byte] = (value >>> (8 * byte)) & 0xff;
  }
  return bytes;
};

for (const bits of [16, 24] as const) {
  test.skipIf(nativeFlac === undefined)(
    `native libFLAC decodes PCM${bits} output byte-for-byte`,
    async () => {
      const command = nativeFlac!;
      expect(
        existsSync(command),
        `CODEC_NATIVE_FLAC does not exist: ${command}`,
      ).toBe(true);
      const format = new PcmFormat({
        sampleRate: 44_100,
        channels: 2,
        bitsPerSample: bits,
      });
      const pcm = new Int32Array(2 * 4_097);
      let random = 0x31415926;
      for (let index = 0; index < pcm.length; index++) {
        random = (Math.imul(random, 1_103_515_245) + 12_345) | 0;
        pcm[index] = random >> (32 - bits);
      }
      pcm[0] = -(2 ** (bits - 1));
      pcm[1] = 2 ** (bits - 1) - 1;
      let encoded = new Uint8Array();
      const sink: RandomAccessByteSink<never, never> = {
        writeAt: (offset, bytes) =>
          Effect.sync(() => {
            const end = Number(offset) + bytes.length;
            if (end > encoded.length) {
              const grown = new Uint8Array(end);
              grown.set(encoded);
              encoded = grown;
            }
            encoded.set(bytes, Number(offset));
          }),
        resize: (length) =>
          Effect.sync(() => {
            encoded = encoded.slice(0, Number(length));
          }),
      };
      await Effect.runPromise(
        encodeFlac(
          Stream.make(pcm.subarray(0, 8_192), pcm.subarray(8_192)),
          sink,
          { format, expectedFrames: 4_097n },
        ).pipe(Effect.provide(FlacEncoderLive)),
      );

      const directory = await mkdtemp(join(tmpdir(), "codec-native-"));
      const flacPath = join(directory, `fixture-${bits}.flac`);
      try {
        await Bun.write(flacPath, encoded);
        const proc = Bun.spawn(
          [
            command,
            "--silent",
            "--decode",
            "--stdout",
            "--force-raw-format",
            "--endian=little",
            "--sign=signed",
            flacPath,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [decoded, stderr, status] = await Promise.all([
          new Response(proc.stdout).arrayBuffer(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(status, stderr).toBe(0);
        expect(Array.from(new Uint8Array(decoded))).toEqual(
          Array.from(rawPcm(pcm, bits)),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(nativeFlac === undefined)(
  "level-8 LPC analysis stays within two percent of native libFLAC",
  async () => {
    const command = nativeFlac!;
    expect(
      existsSync(command),
      `CODEC_NATIVE_FLAC does not exist: ${command}`,
    ).toBe(true);
    const format = new PcmFormat({
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 24,
    });
    const frames = 131_072;
    const pcm = new Int32Array(frames * format.channels);
    for (let frame = 0; frame < frames; frame++) {
      const slow = Math.sin(frame * 0.000_31) * 900_000;
      pcm[frame * 2] = Math.round(
        slow +
          Math.sin(frame * 0.007_1) * 2_700_000 +
          Math.sin(frame * 0.011_3) * 1_300_000,
      );
      pcm[frame * 2 + 1] = Math.round(
        slow +
          Math.sin(frame * 0.007_1 + 0.19) * 2_650_000 +
          Math.sin(frame * 0.011_3 + 0.07) * 1_350_000,
      );
    }

    let encoded = new Uint8Array();
    const sink: RandomAccessByteSink<never, never> = {
      writeAt: (offset, bytes) =>
        Effect.sync(() => {
          const end = Number(offset) + bytes.byteLength;
          if (end > encoded.byteLength) {
            const grown = new Uint8Array(end);
            grown.set(encoded);
            encoded = grown;
          }
          encoded.set(bytes, Number(offset));
        }),
      resize: (length) =>
        Effect.sync(() => {
          encoded = encoded.slice(0, Number(length));
        }),
    };
    const blocks: Array<Int32Array> = [];
    for (let frame = 0; frame < frames; frame += 4_096) {
      blocks.push(pcm.subarray(frame * 2, Math.min(frame + 4_096, frames) * 2));
    }
    await Effect.runPromise(
      encodeFlac(Stream.fromIterable(blocks), sink, {
        format,
        expectedFrames: BigInt(frames),
      }).pipe(Effect.provide(FlacEncoderLive)),
    );

    const directory = await mkdtemp(join(tmpdir(), "codec-compression-"));
    const rawPath = join(directory, "predictive.raw");
    const wasmPath = join(directory, "wasm.flac");
    const nativePath = join(directory, "native.flac");
    const analysisPath = join(directory, "wasm.ana");
    try {
      await Promise.all([
        Bun.write(rawPath, rawPcm(pcm, 24)),
        Bun.write(wasmPath, encoded),
      ]);
      const native = Bun.spawn(
        [
          command,
          "--totally-silent",
          "--force",
          "-8",
          "--no-exhaustive-model-search",
          "--threads=1",
          "--no-padding",
          "--no-seektable",
          "--force-raw-format",
          "--endian=little",
          "--sign=signed",
          "--channels=2",
          "--bps=24",
          "--sample-rate=44100",
          `--output-name=${nativePath}`,
          rawPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const nativeStderr = new Response(native.stderr).text();
      expect(await native.exited, await nativeStderr).toBe(0);
      const nativeBytes = (await stat(nativePath)).size;
      expect(encoded.byteLength).toBeLessThanOrEqual(
        Math.ceil(nativeBytes * 1.02),
      );

      const analyze = Bun.spawn(
        [
          command,
          "--analyze",
          "--force",
          `--output-name=${analysisPath}`,
          wasmPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const analyzeStderr = new Response(analyze.stderr).text();
      expect(await analyze.exited, await analyzeStderr).toBe(0);
      const analysis = await readFile(analysisPath, "utf8");
      expect(analysis).toMatch(/type=LPC\s+order=(?:[2-9]|1[0-2])\b/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
