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
const wrapperSource = resolve(repository, "native/decoder.c");
const asset = resolve(repository, "wasm/flac-decoder.wasm");
const manifestPath = resolve(repository, "wasm/flac-decoder.manifest.json");
const buildRoot = resolve(repository, ".cache/flac-decoder-build");
const sourceRoot = resolve(buildRoot, "flac-1.5.0");
const runtimeSource = resolve(repository, "native/decoder-runtime.c");
const emscriptenRoot =
  process.env.CODEC_EMSCRIPTEN_ROOT ??
  "/data/codec-tooling/emsdk/upstream/emscripten";
const emsdkRoot = resolve(emscriptenRoot, "../..");
const emcc = resolve(emscriptenRoot, "emcc");
const emconfigure = resolve(emscriptenRoot, "emconfigure");
const wasmLd = resolve(emscriptenRoot, "../bin/wasm-ld");
const wasmOpt = resolve(emscriptenRoot, "../bin/wasm-opt");

const SOURCE_SHA256 =
  "f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920";
const EMCC_VERSION = "6.0.9";
const EMCC_COMMIT = "4e4223852a0835923411059a3929907d7df1232e";
const SDK_TAG_COMMIT = "5eb0bde7585670252e8ba05e9d361627bffd08b5";
const SDK_RELEASES_COMMIT = "f04ea239d533260dd1db760dd2d668d5f9a88d6b";
const WASM_OPT_VERSION = "wasm-opt version 132 (version_132-49-gd03c25ea4)";
const MEMORY_BYTES = 2 * 1024 * 1024;
const STACK_BYTES = 64 * 1024;
const ASYNCIFY_STACK_BYTES = 64 * 1024;
const SIMD_COMPILER_FLAG = "-msimd128";

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
  if (status !== 0)
    throw new Error(`${command} exited ${status}\n${stdout}${stderr}`);
  if (stderr.length > 0) process.stderr.write(stderr);
  return stdout;
};

const main = async (): Promise<void> => {
  const mode = process.argv[2];
  if (mode !== "--verify" && mode !== "--update") {
    throw new Error(
      "usage: bun run scripts/build-decoder-wasm.ts --verify|--update",
    );
  }

  const archiveHash = sha256(new Uint8Array(await readFile(sourceArchive)));
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
  const sdkCommit = (
    await run("git", ["-C", emsdkRoot, "rev-parse", "HEAD"])
  ).trim();
  if (sdkCommit !== SDK_TAG_COMMIT) {
    throw new Error(`unexpected emsdk checkout commit: ${sdkCommit}`);
  }
  const releaseTags = JSON.parse(
    await readFile(resolve(emsdkRoot, "emscripten-releases-tags.json"), "utf8"),
  ) as {
    readonly releases?: Readonly<Record<string, string>>;
  };
  if (releaseTags.releases?.[EMCC_VERSION] !== SDK_RELEASES_COMMIT) {
    throw new Error(`emsdk release mapping for ${EMCC_VERSION} is not pinned`);
  }
  const wasmOptVersion = (await run(wasmOpt, ["--version"])).trim();
  if (wasmOptVersion !== WASM_OPT_VERSION) {
    throw new Error(`unexpected wasm-opt version: ${wasmOptVersion}`);
  }

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await run("tar", ["-xJf", sourceArchive, "-C", buildRoot]);
  await chmod(resolve(sourceRoot, "configure"), 0o755);
  const reproducibleEnv = {
    SOURCE_DATE_EPOCH: "1735689600",
    ZERO_AR_DATE: "1",
    CFLAGS: `-O3 -DNDEBUG ${SIMD_COMPILER_FLAG}`,
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
  const commonCompile = [
    "-O3",
    SIMD_COMPILER_FLAG,
    "-ffreestanding",
    "-fno-builtin",
    "-DFLAC__NO_DLL",
    "-DHAVE_CONFIG_H",
    `-I${sourceRoot}`,
    `-I${resolve(sourceRoot, "include")}`,
    `-I${resolve(sourceRoot, "src/libFLAC/include")}`,
  ];
  const units = [
    "bitmath",
    "bitreader",
    "cpu",
    "crc",
    "fixed",
    "format",
    "lpc",
    "md5",
    "memory",
    "stream_decoder",
  ];
  const objects: Array<string> = [];
  for (const unit of units) {
    const object = resolve(buildRoot, `${unit}.o`);
    await run(
      emcc,
      [
        ...commonCompile,
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
  const wrapperObject = resolve(buildRoot, "decoder.o");
  const runtimeObject = resolve(buildRoot, "decoder-runtime.o");
  await run(
    emcc,
    [...commonCompile, "-c", wrapperSource, "-o", wrapperObject],
    repository,
    reproducibleEnv,
  );
  await run(
    emcc,
    [...commonCompile, "-c", runtimeSource, "-o", runtimeObject],
    repository,
    reproducibleEnv,
  );

  const rawOutput = resolve(buildRoot, "flac-decoder.raw.wasm");
  const output = resolve(buildRoot, "flac-decoder.wasm");
  const allowedUndefined = resolve(buildRoot, "allowed-undefined.txt");
  await writeFile(allowedUndefined, "codec_read\n");
  const exports = [
    "malloc",
    "free",
    "codec_decoder_abi_version",
    "codec_decoder_new",
    "codec_decoder_init",
    "codec_decoder_process_single",
    "codec_decoder_finish",
    "codec_decoder_delete",
    "codec_decoder_output_ptr",
    "codec_decoder_output_length",
    "codec_decoder_output_frames",
    "codec_decoder_output_frame_offset_low",
    "codec_decoder_output_frame_offset_high",
    "codec_decoder_release_output",
    "codec_decoder_sample_rate",
    "codec_decoder_channels",
    "codec_decoder_bits_per_sample",
    "codec_decoder_minimum_block_frames",
    "codec_decoder_maximum_block_frames",
    "codec_decoder_total_frames_low",
    "codec_decoder_total_frames_high",
    "codec_decoder_total_frames_known",
    "codec_decoder_md5_present",
    "codec_decoder_streaminfo_frames_low",
    "codec_decoder_streaminfo_frames_high",
    "codec_decoder_streaminfo_frames_known",
    "codec_decoder_decoded_frames_low",
    "codec_decoder_decoded_frames_high",
    "codec_decoder_decoded_bytes_low",
    "codec_decoder_decoded_bytes_high",
    "codec_decoder_callback_error",
    "codec_decoder_state",
    "codec_decoder_allocator_live_bytes",
    "codec_decoder_allocator_peak_live_bytes",
    "codec_decoder_allocator_peak_heap_bytes",
    "codec_decoder_allocator_free_calls",
    "codec_decoder_allocator_realloc_calls",
  ];
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
      "-z",
      `stack-size=${STACK_BYTES}`,
      "--strip-all",
      ...exports.map((name) => `--export=${name}`),
      "-o",
      rawOutput,
      wrapperObject,
      ...objects,
      runtimeObject,
    ],
    repository,
    reproducibleEnv,
  );
  await run(
    wasmOpt,
    [
      rawOutput,
      "--asyncify",
      "--pass-arg=asyncify-imports@codec.read",
      "--enable-bulk-memory",
      "--enable-simd",
      "-O3",
      "--strip-debug",
      "-o",
      output,
    ],
    repository,
    reproducibleEnv,
  );

  const outputBytes = new Uint8Array(await readFile(output));
  const outputHash = sha256(outputBytes);
  const module = await WebAssembly.compile(outputBytes);
  const imports = WebAssembly.Module.imports(module)
    .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
    .sort();
  const expectedImports = ["codec.read:function"];
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
    throw new Error(`unexpected Wasm imports: ${imports.join(", ")}`);
  }
  const exported = WebAssembly.Module.exports(module)
    .map(({ name, kind }) => `${name}:${kind}`)
    .sort();
  const expectedExports = [
    "memory:memory",
    "asyncify_get_state:function",
    "asyncify_start_unwind:function",
    "asyncify_stop_unwind:function",
    "asyncify_start_rewind:function",
    "asyncify_stop_rewind:function",
    ...exports.map((name) => `${name}:function`),
  ].sort();
  if (JSON.stringify(exported) !== JSON.stringify(expectedExports)) {
    throw new Error(`unexpected Wasm exports: ${exported.join(", ")}`);
  }
  if (outputBytes.byteLength > 256 * 1024) {
    throw new Error(
      `decoder Wasm exceeds 256 KiB objective: ${outputBytes.byteLength}`,
    );
  }

  const [wrapperSha256, runtimeSha256] = await Promise.all([
    readFile(wrapperSource).then((bytes) => sha256(new Uint8Array(bytes))),
    readFile(runtimeSource).then((bytes) => sha256(new Uint8Array(bytes))),
  ]);

  const manifest = {
    asset: "flac-decoder.wasm",
    assetSha256: outputHash,
    libflac: {
      version: "1.5.0",
      archive: "vendor/libflac-1.5.0/flac-1.5.0.tar.xz",
      archiveSha256: SOURCE_SHA256,
    },
    sources: {
      wrapper: "native/decoder.c",
      wrapperSha256,
      runtime: "native/decoder-runtime.c",
      runtimeSha256,
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
      asyncifyStackBytes: ASYNCIFY_STACK_BYTES,
      filesystem: false,
      memoryGrowth: false,
      imports: expectedImports,
      exports: expectedExports,
      libflacUnits: units,
      compilerFlags: [
        "-O3",
        SIMD_COMPILER_FLAG,
        "-ffreestanding",
        "-fno-builtin",
        "-DFLAC__NO_DLL",
        "-DHAVE_CONFIG_H",
      ],
      linkerPolicy: {
        allowedUndefinedSymbols: ["codec_read"],
        noEntry: true,
        stripAll: true,
      },
      asyncifyImports: ["codec.read"],
      wasmFeatures: ["bulk-memory", "simd128"],
    },
  } as const;
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;

  if (mode === "--update") {
    await mkdir(dirname(asset), { recursive: true });
    await copyFile(output, asset);
    await writeFile(manifestPath, serializedManifest);
    process.stdout.write(`updated wasm/flac-decoder.wasm (${outputHash})\n`);
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
      "rebuilt decoder Wasm does not match the checked-in asset/manifest; run build-decoder-wasm.ts --update intentionally",
    );
  }
  process.stdout.write(
    `verified reproducible wasm/flac-decoder.wasm (${outputHash})\n`,
  );
};

await main();
