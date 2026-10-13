# Changelog

All notable changes to `@misofm/codec`, newest first.

## 0.2.0

Moves the package from Effect release candidates (`4.0.0-rc.112 || 4.0.0-rc.115`)
to stable Effect `4.0.x`: developed and tested on `4.0.4`, peer floor `4.0.3`.
The public API, the Wasm assets, and the built JavaScript are unchanged. The
`dist/` output compiled against Effect 4.0.4 is byte-identical to the 0.1.1 output
(every `.js`, `.d.ts`, and map), and no source file changed.

### Changed (breaking)

- **Peer `effect` is now `>=4.0.3 <4.1`** (was `4.0.0-rc.112 || 4.0.0-rc.115`).
  Release candidates are no longer supported; stay on 0.1.x for them.

### Behaviour changes from Effect 4.0.x

The codec uses `Stream.transformPullBracket`, `Stream.rechunk`, `Stream.runForEach`,
`Pull.matchEffect`, `Cause.done`, `Scope.addFinalizer`, `Effect.acquireRelease`,
`Effect.scoped`, `Effect.try`/`tryPromise`, `Effect.forEach`, `Effect.yieldNow`,
`Schema.decodeUnknownEffect`, `Schema.TaggedError`, `Schema.Defect`, `Layer.effect`,
and `Context.Service`. It uses no `partition`, `Effect.retry`, `Schedule`,
`Effect.timeout`, `Worker`, or `Effect.async`/`callback`, so the partition-order,
retry, schedule, and TimeoutError-text changes do not apply.

A differential run of the same script against the 0.1.1 package on `effect@4.0.0-rc.115`
and the 0.2.0 package on `effect@4.0.4` (also 0.1.1 on 4.0.4 and 0.2.0 on rc.115)
produced identical output for:

- the `message`, `name`, JSON, `Cause.pretty`, and Schema-encoded forms of
  `FlacDecodeError`, `FlacEncodeError`, and `PcmInputError` (with and without a plain
  `Error` as `cause`, and with `bigint` fields);
- the encoded FLAC bytes, STREAMINFO MD5, decoded PCM bytes, and `Complete` event;
- the exit reasons for truncated input, a failing source (the source's error object
  is still returned by identity), invalid options, and invalid PCM blocks;
- interruption while the decoder waits for input (one `Interrupt` reason, source
  finalizer run once), early `Stream.take` (no `Complete`, source finalizer run once),
  `Effect.timeout` on a stalled source, and interruption of an encode with a pending
  source (one `Interrupt` reason, no late sink writes).

One difference is known and was measured: `JSON.stringify` of a `FlacDecodeError` whose
`cause` is an Effect `SchemaError` now yields the compact `{ "_tag": "SchemaError",
"message": ... }` object (Effect 4.0.3, #8895) instead of a dump of the schema AST. Its
Schema-encoded form and `Cause.pretty` output are unchanged. The codec sets such a cause
in one place only: when the decoder Wasm reports a PCM format that `PcmFormat` rejects
(`reason: "wasm-abi"`), an ABI violation that the pinned decoder asset does not produce,
so the path is effectively unreachable.

Effect 4.0.x changes that touch this code, and why they are unobservable here:

- `Scope.close` finalizers run uninterruptibly (Effect rc.118). The decoder release
  finalizer and the encoder `acquireRelease` release are synchronous and bounded, so
  interruption could not abandon them before either.
- A pending interruption is kept when an uninterruptible effect fails, and typed
  failures are dropped when interruption skips recovery handlers (Effect 4.0.1, #8652).
  The Wasm calls are synchronous and the codec has no uninterruptible region of its own,
  so a decode or encode is still interrupted at the next pull, input wait, or sink write.

### Migrating from 0.1.x

1. Move your whole Effect release train to stable together and pin it to one `4.0.x`
   version, for example `"effect": "4.0.4"` plus every `@effect/*` package you use at
   `4.0.4`. A mixed release-candidate and stable install fails to resolve `effect/*`
   module paths, and two copies of `effect` give the shared `Context.Service` tags,
   tagged errors, and `Layer` internals different identities. In particular, a
   Layer built by one copy's runtime and constructed by another copy fails with
   `Cannot read properties of undefined (reading 'scheduler')`: this happens when a
   dependency such as `@misofm/engine-web-adapter@0.5.x` still pins
   `effect@4.0.0-rc.112` while the app and `@misofm/codec` use 4.0.x. Upgrade every
   `@misofm/*` package that depends on `effect` in the same change.
2. Nothing else changes in code that imports `@misofm/codec`.
