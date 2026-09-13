# Final independent review — `@misofm/codec` issue 1

## Decision

**Signed off with no remaining blocker** at immutable commit `07189c3c709f77fb5218420896b76b152ae2b01a` (`feat: add bounded FLAC Wasm encoding and async decoding`). The worktree was clean, and `git diff --check` passed.

This review covered the bounded Effect APIs, generic source/sink error and requirement ownership, encoder backpressure, asynchronous decoder streaming and chunk boundaries, metadata/frame/truncation handling, normal cancellation and finalization, malformed ABI typed failures, fixed-memory and asset guards, strict linker inputs, reproducible provenance, package imports, native-oracle tests, packed consumers, and the committed corpus receipt.

## Resolved review findings

The initial frozen decoder had release blockers in runtime option totality, unresolved `stdin` hidden by permissive linking, optional metadata validation/order, malformed ABI scalar/range handling, and unbounded zero-progress calls, plus inaccurate post-metadata input phases and incomplete provenance/endpoint evidence. The final commit resolves each:

- decoder options fail lazily through typed `FlacDecodeError`;
- the linker allows only `codec.read`, with inert `stdin` explicitly defined;
- libFLAC responds to and validates supported metadata, enforces STREAMINFO order/uniqueness and optional-block legality, and maps fixed-memory refusal to typed `allocation-failed`;
- metadata flags/scalars and PCM pointer/length/frame/offset values are checked before object/view creation;
- 64 progressless calls produce a typed frame failure;
- input errors use the active metadata/frame phase;
- source/runtime hashes, units, flags, exact imports/exports, memory, and strict linker policy are recorded.

The encoder review found malformed allocation values, incomplete declared metadata-chain success, discarded successful-path cleanup traps, and a missing build-time 256 KiB guard. The final commit validates state/input pointers, captures and validates the complete pinned STREAMINFO + terminal VORBIS_COMMENT profile, checks STREAMINFO block/frame scalars, performs typed idempotent cleanup before returning success, and enforces the asset ceiling in the build script. The missing musl `log_data`/`exp_data` units are restored; the level-8 native compression regression now passes.

Committed ABI tests prove cleanup traps prevent encoder success and decoder `Complete`, earlier source failures remain primary, malformed encoder allocation/metadata and decoder metadata/output/stall cases fail without `Die`, and readable WAT sources correspond to embedded ordinary-test fixtures. The actual decoder allocator test demonstrates a steady live/peak/heap plateau over 96 × 4,096-frame blocks, fixed 2 MiB memory, baseline after delete, zero after dispose, and cleanup after truncation/interruption.

## Independent validation

- `bun run check`: **40 pass, 5 intentional native-only skips, 0 fail, 832 assertions**; Prettier and both strict TypeScript projects passed.
- Native libFLAC 1.5.0 oracle (`989d591e2c859a921bc6ef35da2fd849fbb0ecc7a1eaf37262100cb18fd33a69`): **5 pass, 0 fail, 657 assertions**. This covers PCM16/24 native decode, level-8 LPC compression, a 65,535-frame compressed block larger than the input slot, every native 8 kHz FLAC split, and every strict prefix.
- `bun run build`: passed.
- Pinned offline rebuild: encoder and decoder reproduced byte-for-byte.
- Fresh `bun run pack:check`: both Effect peers passed on Bun, Node, Chromium, Firefox, and WebKit, reproducing the recorded tarball hash.
- GitHub Actions run `34737906581`: both the package/browser/native job and Wasm rebuild job were reported green on the reviewed commit.

## Final hashes and receipts

```text
90da75c73784e7184ea6c27d3ea9509f74df2eda405d8ddc8f964d78a16a273e  wasm/flac-encoder.wasm (133,885 bytes)
ded738b5deed37bdf277c90d6c7aec9c26779ce2f4c4852ae03804ad92ebc50f  wasm/flac-encoder.manifest.json
5e282f9874ecb3f49b8ee8437efc318ec14ef5cff5b7580da9d875f94e5c5925  wasm/flac-decoder.wasm (74,338 bytes)
9d29a97f4e9df858a124b524cb487aac25f0ed5e2855853050492b50778bd718  wasm/flac-decoder.manifest.json
3a1d684e378028054eced616aa593f38f914ee6bce8a35476651f4b44080fe20  src/encode.ts
b7c58f091a24a43b47b1369fcc8be23eec53476f263ce3c5701a8facccb8a97a  src/decode.ts
715916727af8c6a41fe0cc2c5bf117e8b29276bab9fd89bebbcf9e567fc43645  src/internal/encoder-abi.ts
dbd46bbbe563e0a58979ad10efde295ec44d30c55f179b81896579b1076e6f57  src/internal/decoder-abi.ts
51468fc2376a9cf70c5b95ee8d6596b12c2ec3806e8036db3617f089a298c5b5  native/encoder.c
9063ad212a83f506ada7caaefdf47ebad4d34d2744f8a0628c722bf3ffec8743  native/decoder.c
13fdff77ed97c94a84f9a2f28433c694aa82184c147a2acf7eb6e4f019675e22  native/decoder-runtime.c
36a66b7f90904c0efa29869e90e6620f4f219ff3a3771e6420b3c6aefe1131fa  scripts/build-wasm.ts
f080c39e32ec2733737aa4e9bb8da8a3264c7ae71436b74a59d6a88f79c3f036  scripts/build-decoder-wasm.ts
fa4bf315bc4394145c136b07b92c94058ea183725aa6f606c5171b03f154e33b  test/abi-cleanup.test.ts
7e11a08bfca5ba5c5e57b8ae084f996d095277e8267adbdd33bbd65d1bef026d  test/resource-lifecycle.test.ts
847848097dd1a506f9b6b380d08a608ca9a10e0a13a51fc4cfc2655be6a3b7c7  test/partition.test.ts
c18e86ef6e9898e9c2fa41ff90b2d6bfcb7ac3adb2b70db4ff4e84d5d28fa60f  docs/evidence/packed-consumers.json
c3670d75efb6273a132d232964e14aa1859cb6ca3d2c1bfe85479f3e6a21ae25  benchmark/evidence/corpus-benchmark.json
```

The packed receipt contains 10 successful runtime/peer combinations and tarball SHA-256 `19045d0bd1524d07b2d31e07d64fb06832a50dc968904faa5ba328601a52e7a5`. The corpus receipt is complete: 137 decoder qualifications, 822 timed rows, and 971,988,594 verified canonical PCM bytes. It records a brief packed-consumer overlap with warm round 1; all measurements remain present, and round 1 was faster than the median for both implementations.

## Limits

This signoff covers the package slice. Adapter migration and its HTTP/worker/OPFS pipeline were not authorized here. Caller-owned canonical SHA-256, output promotion/rollback, concurrency, and publication remain outside the codec. Mobile measurement, npm publication, merge, and release were not performed.

The decoder's configurable metadata value is a read cap. It does not enlarge fixed 2 MiB memory; a legal retained block that cannot fit fails with typed `allocation-failed`, as documented. The packed browser evidence is for standalone workers and does not claim the later adapter migration.

One unused older base64 test constant remains in `test/abi-cleanup.test.ts`; it is excluded from the package and has no functional effect. Root plans to remove it in a test-only follow-up.
