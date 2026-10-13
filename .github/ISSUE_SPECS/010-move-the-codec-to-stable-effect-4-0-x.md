# Move the codec to stable Effect 4.0.x (0.2.0)

GitHub: https://github.com/misofm/codec/issues/10

## Objective and immutable scope

Move `@misofm/codec` from Effect release candidates (peer `4.0.0-rc.112 || 4.0.0-rc.115`) to stable Effect `4.0.x` so `misofm/app` and `@misofm/engine-web-adapter` can share one Effect 4.0.4 copy. Release as 0.2.0. Preserve the public API (built `dist` identical to 0.1.1), the Wasm assets (encoder `90da75c7…`, decoder `70caf381…`), bounds, cancellation, and backpressure. No source, ABI, or asset change; no adapter, app, or Engine work.

Why: `engine-web-adapter@0.5.13` depended on `effect@4.0.0-rc.112`. When the application shares one Effect 4.0.x copy with the codec (deduplicated install, for example bun's loose peers), the adapter's rc.112 runtime runs a codec `Layer` built by that copy and fails with `Cannot read properties of undefined (reading 'scheduler')`. Unit tests did not catch it because they resolve one Effect copy.

Base: origin/main `10abab98191b878482a02c0d8e9a2572c8eb0958` (codec 0.1.1). Branch `effect-4.0.4`, PR https://github.com/misofm/codec/pull/9. Effect guidance: [skills revision 0507930](https://github.com/unconfirmedlabs/skills/tree/0507930b6dd13f39739aba40b86a6afb63d32e09/effect-ts) (`references/migration.md`, "Effect v4 release candidates to 4.0.x").

## Implementation contract

- `package.json`: version 0.2.0, peer `effect >=4.0.3 <4.1`, dev dependency `effect` pinned exactly to 4.0.4 (the codec imports only `effect`; there is no `@effect/*` package), `CHANGELOG.md` in `files`. Regenerate `bun.lock`.
- `scripts/pack-check.mjs` runs the isolated packed-consumer matrix on Effect 4.0.3 and 4.0.4 (Bun, Node, Chromium, Firefox, WebKit) and requires `CHANGELOG.md` in the tarball.
- `CHANGELOG.md` records the behaviour audit and the consumer migration note. README and `.github/RELEASING.md` name the new matrix.
- Historical evidence (`docs/evidence/packed-consumers.json`, `.github/RELEASE_EVIDENCE/003`, `006`) is not rewritten.

## Evidence (candidate, not published)

- Compiles unchanged against 4.0.4; the built `.js`, `.d.ts`, and maps are byte-identical to the 0.1.1 output.
- Differential script across {0.1.1, 0.2.0} × {rc.115, 4.0.4}: identical error shapes (message, JSON, `Cause.pretty`, Schema encoding), encoded FLAC and decoded PCM hashes, exit reasons, source-error identity, interruption while waiting for input, early take, timeout on a stalled source, and encode interruption without late writes. One measured exception: `JSON.stringify` of a `FlacDecodeError` whose `cause` is a `SchemaError` is now compact (Effect #8895); the only producer is an ABI-violation path (see `CHANGELOG.md`).
- Local: `bun run check` (40 pass, 5 native-only skips), pinned-native `bun run test:integration` (5 pass), `bun run build:wasm:verify` (both assets reproduce), `bun run pack:check` on 4.0.3 and 4.0.4. `npm install --strict-peer-deps` plus `npm ls` valid on 4.0.4 and 4.0.3; `4.0.0-rc.115` is rejected with `ERESOLVE`.
- Repro of the original failure and its absence with codec 0.2.0 plus adapter 0.6.0: see the adapter PR https://github.com/misofm/engine-web-adapter/pull/130.

## Release contract and blockers

Release follows `.github/RELEASING.md`: merge a reviewed, green PR; run `npm-publish.yml` on `main` with `mode=publish`, the exact 40-character merge SHA, and `expected_version=0.2.0`; create the `v0.2.0` release/tag at that commit; record the run URL, registry integrity, and decoder hash here and in `.github/RELEASE_EVIDENCE/010/registry-release.json`. Blockers: the adapter PR installs this codec from the throwaway branch `effect-4.0.4-ci-dist` and must be flipped to the published 0.2.0 after release; delete that branch afterwards. Publication has not been performed.

## Published release

Codec 0.2.0 was merged in PR #9 at `56383ab56c2a389a6856b27d8207695f6153c0fe` and published through trusted publishing: https://github.com/misofm/codec/actions/runs/38429325908 . Its qualification and `npm publish` (signed provenance) succeeded; the job then failed its post-publish convergence check only because the registry took more than two minutes to list the version, so its registry-consumer job was skipped. A `mode=verify` dispatch at the same commit, https://github.com/misofm/codec/actions/runs/38430320099 , passed qualification, registry comparison, and the full registry-consumer matrix against the published tarball (read-only; it does not itself claim an OIDC publication). The `v0.2.0` annotated tag and release point to that revision: https://github.com/misofm/codec/releases/tag/v0.2.0 . Registry integrity, tarball SHA-256, and decoder hash are recorded in `.github/RELEASE_EVIDENCE/010/registry-release.json`; the decoder asset is unchanged (`70caf381…`). The adapter PR (https://github.com/misofm/engine-web-adapter/pull/130) moves to the published package; the throwaway `effect-4.0.4-ci-dist` branch is retained until that lands.
