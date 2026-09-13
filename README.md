# @misofm/codec

Bounded FLAC encoding and asynchronous streaming decoding, backed by pinned
libFLAC 1.5.0 WebAssembly and composed with Effect v4. Development uses Bun.

The package owns codec primitives and Wasm assets. Callers own input/output,
files, media pipelines, delivery chunks, manifests, storage, and publication.
See [package boundaries](docs/architecture.md) and the
[engine web adapter integration contract](docs/adapter-integration.md).

Install the package with a supported Effect peer:

```sh
bun add @misofm/codec effect@4.0.0-rc.115
```

## Encoding

`encodeFlac(source, sink, options)` accepts an Effect stream of signed,
right-justified, interleaved `Int32Array` PCM blocks. It supports mono/stereo,
16/24-bit samples, and integer sample rates from 8,000 through 192,000 Hz.
Each block contains 1–4,096 frames. An empty source encodes zero frames.

```ts
import * as Effect from "effect/Effect";
import { encodeFlac, PcmFormat } from "@misofm/codec";
import { FlacEncoderLive } from "@misofm/codec/node";

// pcmBlocks and output are caller-owned capabilities.
const encoded = encodeFlac(pcmBlocks, output, {
  format: new PcmFormat({ sampleRate: 44100, channels: 2, bitsPerSample: 24 }),
  expectedFrames: 1323000n,
}).pipe(Effect.provide(FlacEncoderLive));
```

The sink supplies `writeAt(offset: bigint, bytes: Uint8Array)` and
`resize(length: bigint)`, both returning Effects. Writes are ordered and awaited.
The sink must implement arbitrary byte offsets: libFLAC rewrites STREAMINFO
when it finishes. Success follows every write, final metadata validation, and
one final resize. The result includes the format, frame count, encoded length,
and finalized STREAMINFO/PCM MD5.

Encoding uses compression level 8, a 4,096-frame FLAC block size, one thread, and
no exhaustive model search, padding, or SEEKTABLE. It does not resample, normalize,
quantize, or change channel order. Out-of-range samples fail explicitly.

## Asynchronous streaming decoding

`decodeFlac(source, options?)` consumes an Effect stream of FLAC `Uint8Array`
fragments. Input boundaries may split metadata, frame headers, samples, or CRCs.
The decoder can suspend for input in the middle of a frame.
Each source element must be at most 256 KiB; use bounded file/network reads or
split larger upstream chunks before passing them to the decoder. For example,
Node/Bun's `createReadStream(path, { highWaterMark: 65536 })` can be adapted with
`Stream.fromAsyncIterable`. Bun's default `Bun.file(path).stream()` may emit
larger elements.

```ts
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { decodeFlac } from "@misofm/codec";
import { FlacDecoderLive } from "@misofm/codec/node";

const decoded = decodeFlac(flacFragments).pipe(
  Stream.runForEach((event) => {
    switch (event._tag) {
      case "Metadata":
        return onMetadata(event);
      case "Pcm":
        return consumePcm(event.bytes);
      case "Complete":
        return onComplete(event);
    }
  }),
  Effect.provide(FlacDecoderLive),
);
```

Events establish the format before PCM, emit bounded packed signed little-endian
PCM blocks, then report completion after stream validation. PCM received before
completion is provisional. A zero embedded MD5 is reported as absent rather than
verified. Applications may additionally check their own canonical SHA-256.
If STREAMINFO omits both the sample count and MD5, detecting a cut at a valid
frame boundary requires a caller-supplied `expectedFrames` or external digest.

The decoder accepts a single FLAC stream and rejects trailing bytes or a second
concatenated stream. Optional `expectedFormat` and `expectedFrames` constrain the
decoded result. Metadata reading defaults to a 1 MiB cap, configurable from 42
bytes through 16 MiB. This is a read limit: increasing it does not enlarge the
decoder's fixed memory, and retained metadata that cannot fit fails explicitly.

| Per-operation resource | Encoder                | Decoder                        |
| ---------------------- | ---------------------- | ------------------------------ |
| Fixed Wasm memory      | 16 MiB                 | 2 MiB                          |
| Input element          | 4,096 PCM frames       | 256 KiB compressed bytes       |
| Staged output          | 256 KiB callback bytes | One PCM block, at most 384 KiB |

Decoded blocks may contain up to 65,535 frames. The library waits for downstream
demand before decoding the next block. Callers must also bound upstream stream
batches and any output queues they introduce.

The decoder needs no shared memory, cross-origin isolation, network client, or
filesystem. The portable entrypoint accepts a compiled-module Layer created from
Wasm bytes. The `/node` entrypoint loads the installed package assets on Node or
Bun. Browser consumers can load the exported `FLAC_*_WASM_URL` values and use
`makeFlacEncoderLayer` / `makeFlacDecoderLayer`; bundlers must deploy those assets
with their corresponding URLs.

## Effect and resource ownership

The APIs preserve source/sink error and service types. Codec and PCM failures
use Schema-backed tagged errors. Core imports are inert; each Layer shares a
compiled module, and each operation owns an independent Wasm instance.

Source consumption and output writes obey backpressure. Failure, interruption,
and early stream cancellation release the codec. Calls into Wasm are synchronous
and cannot be interrupted in the middle of a call; cancellation is observed
between bounded calls and during Effect input/output waits. Run heavy jobs in
application-owned workers when event-loop responsiveness matters.

Partial output may remain after failure or interruption. Callers own staging,
rollback, cleanup, durable commits, and retry policy. The package does not retry
mutations or publish output. Applications also bound concurrent codec operations
and any buffering added before or after these APIs.

## Development and verification

```sh
bun install --frozen-lockfile
bun run check
bun run pack:check
```

Independent native verification builds the pinned libFLAC source outside the
repository and uses the resulting CLI only as a test oracle:

```sh
CODEC_NATIVE_FLAC=$(scripts/build-native-flac.sh) bun run test:integration
```

The supported peer matrix is `effect@4.0.0-rc.112` and `4.0.0-rc.115`; development
pins rc.115. Packed consumer checks execute real incremental encoding, decoding,
round trips, cancellation, and typed truncation failures on Bun 1.4.2, Node
22.23.2, and Chromium, Firefox, and WebKit workers. Consumer examples are compiled from an isolated
installed tarball, without workspace aliases.

The decoder asset uses standard WebAssembly SIMD (`simd128`). The advertised
Bun, Node, Chromium, Firefox, and WebKit worker matrix is qualified with that
feature enabled; environments that cannot compile standard Wasm SIMD should
retain a scalar decoder asset supplied by the caller.

Rebuilding Wasm requires the pinned Emscripten 6.0.9 toolchain. Set
`CODEC_EMSCRIPTEN_ROOT` to its `upstream/emscripten` directory, then run:

```sh
bun run scripts/build-wasm.ts --verify
bun run scripts/build-decoder-wasm.ts --verify
```

Build verification compares fresh output with checked-in asset and provenance
manifests. Intentional changes use the scripts' explicit `--update` mode first.
Normal installation and TypeScript builds use the packaged assets without a
compiler or codec download. See [third-party notices](THIRD_PARTY_NOTICES.md).

The implementation follows the requested
[Effect skill at revision f415b79](https://github.com/unconfirmedlabs/skills/tree/f415b790865c7d391191a8daf67e4f94a7f0a028/effect-ts).
Foreign Wasm callbacks are a narrow synchronous boundary; Effect owns their
asynchronous input/output and resource lifetime. Build and consumer scripts own
their process/host boundaries.

The [server corpus benchmark](https://github.com/misofm/codec/tree/main/benchmark) records Wasm measurements
separately from native libFLAC and validates every result against canonical PCM.
No mobile benchmark is included.
