# Releasing @misofm/codec

Releases use a reviewed, green main commit and an exact version. The package is
built with Bun 1.4.2, verified on Node 22.23.2 and browser workers, and published
with npm 11.19.1. Keep the public package name and repository URL unchanged.

## Preparing a release

1. Update `package.json` and `bun.lock` for a new version, review the change, and
   merge only after the ordinary, native, Wasm rebuild, and packed-consumer gates
   pass. Never reuse a published version.
2. Record the full lowercase main commit SHA and exact package version.
3. Run the **npm-publish.yml** workflow on `main` with `mode=publish`,
   `expected_sha=<40-character commit>`, and `expected_version=<version>`.
4. Verify the registry result and create the matching GitHub release/tag at the
   reviewed commit. Record the run URL and registry integrity in the issue spec.

The workflow has three jobs. Qualification builds and verifies the package
without an OIDC permission, preserving the tarball only after every consumer
passes. The publishing job receives that artifact, verifies its digest and
identity, and publishes it without running repository code or lifecycle scripts.
It alone receives `id-token: write`; it has no npm write-token fallback. The
registry job downloads the published package and repeats the consumer matrix
without OIDC permission.

`mode=verify` performs the same qualification and registry comparison without
publishing. Use it for an existing version with the same package contents. It
proves registry bytes and runtime behavior; it does not prove an OIDC publication.

## Trusted publisher configuration

The npm trusted publisher must match:

| Field             | Value                |
| ----------------- | -------------------- |
| Provider          | GitHub Actions       |
| Repository        | `misofm/codec`       |
| Workflow filename | `npm-publish.yml`    |
| Permission        | Direct `npm publish` |

Configure it with the maintained CLI, using the locally authenticated npm
account and completing npm's own browser/passkey challenge when requested:

```sh
npm exec --yes --package npm@11.19.1 -- npm trust github @misofm/codec \
  --repo=misofm/codec --file=npm-publish.yml --allow-publish --yes
npm exec --yes --package npm@11.19.1 -- npm trust list @misofm/codec
```

Use interactive text output for trust commands: JSON output can buffer the
browser authentication link while the command waits. npm may require a separate
authentication for the read-back command as well as the settings change.

This does not install or replace the local global npm client. GitHub-hosted
publishing uses short-lived OIDC credentials, and npm generates provenance for
those public releases. See the official [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
and [`npm trust` prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Initial 0.1.0 bootstrap

npm requires the package to exist before trust can be configured. The first real
0.1.0 release therefore uses the authorized local npm CLI and the exact tested
tarball. Disable provenance only with an explicit flag on this one command:

```sh
npm exec --yes --package npm@11.19.1 -- npm publish /absolute/path/to/tested.tgz \
  --access=public --tag=latest --ignore-scripts --provenance=false
```

Keep `publishConfig.provenance=true` in the package. The local bootstrap has no
GitHub/npm build attestation; the source revision, tests, pinned Wasm manifests,
and registry artifact equality are recorded independently. Configure trust after
0.1.0 exists, then exercise `mode=verify`. Do not invent a placeholder or extra
patch version just to test OIDC.

## Local artifact verification

The existing consumer script accepts these optional environment variables:

| Variable                     | Purpose                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `CODEC_PACK_DESTINATION`     | Pre-existing empty directory outside the repository; receives the verified tarball after all tests pass |
| `CODEC_PACK_RECEIPT`         | JSON receipt path, including filename, SHA-256, and SHA-512 integrity                                   |
| `CODEC_PACK_SOURCE`          | Exact npm package spec to verify; omitted when packing the working tree                                 |
| `CODEC_PACK_EXPECTED_SHA256` | Expected lowercase SHA-256 of the tarball                                                               |

A registry check uses `CODEC_PACK_SOURCE=@misofm/codec@<version>` and the expected
hash from the release qualification. It checks the actual registry tarball in
isolated installations across Effect rc.112/rc.115, Bun, Node, Chromium, Firefox,
and WebKit. Keep receipts in the issue evidence; do not commit the tarball.
