function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Browser-friendly dictionary bootstrap: dictionary.bin is a compressed
 * copy of the static dictionary; decompress it on first use.
 */
import { BrotliDecompressBuffer } from "./decode";
import dictionaryBin from "./dictionary.bin";

export function init() {
  const compressed = base64ToBytes(dictionaryBin);
  return BrotliDecompressBuffer(compressed);
}
