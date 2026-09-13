# Focused release-audit fix review

## Decision

**PASS: no blocker found in immutable commit `b234c1f94b4684c747adde1606dcb341c1c44288` against main `12f54c988a2df319064e6ca3885268d976319cc1`.**

This review was limited to the signature/provenance audit repair and the added release evidence/documentation. It did not repeat codec or consumer qualification.

## Audit fix

The failed workflow used a shell `if` around an indented heredoc. The repair removes that shell construct, places the mode branch inside Node, and leaves the heredoc terminator at shell column zero after YAML block indentation is removed.

I independently extracted all 14 `run` values from the final workflow and passed each exact value to `bash -n`: 14 passed, 0 failed. `actionlint 1.7.12` also passes the final workflow, and Prettier and `git diff --check` pass.

The mode behavior remains fail-closed where required:

- `mode=verify` still runs `npm audit signatures` first. The Node branch then exits successfully without reading or requiring a provenance attestation and emits the explicit statement that verify mode was read-only and does not prove an OIDC publication.
- `mode=publish` reads the audit report, requires the exact `@misofm/codec@0.1.0` entry, and requires `attestations.provenance.predicateType` to equal `https://slsa.dev/provenance/v1`.
- An independently executed extraction of the exact Node body passed for verify mode even with deliberately non-JSON attestation contents, passed for publish mode with the expected SLSA predicate, and failed for publish mode when provenance was absent with `OIDC publication lacks a verified provenance attestation`.
- The actual `npm publish` step remains conditional on `inputs.mode == 'publish'`; this patch did not weaken OIDC or publication isolation.

## Evidence and documentation

- The diff contains only the workflow fix, issue/release documentation, and release evidence. No package or codec file changed.
- The release main tree `12f54c9` is byte-identical to the previously reviewed `5d7e1a7` tree.
- `qualified-tarball.json` and `registry-consumer.json` are byte-identical. Their SHA-256, SHA-512 integrity, 139,230-byte size, two Effect peers, Bun/Node results, and Chromium/Firefox/WebKit results agree with `registry-artifact.json`.
- The registry artifact is explicitly recorded as the local bootstrap with no CI attestation. The issue does not claim that the verify-only workflow exercised OIDC publication.
- The issue accurately records run `34741165009` as passing qualification, byte equality, and the full registry matrix while failing the final audit step because of heredoc syntax.
- Trusted-publisher creation is recorded as successful from the creation response, while the separate authenticated read-back remains explicitly pending. The release guide explains the observed JSON buffering behavior and uses interactive text output for the read-back command.
- PR 5 CI run `34741533160` is reported green. A green verify dispatch of the merged correction remains an explicit completion step, as it should.

## Handoff

Commit `b234c1f94b4684c747adde1606dcb341c1c44288` is safe to merge. After merge, rerun `mode=verify` at the exact new main SHA and retain its green final audit result. This run remains read-only evidence and must not be described as an OIDC publish. Complete the separately authenticated trust read-back before declaring issue 3 fully complete.
