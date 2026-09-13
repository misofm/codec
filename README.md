# @misofm/codec

Effect-based audio codec primitives backed by pinned libFLAC WebAssembly.

This package owns codec implementation and bounded PCM processing. Callers own
files, media pipelines, delivery chunks, manifests, storage, and publication.

Development uses Bun. The first implementation is tracked in the repository's
numbered issue specifications under `.github/ISSUE_SPECS/`.
