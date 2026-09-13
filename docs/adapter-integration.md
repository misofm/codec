# Engine web adapter integration

The codec boundary is designed to replace the adapter's package-private libFLAC
implementation. Integrating it into the adapter is a separate change; this
repository does not change playback or delivery behavior.

The compatibility reference is `misofm/engine-web-adapter` revision
`73e891df62375d1ee45d8228029796ef9597cb43`, specifically
`src/stems/native-flac-decoder.ts`, `src/stems/native-flac-metadata.ts`,
`src/stems/flac-input-slot.ts`, and `decoder/flac_decoder.c`. No engine or app
source was inspected or copied for this implementation.

| Responsibility                                          | Owner after integration |
| ------------------------------------------------------- | ----------------------- |
| libFLAC version, Wasm build and asset                   | `@misofm/codec`         |
| FLAC metadata, frame decoding, CRC/count/MD5 checks     | `@misofm/codec`         |
| HTTP range/auth mapping, retries and delivery admission | Adapter/caller          |
| Worker scheduling and output credits                    | Adapter                 |
| Canonical byte count and SHA-256, OPFS promotion        | Adapter                 |
| AudioWorklet and engine delivery                        | Adapter                 |

The existing adapter accepts mono/stereo signed 16/24-bit PCM at 44.1, 48, 88.2,
or 96 kHz; variable FLAC blocks up to 65,535 frames; and a header sample count of
zero when the caller supplies the expected count. Its input slot is 256 KiB and
its packed PCM output limit is 384 KiB. These are compatibility targets for this
library's decoder tests.

Its current metadata scanner may skip non-audio metadata using HTTP ranges and
feed a synthesized 42-byte FLAC STREAMINFO prefix followed by audio frames. The
same sequence can be represented as an Effect byte stream for `decodeFlac`.
Applications that already supply a complete FLAC stream can pass that directly.

Use the package's portable compiled-module Layer in the adapter worker. The
adapter can adapt its current input transport to an Effect stream and await each
PCM block's output credit. The decoder does not require SharedArrayBuffer or
cross-origin isolation; the adapter may retain shared transport for its own
requirements.

A final decoder completion validates FLAC's stream-level checks. It does not
replace the adapter's canonical SHA-256 or full byte-count verification. An
absent FLAC MD5 must remain visibly absent, and no source becomes ready before
all adapter verification and storage promotion finish.

Before replacing the adapter implementation, run its full packed browser suite,
measure its worker memory and cancellation behavior, and update its asset
packaging to resolve the codec package's Wasm export. This package's standalone
packed worker test establishes host compatibility, not completed adapter
integration.
