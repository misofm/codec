import * as Schema from "effect/Schema";

export const PcmSampleRate = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 8_000, maximum: 192_000 })),
).annotate({
  identifier: "PcmSampleRate",
  description: "Integer PCM sample rate from 8,000 through 192,000 Hz",
});

export const PcmChannels = Schema.Literals([1, 2]).annotate({
  identifier: "PcmChannels",
  description: "Interleaved mono or stereo PCM channel count",
});

export const PcmBitsPerSample = Schema.Literals([16, 24]).annotate({
  identifier: "PcmBitsPerSample",
  description: "Signed, right-justified integer PCM sample depth",
});

/** The validated PCM format accepted and returned by this package. */
export class PcmFormat extends Schema.Class<PcmFormat>(
  "@misofm/codec/PcmFormat",
)({
  sampleRate: PcmSampleRate,
  channels: PcmChannels,
  bitsPerSample: PcmBitsPerSample,
}) {}
