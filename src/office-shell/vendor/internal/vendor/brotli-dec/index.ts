/** Vendored Brotli decompressor (MIT, brotli.js / Google). See dec/decode.ts header. */
import { BrotliDecompressBuffer } from "./dec/decode";

export function brotliDecompress(input: Uint8Array): Uint8Array {
  return BrotliDecompressBuffer(input) as Uint8Array;
}
