import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  copyFile,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  FLAC_ENCODER_WASM_SHA256,
  FLAC_ENCODER_WASM_URL,
  FlacEncoder,
  PcmFormat,
  encodeFlac,
  type RandomAccessByteSink,
} from "../src/index.js";
import {
  decodeFlac,
  type FlacDecodeComplete,
  type FlacMetadata,
} from "../src/decode.js";
import {
  FLAC_DECODER_WASM_SHA256,
  FLAC_DECODER_WASM_URL,
  FlacDecoder,
  loadFlacDecoderFromBytes,
} from "../src/decoder-wasm.js";
import { loadFlacEncoderFromBytes } from "../src/wasm.js";

const EXPECTED_STEMS = 30;
const EXPECTED_CHUNKS = 137;
const EXPECTED_BASELINE_PAYLOAD_BYTES = 425_690_361;
const EXPECTED_BASELINE_MANIFEST_BYTES = 78_215;
const EXPECTED_BASELINE_CONTAINER_BYTES = 480;
const EXPECTED_RELEASE_REVISION = "aab52d13309a191494bcb02dc706519c31bc1a97";
const PCM_FRAMES_PER_READ = 4_096;
const FLAC_FRAGMENT_PATTERN = [
  1, 2, 3, 5, 7, 31, 257, 4_093, 65_521, 262_139,
] as const;

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0)
    throw new Error("cannot calculate a median without values");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle]!;
};

const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);

const ChunkManifest = Schema.Struct({
  bytes: Schema.Natural,
  flacSha256: Sha256,
  frames: Schema.Natural,
  offset: Schema.Natural,
  packedStartFrame: Schema.Natural,
  pcmSha256: Sha256,
});

const StemManifest = Schema.Struct({
  bitDepth: Schema.Literal(24),
  channels: Schema.Literal(2),
  chunks: Schema.Array(ChunkManifest),
  format: Schema.Literal("miso_sparse_stem_v1"),
  frames: Schema.Natural,
  identity: Schema.String,
  sampleRateHz: Schema.Literal(44_100),
});

const SourcesCatalog = Schema.Struct({
  format: Schema.Literal("issue77-source-catalog-v1"),
  release: Schema.Struct({
    repository: Schema.String,
    revision: Schema.String,
    path: Schema.String,
    sha256: Sha256,
  }),
  stems: Schema.Array(
    Schema.Struct({
      identity: Schema.String,
      shape: Schema.Struct({
        sampleRateHz: Schema.Literal(44_100),
        channels: Schema.Literal(2),
        bitDepth: Schema.Literal(24),
        frames: Schema.Natural,
      }),
      chunkCount: Schema.Natural,
    }),
  ),
});

class BenchmarkError extends Schema.TaggedError<BenchmarkError>()(
  "BenchmarkError",
  {
    phase: Schema.Literals([
      "arguments",
      "corpus",
      "input",
      "wasm",
      "native-encode",
      "native-decode",
      "verify",
      "receipt",
    ]),
    detail: Schema.String,
    path: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

interface Arguments {
  readonly corpus: string;
  readonly sources: string;
  readonly nativeFlac: string;
  readonly receipt: string;
  readonly rounds: number;
  readonly limit: number | undefined;
  readonly keepWasm: string | undefined;
}

interface CorpusChunk {
  readonly stemIdentity: string;
  readonly chunkIndex: number;
  readonly activeRawPath: string;
  readonly sourceManifestPath: string;
  readonly retainedFlacPath: string;
  readonly expectedFlacSha256: string;
  readonly packedStartFrame: number;
  readonly frames: number;
  readonly expectedPcmSha256: string;
  readonly retainedFlacBytes: number;
}

interface InputDigest {
  readonly bytes: number;
  readonly sha256: string;
  readonly md5: string;
}

interface StreamInfo {
  readonly minimumBlockSize: number;
  readonly maximumBlockSize: number;
  readonly minimumFrameSize: number;
  readonly maximumFrameSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly totalFrames: string;
  readonly md5Hex: string;
}

interface MeasurementRow {
  readonly implementation: "wasm" | "native";
  readonly round: number;
  readonly stemIdentity: string;
  readonly chunkIndex: number;
  readonly frames: number;
  readonly expectedPcmSha256: string;
  readonly encodedBytes: number;
  readonly elapsedMilliseconds: number;
  readonly streamInfo: StreamInfo;
  readonly nativeDecodedPcmSha256: string;
}

interface DecodeQualificationRow {
  readonly stemIdentity: string;
  readonly chunkIndex: number;
  readonly encodedBytes: number;
  readonly frames: number;
  readonly pcmBytes: number;
  readonly pcmBlocks: number;
  readonly maximumPcmBlockBytes: number;
  readonly pcmSha256: string;
  readonly metadataMd5Present: boolean;
  readonly completeMd5Checked: boolean;
  readonly completeMd5Verified: boolean;
}

const fail = (
  phase: BenchmarkError["phase"],
  detail: string,
  fields: { readonly path?: string; readonly cause?: unknown } = {},
): BenchmarkError => new BenchmarkError({ phase, detail, ...fields });

const parseArguments = (argv: ReadonlyArray<string>): Arguments => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw fail(
        "arguments",
        `expected --name value pairs, received ${argv.join(" ")}`,
      );
    }
    values.set(name.slice(2), value);
  }

  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) {
      throw fail("arguments", `missing --${name}`);
    }
    return value;
  };
  const positiveInteger = (name: string, fallback?: number): number => {
    const text = values.get(name);
    if (text === undefined && fallback !== undefined) return fallback;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw fail("arguments", `--${name} must be a positive safe integer`);
    }
    return value;
  };

  return {
    corpus: required("corpus"),
    sources: required("sources"),
    nativeFlac: required("native-flac"),
    receipt: required("receipt"),
    rounds: positiveInteger("rounds", 3),
    limit: values.has("limit") ? positiveInteger("limit") : undefined,
    keepWasm: values.get("keep-wasm"),
  };
};

const readUnknownJson = (
  path: string,
): Effect.Effect<unknown, BenchmarkError> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
    catch: (cause) =>
      fail("corpus", "could not read or parse JSON", { path, cause }),
  });

const decodeJson = <A, I, R>(
  schema: Schema.Codec<A, I, R, never>,
  path: string,
): Effect.Effect<A, BenchmarkError, R> =>
  readUnknownJson(path).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) =>
      cause instanceof BenchmarkError
        ? cause
        : fail("corpus", `JSON failed schema validation: ${String(cause)}`, {
            path,
            cause,
          }),
    ),
  );

const discoverCorpus = Effect.fn("benchmark.discoverCorpus")(function* (
  args: Arguments,
): Effect.fn.Return<ReadonlyArray<CorpusChunk>, BenchmarkError> {
  const catalog = yield* decodeJson(SourcesCatalog, args.sources);
  if (catalog.release.revision !== EXPECTED_RELEASE_REVISION) {
    return yield* fail(
      "corpus",
      `source catalog release is ${catalog.release.revision}; expected ${EXPECTED_RELEASE_REVISION}`,
      { path: args.sources },
    );
  }
  const entries = yield* Effect.tryPromise({
    try: () => readdir(args.corpus, { withFileTypes: true }),
    catch: (cause) =>
      fail("corpus", "could not enumerate corpus", {
        path: args.corpus,
        cause,
      }),
  });
  const stemIds = entries
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const catalogIds = new Set(
    catalog.stems.map((stem) => stem.identity.replace(/^sha256:/, "")),
  );
  const chunks: Array<CorpusChunk> = [];
  for (const stemId of stemIds) {
    if (!catalogIds.has(stemId)) continue;
    const manifestPath = join(
      args.corpus,
      stemId,
      "flac8-30s",
      "manifest.json",
    );
    const activeRawPath = join(args.corpus, stemId, "active.raw");
    const manifest = yield* decodeJson(StemManifest, manifestPath);
    if (manifest.identity !== `sha256:${stemId}`) {
      return yield* fail(
        "corpus",
        "manifest identity does not match its directory",
        {
          path: manifestPath,
        },
      );
    }
    const catalogStem = catalog.stems.find(
      (stem) => stem.identity === manifest.identity,
    );
    if (
      catalogStem === undefined ||
      catalogStem.chunkCount !== manifest.chunks.length
    ) {
      return yield* fail(
        "corpus",
        "source catalog and candidate chunk count differ",
        {
          path: manifestPath,
        },
      );
    }
    let packedFrameCursor = 0;
    for (const chunk of manifest.chunks) {
      if (
        !Number.isSafeInteger(chunk.frames) ||
        !Number.isSafeInteger(chunk.packedStartFrame) ||
        chunk.packedStartFrame !== packedFrameCursor
      ) {
        return yield* fail(
          "corpus",
          "candidate chunks are not contiguous safe PCM ranges",
          {
            path: manifestPath,
          },
        );
      }
      packedFrameCursor += chunk.frames;
    }
    const activeRaw = yield* Effect.tryPromise({
      try: () => stat(activeRawPath),
      catch: (cause) =>
        fail("corpus", "could not stat active PCM", {
          path: activeRawPath,
          cause,
        }),
    });
    if (activeRaw.size !== packedFrameCursor * 6) {
      return yield* fail(
        "corpus",
        `active PCM has ${activeRaw.size} bytes; chunks require ${packedFrameCursor * 6}`,
        { path: activeRawPath },
      );
    }
    manifest.chunks.forEach((chunk, chunkIndex) => {
      chunks.push({
        stemIdentity: manifest.identity,
        chunkIndex,
        activeRawPath,
        sourceManifestPath: manifestPath,
        retainedFlacPath: join(
          args.corpus,
          stemId,
          "flac8-30s",
          `${chunkIndex}.flac`,
        ),
        expectedFlacSha256: chunk.flacSha256,
        packedStartFrame: chunk.packedStartFrame,
        frames: chunk.frames,
        expectedPcmSha256: chunk.pcmSha256,
        retainedFlacBytes: chunk.bytes,
      });
    });
  }

  if (stemIds.length !== EXPECTED_STEMS || chunks.length !== EXPECTED_CHUNKS) {
    return yield* fail(
      "corpus",
      `expected ${EXPECTED_STEMS} stems/${EXPECTED_CHUNKS} chunks, found ${stemIds.length}/${chunks.length}`,
      { path: args.corpus },
    );
  }
  const retainedPayload = chunks.reduce(
    (total, chunk) => total + chunk.retainedFlacBytes,
    0,
  );
  if (retainedPayload !== EXPECTED_BASELINE_PAYLOAD_BYTES) {
    return yield* fail(
      "corpus",
      `retained payload is ${retainedPayload}, expected ${EXPECTED_BASELINE_PAYLOAD_BYTES}`,
      { path: args.corpus },
    );
  }
  return args.limit === undefined ? chunks : chunks.slice(0, args.limit);
});

const readExact = async (
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Uint8Array> => {
  const bytes = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const read = await handle.read(
      bytes,
      filled,
      length - filled,
      position + filled,
    );
    if (read.bytesRead === 0) {
      throw new Error(
        `unexpected EOF at ${position + filled}; needed ${length - filled} bytes`,
      );
    }
    filled += read.bytesRead;
  }
  return bytes;
};

const hashPcmRange = (
  chunk: CorpusChunk,
): Effect.Effect<InputDigest, BenchmarkError> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(chunk.activeRawPath, "r");
      const sha256 = createHash("sha256");
      const md5 = createHash("md5");
      const bytesPerFrame = 6;
      let position = chunk.packedStartFrame * bytesPerFrame;
      let remaining = chunk.frames * bytesPerFrame;
      try {
        while (remaining > 0) {
          const length = Math.min(
            remaining,
            PCM_FRAMES_PER_READ * bytesPerFrame,
          );
          const bytes = await readExact(handle, position, length);
          sha256.update(bytes);
          md5.update(bytes);
          position += length;
          remaining -= length;
        }
      } finally {
        await handle.close();
      }
      return {
        bytes: chunk.frames * bytesPerFrame,
        sha256: sha256.digest("hex"),
        md5: md5.digest("hex"),
      };
    },
    catch: (cause) =>
      fail("input", "could not hash PCM source range", {
        path: chunk.activeRawPath,
        cause,
      }),
  });

const pcmSource = (
  chunk: CorpusChunk,
): Stream.Stream<Int32Array, BenchmarkError> => {
  const iterable: AsyncIterable<Int32Array> = {
    async *[Symbol.asyncIterator]() {
      const handle = await open(chunk.activeRawPath, "r");
      let frameOffset = chunk.packedStartFrame;
      let remainingFrames = chunk.frames;
      try {
        while (remainingFrames > 0) {
          const frames = Math.min(remainingFrames, PCM_FRAMES_PER_READ);
          const packed = await readExact(handle, frameOffset * 6, frames * 6);
          const samples = new Int32Array(frames * 2);
          for (let index = 0; index < samples.length; index += 1) {
            const byteOffset = index * 3;
            const low = packed[byteOffset];
            const middle = packed[byteOffset + 1];
            const high = packed[byteOffset + 2];
            if (
              low === undefined ||
              middle === undefined ||
              high === undefined
            ) {
              throw new Error(`misaligned PCM at sample ${index}`);
            }
            const unsigned = low | (middle << 8) | (high << 16);
            samples[index] =
              (unsigned & 0x80_0000) === 0 ? unsigned : unsigned | 0xff00_0000;
          }
          yield samples;
          frameOffset += frames;
          remainingFrames -= frames;
        }
      } finally {
        await handle.close();
      }
    },
  };
  return Stream.fromAsyncIterable(iterable, (cause) =>
    cause instanceof BenchmarkError
      ? cause
      : fail("input", "PCM source stream failed", {
          path: chunk.activeRawPath,
          cause,
        }),
  );
};

const fragmentedFlacSource = (
  path: string,
): Stream.Stream<Uint8Array, BenchmarkError> => {
  const iterable: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      const handle = await open(path, "r");
      let position = 0;
      let fragmentIndex = 0;
      try {
        const file = await handle.stat();
        while (position < file.size) {
          const requested =
            FLAC_FRAGMENT_PATTERN[
              fragmentIndex % FLAC_FRAGMENT_PATTERN.length
            ]!;
          const length = Math.min(requested, file.size - position);
          yield await readExact(handle, position, length);
          position += length;
          fragmentIndex += 1;
        }
      } finally {
        await handle.close();
      }
    },
  };
  return Stream.fromAsyncIterable(iterable, (cause) =>
    cause instanceof BenchmarkError
      ? cause
      : fail("input", "fragmented FLAC source failed", { path, cause }),
  );
};

const verifyPackageDecode = Effect.fn("benchmark.verifyPackageDecode")(
  function* (
    format: PcmFormat,
    chunk: CorpusChunk,
  ): Effect.fn.Return<
    DecodeQualificationRow,
    BenchmarkError | import("../src/decoder-errors.js").FlacDecodeError,
    FlacDecoder
  > {
    const flacSha256 = yield* sha256File(chunk.retainedFlacPath);
    if (flacSha256 !== chunk.expectedFlacSha256) {
      return yield* fail(
        "input",
        "retained FLAC hash does not match manifest",
        {
          path: chunk.retainedFlacPath,
        },
      );
    }
    const digest = createHash("sha256");
    let metadata: FlacMetadata | undefined;
    let complete: FlacDecodeComplete | undefined;
    let expectedFrameOffset = 0n;
    let pcmBytes = 0;
    let pcmBlocks = 0;
    let maximumPcmBlockBytes = 0;
    yield* Stream.runForEach(
      decodeFlac(fragmentedFlacSource(chunk.retainedFlacPath), {
        expectedFormat: format,
        expectedFrames: BigInt(chunk.frames),
      }),
      (event) => {
        if (event._tag === "Metadata") {
          if (
            metadata !== undefined ||
            pcmBlocks !== 0 ||
            complete !== undefined ||
            event.format.sampleRate !== format.sampleRate ||
            event.format.channels !== format.channels ||
            event.format.bitsPerSample !== format.bitsPerSample ||
            event.totalFrames !== BigInt(chunk.frames)
          ) {
            return Effect.fail(
              fail("verify", "decoder emitted invalid or misplaced metadata", {
                path: chunk.retainedFlacPath,
              }),
            );
          }
          metadata = event;
          return Effect.void;
        }
        if (event._tag === "Pcm") {
          if (
            metadata === undefined ||
            complete !== undefined ||
            event.frameOffset !== expectedFrameOffset ||
            event.bytes.byteLength !== event.frames * 6
          ) {
            return Effect.fail(
              fail(
                "verify",
                "decoder emitted invalid PCM event ordering or shape",
                {
                  path: chunk.retainedFlacPath,
                },
              ),
            );
          }
          digest.update(event.bytes);
          expectedFrameOffset += BigInt(event.frames);
          pcmBytes += event.bytes.byteLength;
          pcmBlocks += 1;
          maximumPcmBlockBytes = Math.max(
            maximumPcmBlockBytes,
            event.bytes.byteLength,
          );
          return Effect.void;
        }
        if (
          metadata === undefined ||
          complete !== undefined ||
          event.frames !== BigInt(chunk.frames) ||
          event.bytes !== BigInt(chunk.frames * 6)
        ) {
          return Effect.fail(
            fail("verify", "decoder emitted invalid completion", {
              path: chunk.retainedFlacPath,
            }),
          );
        }
        complete = event;
        return Effect.void;
      },
    );
    const pcmSha256 = digest.digest("hex");
    if (
      metadata === undefined ||
      complete === undefined ||
      expectedFrameOffset !== BigInt(chunk.frames) ||
      pcmBytes !== chunk.frames * 6 ||
      pcmSha256 !== chunk.expectedPcmSha256 ||
      !metadata.md5Present ||
      !complete.md5Checked ||
      !complete.md5Verified
    ) {
      return yield* fail(
        "verify",
        "package decoder did not produce one fully verified PCM stream",
        {
          path: chunk.retainedFlacPath,
        },
      );
    }
    return {
      stemIdentity: chunk.stemIdentity,
      chunkIndex: chunk.chunkIndex,
      encodedBytes: chunk.retainedFlacBytes,
      frames: chunk.frames,
      pcmBytes,
      pcmBlocks,
      maximumPcmBlockBytes,
      pcmSha256,
      metadataMd5Present: metadata.md5Present,
      completeMd5Checked: complete.md5Checked,
      completeMd5Verified: complete.md5Verified,
    };
  },
);

const safePosition = (offset: bigint): number => {
  const position = Number(offset);
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error(`unsafe output offset ${offset}`);
  }
  return position;
};

const makeFileSink = (
  handle: FileHandle,
  path: string,
): RandomAccessByteSink<BenchmarkError, never> => ({
  writeAt: (offset, bytes) =>
    Effect.tryPromise({
      try: async () => {
        const position = safePosition(offset);
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            position + written,
          );
          if (result.bytesWritten === 0)
            throw new Error("zero-byte positional write");
          written += result.bytesWritten;
        }
      },
      catch: (cause) =>
        fail("wasm", "seekable output write failed", { path, cause }),
    }),
  resize: (length) =>
    Effect.tryPromise({
      try: () => handle.truncate(safePosition(length)),
      catch: (cause) =>
        fail("wasm", "seekable output resize failed", { path, cause }),
    }),
});

const withFileSink = <A, E, R>(
  path: string,
  use: (
    sink: RandomAccessByteSink<BenchmarkError, never>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, BenchmarkError | E, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, "w+"),
      catch: (cause) =>
        fail("wasm", "could not open seekable output", { path, cause }),
    }),
    (handle) => use(makeFileSink(handle, path)),
    (handle) => Effect.promise(() => handle.close()),
  );

const parseStreamInfo = (
  path: string,
): Effect.Effect<StreamInfo, BenchmarkError> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, "r");
      let bytes: Uint8Array;
      try {
        bytes = await readExact(handle, 0, 42);
      } finally {
        await handle.close();
      }
      if (String.fromCharCode(...bytes.subarray(0, 4)) !== "fLaC") {
        throw new Error("missing native FLAC marker");
      }
      const metadataHeader = bytes[4];
      const metadataLength =
        ((bytes[5] ?? 0) << 16) | ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0);
      if (
        metadataHeader === undefined ||
        (metadataHeader & 0x7f) !== 0 ||
        metadataLength !== 34
      ) {
        throw new Error("first metadata block is not 34-byte STREAMINFO");
      }
      const packed = bytes.subarray(18, 26);
      let shape = 0n;
      for (const byte of packed) shape = (shape << 8n) | BigInt(byte);
      return {
        minimumBlockSize: ((bytes[8] ?? 0) << 8) | (bytes[9] ?? 0),
        maximumBlockSize: ((bytes[10] ?? 0) << 8) | (bytes[11] ?? 0),
        minimumFrameSize:
          ((bytes[12] ?? 0) << 16) | ((bytes[13] ?? 0) << 8) | (bytes[14] ?? 0),
        maximumFrameSize:
          ((bytes[15] ?? 0) << 16) | ((bytes[16] ?? 0) << 8) | (bytes[17] ?? 0),
        sampleRate: Number((shape >> 44n) & 0xf_ffffn),
        channels: Number((shape >> 41n) & 0x7n) + 1,
        bitsPerSample: Number((shape >> 36n) & 0x1fn) + 1,
        totalFrames: String(shape & 0xf_ffff_ffffn),
        md5Hex: Buffer.from(bytes.subarray(26, 42)).toString("hex"),
      };
    },
    catch: (cause) =>
      fail("verify", "could not parse STREAMINFO", { path, cause }),
  });

const sha256File = (path: string): Effect.Effect<string, BenchmarkError> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, "r");
      const digest = createHash("sha256");
      let position = 0;
      try {
        const file = await handle.stat();
        while (position < file.size) {
          const length = Math.min(256 * 1_024, file.size - position);
          digest.update(await readExact(handle, position, length));
          position += length;
        }
      } finally {
        await handle.close();
      }
      return digest.digest("hex");
    },
    catch: (cause) => fail("verify", "could not hash file", { path, cause }),
  });

const runNative = (
  command: ReadonlyArray<string>,
  phase: "native-encode" | "native-decode",
): Effect.Effect<
  { readonly stdout: Uint8Array; readonly stderr: string },
  BenchmarkError
> =>
  Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
      const abort = () => child.kill();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).bytes(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) {
          throw new Error(
            `${basename(command[0] ?? "command")} exited ${exitCode}: ${stderr.slice(0, 4_096)}`,
          );
        }
        return { stdout, stderr };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    catch: (cause) =>
      fail(phase, "native libFLAC command failed", {
        ...(command[0] === undefined ? {} : { path: command[0] }),
        cause,
      }),
  });

const nativeEncode = (
  nativeFlac: string,
  chunk: CorpusChunk,
  outputPath: string,
): Effect.Effect<void, BenchmarkError> =>
  runNative(
    [
      nativeFlac,
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
      `--skip=${chunk.packedStartFrame}`,
      `--until=+${chunk.frames}`,
      `--output-name=${outputPath}`,
      chunk.activeRawPath,
    ],
    "native-encode",
  ).pipe(Effect.asVoid);

const nativeDecodeDigest = (
  nativeFlac: string,
  inputPath: string,
): Effect.Effect<
  { readonly bytes: number; readonly sha256: string },
  BenchmarkError
> =>
  Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn(
        [
          nativeFlac,
          "--totally-silent",
          "--decode",
          "--stdout",
          "--force-raw-format",
          "--endian=little",
          "--sign=signed",
          inputPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const abort = () => child.kill();
      signal.addEventListener("abort", abort, { once: true });
      const digest = createHash("sha256");
      let bytes = 0;
      try {
        const stderrPromise = new Response(child.stderr).text();
        const reader = child.stdout.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            digest.update(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          stderrPromise,
        ]);
        if (exitCode !== 0) {
          throw new Error(
            `flac decode exited ${exitCode}: ${stderr.slice(0, 4_096)}`,
          );
        }
        return { bytes, sha256: digest.digest("hex") };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    catch: (cause) =>
      fail("native-decode", "native libFLAC decode failed", {
        path: inputPath,
        cause,
      }),
  });

const validateOutput = Effect.fn("benchmark.validateOutput")(function* (
  nativeFlac: string,
  chunk: CorpusChunk,
  input: InputDigest,
  outputPath: string,
): Effect.fn.Return<
  {
    readonly bytes: number;
    readonly streamInfo: StreamInfo;
    readonly nativeDecodedPcmSha256: string;
  },
  BenchmarkError
> {
  const [file, streamInfo, decoded] = yield* Effect.all(
    [
      Effect.tryPromise({
        try: () => stat(outputPath),
        catch: (cause) =>
          fail("verify", "could not stat encoded FLAC", {
            path: outputPath,
            cause,
          }),
      }),
      parseStreamInfo(outputPath),
      nativeDecodeDigest(nativeFlac, outputPath),
    ],
    { concurrency: 2 },
  );
  if (
    streamInfo.sampleRate !== 44_100 ||
    streamInfo.channels !== 2 ||
    streamInfo.bitsPerSample !== 24
  ) {
    return yield* fail(
      "verify",
      "STREAMINFO format does not match corpus PCM",
      { path: outputPath },
    );
  }
  if (streamInfo.totalFrames !== String(chunk.frames)) {
    return yield* fail("verify", "STREAMINFO total frames do not match chunk", {
      path: outputPath,
    });
  }
  if (streamInfo.md5Hex !== input.md5) {
    return yield* fail("verify", "STREAMINFO MD5 does not match source PCM", {
      path: outputPath,
    });
  }
  if (
    decoded.bytes !== input.bytes ||
    decoded.sha256 !== chunk.expectedPcmSha256
  ) {
    return yield* fail("verify", "native decode does not match source PCM", {
      path: outputPath,
    });
  }
  return {
    bytes: file.size,
    streamInfo,
    nativeDecodedPcmSha256: decoded.sha256,
  };
});

const measureWasm = Effect.fn("benchmark.measureWasm")(function* (
  nativeFlac: string,
  format: PcmFormat,
  chunk: CorpusChunk,
  input: InputDigest,
  outputPath: string,
  round: number,
): Effect.fn.Return<
  MeasurementRow,
  | BenchmarkError
  | import("../src/index.js").PcmInputError
  | import("../src/index.js").FlacEncodeError,
  FlacEncoder
> {
  const started = performance.now();
  yield* withFileSink(outputPath, (sink) =>
    encodeFlac(pcmSource(chunk), sink, {
      format,
      expectedFrames: BigInt(chunk.frames),
    }),
  );
  const elapsedMilliseconds = performance.now() - started;
  const verified = yield* validateOutput(nativeFlac, chunk, input, outputPath);
  return {
    implementation: "wasm",
    round,
    stemIdentity: chunk.stemIdentity,
    chunkIndex: chunk.chunkIndex,
    frames: chunk.frames,
    expectedPcmSha256: chunk.expectedPcmSha256,
    encodedBytes: verified.bytes,
    elapsedMilliseconds,
    streamInfo: verified.streamInfo,
    nativeDecodedPcmSha256: verified.nativeDecodedPcmSha256,
  };
});

const measureNative = Effect.fn("benchmark.measureNative")(function* (
  nativeFlac: string,
  chunk: CorpusChunk,
  input: InputDigest,
  outputPath: string,
  round: number,
): Effect.fn.Return<MeasurementRow, BenchmarkError> {
  const started = performance.now();
  yield* nativeEncode(nativeFlac, chunk, outputPath);
  const elapsedMilliseconds = performance.now() - started;
  const verified = yield* validateOutput(nativeFlac, chunk, input, outputPath);
  return {
    implementation: "native",
    round,
    stemIdentity: chunk.stemIdentity,
    chunkIndex: chunk.chunkIndex,
    frames: chunk.frames,
    expectedPcmSha256: chunk.expectedPcmSha256,
    encodedBytes: verified.bytes,
    elapsedMilliseconds,
    streamInfo: verified.streamInfo,
    nativeDecodedPcmSha256: verified.nativeDecodedPcmSha256,
  };
});

const program = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parseArguments(Bun.argv.slice(2)),
    catch: (cause) =>
      cause instanceof BenchmarkError
        ? cause
        : fail("arguments", "could not parse command line", { cause }),
  });
  const chunks = yield* discoverCorpus(args);
  const format = yield* PcmFormat.makeEffect({
    sampleRate: 44_100,
    channels: 2,
    bitsPerSample: 24,
  }).pipe(
    Effect.mapError((cause) =>
      fail("corpus", "could not construct corpus PCM format", { cause }),
    ),
  );

  const wasmPath = FLAC_ENCODER_WASM_URL.pathname;
  const wasmBytes = yield* Effect.tryPromise({
    try: async () => new Uint8Array(await readFile(FLAC_ENCODER_WASM_URL)),
    catch: (cause) =>
      fail("wasm", "could not read encoder Wasm", { path: wasmPath, cause }),
  });
  const wasmSha256 = createHash("sha256").update(wasmBytes).digest("hex");
  const expectedEncoderWasmSha256: string = FLAC_ENCODER_WASM_SHA256;
  if (
    expectedEncoderWasmSha256 !== "pending" &&
    wasmSha256 !== expectedEncoderWasmSha256
  ) {
    return yield* fail("wasm", "encoder Wasm hash differs from exported pin", {
      path: wasmPath,
    });
  }
  const decoderWasmPath = FLAC_DECODER_WASM_URL.pathname;
  const decoderWasmBytes = yield* Effect.tryPromise({
    try: async () => new Uint8Array(await readFile(FLAC_DECODER_WASM_URL)),
    catch: (cause) =>
      fail("wasm", "could not read decoder Wasm", {
        path: decoderWasmPath,
        cause,
      }),
  });
  const decoderWasmSha256 = createHash("sha256")
    .update(decoderWasmBytes)
    .digest("hex");
  const expectedDecoderWasmSha256: string = FLAC_DECODER_WASM_SHA256;
  if (
    expectedDecoderWasmSha256 !== "pending" &&
    decoderWasmSha256 !== expectedDecoderWasmSha256
  ) {
    return yield* fail("wasm", "decoder Wasm hash differs from exported pin", {
      path: decoderWasmPath,
    });
  }
  const decoderCompileStarted = performance.now();
  const decoder = yield* loadFlacDecoderFromBytes(decoderWasmBytes);
  const decoderCompileMilliseconds = performance.now() - decoderCompileStarted;
  const nativeVersionResult = yield* runNative(
    [args.nativeFlac, "--version"],
    "native-encode",
  );
  const nodeVersionResult = yield* runNative(
    ["node", "--version"],
    "native-encode",
  );
  const nativeSha256 = yield* sha256File(args.nativeFlac);
  const sourceCatalogSha256 = yield* sha256File(args.sources);
  const inputDigests = new Map<string, InputDigest>();
  for (const chunk of chunks) {
    const input = yield* hashPcmRange(chunk);
    if (input.sha256 !== chunk.expectedPcmSha256) {
      return yield* fail("input", "source PCM hash does not match manifest", {
        path: chunk.activeRawPath,
      });
    }
    inputDigests.set(`${chunk.stemIdentity}:${chunk.chunkIndex}`, input);
  }
  const decodeQualification: Array<DecodeQualificationRow> = [];
  for (const chunk of chunks) {
    decodeQualification.push(
      yield* verifyPackageDecode(format, chunk).pipe(
        Effect.provideService(FlacDecoder, decoder),
      ),
    );
  }

  const receipt = yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "misofm-codec-benchmark-")),
      catch: (cause) =>
        fail("receipt", "could not create benchmark workspace", { cause }),
    }),
    (workspace) =>
      Effect.gen(function* () {
        const firstChunk = chunks[0];
        if (firstChunk === undefined)
          return yield* fail("corpus", "corpus selection is empty");
        const firstKey = `${firstChunk.stemIdentity}:${firstChunk.chunkIndex}`;
        const firstInput = inputDigests.get(firstKey);
        if (firstInput === undefined)
          return yield* fail("input", `missing digest for ${firstKey}`);
        const coldOutput = join(workspace, "cold-compile-first-chunk.flac");
        const coldStarted = performance.now();
        const encoder = yield* loadFlacEncoderFromBytes(wasmBytes);
        const compiledAt = performance.now();
        yield* withFileSink(coldOutput, (sink) =>
          encodeFlac(pcmSource(firstChunk), sink, {
            format,
            expectedFrames: BigInt(firstChunk.frames),
          }),
        ).pipe(Effect.provideService(FlacEncoder, encoder));
        const coldFinished = performance.now();
        const coldVerified = yield* validateOutput(
          args.nativeFlac,
          firstChunk,
          firstInput,
          coldOutput,
        );

        const rows: Array<MeasurementRow> = [];
        for (let round = 1; round <= args.rounds; round += 1) {
          for (const chunk of chunks) {
            const key = `${chunk.stemIdentity}:${chunk.chunkIndex}`;
            const input = inputDigests.get(key);
            if (input === undefined)
              return yield* fail("input", `missing digest for ${key}`);
            const stemId = chunk.stemIdentity.replace(/^sha256:/, "");
            const wasmOutput = join(
              workspace,
              `${stemId}-${chunk.chunkIndex}-wasm.flac`,
            );
            const nativeOutput = join(
              workspace,
              `${stemId}-${chunk.chunkIndex}-native.flac`,
            );
            const wasmRow = yield* measureWasm(
              args.nativeFlac,
              format,
              chunk,
              input,
              wasmOutput,
              round,
            ).pipe(Effect.provideService(FlacEncoder, encoder));
            rows.push(wasmRow);
            if (
              args.keepWasm !== undefined &&
              round === 1 &&
              chunk === firstChunk
            ) {
              const keepWasm = args.keepWasm;
              yield* Effect.tryPromise({
                try: async () => {
                  await mkdir(dirname(keepWasm), { recursive: true });
                  await copyFile(wasmOutput, keepWasm);
                },
                catch: (cause) =>
                  fail("receipt", "could not retain first Wasm FLAC", {
                    path: keepWasm,
                    cause,
                  }),
              });
            }
            rows.push(
              yield* measureNative(
                args.nativeFlac,
                chunk,
                input,
                nativeOutput,
                round,
              ),
            );
          }
        }

        const totals = Array.from(
          { length: args.rounds },
          (_, index) => index + 1,
        ).flatMap((round) =>
          (["wasm", "native"] as const).map((implementation) => {
            const selected = rows.filter(
              (row) =>
                row.round === round && row.implementation === implementation,
            );
            return {
              round,
              implementation,
              chunks: selected.length,
              encodedBytes: selected.reduce(
                (total, row) => total + row.encodedBytes,
                0,
              ),
              elapsedMilliseconds: selected.reduce(
                (total, row) => total + row.elapsedMilliseconds,
                0,
              ),
            };
          }),
        );
        const wasmTotals = totals.filter(
          (total) => total.implementation === "wasm",
        );
        const nativeTotals = totals.filter(
          (total) => total.implementation === "native",
        );
        const wasmPayloadBytes = wasmTotals[0]?.encodedBytes;
        const nativePayloadBytes = nativeTotals[0]?.encodedBytes;
        if (
          wasmPayloadBytes === undefined ||
          nativePayloadBytes === undefined ||
          wasmTotals.some((total) => total.encodedBytes !== wasmPayloadBytes) ||
          nativeTotals.some(
            (total) => total.encodedBytes !== nativePayloadBytes,
          )
        ) {
          return yield* fail(
            "verify",
            "encoded payload totals changed between serial rounds",
          );
        }
        const wasmMedianMilliseconds = median(
          wasmTotals.map((total) => total.elapsedMilliseconds),
        );
        const nativeMedianMilliseconds = median(
          nativeTotals.map((total) => total.elapsedMilliseconds),
        );
        const payloadDeltaBytes = wasmPayloadBytes - nativePayloadBytes;

        return {
          format: "misofm-codec-corpus-benchmark-v1",
          complete: args.limit === undefined && args.rounds === 3,
          createdAt: new Date().toISOString(),
          configuration: {
            rounds: args.rounds,
            limit: args.limit ?? null,
            retainedFirstWasmOutput: args.keepWasm ?? null,
            level: 8,
            exhaustiveModelSearch: false,
            padding: false,
            seekTable: false,
            verificationInsideTimedIntervals: false,
            pcm24ToInt32ConversionInsideWasmIntervals: true,
            outputWritesInsideTimedIntervals: true,
            nativeProcessStartupInsideTimedIntervals: true,
            wasmPcmFramesPerRead: PCM_FRAMES_PER_READ,
            corpusStemCount: EXPECTED_STEMS,
            corpusChunkCount: EXPECTED_CHUNKS,
          },
          baseline: {
            flacPayloadBytes: EXPECTED_BASELINE_PAYLOAD_BYTES,
            manifestBytes: EXPECTED_BASELINE_MANIFEST_BYTES,
            containerBytes: EXPECTED_BASELINE_CONTAINER_BYTES,
            deliveryBytes:
              EXPECTED_BASELINE_PAYLOAD_BYTES +
              EXPECTED_BASELINE_MANIFEST_BYTES +
              EXPECTED_BASELINE_CONTAINER_BYTES,
          },
          host: {
            bunRuntimeVersion: Bun.version,
            nodeRuntimeVersion: new TextDecoder()
              .decode(nodeVersionResult.stdout)
              .trim(),
            bunNodeCompatibilityVersion: process.version,
            os: `${platform()} ${release()}`,
            cpu: cpus()[0]?.model ?? "unknown",
          },
          provenance: {
            corpusRoot: args.corpus,
            sourcesCatalog: args.sources,
            sourcesCatalogSha256: sourceCatalogSha256,
            nativeFlac: args.nativeFlac,
            nativeFlacSha256: nativeSha256,
            nativeFlacVersion: new TextDecoder()
              .decode(nativeVersionResult.stdout)
              .trim(),
            encoderWasmUrl: FLAC_ENCODER_WASM_URL.href,
            encoderWasmSha256: wasmSha256,
            decoderWasmUrl: FLAC_DECODER_WASM_URL.href,
            decoderWasmSha256,
          },
          decoderCompileMilliseconds,
          decodeQualification,
          cold: {
            stemIdentity: firstChunk.stemIdentity,
            chunkIndex: firstChunk.chunkIndex,
            frames: firstChunk.frames,
            compileMilliseconds: compiledAt - coldStarted,
            compileInstantiateEncodeMilliseconds: coldFinished - coldStarted,
            encodedBytes: coldVerified.bytes,
            nativeDecodedPcmSha256: coldVerified.nativeDecodedPcmSha256,
          },
          summary: {
            selectedChunks: chunks.length,
            selectedFrames: chunks.reduce(
              (total, chunk) => total + chunk.frames,
              0,
            ),
            decoderQualifiedChunks: decodeQualification.length,
            decoderPcmBytes: decodeQualification.reduce(
              (total, row) => total + row.pcmBytes,
              0,
            ),
            decoderPcmBlocks: decodeQualification.reduce(
              (total, row) => total + row.pcmBlocks,
              0,
            ),
            decoderMaximumPcmBlockBytes: decodeQualification.reduce(
              (maximum, row) => Math.max(maximum, row.maximumPcmBlockBytes),
              0,
            ),
            wasmPayloadBytes,
            nativePayloadBytes,
            payloadDeltaBytes,
            payloadDeltaPercent:
              nativePayloadBytes === 0
                ? 0
                : (payloadDeltaBytes / nativePayloadBytes) * 100,
            wasmMedianMilliseconds,
            nativeMedianMilliseconds,
            wasmToNativeMedianTimeRatio:
              nativeMedianMilliseconds === 0
                ? null
                : wasmMedianMilliseconds / nativeMedianMilliseconds,
          },
          totals,
          rows,
        };
      }),
    (workspace) =>
      Effect.tryPromise({
        try: () => rm(workspace, { recursive: true, force: true }),
        catch: (cause) =>
          fail("receipt", "could not remove benchmark workspace", {
            path: workspace,
            cause,
          }),
      }),
  );

  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(args.receipt), { recursive: true });
      await writeFile(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`, {
        flag: "wx",
      });
    },
    catch: (cause) =>
      fail("receipt", "could not write new receipt", {
        path: args.receipt,
        cause,
      }),
  });
  yield* Effect.logInfo("codec corpus benchmark complete", {
    receipt: args.receipt,
    chunks: chunks.length,
    rounds: args.rounds,
  });
});

await Effect.runPromise(program);
