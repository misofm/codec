# Support Effect 4.1 (0.2.2)

## Objective and immutable scope

Widen the `effect` peer of `@misofm/codec` from `>=4.0.3 <4.1` to `>=4.0.3 <4.2` and release it as 0.2.2. Miso Studio (`misofm/studio-v2`) needs Effect 4.1 for `@misofm/sdk` and `@unconfirmed/sui-effect` 0.6, whose peers are `effect >=4.1.1 <4.2`, while keeping one Effect copy shared with the codec. The public API, Wasm assets, bounds, cancellation, backpressure and scheduling stay unchanged. No source, ABI or asset change.

Base: origin/main `105cbe7` (codec 0.2.1). Branch `effect-4.1`.

## Implementation contract

- `package.json`: version 0.2.2, peer `effect >=4.0.3 <4.2`, dev dependency `effect` pinned exactly to 4.1.2. Regenerate `bun.lock`.
- `scripts/pack-check.mjs` runs the isolated packed-consumer matrix on Effect 4.0.3, 4.0.4, 4.1.1 and 4.1.2 (Bun, Node, Chromium, Firefox, WebKit).
- `CHANGELOG.md`, README and `.github/RELEASING.md` name the new range and matrix.
- Historical evidence is not rewritten.

## Evidence (candidate, not published)

- `dist/` compiled against Effect 4.1.2 is byte-identical to the build against 4.0.4.
- Local, on Effect 4.1.2: `bun run check` (47 pass, 5 native-only skips), pinned-native `bun run test:integration` (5 pass), `bun run pack:check` on 4.0.3, 4.0.4, 4.1.1 and 4.1.2 (Bun 1.4.4, Node 24.22.1, Chromium, Firefox, WebKit).
- `node scripts/throughput.mjs default 3 node,bun`: encode about 4.2 s on Node and 4.5 s on Bun with 41–44 scheduler dispatches on both 4.1.2 and 4.0.4. Decode is unchanged at 35 dispatches.

## Release contract and blockers

Release follows `.github/RELEASING.md`: merge a green PR, after which `npm-publish.yml` publishes 0.2.2 from `main`. Then create the `v0.2.2` release/tag at that commit and record the run URL and registry integrity here.
