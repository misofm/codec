import * as Schema from "effect/Schema";

export const FlacDecodeErrorReason = Schema.Literals([
  "invalid-options",
  "input-chunk-too-large",
  "wasm-compile",
  "wasm-abi",
  "wasm-instantiate",
  "wasm-trap",
  "allocation-failed",
  "invalid-metadata",
  "metadata-limit",
  "expected-metadata-mismatch",
  "invalid-stream",
  "frame-position-mismatch",
  "frame-count-mismatch",
  "crc-mismatch",
  "md5-mismatch",
]);

/** A checked failure while loading or incrementally decoding a FLAC stream. */
export class FlacDecodeError extends Schema.TaggedError<FlacDecodeError>()(
  "FlacDecodeError",
  {
    reason: FlacDecodeErrorReason,
    phase: Schema.Literals([
      "load",
      "instantiate",
      "metadata",
      "frame",
      "finish",
    ]),
    detail: Schema.String,
    nativeState: Schema.optionalKey(Schema.Int),
    callbackError: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
