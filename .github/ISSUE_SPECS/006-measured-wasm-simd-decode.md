# Measure and qualify a small Wasm SIMD decoder improvement

GitHub: https://github.com/misofm/codec/issues/6

## Objective and immutable scope

Enable standard Wasm SIMD in the existing FLAC decoder only if comparable repeated measurements show a useful improvement. Preserve exact canonical PCM, libFLAC integrity validation, bounded memory/foreign calls, cancellation, backpressure, public APIs, and existing supported-runtime qualification. No libFLAC rewrite, storage/delivery policy, WebGPU, format migration, or engine work.

Published baseline: codec 0.1.0 at `12f54c988a2df319064e6ca3885268d976319cc1`; decoder SHA-256 `5e282f9874ecb3f49b8ee8437efc318ec14ef5cff5b7580da9d875f94e5c5925`. Candidate base is origin/main `970119ce723666267aa28856f315d7b702945a93`, retaining source-equivalent release/docs fixes. Candidate tree `/tmp/miso-simd-study/candidates/codec`, branch `perf/simd-codec-6`. Read-only baseline tree `/tmp/miso-simd-study/worktrees/codec` must remain unchanged.

User-selected sequence supersedes local launch defaults: Sol high baseline → Astra xhigh scoped plan → Luna xhigh implementation → fresh Astra medium independent verification → identical after benchmarks → root release and app integration only if positive. Current status: baseline and scope complete; implementation, independent verification, positive comparison, and release pending. User authorizes the conditional sequence; no new routine approval step is required.

## Evidence informing the slice

Study root `/tmp/miso-simd-study`. Representative Bun 1.4.2 seven-round median: decode 57.345 ms (55.566–58.863) for 5,124,876 compressed bytes / 7,938,000 PCM bytes; adapter JS SHA 395.068 ms. Chromium 153.0.8010.12 whole Ghost r1 corpus: eight stems / 35 chunks / 92,685,354 compressed bytes / 249,323,400 active PCM bytes. Five-round one-worker decoder median 2,258.0 ms (2,248.4–2,330.8); eight-worker makespan 391.9 ms (390.7–394.8). All eight package, 35 compressed chunk, 35 decoded PCM chunk, and eight canonical hashes pass. Evidence files: `evidence/representative-bun-baseline.json`, `evidence/browser-baseline.json`.

These are isolated compute measurements, not HTTP/OPFS installation or app-open timings. The adapter's larger PCM verification cost is addressed separately in adapter #82, without changing delivery/storage or removing checks.

## Smallest implementation

1. Add `-msimd128` to actual decoder/libFLAC/wrapper/runtime compilation in `scripts/build-decoder-wasm.ts`, enable the necessary Binaryen SIMD feature through the existing Asyncify pipeline, and record flags/features in the reproducibility manifest. Keep Emscripten 6.0.9 and libFLAC 1.5.0 pins, `-O3`, ABI/imports, fixed 2 MiB memory, stack bounds, 256 KiB asset/input caps, and 384 KiB PCM output cap.
2. Update `wasm/flac-decoder.wasm`, its manifest, and `src/decoder-wasm.ts` public hash. Inspect actual Wasm disassembly for SIMD instructions and record the finding. Flags alone do not prove acceleration.
3. Compare the compiler-only candidate using the frozen benchmark workload before any manual SIMD work. If neutral/negative, retain published scalar and record the rejected experiment. Do not start a predictor rewrite or broad libFLAC fork. Return any proposed follow-on source adjustment to root with measured justification.
4. For a positive candidate, retain the existing asset URL/public API and document standard Wasm SIMD requirements. All currently advertised Bun/Node/browser worker gates must pass. If a supported runtime fails, keep scalar for this release rather than silently dropping support or building an unplanned dual-asset framework.

Owned files: decoder build script, decoder Wasm/manifest/public hash, focused decoder test adjustments, README, numbered spec/evidence, and eventual version/lock changes. Do not change encoder implementation, decoder Effect/control APIs, or original research worktrees. If Effect implementation changes become necessary, read and pin the user-requested Effect guidance first.

## Correctness and performance acceptance

Existing tests must retain exact mono/stereo16/24 PCM, variable-block behavior, CRC/MD5/truncation/count/metadata rejection, allocator/ABI cleanup, bounded inputs/outputs, downstream backpressure, and cancellation. Rebuild reproducibly and verify fixed memory/imports/exports/asset size. Add only a missing discriminating SIMD-boundary test if existing tests do not cover it.

Rerun `harness/representative.mjs` and `harness/run-browser.mjs` with the same source fragmentation, corpus, CPU/runtime/browser, warmups, seven Bun rounds and five browser decode rounds. Record actual candidate source/tree/version and Wasm hash; source labels must be parameterized without changing timed work. Run CPU-heavy work serially with benchmark ownership. Accept a repeatable whole-corpus improvement larger than observed variation, without a material regression in single/eight-worker modes or supported runtimes. Keep raw samples, medians/ranges, percent differences, initialization/compile cost, asset size, and bounds. A single fast sample is insufficient; do not retry repeatedly looking for a win.

## Required qualification and release

Run `bun run check`, pinned-native `bun run test:integration`, `bun run build:wasm:verify`, `bun run build`, and `bun run pack:check`. Keep the existing isolated packed consumer matrix: Bun 1.4.2, Node 22.23.2, Effect rc.112/rc.115, Chromium/Firefox/WebKit workers. Preserve source/toolchain/license provenance and both Wasm reproducibility gates. Do not commit corpus media, caches, dependencies, secrets, or tarballs.

Fresh Astra medium independently verifies a frozen candidate and records full commit/tree, files, commands/results, packed archive provenance, benchmark comparison, verdict, and remaining blockers here. Root owns versioning, merge, trusted publication using `.github/RELEASING.md`, registry artifact verification, and downstream adapter/app installation. Codec may remain unchanged if its candidate is not positive; that does not prevent a qualified adapter-only improvement. No implementation or publication is claimed by this scope.

Companion plan: `/tmp/miso-simd-study/simd-plan.md`; adapter issue https://github.com/misofm/engine-web-adapter/issues/82. Technical reference: https://emscripten.org/docs/porting/simd.html .

## Luna implementation evidence (candidate, not published)

The compiler-only candidate was built with the pinned Emscripten 6.0.9
checkout and libFLAC 1.5.0 archive. `-msimd128` is present in configure
`CFLAGS` and every decoder, libFLAC, wrapper, and runtime compile. The existing
Asyncify pipeline now passes `--enable-simd`; the manifest records the exact
compiler flag and `bulk-memory`/`simd128` features. The rebuilt fixed-memory
asset is 75,923 bytes with SHA-256
`70caf38185675dff89498e89f98171d49ec6f143a56c6895088d93c35e2018cd`.

`wasm2wat wasm/flac-decoder.wasm` contains 62 `v128.const`, 23 `v128.load`,
80 `v128.store`, 20 `i8x16.shuffle`, and additional typed SIMD operations.
This is actual SIMD in the asset; the compiler flag alone was not used as
evidence. No libFLAC source or decoder control-flow changes were made.

On the frozen representative Bun workload (Bun 1.4.2, seven rounds), decode
was 54.872 ms (53.596–71.818) versus the scalar baseline 57.345 ms
(55.566–58.863), a 4.31% median reduction. On Chromium 153.0.8010.12 and the
full eight-stem/35-chunk corpus, one-worker decode medians were 2,179.1 ms
(2,140.4–2,191.7) and 2,155.5 ms (2,150.3–2,192.5) in two candidate runs;
the published baseline was 2,258.0 ms (2,248.4–2,330.8), with an adjacent
unchanged baseline at 2,243.9 ms (2,229.0–2,298.4). Eight-worker makespan
medians were 378.1 ms (370.2–390.4) and 377.7 ms (372.5–379.8), versus the
published 391.9 ms (390.7–394.8) and adjacent unchanged 394.1 ms
(388.8–422.4). All package, compressed chunk, decoded PCM chunk, canonical
PCM, libFLAC MD5, and count checks passed in each harness run.

Local gates passed: `bun run check` (40 passed, 5 skipped native-only),
`CODEC_NATIVE_FLAC=/data/codec-tooling/flac-scalar/src/flac/flac bun run
test:integration` (5 passed), `bun run build:wasm:verify`, `bun run build`, and
`bun run pack:check` (Bun/Node and Chromium/Firefox/WebKit packed consumers for
Effect rc.112 and rc.115). Fresh independent review and root release remain
pending; this candidate does not claim publication.
