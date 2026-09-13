# Adversarial npm release review

## Decision

**Sign-off: PASS for release commit `5d7e1a7ceb667276c84934e0a61e95c725e5cae6`, with no remaining launch blocker in the reviewed release tooling or documentation.**

Reviewed against base `544aaa969a186ef52e492e580dee34986c72d8bf` and issue 3's release contract. Scope was `.github/workflows/npm-publish.yml`, `.github/RELEASING.md`, `README.md`, and the release extensions to `scripts/pack-check.mjs`; codec implementation was intentionally excluded.

## Blocker found and resolved

The original review target `732d6dcb710e641b3aa2c65f5cca9f122bdf7ba7` used `${{ runner.temp }}` in `jobs.<job_id>.env` for both the publish/compare and registry-consumer jobs. GitHub's context-availability rules do not permit the `runner` context at job-level `env`, so the workflow could fail validation before dispatch.

Commit `5d7e1a7ceb667276c84934e0a61e95c725e5cae6` removes those expressions. Each pinned-npm setup step now derives the two npm config paths from `$RUNNER_TEMP`, exports them for the current step, creates the empty files, and persists the resolved paths through `$GITHUB_ENV`. The npm token variables remain empty for the entire job. The final workflow passes actionlint 1.7.12.

Reference: <https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability>

## Release invariants reviewed

- Exact-main admission is fail-closed: the dispatch input must be a lowercase 40-character SHA, the dispatch ref and event SHA must match it, checkout HEAD must match it, and the live remote `main` tip must match it. Package name, version, and repository identity are also checked before qualification.
- Version admission is correct for both modes. `publish` requires a registry 404 for the exact version and npm remains the authoritative race-safe final writer; `verify` requires the exact registry version to exist. The live registry returned 404 for `@misofm/codec@0.1.0` during this review.
- OIDC is isolated to `publish-or-compare`. Qualification and registry-consumer jobs have only `contents: read`; the privileged job does not check out or execute repository code and has no npm token fallback. Its publish step is additionally conditional on `mode=publish`.
- Qualification copies the tarball only after the complete packed-consumer matrix succeeds. The workflow then requires one retained `.tgz`, recomputes SHA-256 and SHA-512 integrity, binds them to the receipt, and transfers only the tarball plus receipt as a one-day artifact.
- The publish job rechecks artifact membership, receipt fields, both digests, and the packed manifest before registry admission. It publishes the exact downloaded `.tgz` with lifecycle scripts disabled, then downloads the registry tarball and requires byte-level SHA-256/SHA-512 equality.
- Registry verification reuses the full `pack:check` consumer path against `@misofm/codec@<version>` with the qualification SHA-256. It therefore covers both Effect peers, Bun, Node, and Chromium/Firefox/WebKit using the registry tarball rather than a workspace alias.
- Bootstrap semantics are explicit and correct: the one authorized local 0.1.0 command uses the retained tested tarball, `--ignore-scripts`, and `--provenance=false`, while `publishConfig.provenance=true` stays in the manifest. Trust is configured only after the real package exists. `npm trust github` help under npm 11.19.1 confirms `--file`, `--repo`, and `--allow-publish`; the documented command selects npm 11.19.1 without replacing the global client.
- CI publish mode requires a verified SLSA provenance attestation. Verify mode skips publication and explicitly states that it does not prove an OIDC publish, matching the issue and release guide.
- README publication wording and install command are consistent with the intended public 0.1.0 release. The release guide accurately distinguishes local bootstrap from subsequent OIDC publication.

## Focused validation evidence

- `actionlint 1.7.12 .github/workflows/npm-publish.yml`: pass.
- Prettier on all changed release/docs files: pass.
- `node --check scripts/pack-check.mjs`: pass.
- `git diff --check 544aaa9..5d7e1a7`: pass; worktree clean.
- Independently exercised failure paths: malformed expected SHA, destination inside the repository, and receipt inside the retained-artifact directory all exited nonzero with the intended diagnostic before qualification.
- Retained tested tarball: `/tmp/codec-release.265Gqx/misofm-codec-0.1.0.tgz`.
- Receipt: `/tmp/codec-pack-receipt.FsHDl3.json`.
- Independently recomputed SHA-256: `3c318e0e5ccb861994b5084f5b3aeea857d79c5ae78f5fc412f2e85d8dd10a36`, equal to the receipt.
- Independently recomputed SHA-512 integrity equals the receipt: `sha512-Oleo8mUbyNzooQIgOsdxfxBYGhBXAJyGvZCna5cTcD8vGdfgcxMTUvzbCSccEOUYQ6vg+87WbI0UYmcEQpAk0w==`.
- A fresh npm 11.19.1 pack of final commit `5d7e1a7` produced the same SHA-256, confirming that the workflow-only correction did not alter package bytes.
- Existing full qualification receipt contains both advertised Effect peers. The supplied full ten-combination packed matrix passed under npm 11.19.1. PR 4 CI was reported green for package and Wasm jobs; those checks were not redundantly rerun in this release-only review.
- npm 11.19.1 resolves through the documented `npm exec` form, and `--provenance=false` resolves to `false`, overriding the manifest default for the bootstrap command.

## Operational handoff

The reviewed tooling is ready to merge and use. Publication/trust setup still must record the resulting main SHA, registry integrity and `latest` dist-tag, saved trusted-publisher configuration, read-only `mode=verify` run URL, and registry-consumer result in issue 3. A verify-only run must remain recorded as read-only evidence rather than as an OIDC publication test.
