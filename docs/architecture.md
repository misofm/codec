# Package boundaries

`@misofm/codec` owns the pinned codec implementation, WebAssembly assets, typed
format boundaries, and bounded conversion between PCM and encoded audio.
Version 0.1 implements FLAC encoding and asynchronous streaming decoding. The public API composes with Effect;
applications choose when and how to run it.

`@misofm/transcoder` owns higher-level media pipelines such as AAC renditions,
HLS layouts, and verified artifacts. The CLI owns orchestration, delivery chunk
policy, manifests, uploads, and publication. Creating this package does not
migrate either consumer automatically.

The first encoding profile uses libFLAC 1.5.0 compression level 8. Prior server
research found that exhaustive model search saved only 353,391 additional bytes
across the measured corpus while increasing summed native encoding time from
15.434 to 60.814 seconds. The underlying
[research and evidence](https://github.com/misofm/engine-web-adapter/blob/73e891df62375d1ee45d8228029796ef9597cb43/research/077-lossless-delivery/REPORT.md)
are native measurements. This repository measures the actual Wasm implementation
separately.

Wasm is the selected backend because current encoding demand does not justify
native-addon installation and platform distribution work. Applications can
scale jobs horizontally. Synchronous Wasm calls still occupy the host thread;
offloading jobs belongs to the application.

A seekable output capability lets libFLAC finalize STREAMINFO without retaining
the complete output. Effect owns source consumption, sink backpressure, errors,
and resource lifetime. Callers own durable staging and removal of partial output
after failure or interruption.

The streaming decoder bridges libFLAC's synchronous read callback to Effect
input pulls. Each decode owns bounded memory and produces bounded PCM blocks.
The browser adapter can consume this capability while retaining HTTP ranges,
worker scheduling, OPFS, canonical SHA-256 verification, and engine delivery.
Independent native libFLAC remains an oracle for verifying encoded output.
