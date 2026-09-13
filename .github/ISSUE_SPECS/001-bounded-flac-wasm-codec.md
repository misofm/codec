# Build bounded native-FLAC encoding and decoding with pinned libFLAC Wasm

GitHub: https://github.com/misofm/codec/issues/1

Base: public `misofm/codec` main `23841d1`.

## Objective

Deliver `@misofm/codec` 0.1 as a reusable, storage-neutral native-FLAC codec:
bounded incremental integer PCM encoding and asynchronous streaming decoding,
using Bun, Effect v4, and package-owned libFLAC 1.5.0 WebAssembly. It must run
from a packed install on Bun 1.4.2 and Node 22.23.2, and its portable decoder
contract must be usable by `engine-web-adapter` without importing adapter policy.

Callers own input/output I/O, staging cleanup, concurrency, retries, manifests,
delivery chunking, URLs/auth, uploads, and publication. Consumers own the Effect
runtime. Do not inspect or copy Engine/app source or change adapter/CLI/transcoder.

## Public contract

Export Schema-validated `PcmFormat` for one/two channels, integer PCM16/24, and
integer 8,000–192,000 Hz rates. PCM blocks are non-empty `Int32Array` values of
signed, right-justified, interleaved samples, aligned to channels and bounded by
a documented fixed frame maximum. Stereo 44.1 kHz PCM16/24 is mandatory.

`encodeFlac(source, sink, options)` accepts
`Stream.Stream<Int32Array, EI, RI>` and a generic caller sink:

```ts
interface RandomAccessByteSink<E, R> {
  writeAt(offset: bigint, bytes: Uint8Array): Effect.Effect<void, E, R>;
  resize(length: bigint): Effect.Effect<void, E, R>;
}
```

Options contain `format` and optional checked `expectedFrames`. The result
reports format, encoded byte/frame counts, and finalized STREAMINFO block/frame
sizes, total frames, and MD5. Preserve source/sink `E` and `R`; add only narrow
Schema-backed `PcmInputError | FlacEncodeError`. Success follows all writes,
backward STREAMINFO rewrites, validation, and exactly one final resize. On error
or interruption the sink may contain partial bytes; the caller owns rollback.

`decodeFlac(source, options?)` accepts a bounded
`Stream.Stream<Uint8Array, EI, RI>` and returns a lazy
`Stream.Stream<FlacDecodeEvent, EI | FlacDecodeError, RI | FlacDecoder>`.
Events distinguish `Metadata`, `Pcm`, and final `Complete`. Each PCM event
contains the established `PcmFormat`, starting frame, frame
count, and bounded packed signed little-endian PCM bytes. Metadata becomes available before
the first PCM block through a documented event/result shape; no PCM may precede
validated STREAMINFO. Completion validates exact total frames when declared or
caller-supplied and libFLAC MD5 when present. A standards-defined zero MD5 is
reported as absent, never as verified. Caller-owned canonical SHA-256
verification remains separate.
Truncation, CRC/lost-sync, malformed metadata/frame bounds, trailing policy,
shape/count/position/MD5 mismatch, callback stall, and ABI/trap failures are
typed `FlacDecodeError`s with bounded phase/state fields.

Ship external Wasm asset(s), export package-relative URL(s), and provide
`FlacEncoder`/`FlacDecoder` Context services plus Layers from trusted Wasm bytes.
Compile/validate a module once per Layer; acquire and release one independent
codec instance per stream invocation. Core imports are inert and touch no I/O.

## Bounded codec design

- Pin native FLAC compression level 8, single-threaded, without exhaustive
  model search (`-e`). Build encoder/decoder stream APIs only: no Ogg, CLI,
  metadata editor, stdio/filesystem, network, WASI, pthreads, or policy formats.
- Use ordinary fixed, non-growing Wasm memory at most 16 MiB and fixed input,
  output, callback-operation, and metadata-prefix bounds. Reject unexpected
  imports/exports, shared/growing memory, bad ABI, offset/count overflow, or stall.
- Encoder callbacks stage a fixed ordered batch using virtual write/seek/tell;
  drain every `writeAt` effect before pulling more PCM or making another bounded
  Wasm process call. Final seek rewrites must produce canonical STREAMINFO/MD5.
- Decoder bridges libFLAC's synchronous pull/write callbacks to the asynchronous
  Effect source with a bounded mechanism proven on Bun, Node, and the intended
  browser host. At most one fixed compressed slot and a fixed small number of PCM
  blocks may be live. Await downstream demand/credit before processing more;
  never collect a FLAC file/frame or decoded asset solely to bridge callbacks.
- Preserve arbitrary source chunk boundaries, including splits across metadata,
  frame headers/subframes/CRCs and frames larger than the input slot. EOF is
  signalled only after upstream ends; early EOF must fail without hanging.
- Scope every instance through its stream's last consumer. Early take, source or
  consumer failure, and interruption stop input, unblock the bridge, suppress
  late output, and finalize exactly once. Synchronous Wasm calls are bounded but
  non-interruptible mid-call; document this cancellation limit.

## Provenance and package

Use official libFLAC 1.5.0 archive SHA-256
`f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920`.
Use Emscripten 6.0.9: emsdk `5eb0bde7585670252e8ba05e9d361627bffd08b5`,
compiler `4e4223852a0835923411059a3929907d7df1232e`, SDK releases
`f04ea239d533260dd1db760dd2d668d5f9a88d6b`. Record flags, patches, imports/
exports, memory, tool/source/artifact hashes, and reproduce checked-in Wasm
byte-for-byte offline. Ordinary package work uses it without compiler/download.
Include libFLAC/Emscripten/musl notices; never distribute the GPL `flac` CLI.

Use strict Node-compatible ESM/declarations/exports. Develop with exact
`effect@4.0.0-rc.115`; advertise peer `4.0.0-rc.112 || 4.0.0-rc.115` only if
packed Bun and Node consumers typecheck/run both, otherwise use the exact tested
peer. Record the exact requested Effect-skill revision in evidence.

## Objective gates

1. Deterministic silence/impulse/extrema/random/partial/empty vectors cover both
   channels/depths, 44.1 kHz and rate boundaries. Native libFLAC independently
   verifies encoded FLAC and decoded PCM byte-for-byte, including channel order,
   total frames, SHA-256, finalized STREAMINFO, and canonical-PCM MD5.
2. Partition properties vary every legal PCM/FLAC source boundary without
   changing decoded PCM or metadata. Corruption, truncation, trailing bytes,
   wrong format/sample/range/count, oversized chunks/frames, bad callback data,
   false codec status, trap, and malformed ABI all reach the documented typed
   channel, never false success, defect, or hang.
3. Trace sources/sinks prove pull backpressure and ordered seek writes. Slow
   consumers prove fixed compressed/PCM credits; long streams prove
   duration-independent JS/Wasm memory. No mutation retry occurs.
4. Success, typed failure, defect injection, interruption at every wait/call
   boundary, early decoded-stream cancellation, and concurrent streams prove one
   acquire/release, no late work, no cross-stream state, and truthful Exit/Cause.
5. Static policy proves Wasm is at most 256 KiB per asset, fixed non-shared memory
   at most 16 MiB, exact audited imports/exports, and no forbidden surface. A
   clean pinned rebuild reproduces every asset hash.
6. Public type/Schema tests establish exact values/errors/requirements and
   rejected misuse. `bun test`, strict typecheck, formatting, policy/license/
   rebuild checks, `git diff --check`, and packed fresh consumers all pass.
7. Packed Bun 1.4.2 and Node 22.23.2 consumers resolve installed Wasm assets and
   run real incremental encode/decode/round-trip plus cancellation for every
   advertised Effect peer. Add a packed browser consumer before claiming the
   decoder ready for adapter replacement.
8. On `/data/issue-77-lossless/run-02`, all 137 `flac8-30s` chunks across 30
   stereo 44.1 kHz PCM24 stems encode and decode with exact manifest PCM hashes.
   Run three serial warm Wasm/native-libFLAC level-8 rounds plus separate cold
   compile/instantiate timing; verification is outside timing. Record per-chunk
   and aggregate bytes/times/provenance. Compare FLAC payload to 425,690,361
   bytes; 425,769,056 additionally includes 78,215 manifest and 480 container
   bytes. Commit no media or encoded corpus.

## Non-goals and workflow

No whole-file convenience API, Promise facade, transcoding/HLS/AAC, sparse
policy/manifests, storage implementation, upload/publication, CLI, engine/app
changes, codec selection, Ogg, threads/SIMD, custom codec, npm publish, merge, or
release. Adapter integration is a later issue after this package gate passes.

Sol scopes, Sol implements, and a fresh Sol adversarially reviews an immutable
checkpoint. Record implementation/rebuild/packed-consumer/corpus evidence and
publish-readiness blockers here; do not weaken a gate to declare completion.

## Implementation evidence

The implementation uses the requested Effect guidance at
`unconfirmedlabs/skills@f415b790865c7d391191a8daf67e4f94a7f0a028`, including
its reusable-library, Schema, stream, service, and consumer-testing guidance.
Sol scoped and implemented this slice; independent Sol review found and drove
fixes for runtime option validation, metadata structure/order, strict linking,
ABI ranges/stalls, encoder metadata completeness, and successful cleanup errors.
The final immutable-checkpoint review signed off with no remaining blocker.

The encoder accepts at most 4,096 frames per input element and stages at most
256 KiB / 64 writes per native call in fixed 16 MiB Wasm memory. The decoder
accepts at most 256 KiB per input element, emits one packed PCM block of at most
384 KiB, and uses fixed 2 MiB Wasm memory. Its metadata setting is a read cap;
retained metadata that cannot fit fails with a typed allocation error rather
than growing memory. Both APIs await caller work and preserve primary failures
and interruption. Checked cleanup precedes successful return or `Complete`.

Final asset provenance is recorded in the checked manifests:

| Asset   |   Bytes | SHA-256                                                            |
| ------- | ------: | ------------------------------------------------------------------ |
| Encoder | 133,885 | `90da75c73784e7184ea6c27d3ea9509f74df2eda405d8ddc8f964d78a16a273e` |
| Decoder |  74,338 | `5e282f9874ecb3f49b8ee8437efc318ec14ef5cff5b7580da9d875f94e5c5925` |

Both pinned build scripts reproduced their asset and provenance manifest exactly.
The encoder permits only `codec.seek` and `codec.write`; the decoder permits
only `codec.read`. All other unresolved symbols fail the link, including data
symbols. Both build scripts enforce the 256 KiB asset ceiling. Manifests record
source/archive hashes, compiler pins/flags, source units, exact imports/exports,
fixed memory, and the strict linker policy.

The native integration command requires an explicit `CODEC_NATIVE_FLAC`.
`scripts/build-native-flac.sh` builds the pinned source in a temporary directory
outside the repository; CI uses this independent oracle. The maximum-block test
generates 65,535 stereo PCM24 frames and a compressed frame exceeding 256 KiB,
then decodes through 997-byte fragments to 393,210 exact bytes with SHA-256
`dfe5d44b7eab5437879b3f91a9c4d5443c263ed0e33dab15399dccc38bfe9443`.
Small fixtures exercise every two-part PCM/FLAC split and every strict truncated
prefix of a native 8 kHz stream. Deterministic vectors cover silence, impulses,
extrema, random partial tails, empty streams, and all four channel/depth shapes.

The actual decoder allocator is sampled across 96 × 4,096-frame blocks while PCM
is hashed and discarded. Allocation reaches a steady plateau after warm-up;
Wasm memory remains 2 MiB, and live allocations return to zero after success,
truncation, and interruption. Public source finalizers run once. Readable WAT
fixtures and corresponding embedded test bytes audit failure paths without
requiring a compiler for ordinary tests; these fixtures are excluded from the
package.

`docs/evidence/packed-consumers.json` records a fresh isolated tarball test:
139,215 packed bytes, 418,391 unpacked bytes, SHA-256
`19045d0bd1524d07b2d31e07d64fb06832a50dc968904faa5ba328601a52e7a5`.
Both advertised Effect peers passed typechecks and real four-format round trips,
truncation, and cancellation on Bun 1.4.2, Node 22.23.2, Chromium 151.0.7922.34,
Firefox 153.0, and WebKit 26.5 workers. Every runtime verifies 32,772 frames /
122,895 canonical PCM bytes. The package owns both deployed assets and resolves
them from the installed tarball without source-tree aliases.

The canonical server receipt is `benchmark/evidence/corpus-benchmark.json`,
SHA-256 `c3670d75efb6273a132d232964e14aa1859cb6ca3d2c1bfe85479f3e6a21ae25`.
It covers all 30 stems / 137 chunks, three serial warm rounds, and separate cold
compilation. All 137 decoder qualifications verify 971,988,594 canonical PCM
bytes against manifest SHA-256 and STREAMINFO MD5; all 822 generated-file checks
also verify exact native-decoded PCM.

| Measurement                 |        Wasm | Native libFLAC 1.5.0 |
| --------------------------- | ----------: | -------------------: |
| FLAC payload bytes          | 425,689,892 |          425,690,361 |
| Median corpus encoding time |    60.580 s |             15.554 s |

Wasm saved 469 bytes (0.000110%) against the native payload and took 3.895 times
as long on the recorded AMD EPYC 7313P server. Cold compile plus the first
30-second encode took 485.601 ms, including 2.321 ms compilation. Verification
is outside timed intervals. A packed consumer check briefly overlapped round 1;
the receipt explicitly records this caveat and retains all rounds. Round 1 was
faster than the median for both implementations.

Final local checks passed on the frozen implementation:

- `bun run check`: 40 passed, 5 intentional native-only skips, 832 assertions;
  formatting and both strict TypeScript checks passed.
- `CODEC_NATIVE_FLAC=<fresh pinned native build> bun run test:integration`:
  5 passed, 657 assertions, no skips.
- `bun run build`, both pinned `--verify` Wasm rebuilds, and
  `bun run pack:check` passed.
- `git diff --check` passed. No media, generated dependencies/caches, or packed
  tarballs are committed.

### Final review and CI

Independent Sol review signed off with no remaining blocker at
`07189c3c709f77fb5218420896b76b152ae2b01a`. The complete final report is
`docs/evidence/final-review.md`, SHA-256
`272505166d9f076b800c6f84de85af518ee0810c5a45f5b7bf6978ab57cfffec`.
The reviewer independently repeated ordinary/native checks, build, both offline
Wasm rebuilds, and the full packed matrix, reproducing the same tarball hash.

[GitHub CI run 34737906581](https://github.com/misofm/codec/actions/runs/34737906581)
passed both jobs on that checkpoint: fresh native and browser/package verification,
and clean pinned Wasm rebuilds. The follow-up commit records this evidence and
removes one unused test-only binary literal; it changes no package source, asset,
manifest, or packed file. The retained ABI regressions pass after that removal.

Reviewable delivery: [draft PR #2](https://github.com/misofm/codec/pull/2).
There are no remaining implementation blockers for this package slice.

### Release and integration status

No adapter, CLI, or transcoder integration was performed. The adapter can map its
existing synthesized STREAMINFO prefix and bounded input transport into the new
stream API; its HTTP/auth, worker credits, OPFS, canonical SHA-256, and readiness
rules remain caller-owned. Its full packed browser suite and integration memory /
cancellation checks remain gates for that later migration.

No mobile measurement, npm publication, merge, or release is part of this slice.
