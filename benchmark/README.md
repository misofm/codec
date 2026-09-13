# Lossless corpus benchmark

`corpus.ts` compares the package's pinned libFLAC Wasm encoder with the pinned
native libFLAC 1.5.0 CLI on the 30-stem, 137-chunk issue-77 corpus. It also
qualifies the package decoder with deliberately fragmented FLAC input. Corpus
audio and generated files remain outside this repository.

The benchmark measures encoding only. Input integrity checks, STREAMINFO checks,
native decode, package decode, PCM hashing, and receipt serialization run outside
the timed interval. A cold Wasm compile is reported separately from the three
serial warm rounds.

The receipt reports the installed Node runtime separately from the Node
compatibility version exposed by Bun's `process.version`.

```sh
bun run benchmark/corpus.ts \
  --corpus /data/issue-77-lossless/run-02 \
  --sources /home/bl/misofm/engine-web-adapter/research/077-lossless-delivery/sources.json \
  --native-flac /data/issue-77-lossless/tooling/flac-build/src/flac/flac \
  --rounds 3 \
  --receipt benchmark/evidence/corpus-benchmark.json
```

## Recorded qualification

The canonical 2026-09-13 receipt has SHA-256
`c3670d75efb6273a132d232964e14aa1859cb6ca3d2c1bfe85479f3e6a21ae25`.
It pins encoder `90da75c73784e7184ea6c27d3ea9509f74df2eda405d8ddc8f964d78a16a273e`
and decoder `5e282f9874ecb3f49b8ee8437efc318ec14ef5cff5b7580da9d875f94e5c5925`.
All 137 chunks decoded to the expected 971,988,594 PCM bytes and verified their
manifest SHA-256 and STREAMINFO MD5. All 822 generated-file checks also decoded
to the expected PCM.

Wasm produced 425,689,892 FLAC payload bytes, 469 bytes (0.000110%) less than
native libFLAC's 425,690,361 bytes. Median serial encoding time was 60.580 s for
Wasm and 15.554 s for native, a 3.895x ratio. Cold compile plus first encode was
485.601 ms, of which compilation was 2.321 ms. A packed fresh-consumer check
briefly overlapped warm round 1 and completed before rounds 2 and 3. The receipt
retains all values and records the caveat; round 1 was faster than the median for
both implementations.

Use `--limit 1 --rounds 1` for a development smoke run. A limited run is marked
as such and cannot satisfy the issue gate. The native command uses level 8 with
no exhaustive model search, padding, or SEEKTABLE. Receipt totals distinguish
FLAC payload bytes from the retained 425,769,056-byte delivery total, which also
contains 78,215 manifest bytes and 480 container bytes.

The predictive fixture in `test/encode-native-integration.test.ts` was also
replayed against the superseded encoder asset
`ddd796cd287f6fd3f95a4643644cfb9bdf83c9a138d59fd763467651ed688240`.
That asset produced 102,778 bytes versus native's 96,283 bytes (+6.745739%) and
no LPC subframe above order 1. The fixed encoder produced 97,621 bytes
(+1.389653%) and 64 higher-order LPC subframes on the same fixture, proving that
both regression assertions reject the original missing-math-table build. The
superseded asset is not retained in this repository.
