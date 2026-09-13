# Third-party software

`@misofm/codec` source is licensed under Apache-2.0. Its bundled WebAssembly
assets incorporate separately licensed software. Complete notices in
`vendor/licenses/` are included in the npm package.

| Component          | Version                      | Notice                                                              |
| ------------------ | ---------------------------- | ------------------------------------------------------------------- |
| libFLAC            | 1.5.0                        | [Xiph BSD license](vendor/licenses/libFLAC.txt)                     |
| Emscripten runtime | 6.0.9                        | [MIT / University of Illinois-NCSA](vendor/licenses/emscripten.txt) |
| musl libc          | supplied by Emscripten 6.0.9 | [musl notices](vendor/licenses/musl.txt)                            |
| LLVM compiler-rt   | supplied by Emscripten 6.0.9 | [LLVM notices](vendor/licenses/compiler-rt.txt)                     |

The decoder's freestanding allocator/runtime is derived from
`misofm/engine-web-adapter`, `decoder/freestanding.c`, revision
`73e891df62375d1ee45d8228029796ef9597cb43`, Copyright 2026 Miso, under Apache-2.0.
The package-local adaptation is identified in `native/decoder-runtime.c`.

Only the libFLAC library is linked into the assets. The upstream `flac` command
line program is a development and verification tool and is not distributed in
the npm package.

The source archive is retained in the Git repository for reproducible builds.
Its upstream distribution includes files under other licenses; those files are
not all linked into the distributed assets. Consult the archive's individual
notices when using it independently. Wasm build manifests record exact source,
toolchain, patch, and asset provenance.
