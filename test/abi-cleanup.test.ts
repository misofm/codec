import { expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import {
  decodeFlac,
  encodeFlac,
  FlacDecodeError,
  FlacDecoder,
  FlacEncodeError,
  FlacEncoder,
  PcmFormat,
  type RandomAccessByteSink,
} from "../src/index.js";

// Auditable WAT sources live in test/fixtures/*.wat. The embedded compiled bytes
// keep ordinary tests independent of an external WABT installation.
const ENCODER_DELETE_TRAP =
  "AGFzbQEAAAABJgZgA35/fwF/YAF+AX9gAX8Bf2ABfwBgBX9/f39/AX9gA39/fwF/AhwCBWNvZGVjBXdyaXRlAAAFY29kZWMEc2VlawABAwkIAgMEAgUCAgMFBgEBgAKAAgerAQkGbWVtb3J5AgAGbWFsbG9jAAIEZnJlZQADEWNvZGVjX2VuY29kZXJfbmV3AAQSY29kZWNfZW5jb2Rlcl9pbml0AAUhY29kZWNfZW5jb2Rlcl9wcm9jZXNzX2ludGVybGVhdmVkAAYUY29kZWNfZW5jb2Rlcl9maW5pc2gABxNjb2RlY19lbmNvZGVyX3N0YXRlAAgUY29kZWNfZW5jb2Rlcl9kZWxldGUACQozCAUAQYAQCwIACwUAQYACCw8AQgBBgAhB1gAQABpBAAsEAEEBCwQAQQELBABBAAsDAAALC10BAEGACAtWZkxhQwAAACIQABAA////AAAAAfQA8AAAAADUHYzZjwCyBOmACZjs+EJ+hAAAKCAAAAByZWZlcmVuY2UgbGliRkxBQyAxLjUuMCAyMDI1MDIxMQAAAAA=";
const DECODER_DELETE_TRAP =
  "AGFzbQEAAAABDANgAABgAAF/YAF/AAMNDAABAQEBAQEBAQEBAgUEAQEgIAeDCisGbWVtb3J5AgAG" +
  "bWFsbG9jAAMEZnJlZQAAFWFzeW5jaWZ5X3N0YXJ0X3Vud2luZAAAFGFzeW5jaWZ5X3N0b3BfdW53" +
  "aW5kAAAVYXN5bmNpZnlfc3RhcnRfcmV3aW5kAAAUYXN5bmNpZnlfc3RvcF9yZXdpbmQAABJhc3lu" +
  "Y2lmeV9nZXRfc3RhdGUAARljb2RlY19kZWNvZGVyX2FiaV92ZXJzaW9uAAIRY29kZWNfZGVjb2Rl" +
  "cl9uZXcAAhJjb2RlY19kZWNvZGVyX2luaXQAARxjb2RlY19kZWNvZGVyX3Byb2Nlc3Nfc2luZ2xl" +
  "AAUUY29kZWNfZGVjb2Rlcl9maW5pc2gAARRjb2RlY19kZWNvZGVyX2RlbGV0ZQALGGNvZGVjX2Rl" +
  "Y29kZXJfb3V0cHV0X3B0cgADG2NvZGVjX2RlY29kZXJfb3V0cHV0X2xlbmd0aAAKG2NvZGVjX2Rl" +
  "Y29kZXJfb3V0cHV0X2ZyYW1lcwAJJWNvZGVjX2RlY29kZXJfb3V0cHV0X2ZyYW1lX29mZnNldF9s" +
  "b3cAASZjb2RlY19kZWNvZGVyX291dHB1dF9mcmFtZV9vZmZzZXRfaGlnaAABHGNvZGVjX2RlY29k" +
  "ZXJfcmVsZWFzZV9vdXRwdXQAABljb2RlY19kZWNvZGVyX3NhbXBsZV9yYXRlAAQWY29kZWNfZGVj" +
  "b2Rlcl9jaGFubmVscwAFHWNvZGVjX2RlY29kZXJfYml0c19wZXJfc2FtcGxlAAciY29kZWNfZGVj" +
  "b2Rlcl9taW5pbXVtX2Jsb2NrX2ZyYW1lcwAGImNvZGVjX2RlY29kZXJfbWF4aW11bV9ibG9ja19m" +
  "cmFtZXMACB5jb2RlY19kZWNvZGVyX3RvdGFsX2ZyYW1lc19sb3cAAR9jb2RlY19kZWNvZGVyX3Rv" +
  "dGFsX2ZyYW1lc19oaWdoAAEgY29kZWNfZGVjb2Rlcl90b3RhbF9mcmFtZXNfa25vd24AASNjb2Rl" +
  "Y19kZWNvZGVyX3N0cmVhbWluZm9fZnJhbWVzX2xvdwABJGNvZGVjX2RlY29kZXJfc3RyZWFtaW5m" +
  "b19mcmFtZXNfaGlnaAABJWNvZGVjX2RlY29kZXJfc3RyZWFtaW5mb19mcmFtZXNfa25vd24AARlj" +
  "b2RlY19kZWNvZGVyX21kNV9wcmVzZW50AAEgY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2ZyYW1lc19s" +
  "b3cAASFjb2RlY19kZWNvZGVyX2RlY29kZWRfZnJhbWVzX2hpZ2gAAR9jb2RlY19kZWNvZGVyX2Rl" +
  "Y29kZWRfYnl0ZXNfbG93AAEgY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2J5dGVzX2hpZ2gAARxjb2Rl" +
  "Y19kZWNvZGVyX2NhbGxiYWNrX2Vycm9yAAETY29kZWNfZGVjb2Rlcl9zdGF0ZQABImNvZGVjX2Rl" +
  "Y29kZXJfYWxsb2NhdG9yX2xpdmVfYnl0ZXMAASdjb2RlY19kZWNvZGVyX2FsbG9jYXRvcl9wZWFr" +
  "X2xpdmVfYnl0ZXMAASdjb2RlY19kZWNvZGVyX2FsbG9jYXRvcl9wZWFrX2hlYXBfYnl0ZXMAASJj" +
  "b2RlY19kZWNvZGVyX2FsbG9jYXRvcl9mcmVlX2NhbGxzAAElY29kZWNfZGVjb2Rlcl9hbGxvY2F0" +
  "b3JfcmVhbGxvY19jYWxscwABCj8MAgALBABBAAsEAEEBCwUAQYAICwYAQcTYAgsEAEECCwQAQRAL" +
  "BABBGAsGAEH//wMLBABBfwsEAEF6CwMAAAs=";
const ENCODER_INVALID_ALLOCATION =
  "AGFzbQEAAAABCAJgAABgAAF/AwYFAAEBAQEFBgEBgAKAAgerAQkGbWVtb3J5AgAGbWFsbG9jAAQEZnJlZQAAEWNvZGVjX2VuY29kZXJfbmV3AAMSY29kZWNfZW5jb2Rlcl9pbml0AAEhY29kZWNfZW5jb2Rlcl9wcm9jZXNzX2ludGVybGVhdmVkAAIUY29kZWNfZW5jb2Rlcl9maW5pc2gAAhNjb2RlY19lbmNvZGVyX3N0YXRlAAEUY29kZWNfZW5jb2Rlcl9kZWxldGUAAAoZBQIACwQAQQALBABBAQsFAEGAAgsEAEF8Cw==";
const ENCODER_INVALID_METADATA_CHAIN =
  "AGFzbQEAAAABJgZgA35/fwF/YAF+AX9gAX8Bf2ABfwBgBX9/f39/AX9gA39/fwF/AhwCBWNvZGVjBXdyaXRlAAAFY29kZWMEc2VlawABAwkIAgMEAgUCAgMFBgEBgAKAAgerAQkGbWVtb3J5AgAGbWFsbG9jAAIEZnJlZQADEWNvZGVjX2VuY29kZXJfbmV3AAQSY29kZWNfZW5jb2Rlcl9pbml0AAUhY29kZWNfZW5jb2Rlcl9wcm9jZXNzX2ludGVybGVhdmVkAAYUY29kZWNfZW5jb2Rlcl9maW5pc2gABxNjb2RlY19lbmNvZGVyX3N0YXRlAAgUY29kZWNfZW5jb2Rlcl9kZWxldGUACQoxCAUAQYAQCwIACwUAQYACCw4AQgBBgAhBKhAAGkEACwQAQQELBABBAQsEAEEACwIACwsxAQBBgAgLKmZMYUMAAAAiEAAQAAAAAAAAAAH0APAAAAAA1B2M2Y8AsgTpgAmY7PhCfg==";
const DECODER_INVALID_METADATA =
  "AGFzbQEAAAABCAJgAAF/YAAAAwUEAQAAAAUEAQEgIAeDCisGbWVtb3J5AgAGbWFsbG9jAAMEZnJlZQAAFWFzeW5jaWZ5X3N0YXJ0X3Vud2luZAAAFGFzeW5jaWZ5X3N0b3BfdW53aW5kAAAVYXN5bmNpZnlfc3RhcnRfcmV3aW5kAAAUYXN5bmNpZnlfc3RvcF9yZXdpbmQAABJhc3luY2lmeV9nZXRfc3RhdGUAARljb2RlY19kZWNvZGVyX2FiaV92ZXJzaW9uAAIRY29kZWNfZGVjb2Rlcl9uZXcAAhJjb2RlY19kZWNvZGVyX2luaXQAARxjb2RlY19kZWNvZGVyX3Byb2Nlc3Nfc2luZ2xlAAEUY29kZWNfZGVjb2Rlcl9maW5pc2gAARRjb2RlY19kZWNvZGVyX2RlbGV0ZQAAGGNvZGVjX2RlY29kZXJfb3V0cHV0X3B0cgACG2NvZGVjX2RlY29kZXJfb3V0cHV0X2xlbmd0aAABG2NvZGVjX2RlY29kZXJfb3V0cHV0X2ZyYW1lcwABJWNvZGVjX2RlY29kZXJfb3V0cHV0X2ZyYW1lX29mZnNldF9sb3cAASZjb2RlY19kZWNvZGVyX291dHB1dF9mcmFtZV9vZmZzZXRfaGlnaAABHGNvZGVjX2RlY29kZXJfcmVsZWFzZV9vdXRwdXQAABljb2RlY19kZWNvZGVyX3NhbXBsZV9yYXRlAAEWY29kZWNfZGVjb2Rlcl9jaGFubmVscwABHWNvZGVjX2RlY29kZXJfYml0c19wZXJfc2FtcGxlAAEiY29kZWNfZGVjb2Rlcl9taW5pbXVtX2Jsb2NrX2ZyYW1lcwABImNvZGVjX2RlY29kZXJfbWF4aW11bV9ibG9ja19mcmFtZXMAAR5jb2RlY19kZWNvZGVyX3RvdGFsX2ZyYW1lc19sb3cAAR9jb2RlY19kZWNvZGVyX3RvdGFsX2ZyYW1lc19oaWdoAAEgY29kZWNfZGVjb2Rlcl90b3RhbF9mcmFtZXNfa25vd24AASNjb2RlY19kZWNvZGVyX3N0cmVhbWluZm9fZnJhbWVzX2xvdwABJGNvZGVjX2RlY29kZXJfc3RyZWFtaW5mb19mcmFtZXNfaGlnaAABJWNvZGVjX2RlY29kZXJfc3RyZWFtaW5mb19mcmFtZXNfa25vd24AARljb2RlY19kZWNvZGVyX21kNV9wcmVzZW50AAEgY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2ZyYW1lc19sb3cAASFjb2RlY19kZWNvZGVyX2RlY29kZWRfZnJhbWVzX2hpZ2gAAR9jb2RlY19kZWNvZGVyX2RlY29kZWRfYnl0ZXNfbG93AAEgY29kZWNfZGVyX2RlY29kZWRfYnl0ZXNfaGlnaAABHGNvZGVjX2RlY29kZXJfY2FsbGJhY2tfZXJyb3IAARNjb2RlY19kZWNvZGVyX3N0YXRlAAEiY29kZWNfZGVyX2FsbG9jYXRvcl9saXZlX2J5dGVzAAEnY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfcGVha19saXZlX2J5dGVzAAEnY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfcGVha19oZWFwX2J5dGVzAAEiY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfZnJlZV9jYWxscwABJWNvZGVjX2RlY29kZXJfYWxsb2NhdG9yX3JlYWxsb2NfY2FsbHMAAQoUBAIACwQAQQALBABBAQsFAEGACAs=";
const DECODER_INVALID_OUTPUT =
  "AGFzbQEAAAABCAJgAAF/YAAAAwwLAQAAAAAAAAAAAAAFBAEBICAHgworBm1lbW9yeQIABm1hbGxvYwADBGZyZWUAABVhc3luY2lmeV9zdGFydF91bndpbmQAABRhc3luY2lmeV9zdG9wX3Vud2luZAAAFWFzeW5jaWZ5X3N0YXJ0X3Jld2luZAAAFGFzeW5jaWZ5X3N0b3BfcmV3aW5kAAASYXN5bmNpZnlfZ2V0X3N0YXRlAAEZY29kZWNfZGVjb2Rlcl9hYmlfdmVyc2lvbgACEWNvZGVjX2RlY29kZXJfbmV3AAISY29kZWNfZGVjb2Rlcl9pbml0AAEcY29kZWNfZGVjb2Rlcl9wcm9jZXNzX3NpbmdsZQACFGNvZGVjX2RlY29kZXJfZmluaXNoAAEUY29kZWNfZGVjb2Rlcl9kZWxldGUAABhjb2RlY19kZWNvZGVyX291dHB1dF9wdHIAAxtjb2RlY19kZWNvZGVyX291dHB1dF9sZW5ndGgAChtjb2RlY19kZWNvZGVyX291dHB1dF9mcmFtZXMACSVjb2RlY19kZWNvZGVyX291dHB1dF9mcmFtZV9vZmZzZXRfbG93AAEmY29kZWNfZGVjb2Rlcl9vdXRwdXRfZnJhbWVfb2Zmc2V0X2hpZ2gAARxjb2RlY19kZWNvZGVyX3JlbGVhc2Vfb3V0cHV0AAAZY29kZWNfZGVjb2Rlcl9zYW1wbGVfcmF0ZQAEFmNvZGVjX2RlY29kZXJfY2hhbm5lbHMABR1jb2RlY19kZWNvZGVyX2JpdHNfcGVyX3NhbXBsZQAHImNvZGVjX2RlY29kZXJfbWluaW11bV9ibG9ja19mcmFtZXMABiJjb2RlY19kZWNvZGVyX21heGltdW1fYmxvY2tfZnJhbWVzAAgeY29kZWNfZGVjb2Rlcl90b3RhbF9mcmFtZXNfbG93AAEfY29kZWNfZGVjb2Rlcl90b3RhbF9mcmFtZXNfaGlnaAABIGNvZGVjX2RlY29kZXJfdG90YWxfZnJhbWVzX2tub3duAAEjY29kZWNfZGVjb2Rlcl9zdHJlYW1pbmZvX2ZyYW1lc19sb3cAASRjb2RlY19kZWNvZGVyX3N0cmVhbWluZm9fZnJhbWVzX2hpZ2gAASVjb2RlY19kZWNvZGVyX3N0cmVhbWluZm9fZnJhbWVzX2tub3duAAEZY29kZWNfZGVjb2Rlcl9tZDVfcHJlc2VudAABIGNvZGVjX2RlY29kZXJfZGVjb2RlZF9mcmFtZXNfbG93AAEhY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2ZyYW1lc19oaWdoAAEfY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2J5dGVzX2xvdwABIGNvZGVjX2RlY29kZXJfZGVjb2RlZF9ieXRlc19oaWdoAAEcY29kZWNfZGVjb2Rlcl9jYWxsYmFja19lcnJvcgABE2NvZGVjX2RlY29kZXJfc3RhdGUAASJjb2RlY19kZWNvZGVyX2FsbG9jYXRvcl9saXZlX2J5dGVzAAEnY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfcGVha19saXZlX2J5dGVzAAEnY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfcGVha19oZWFwX2J5dGVzAAEiY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfZnJlZV9jYWxscwABJWNvZGVjX2RlY29kZXJfYWxsb2NhdG9yX3JlYWxsb2NfY2FsbHMAAQo7CwIACwQAQQALBABBAQsFAEGACAsGAEHE2AILBABBAgsEAEEQCwQAQRgLBgBB//8DCwQAQX8LBABBegs=";
const DECODER_STALL =
  "AGFzbQEAAAABCAJgAAF/YAAAAwwLAQAAAAAAAAAAAAAFBAEBICAHgworBm1lbW9yeQIABm1hbGxvYwADBGZyZWUAABVhc3luY2lmeV9zdGFydF91bndpbmQAABRhc3luY2lmeV9zdG9wX3Vud2luZAAAFWFzeW5jaWZ5X3N0YXJ0X3Jld2luZAAAFGFzeW5jaWZ5X3N0b3BfcmV3aW5kAAASYXN5bmNpZnlfZ2V0X3N0YXRlAAEZY29kZWNfZGVjb2Rlcl9hYmlfdmVyc2lvbgACEWNvZGVjX2RlY29kZXJfbmV3AAISY29kZWNfZGVjb2Rlcl9pbml0AAEcY29kZWNfZGVjb2Rlcl9wcm9jZXNzX3NpbmdsZQABFGNvZGVjX2RlY29kZXJfZmluaXNoAAEUY29kZWNfZGVjb2Rlcl9kZWxldGUAABhjb2RlY19kZWNvZGVyX291dHB1dF9wdHIAAxtjb2RlY19kZWNvZGVyX291dHB1dF9sZW5ndGgAChtjb2RlY19kZWNvZGVyX291dHB1dF9mcmFtZXMACSVjb2RlY19kZWNvZGVyX291dHB1dF9mcmFtZV9vZmZzZXRfbG93AAEmY29kZWNfZGVjb2Rlcl9vdXRwdXRfZnJhbWVfb2Zmc2V0X2hpZ2gAARxjb2RlY19kZWNvZGVyX3JlbGVhc2Vfb3V0cHV0AAAZY29kZWNfZGVjb2Rlcl9zYW1wbGVfcmF0ZQAEFmNvZGVjX2RlY29kZXJfY2hhbm5lbHMABR1jb2RlY19kZWNvZGVyX2JpdHNfcGVyX3NhbXBsZQAHImNvZGVjX2RlY29kZXJfbWluaW11bV9ibG9ja19mcmFtZXMABiJjb2RlY19kZWNvZGVyX21heGltdW1fYmxvY2tfZnJhbWVzAAgeY29kZWNfZGVjb2Rlcl90b3RhbF9mcmFtZXNfbG93AAEfY29kZWNfZGVjb2Rlcl90b3RhbF9mcmFtZXNfaGlnaAABIGNvZGVjX2RlY29kZXJfdG90YWxfZnJhbWVzX2tub3duAAEjY29kZWNfZGVjb2Rlcl9zdHJlYW1pbmZvX2ZyYW1lc19sb3cAASRjb2RlY19kZWNvZGVyX3N0cmVhbWluZm9fZnJhbWVzX2hpZ2gAASVjb2RlY19kZWNvZGVyX3N0cmVhbWluZm9fZnJhbWVzX2tub3duAAEZY29kZWNfZGVjb2Rlcl9tZDVfcHJlc2VudAABIGNvZGVjX2RlY29kZXJfZGVjb2RlZF9mcmFtZXNfbG93AAEhY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2ZyYW1lc19oaWdoAAEfY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2J5dGVzX2xvdwABIGNvZGVjX2RlY29kZXJfZGVjb2RlZF9ieXRlc19oaWdoAAEcY29kZWNfZGVjb2Rlcl9jYWxsYmFja19lcnJvcgABE2NvZGVjX2RlY29kZXJfc3RhdGUAASJjb2RlY19kZWNvZGVyX2FsbG9jYXRvcl9saXZlX2J5dGVzAAEnY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfcGVha19saXZlX2J5dGVzAAEnY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfcGVha19oZWFwX2J5dGVzAAEiY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfZnJlZV9jYWxscwABJWNvZGVjX2RlY29kZXJfYWxsb2NhdG9yX3JlYWxsb2NfY2FsbHMAAQo7CwIACwQAQQALBABBAQsFAEGACAsGAEHE2AILBABBAgsEAEEQCwQAQRgLBgBB//8DCwQAQX8LBABBegs=";

const joinBase64 = (...chunks: ReadonlyArray<string>): string =>
  chunks.join("");
const DECODER_INVALID_METADATA_AUDITED = joinBase64(
  "AGFzbQEAAAABCAJgAABgAAF/AwUEAAEBAQUEAQEgIAeDCisGbWVtb3J5AgAGbWFsbG9jAAMEZnJl",
  "ZQAAFWFzeW5jaWZ5X3N0YXJ0X3Vud2luZAAAFGFzeW5jaWZ5X3N0b3BfdW53aW5kAAAVYXN5bmNp",
  "Znlfc3RhcnRfcmV3aW5kAAAUYXN5bmNpZnlfc3RvcF9yZXdpbmQAABJhc3luY2lmeV9nZXRfc3Rh",
  "dGUAARljb2RlY19kZWNvZGVyX2FiaV92ZXJzaW9uAAIRY29kZWNfZGVjb2Rlcl9uZXcAAhJjb2Rl",
  "Y19kZWNvZGVyX2luaXQAARxjb2RlY19kZWNvZGVyX3Byb2Nlc3Nfc2luZ2xlAAEUY29kZWNfZGVj",
  "b2Rlcl9maW5pc2gAARRjb2RlY19kZWNvZGVyX2RlbGV0ZQAAGGNvZGVjX2RlY29kZXJfb3V0cHV0",
  "X3B0cgACG2NvZGVjX2RlY29kZXJfb3V0cHV0X2xlbmd0aAABG2NvZGVjX2RlY29kZXJfb3V0cHV0",
  "X2ZyYW1lcwABJWNvZGVjX2RlY29kZXJfb3V0cHV0X2ZyYW1lX29mZnNldF9sb3cAASZjb2RlY19k",
  "ZWNvZGVyX291dHB1dF9mcmFtZV9vZmZzZXRfaGlnaAABHGNvZGVjX2RlY29kZXJfcmVsZWFzZV9v",
  "dXRwdXQAABljb2RlY19kZWNvZGVyX3NhbXBsZV9yYXRlAAEWY29kZWNfZGVjb2Rlcl9jaGFubmVs",
  "cwABHWNvZGVjX2RlY29kZXJfYml0c19wZXJfc2FtcGxlAAEiY29kZWNfZGVjb2Rlcl9taW5pbXVt",
  "X2Jsb2NrX2ZyYW1lcwABImNvZGVjX2RlY29kZXJfbWF4aW11bV9ibG9ja19mcmFtZXMAAR5jb2Rl",
  "Y19kZWNvZGVyX3RvdGFsX2ZyYW1lc19sb3cAAR9jb2RlY19kZWNvZGVyX3RvdGFsX2ZyYW1lc19o",
  "aWdoAAEgY29kZWNfZGVjb2Rlcl90b3RhbF9mcmFtZXNfa25vd24AASNjb2RlY19kZWNvZGVyX3N0",
  "cmVhbWluZm9fZnJhbWVzX2xvdwABJGNvZGVjX2RlY29kZXJfc3RyZWFtaW5mb19mcmFtZXNfaGln",
  "aAABJWNvZGVjX2RlY29kZXJfc3RyZWFtaW5mb19mcmFtZXNfa25vd24AARljb2RlY19kZWNvZGVy",
  "X21kNV9wcmVzZW50AAEgY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2ZyYW1lc19sb3cAASFjb2RlY19k",
  "ZWNvZGVyX2RlY29kZWRfZnJhbWVzX2hpZ2gAAR9jb2RlY19kZWNvZGVyX2RlY29kZWRfYnl0ZXNf",
  "bG93AAEgY29kZWNfZGVjb2Rlcl9kZWNvZGVkX2J5dGVzX2hpZ2gAARxjb2RlY19kZWNvZGVyX2Nh",
  "bGxiYWNrX2Vycm9yAAETY29kZWNfZGVjb2Rlcl9zdGF0ZQABImNvZGVjX2RlY29kZXJfYWxsb2Nh",
  "dG9yX2xpdmVfYnl0ZXMAASdjb2RlY19kZWNvZGVyX2FsbG9jYXRvcl9wZWFrX2xpdmVfYnl0ZXMA",
  "ASdjb2RlY19kZWNvZGVyX2FsbG9jYXRvcl9wZWFrX2hlYXBfYnl0ZXMAASJjb2RlY19kZWNvZGVy",
  "X2FsbG9jYXRvcl9mcmVlX2NhbGxzAAElY29kZWNfZGVjb2Rlcl9hbGxvY2F0b3JfcmVhbGxvY19j",
  "YWxscwABChQEAgALBABBAAsEAEEBCwUAQYAICw==",
);

const moduleFromBase64 = (base64: string): Promise<WebAssembly.Module> =>
  WebAssembly.compile(
    Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
  );

const format = new PcmFormat({
  sampleRate: 8_000,
  channels: 1,
  bitsPerSample: 16,
});

const memorySink = (): RandomAccessByteSink<never, never> => ({
  writeAt: () => Effect.void,
  resize: () => Effect.void,
});

test("successful encoder cleanup traps are typed failures", async () => {
  const module = await moduleFromBase64(ENCODER_DELETE_TRAP);
  const exit = await Effect.runPromise(
    Effect.exit(
      encodeFlac(Stream.empty, memorySink(), {
        format,
        expectedFrames: 0n,
      }).pipe(Effect.provideService(FlacEncoder, { module })),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(false);
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(FlacEncodeError);
    expect(error).toMatchObject({ reason: "wasm-trap", phase: "finish" });
  }
});

test("successful decoder cleanup traps before Complete", async () => {
  const module = await moduleFromBase64(DECODER_DELETE_TRAP);
  const emitted: Array<string> = [];
  const exit = await Effect.runPromise(
    Effect.exit(
      Stream.runDrain(
        decodeFlac(Stream.empty).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              emitted.push(event._tag);
            }),
          ),
        ),
      ).pipe(Effect.provideService(FlacDecoder, { module })),
    ),
  );
  expect(emitted).toEqual(["Metadata"]);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(false);
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(FlacDecodeError);
    expect(error).toMatchObject({ reason: "wasm-trap", phase: "finish" });
  }
});

test("cleanup traps preserve a primary source failure", async () => {
  const module = await moduleFromBase64(ENCODER_DELETE_TRAP);
  const primary = { _tag: "PrimaryFailure" } as const;
  const exit = await Effect.runPromise(
    Effect.exit(
      encodeFlac(Stream.fail(primary), memorySink(), {
        format,
        expectedFrames: 0n,
      }).pipe(Effect.provideService(FlacEncoder, { module })),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(primary);
});

test("malformed encoder pointers and metadata chains fail without defects", async () => {
  for (const [bytes, expected] of [
    [ENCODER_INVALID_ALLOCATION, { reason: "wasm-abi", phase: "init" }],
    [
      ENCODER_INVALID_METADATA_CHAIN,
      { reason: "invalid-streaminfo", phase: "validate" },
    ],
  ] as const) {
    const module = await moduleFromBase64(bytes);
    const exit = await Effect.runPromise(
      Effect.exit(
        encodeFlac(Stream.empty, memorySink(), {
          format,
          expectedFrames: 0n,
        }).pipe(Effect.provideService(FlacEncoder, { module })),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toMatchObject(expected);
    }
  }
});

test("malformed decoder metadata, output, and stalls fail without defects", async () => {
  for (const [bytes, expected, expectedEvents] of [
    [
      DECODER_INVALID_METADATA_AUDITED,
      { reason: "wasm-abi", phase: "metadata" },
      [],
    ],
    [
      DECODER_INVALID_OUTPUT,
      { reason: "wasm-abi", phase: "frame" },
      ["Metadata"],
    ],
    [DECODER_STALL, { reason: "invalid-stream", phase: "frame" }, ["Metadata"]],
  ] as const) {
    const module = await moduleFromBase64(bytes);
    const emitted: Array<string> = [];
    const exit = await Effect.runPromise(
      Effect.exit(
        Stream.runDrain(
          decodeFlac(Stream.empty).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                emitted.push(event._tag);
              }),
            ),
          ),
        ).pipe(Effect.provideService(FlacDecoder, { module })),
      ),
    );
    expect(emitted).toEqual([...expectedEvents]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toMatchObject(expected);
    }
  }
});
