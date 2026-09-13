import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const sourceArchive = resolve(
  repository,
  "vendor/libflac-1.5.0/flac-1.5.0.tar.xz",
);
const wrapperSource = resolve(repository, "native/encoder.c");
const asset = resolve(repository, "wasm/flac-encoder.wasm");
const manifestPath = resolve(repository, "wasm/flac-encoder.manifest.json");
const buildRoot = resolve(repository, ".cache/flac-encoder-build");
const sourceRoot = resolve(buildRoot, "flac-1.5.0");
const emscriptenRoot =
  process.env.CODEC_EMSCRIPTEN_ROOT ??
  "/data/codec-tooling/emsdk/upstream/emscripten";
const emcc = resolve(emscriptenRoot, "emcc");
const emconfigure = resolve(emscriptenRoot, "emconfigure");
const wasmLd = resolve(emscriptenRoot, "../bin/wasm-ld");
const wasmOpt = resolve(emscriptenRoot, "../bin/wasm-opt");
const sysroot = resolve(emscriptenRoot, "cache/sysroot");
const musl = resolve(emscriptenRoot, "system/lib/libc/musl");
const emsdkRoot = resolve(emscriptenRoot, "../..");

const SOURCE_SHA256 =
  "f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920";
const EMCC_VERSION = "6.0.9";
const EMCC_COMMIT = "4e4223852a0835923411059a3929907d7df1232e";
const SDK_TAG_COMMIT = "5eb0bde7585670252e8ba05e9d361627bffd08b5";
const SDK_RELEASES_COMMIT = "f04ea239d533260dd1db760dd2d668d5f9a88d6b";
const WASM_OPT_VERSION = "wasm-opt version 132 (version_132-49-gd03c25ea4)";
const MEMORY_BYTES = 16 * 1024 * 1024;
const STACK_BYTES = 256 * 1024;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const run = async (
  command: string,
  args: ReadonlyArray<string>,
  cwd = repository,
  env: Record<string, string> = {},
): Promise<string> => {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) {
    throw new Error(`${command} exited ${status}\n${stdout}${stderr}`);
  }
  if (stderr.length > 0) process.stderr.write(stderr);
  return stdout;
};

const main = async (): Promise<void> => {
  const mode = process.argv[2];
  if (mode !== "--verify" && mode !== "--update") {
    throw new Error("usage: bun run scripts/build-wasm.ts --verify|--update");
  }

  const archiveBytes = new Uint8Array(await readFile(sourceArchive));
  const archiveHash = sha256(archiveBytes);
  if (archiveHash !== SOURCE_SHA256) {
    throw new Error(`libFLAC source SHA-256 mismatch: ${archiveHash}`);
  }

  const version = await run(emcc, ["--version"]);
  if (
    !version.includes(
      `emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${EMCC_VERSION}`,
    ) ||
    !version.includes(EMCC_COMMIT)
  ) {
    throw new Error(`unexpected compiler version:\n${version}`);
  }
  const sdkCommit = (await run("git", ["rev-parse", "HEAD"], emsdkRoot)).trim();
  if (sdkCommit !== SDK_TAG_COMMIT) {
    throw new Error(`unexpected emsdk revision: ${sdkCommit}`);
  }
  const releaseTags = JSON.parse(
    await readFile(resolve(emsdkRoot, "emscripten-releases-tags.json"), "utf8"),
  ) as {
    readonly releases?: Readonly<Record<string, unknown>>;
  };
  if (releaseTags.releases?.[EMCC_VERSION] !== SDK_RELEASES_COMMIT) {
    throw new Error(
      `emsdk release map does not pin ${EMCC_VERSION} to ${SDK_RELEASES_COMMIT}`,
    );
  }
  const wasmOptVersion = (await run(wasmOpt, ["--version"])).trim();
  if (wasmOptVersion !== WASM_OPT_VERSION) {
    throw new Error(`unexpected wasm-opt version: ${wasmOptVersion}`);
  }

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await run("tar", ["-xJf", sourceArchive, "-C", buildRoot]);
  await chmod(resolve(sourceRoot, "configure"), 0o755);
  await run(
    "patch",
    ["-p1", "-i", resolve(repository, "native/libflac-stream-only.patch")],
    sourceRoot,
  );

  const reproducibleEnv = {
    SOURCE_DATE_EPOCH: "1735689600",
    ZERO_AR_DATE: "1",
    CFLAGS: "-O3 -DCODEC_STREAM_ONLY=1",
  };
  await run(
    emconfigure,
    [
      "./configure",
      "--host=wasm32-unknown-emscripten",
      "--disable-shared",
      "--enable-static",
      "--disable-asm-optimizations",
      "--disable-avx",
      "--disable-cpplibs",
      "--disable-ogg",
      "--disable-oggtest",
      "--disable-programs",
      "--disable-examples",
      "--disable-multithreading",
      "--disable-doxygen-docs",
      "--disable-dependency-tracking",
      "--disable-version-from-git",
    ],
    sourceRoot,
    reproducibleEnv,
  );
  const objectRoot = resolve(buildRoot, "objects");
  await mkdir(objectRoot, { recursive: true });
  const includeFlags = [
    `-I${sourceRoot}`,
    `-I${resolve(sourceRoot, "include")}`,
    `-I${resolve(sourceRoot, "src/libFLAC/include")}`,
  ];
  const commonCompileFlags = [
    "-O3",
    "-ffreestanding",
    "-fno-builtin",
    "-DFLAC__NO_DLL",
    "-DHAVE_CONFIG_H",
    "-DCODEC_STREAM_ONLY=1",
    ...includeFlags,
  ];
  const flacUnits = [
    "bitmath",
    "bitreader",
    "bitwriter",
    "cpu",
    "crc",
    "fixed",
    "float",
    "format",
    "lpc",
    "md5",
    "memory",
    "stream_decoder",
    "stream_encoder",
    "stream_encoder_framing",
    "window",
  ] as const;
  const objects: Array<string> = [];
  for (const unit of flacUnits) {
    const object = resolve(objectRoot, `flac-${unit}.o`);
    await run(
      emcc,
      [
        ...commonCompileFlags,
        "-c",
        resolve(sourceRoot, `src/libFLAC/${unit}.c`),
        "-o",
        object,
      ],
      repository,
      reproducibleEnv,
    );
    objects.push(object);
  }
  const wrapperObject = resolve(objectRoot, "encoder.o");
  await run(
    emcc,
    [...commonCompileFlags, "-c", wrapperSource, "-o", wrapperObject],
    repository,
    reproducibleEnv,
  );
  objects.unshift(wrapperObject);

  const muslUnits = [
    "string/memcpy",
    "string/memmove",
    "string/memset",
    "string/memcmp",
    "string/strcmp",
    "string/strlen",
    "stdlib/abs",
    "stdlib/qsort",
    "stdlib/qsort_nr",
    "math/log",
    "math/log_data",
    "math/exp",
    "math/exp_data",
    "math/frexp",
    "math/lround",
    "math/round",
    "math/floor",
    "math/cosf",
    "math/fabs",
    "math/fabsf",
    "math/scalbn",
    "math/__cosdf",
    "math/__sindf",
    "math/__rem_pio2f",
    "math/__rem_pio2_large",
    "math/__math_uflow",
    "math/__math_oflow",
    "math/__math_divzero",
    "math/__math_invalid",
    "math/__math_xflow",
  ] as const;
  const muslIncludeFlags = [
    `-I${resolve(musl, "src/include")}`,
    `-I${resolve(musl, "src/internal")}`,
    `-I${resolve(musl, "arch/emscripten")}`,
    `-I${resolve(musl, "arch/generic")}`,
  ];
  for (const unit of muslUnits) {
    const object = resolve(objectRoot, `musl-${unit.replaceAll("/", "-")}.o`);
    await run(
      emcc,
      [
        "-O3",
        "-ffreestanding",
        "-fno-builtin",
        ...muslIncludeFlags,
        "-c",
        resolve(musl, `src/${unit}.c`),
        "-o",
        object,
      ],
      repository,
      reproducibleEnv,
    );
    objects.push(object);
  }

  const rawOutput = resolve(buildRoot, "flac-encoder.raw.wasm");
  const output = resolve(buildRoot, "flac-encoder.wasm");
  const allowedUndefined = resolve(buildRoot, "allowed-undefined.txt");
  await writeFile(allowedUndefined, "codec_seek\ncodec_write\n");
  await run(
    wasmLd,
    [
      "--no-entry",
      `--allow-undefined-file=${allowedUndefined}`,
      "--import-undefined",
      "--export-memory",
      `--initial-memory=${MEMORY_BYTES}`,
      `--max-memory=${MEMORY_BYTES}`,
      "--stack-first",
      `-zstack-size=${STACK_BYTES}`,
      "--strip-all",
      "--export=malloc",
      "--export=free",
      "--export=codec_encoder_new",
      "--export=codec_encoder_init",
      "--export=codec_encoder_process_interleaved",
      "--export=codec_encoder_finish",
      "--export=codec_encoder_state",
      "--export=codec_encoder_delete",
      "-o",
      rawOutput,
      ...objects,
      resolve(sysroot, "lib/wasm32-emscripten/libemmalloc.a"),
      resolve(sysroot, "lib/wasm32-emscripten/libclang_rt.builtins.a"),
    ],
    repository,
    reproducibleEnv,
  );
  await run(wasmOpt, [
    rawOutput,
    "--enable-bulk-memory",
    "--enable-nontrapping-float-to-int",
    "-O3",
    "--strip-debug",
    "-o",
    output,
  ]);

  const outputBytes = new Uint8Array(await readFile(output));
  if (outputBytes.byteLength > 256 * 1024) {
    throw new Error(
      `encoder Wasm exceeds 256 KiB objective: ${outputBytes.byteLength}`,
    );
  }
  const outputHash = sha256(outputBytes);
  const imports = WebAssembly.Module.imports(
    await WebAssembly.compile(outputBytes),
  )
    .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
    .sort();
  const expectedImports = ["codec.seek:function", "codec.write:function"];
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
    throw new Error(`unexpected Wasm imports: ${imports.join(", ")}`);
  }
  const exports = WebAssembly.Module.exports(
    await WebAssembly.compile(outputBytes),
  )
    .map(({ name, kind }) => `${name}:${kind}`)
    .sort();
  const expectedExports = [
    "__em_lib_deps__em_malloc_deps:global",
    "codec_encoder_delete:function",
    "codec_encoder_finish:function",
    "codec_encoder_init:function",
    "codec_encoder_new:function",
    "codec_encoder_process_interleaved:function",
    "codec_encoder_state:function",
    "free:function",
    "malloc:function",
    "memory:memory",
  ];
  if (JSON.stringify(exports) !== JSON.stringify(expectedExports)) {
    throw new Error(`unexpected Wasm exports: ${exports.join(", ")}`);
  }

  const patchHash = sha256(
    new Uint8Array(
      await readFile(resolve(repository, "native/libflac-stream-only.patch")),
    ),
  );
  const wrapperSha256 = sha256(new Uint8Array(await readFile(wrapperSource)));
  const manifest = {
    asset: "flac-encoder.wasm",
    assetSha256: outputHash,
    libflac: {
      version: "1.5.0",
      archive: "vendor/libflac-1.5.0/flac-1.5.0.tar.xz",
      archiveSha256: SOURCE_SHA256,
      patch: "native/libflac-stream-only.patch",
      patchSha256: patchHash,
    },
    sources: {
      wrapper: "native/encoder.c",
      wrapperSha256,
    },
    emscripten: {
      version: EMCC_VERSION,
      compilerCommit: EMCC_COMMIT,
      sdkTagCommit: SDK_TAG_COMMIT,
      sdkReleasesCommit: SDK_RELEASES_COMMIT,
      wasmOptVersion: WASM_OPT_VERSION,
    },
    build: {
      initialMemoryBytes: MEMORY_BYTES,
      maximumMemoryBytes: MEMORY_BYTES,
      stackBytes: STACK_BYTES,
      filesystem: false,
      memoryGrowth: false,
      imports: expectedImports,
      exports: expectedExports,
      libflacUnits: flacUnits,
      muslUnits,
      compilerFlags: [
        "-O3",
        "-ffreestanding",
        "-fno-builtin",
        "-DFLAC__NO_DLL",
        "-DHAVE_CONFIG_H",
        "-DCODEC_STREAM_ONLY=1",
      ],
      linkerPolicy: {
        allowedUndefinedSymbols: ["codec_seek", "codec_write"],
        noEntry: true,
        stripAll: true,
      },
    },
  } as const;
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;

  if (mode === "--update") {
    await mkdir(dirname(asset), { recursive: true });
    await copyFile(output, asset);
    await writeFile(manifestPath, serializedManifest);
    process.stdout.write(`updated wasm/flac-encoder.wasm (${outputHash})\n`);
    return;
  }

  const [checkedAsset, checkedManifest] = await Promise.all([
    readFile(asset),
    readFile(manifestPath, "utf8"),
  ]);
  if (
    sha256(checkedAsset) !== outputHash ||
    checkedManifest !== serializedManifest
  ) {
    throw new Error(
      "rebuilt encoder Wasm does not match the checked-in asset/manifest; run build:wasm:update intentionally",
    );
  }
  process.stdout.write(
    `verified reproducible wasm/flac-encoder.wasm (${outputHash})\n`,
  );
};

await main();
