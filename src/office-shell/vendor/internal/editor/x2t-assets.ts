import {
  resolveSiteUrl,
  STATIC_RESOURCE,
  X2T_PDF_FONT_MANIFEST,
} from "../../const";

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;

let brotliStreamSupported: boolean | null = null;

function isWasmBinary(data: Uint8Array) {
  return (
    data.length >= WASM_MAGIC.length &&
    WASM_MAGIC.every((byte, index) => data[index] === byte)
  );
}

function isJavaScriptSource(data: Uint8Array) {
  const head = new TextDecoder().decode(
    data.slice(0, Math.min(data.length, 128)),
  );
  return /^\s*(\/\/|\/\*|var |function|\(function)/.test(head);
}

function isAlreadyDecompressed(data: Uint8Array) {
  return isWasmBinary(data) || isJavaScriptSource(data);
}

function canDecompressBrotliInBrowser() {
  if (brotliStreamSupported !== null) {
    return brotliStreamSupported;
  }

  if (!("DecompressionStream" in globalThis)) {
    brotliStreamSupported = false;
    return false;
  }

  try {
    new DecompressionStream("br" as CompressionFormat);
    brotliStreamSupported = true;
  } catch {
    brotliStreamSupported = false;
  }

  return brotliStreamSupported;
}

function toArrayBuffer(data: Uint8Array) {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

async function decompressWithStream(buffer: ArrayBuffer) {
  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("br" as CompressionFormat));

  return new Response(stream).arrayBuffer();
}

function decompressWithVendoredBrotli(buffer: ArrayBuffer) {
  return import("../vendor/brotli-dec").then(({ brotliDecompress }) =>
    toArrayBuffer(brotliDecompress(new Uint8Array(buffer))),
  );
}

async function decompressBrotli(buffer: ArrayBuffer) {
  if (canDecompressBrotliInBrowser()) {
    try {
      return await decompressWithStream(buffer);
    } catch {
      /**
       * @description Safari 等环境可能构造成功但运行失败，此时继续走内置 JS 解码。
       */
    }
  }

  return decompressWithVendoredBrotli(buffer);
}

/**
 * @description 拉取 Brotli 预压缩的 x2t 静态资源并解压，不依赖服务端 Content-Encoding: br。
 */
export async function fetchMaybeBrotliAsset(
  url: string,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (isAlreadyDecompressed(bytes)) {
    return buffer;
  }

  return decompressBrotli(buffer);
}

/**
 * @description 拉取并解码为 JS 源码（供 Worker 内 executeEmscriptenScript 执行）。
 */
export async function fetchMaybeBrotliScript(
  url: string,
  fetchImpl: typeof fetch = fetch,
) {
  const buffer = await fetchMaybeBrotliAsset(url, fetchImpl);
  return new TextDecoder().decode(buffer);
}


let cachedFonts: Record<string, Uint8Array> | null = null;
let cachedFontsRoot = "";
let loadingPromise: Promise<Record<string, Uint8Array>> | null = null;
let loadingFontsRoot = "";

async function fetchPdfFontFile(origin: string, root: string, file: string) {
  const url = resolveSiteUrl(
    origin,
    `${root}/${file}`,
  );
  const response = await fetch(url);
  if (!response.ok) {
    console.warn("[x2t-assets] font fetch failed:", url, response.status);
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength ? bytes : null;
}

/**
 * @description 加载 PDF 导出字体，结果缓存在内存中。
 */
export async function loadX2tPdfFonts(
  origin: string,
  root = STATIC_RESOURCE.x2t.pdfFonts.root,
): Promise<Record<string, Uint8Array>> {
  if (cachedFonts && cachedFontsRoot === root) {
    return cachedFonts;
  }
  if (loadingPromise && loadingFontsRoot === root) {
    return loadingPromise;
  }
  loadingFontsRoot = root;

  loadingPromise = (async () => {
    const fonts: Record<string, Uint8Array> = {};

    for (const entry of X2T_PDF_FONT_MANIFEST) {
      const bytes = await fetchPdfFontFile(origin, root, entry.file);
      if (!bytes) {
        continue;
      }
      for (const alias of entry.aliases) {
        fonts[alias] = bytes;
      }
    }

    if (!fonts["Carlito.ttf"]?.byteLength) {
      console.warn(
        "[x2t-assets] Carlito regular missing under",
        root,
      );
      return {};
    }

    cachedFonts = fonts;
    cachedFontsRoot = root;
    return cachedFonts;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}
