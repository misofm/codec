# Publish @misofm/codec 0.1.0 and configure trusted publishing

GitHub: https://github.com/misofm/codec/issues/3

## Authorization and scope

The user explicitly requested publication and npm trusted publishing on
2026-09-13. This authorizes the release actions that were excluded from issue 1.
The reviewed codec implementation is merged through PR 2 at main `544aaa9`.
Publish the real `@misofm/codec@0.1.0` package and configure a reusable GitHub
Actions OIDC publisher for `misofm/codec`. Preserve all codec source, Wasm assets,
peer/runtime support, and verification gates. No adapter/CLI/transcoder changes.

## Release contract

- Work from a reviewed, green, exact main commit. Keep the public package and
  repository identity fixed; version 0.1.0 must be absent before publication.
- Build and test the release tarball using the existing fresh-consumer matrix.
  Publish exactly the verified tarball, with no media, caches, dependencies,
  credentials, or test fixtures added to the package.
- Because npm requires an existing package to configure trust, use the local
  authorized npm CLI for the first real release. Record that this local bootstrap
  has no CI provenance; keep provenance enabled for subsequent OIDC releases.
  Do not publish placeholder versions or issue extra versions merely to test OIDC.
- Configure trusted publisher `misofm/codec`, workflow `npm-publish.yml`, with
  direct `npm publish` permission. Do not place an npm write token in GitHub.
  Use npm 11.19.1, which supports the current trust CLI, without changing the
  user's global npm installation.
- Add an explicit GitHub-hosted release workflow with publish and verify modes,
  exact main commit/version admission, concurrency control, pinned tooling,
  and `contents: read` / `id-token: write` permissions. Never publish on a PR.
  Run codec checks, native oracle verification, and packed consumers before a
  publish. Future CI publication emits npm provenance automatically.
- Verify public registry identity, integrity, installed Wasm assets, and real
  encode/decode through an isolated registry consumer. Verify the saved trusted
  publisher configuration and exercise the workflow's read-only verify mode.
- A browser/passkey/OTP challenge is a registry authentication requirement, not
  an additional permission request. Preserve the pending CLI command and ask
  for only the authentication action npm requires if it cannot complete locally.

## Evidence and completion gates

Sol scopes and implements release tooling; fresh Sol reviews the immutable
release change. Record exact commit/tag, CI run, tested tarball SHA-256/integrity,
registry version and dist-tag, trust configuration, and registry-consumer result.
The task is complete when 0.1.0 is publicly installable, trusted publishing is
configured, and release verification is green. Do not claim a verify-only run
has exercised an OIDC publish. Any pending authentication remains explicit.

## Current status

The local npm account is authenticated with write access to the organization,
2FA is enabled, and `@misofm/codec` does not yet exist in the registry. Release
workflow implementation, review, publication, and trust configuration are pending.
