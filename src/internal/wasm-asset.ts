import * as Effect from "effect/Effect";

/** How a pinned Wasm asset is identified and how its failures are typed. */
export interface PinnedWasmAsset<E> {
  /** "encoder" or "decoder", used in failure details. */
  readonly label: string;
  readonly maxBytes: number;
  readonly sha256: string;
  readonly expectedImports: ReadonlyArray<string>;
  readonly expectedExports: ReadonlyArray<string>;
  /** Failure while checking or compiling the asset bytes (`wasm-compile`). */
  readonly compileError: (detail: string, cause?: unknown) => E;
  /** The compiled module does not have the pinned imports/exports (`wasm-abi`). */
  readonly abiError: (detail: string) => E;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const describeImports = (module: WebAssembly.Module): ReadonlyArray<string> =>
  WebAssembly.Module.imports(module)
    .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
    .sort();

const describeExports = (module: WebAssembly.Module): ReadonlyArray<string> =>
  WebAssembly.Module.exports(module)
    .map(({ name, kind }) => `${name}:${kind}`)
    .sort();

const sameList = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): boolean =>
  actual.length === expected.length &&
  actual.every((entry, index) => entry === expected[index]);

/**
 * Check a trusted asset against its size limit and pinned SHA-256, compile a
 * private copy, and require exactly the pinned import/export surface.
 */
export const compilePinnedWasm = <E>(
  bytes: Uint8Array,
  asset: PinnedWasmAsset<E>,
): Effect.Effect<WebAssembly.Module, E> =>
  Effect.gen(function* () {
    if (bytes.byteLength > asset.maxBytes) {
      return yield* Effect.fail(
        asset.compileError(
          `${asset.label} asset is ${bytes.byteLength} bytes; maximum is ${asset.maxBytes}`,
        ),
      );
    }
    // Hash and compile one private copy so a caller cannot change the bytes
    // between verification and compilation.
    const owned = Uint8Array.from(bytes);
    const digest = yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.digest("SHA-256", owned.buffer),
      catch: (cause) =>
        asset.compileError(
          `could not compute the SHA-256 of the ${asset.label} asset`,
          cause,
        ),
    });
    const hash = hex(new Uint8Array(digest));
    if (hash !== asset.sha256) {
      return yield* Effect.fail(
        asset.compileError(
          `${asset.label} asset SHA-256 ${hash} does not match pinned ${asset.sha256}`,
        ),
      );
    }
    const module = yield* Effect.tryPromise({
      try: () => WebAssembly.compile(owned.buffer),
      catch: (cause) =>
        asset.compileError(
          `WebAssembly.compile rejected the ${asset.label} asset`,
          cause,
        ),
    });
    const imports = describeImports(module);
    if (!sameList(imports, asset.expectedImports)) {
      return yield* Effect.fail(
        asset.abiError(
          `unexpected ${asset.label} imports: ${imports.join(", ")}`,
        ),
      );
    }
    const exports = describeExports(module);
    if (!sameList(exports, asset.expectedExports)) {
      return yield* Effect.fail(
        asset.abiError(
          `unexpected ${asset.label} exports: ${exports.join(", ")}`,
        ),
      );
    }
    return module;
  });
