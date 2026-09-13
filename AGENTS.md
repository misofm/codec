# Codec agent guide

Build reusable, storage-neutral audio codec primitives with Bun and Effect v4.
The first backend is pinned libFLAC WebAssembly. Keep media pipelines, delivery
chunk policy, manifests, uploads, and publication in consuming packages.

Use Effect for fallible operations and resource ownership, Schema for external
data boundaries, and Context/Layer for dependencies. Consumers own the runtime.
Preserve caller error and service types. Bound memory, queues, PCM batches, and
foreign calls; await downstream work before accepting more input. Document the
limits of cancellation during synchronous Wasm calls.

Work from a stateless numbered spec in `.github/ISSUE_SPECS/`, synchronized with
its GitHub issue. For launch work, Sol scopes, Sol implements, and a fresh Sol
adversarially verifies. Record evidence and release blockers in the spec. Keep
coherent green checkpoints and preserve unrelated work.

Read the user-requested Effect guidance at
https://github.com/unconfirmedlabs/skills/tree/main/effect-ts when working on
Effect code. Pin the guidance revision used in implementation evidence.

Do not inspect or copy legacy engine source. Do not commit corpus media,
dependencies, caches, secrets, or packed tarballs. The pinned distributable Wasm
asset is intentional; retain source/build provenance and third-party notices.
Verify reproducible Wasm builds and execute an isolated packed consumer with
each advertised runtime and Effect peer. Publishing requires authorization.
