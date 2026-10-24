# Changelog

All notable changes to `@misofm/codec`, newest first.

## 0.2.1

Encoding in browsers is about four times faster. The public API, declarations,
Wasm assets, encoded bytes, and error `reason`/`phase` codes are unchanged, so
this is a patch release.

### Fixed

- **The encoder no longer yields to the scheduler after every 4,096-frame block.**
  Effect's default scheduler yields with `setImmediate` where the host has it,
  and with `setTimeout(0)` in browsers and workers. Browsers clamp nested timers
  to at least 4 ms, so a 4-minute 48 kHz stereo encode (2,813 blocks) spent
  seconds waiting on timers. The encoder now relies on the fiber runtime's
  operation budget (`Scheduler.MaxOpsBeforeYield`). It also yields at least once
  per 100 ms of encoding, measured with `Clock.monotonicTimeNanos`, through the
  caller's own `Scheduler` and `Clock`. Measured with `scripts/throughput.mjs`
  (synthetic 4-minute 24-bit stereo, in memory, default scheduler, three to
  five rounds):

  | Runtime                | 0.2.0 encode | 0.2.1 encode | Scheduler dispatches |
  | ---------------------- | ------------ | ------------ | -------------------- |
  | Chromium 151 worker    | 16.5–17.7 s  | 4.33 s       | 2,813 → 41           |
  | WebKit 26.5 worker     | 17.9–19.9 s  | 4.87 s       | 2,813 → 46           |
  | Firefox 153 worker[^1] | 42.3–42.7 s  | 32.1 s       | 2,813 → 288          |
  | Node 22.23.2           | 4.07 s       | 4.05 s       | 2,813 → 40           |

  [^1]:
      Headless Firefox runs this Wasm slowly on the measuring host. With a
      `MessageChannel` scheduler it takes 30.3–30.5 s under both versions.

  Browser consumers no longer need a custom `MessageChannel` scheduler for
  throughput. Decoding never yielded per block. It is unchanged and costs 35
  dispatches per track.

### Behaviour changes

- **The thread is held for longer between scheduler handoffs.** Before, the
  encoder let other fibers, timers, and interruption run after every block,
  roughly every 1.5 ms on the measuring host. During a fully synchronous encode
  (an in-memory source and sink), the longest interval without a handoff is now
  about 100–135 ms on that host. The 100 ms slice also bounds it on slower
  devices. Asynchronous source or sink waits still yield as before. To hand off
  more often on a UI thread, lower `Scheduler.MaxOpsBeforeYield`, or run the
  codec in a worker as before. See "Scheduling" in the README.
- Failure details for malformed or tampered Wasm assets are more accurate.
  Oversize and SHA-256-mismatch assets now say so; before, every case said
  "WebAssembly.compile rejected the asset". Decoder instantiation now names the
  failed check. These failures carry no `cause`. Only `detail` strings changed.
- The decoder now rejects an Asyncify stack allocation with a negative or
  out-of-range pointer, not only a null one (`wasm-instantiate`). It no longer
  calls `codec_decoder_delete` on an invalid non-zero decoder pointer. Decoder
  Wasm instantiation is now an uninterruptible `acquireRelease` acquisition.
  These paths are unreachable with the pinned assets.

### Internal

- Wasm resources are owned by Effect scopes: `acquireRelease` for the decoder ABI
  and libFLAC decoder (into the stream's resource scope), one idempotent
  release for the encoder, and typed `Effect.fail` validation instead of
  exceptions thrown inside `Effect.try`. Asset loading for both codecs shares one
  pinned-Wasm compile helper.
- New `test/scheduling.test.ts` fails if per-block scheduler yields return. New
  `test/wasm-lifecycle.test.ts` covers asset failure details and Wasm release on
  success, failure, and interruption. `scripts/throughput.mjs` measures Node,
  Bun, and browser workers.

### Release automation

- A push to `main` now runs `npm-publish.yml`. It publishes through npm trusted
  publishing (OIDC) only when the exact `package.json` version is absent from the
  registry, after the full qualification gates. Manual dispatch is unchanged. The
  workflow filename is unchanged, so the npm trusted publisher needs no update.

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
