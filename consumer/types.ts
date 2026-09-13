import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  encodeFlac,
  decodeFlac,
  type FlacEncoder,
  type FlacDecoder,
  type FlacEncodeResult,
  type FlacDecodeEvent,
  type FlacEncodeError,
  type FlacDecodeError,
  type PcmInputError,
  type FlacEncodeOptions,
  type RandomAccessByteSink,
} from "@misofm/codec";

class InputService extends Context.Service<
  InputService,
  { readonly input: true }
>()("consumer/Input") {}
class OutputService extends Context.Service<
  OutputService,
  { readonly output: true }
>()("consumer/Output") {}
interface InputFailure {
  readonly _tag: "InputFailure";
}
interface OutputFailure {
  readonly _tag: "OutputFailure";
}
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

declare const input: Stream.Stream<Int32Array, InputFailure, InputService>;
declare const compressed: Stream.Stream<Uint8Array, InputFailure, InputService>;
declare const sink: RandomAccessByteSink<OutputFailure, OutputService>;
declare const options: FlacEncodeOptions;
const encoded = encodeFlac(input, sink, options);
const decoded = decodeFlac(compressed);

export type EncodeValue = Assert<
  Equal<Effect.Success<typeof encoded>, FlacEncodeResult>
>;
export type EncodeErrors = Assert<
  Equal<
    Effect.Error<typeof encoded>,
    InputFailure | OutputFailure | PcmInputError | FlacEncodeError
  >
>;
export type EncodeServices = Assert<
  Equal<
    Effect.Services<typeof encoded>,
    InputService | OutputService | FlacEncoder
  >
>;
export type DecodeValue = Assert<
  Equal<Stream.Success<typeof decoded>, FlacDecodeEvent>
>;
export type DecodeErrors = Assert<
  Equal<Stream.Error<typeof decoded>, InputFailure | FlacDecodeError>
>;
export type DecodeServices = Assert<
  Equal<Stream.Services<typeof decoded>, InputService | FlacDecoder>
>;

// @ts-expect-error PCM byte streams cannot be passed as integer sample streams.
encodeFlac(compressed, sink, options);
// @ts-expect-error Source and sink errors and services cannot disappear.
const falselyInfallible: Effect.Effect<FlacEncodeResult> = encoded;
void falselyInfallible;
