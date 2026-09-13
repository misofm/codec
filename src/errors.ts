import * as Schema from "effect/Schema";

export const PcmInputErrorReason = Schema.Literals([
  "invalid-format",
  "empty-block",
  "misaligned-block",
  "block-too-large",
  "sample-out-of-range",
  "too-many-frames",
  "frame-count-mismatch",
]);

/** A checked PCM contract violation. No samples from the failing block are used. */
export class PcmInputError extends Schema.TaggedError<PcmInputError>()(
  "PcmInputError",
  {
    reason: PcmInputErrorReason,
    detail: Schema.String,
    blockIndex: Schema.optionalKey(Schema.Natural),
    sampleIndex: Schema.optionalKey(Schema.Natural),
    value: Schema.optionalKey(Schema.Int),
    expectedFrames: Schema.optionalKey(Schema.BigInt),
    actualFrames: Schema.optionalKey(Schema.BigInt),
  },
) {}

export const FlacEncodeErrorReason = Schema.Literals([
  "wasm-compile",
  "wasm-abi",
  "wasm-instantiate",
  "wasm-trap",
  "allocation-failed",
  "encoder-create",
  "encoder-init",
  "encoder-process",
  "encoder-finish",
  "staged-output-limit",
  "invalid-streaminfo",
  "streaminfo-mismatch",
]);

/** A failure in the Wasm/libFLAC encoder boundary. */
export class FlacEncodeError extends Schema.TaggedError<FlacEncodeError>()(
  "FlacEncodeError",
  {
    reason: FlacEncodeErrorReason,
    phase: Schema.Literals([
      "load",
      "instantiate",
      "init",
      "process",
      "finish",
      "validate",
    ]),
    detail: Schema.String,
    nativeState: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
