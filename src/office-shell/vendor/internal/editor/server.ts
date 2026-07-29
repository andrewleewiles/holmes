import { converter } from "./x2t";
import { MockSocket } from "./runtime-bridge";
import {
  User,
  Participant,
  AscSaveTypes,
  ServerOptions,
  OfficeXmlSizeLimitExceededError,
  isOfficeXmlSizeLimitExceededError,
} from "./types";
import { emptyDocx, emptyPdf, emptyPptx, emptyXlsx } from "./empty";
import { convertCsvBufferToXlsxBuffer } from "./office-format";
import { createDocxFromText, createXlsxFromText } from "./office-format";
import {
  getDocumentType,
  getFileExt,
  getX2tConvertFormats,
  getX2tExportFormats,
  getX2tCsvConvertOptions,
  sanitizeCsvBufferForX2t,
  isMultilineCsv,
  extensionFromOutputFormat,
  ensureTitleWithExtension,
  isCanvasBinOutputFormat,
  normalizeX2tExportFileType,
} from "./utils";
import { getOnlyOfficeMimeType } from "../../util/document-file";
import {
  OFFICE_XML_EVENT_CONFIG,
  isOnlyOfficeCdnMode,
  type OfficeXmlEventConfig,
} from "../../const";
import {
  getZipXmlUncompressedSize,
  readZipEntries,
  readZipEntryData,
  writeZipEntries,
  type ZipReplacement,
} from "./office-format";
import type { EditorLogCategory, EditorLogLevel } from "./logger";

/**
 * @description Mock OnlyOffice 协作服务，维护 Editor.bin、媒体资源和 downloadAs HTTP 管道。
 */

/**
 * @description 程序化导出完成时返回给 WebSocket save 的占位 URL，避免触发真实浏览器下载。
 */
const PROGRAMMATIC_EXPORT_ACK_URL = "onlyoffice://export/ack";
function mergeBuffers(buffers: Uint8Array[]) {
  const totalLength = buffers.reduce((acc, buffer) => acc + buffer.length, 0);
  const mergedBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    mergedBuffer.set(buffer, offset);
    offset += buffer.length;
  }
  return mergedBuffer;
}

/**
 * @description OnlyOffice 画布 bin 魔数；x2t 只接受 XLSY/DOCY/PPTY，非法数据会导致导出失败。
 */
function isValidEditorBin(data: Uint8Array) {
  if (data.length < 4) {
    return false;
  }

  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  return magic === "XLSY" || magic === "DOCY" || magic === "PPTY";
}

function isPdfBytes(data: Uint8Array) {
  return (
    data.length >= 5 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  );
}

function isOfficeZipFileType(fileType: string) {
  return /^(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm|ppsx|ppsm)$/i.test(
    getFileExt(fileType),
  );
}

function isZipBytes(data: Uint8Array) {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    ((data[2] === 0x03 && data[3] === 0x04) ||
      (data[2] === 0x05 && data[3] === 0x06) ||
      (data[2] === 0x07 && data[3] === 0x08))
  );
}

function createPlainTextOfficeFallback(
  buffer: ArrayBuffer,
  fileType: string,
) {
  switch (getDocumentType(fileType)) {
    case "word":
      return { buffer: createDocxFromText(buffer), fileType: "docx" };
    case "cell":
      return { buffer: createXlsxFromText(buffer), fileType: "xlsx" };
    default:
      return null;
  }
}

const PDF_EOF_MARKER = new TextEncoder().encode("%%EOF");

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array) {
  if (needle.length === 0) {
    return 0;
  }
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function assertValidPdfOutput(data: Uint8Array, label = "PDF") {
  if (!isPdfBytes(data)) {
    throw new Error(`${label} output is not a valid PDF`);
  }
  const scanLen = Math.min(data.byteLength, 1024 * 1024);
  const tail = data.subarray(data.byteLength - scanLen);
  if (indexOfSubarray(tail, PDF_EOF_MARKER) < 0) {
    throw new Error(`${label} output is corrupt (missing %%EOF trailer)`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

const PDF_CONVERT_TIMEOUT_MS = 120_000;
const TRANSPARENT_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  ),
  (value) => value.charCodeAt(0),
);

function randomId() {
  return Math.random().toString(36).substring(2, 9);
}

type CoAuthoringLockBlock =
  | string
  | number
  | { guid?: string; [key: string]: unknown };

function normalizeCoAuthoringLockBlocks(block: unknown): CoAuthoringLockBlock[] {
  if (Array.isArray(block)) {
    return block as CoAuthoringLockBlock[];
  }
  return [block as CoAuthoringLockBlock];
}

function getCoAuthoringLockKey(
  block: CoAuthoringLockBlock,
  isSpreadsheet: boolean,
) {
  if (
    isSpreadsheet &&
    typeof block === "object" &&
    block !== null &&
    block.guid != null
  ) {
    return String(block.guid);
  }
  return String(block);
}

function buildCoAuthoringLocks(
  block: unknown,
  fileType: string,
  userId?: string,
) {
  const isSpreadsheet = getDocumentType(fileType) === "cell";
  const time = +new Date();
  const locks: Record<
    string,
    { time: number; user?: string; block: CoAuthoringLockBlock }
  > = {};

  for (const item of normalizeCoAuthoringLockBlocks(block)) {
    const key = getCoAuthoringLockKey(item, isSpreadsheet);
    locks[key] = {
      time,
      user: userId,
      block: item,
    };
  }

  return locks;
}

function getUrl(data: Uint8Array, type?: string) {
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
    type: type || "application/octet-stream",
  });
  return URL.createObjectURL(blob);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensurePngContentType(contentTypes: string) {
  if (/Extension="png"/i.test(contentTypes)) {
    return contentTypes;
  }

  return contentTypes.replace(
    "</Types>",
    '<Default Extension="png" ContentType="image/png"/></Types>',
  );
}

function parseSvgSize(svgText: string) {
  const width = Number(/<svg\b[^>]*\bwidth="([\d.]+)/i.exec(svgText)?.[1]);
  const height = Number(/<svg\b[^>]*\bheight="([\d.]+)/i.exec(svgText)?.[1]);
  if (width > 0 && height > 0) {
    return { width, height };
  }

  const viewBox = /<svg\b[^>]*\bviewBox="([^"]+)"/i
    .exec(svgText)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  return { width: 256, height: 256 };
}

async function rasterizeImageToPng(
  imageBytes: Uint8Array,
  mimeType: string,
  fallbackSize?: { width: number; height: number },
) {
  if (typeof document === "undefined") {
    return TRANSPARENT_PNG;
  }

  const blob = new Blob([imageBytes as Uint8Array<ArrayBuffer>], {
    type: mimeType,
  });
  const url = URL.createObjectURL(blob);

  try {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode SVG image"));
    });
    image.src = url;
    await loaded;

    const width = image.naturalWidth || fallbackSize?.width || 256;
    const height = image.naturalHeight || fallbackSize?.height || 256;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    const context = canvas.getContext("2d");
    if (!context) {
      return TRANSPARENT_PNG;
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!pngBlob) {
      return TRANSPARENT_PNG;
    }

    return new Uint8Array(await pngBlob.arrayBuffer());
  } catch (err) {
    console.warn("[EditorServer] SVG to PNG fallback:", err);
    return TRANSPARENT_PNG;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function rasterizeSvgToPng(svgBytes: Uint8Array) {
  const svgText = new TextDecoder().decode(svgBytes);
  return rasterizeImageToPng(svgBytes, "image/svg+xml", parseSvgSize(svgText));
}

async function rasterizeWebpToPng(webpBytes: Uint8Array) {
  return rasterizeImageToPng(webpBytes, "image/webp");
}

function replaceBytes(data: Uint8Array, from: Uint8Array, to: Uint8Array) {
  if (from.byteLength !== to.byteLength) {
    throw new Error("Replacement must keep binary length unchanged");
  }

  const output = data.slice();
  for (let i = 0; i <= output.byteLength - from.byteLength; i++) {
    let matches = true;
    for (let j = 0; j < from.byteLength; j++) {
      if (output[i + j] !== from[j]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      output.set(to, i);
      i += from.byteLength - 1;
    }
  }

  return output;
}

function replaceAsciiExtension(
  data: Uint8Array,
  fromExt: string,
  toExt: string,
) {
  return replaceBytes(
    data,
    new TextEncoder().encode(fromExt),
    new TextEncoder().encode(toExt),
  );
}

function replaceUtf16LeExtension(
  data: Uint8Array,
  fromExt: string,
  toExt: string,
) {
  const encode = (value: string) => {
    const bytes = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
      bytes[i * 2] = value.charCodeAt(i);
    }
    return bytes;
  };

  return replaceBytes(data, encode(fromExt), encode(toExt));
}

function rewriteEditorBinUnsupportedMediaRefs(data: Uint8Array) {
  let output = data;
  for (const fromExt of [".emf", ".EMF", ".svg", ".SVG"]) {
    const toExt = fromExt === fromExt.toUpperCase() ? ".PNG" : ".png";
    output = replaceAsciiExtension(output, fromExt, toExt);
    output = replaceUtf16LeExtension(output, fromExt, toExt);
  }
  return output;
}

/**
 * @description Response 头值须为 ISO-8859-1，中文文件名放在 filename*=UTF-8 段。
 */
function buildContentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, '\\"');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function getCacheDownloadName(
  outputName: string,
  title: string,
  filetype: string,
  downloadFileNames: Map<string, string>,
) {
  const stored = downloadFileNames.get(outputName);
  if (stored) {
    return stored;
  }
  if (outputName === "Editor.bin" || outputName.startsWith("output.")) {
    return ensureTitleWithExtension(title, filetype);
  }
  return outputName.split("/").pop() || outputName;
}

function getCacheResponseMimeType(name: string, fallbackFileType: string) {
  if (name.startsWith("media/")) {
    return detectImageMimeForName(name);
  }

  const filetype = getFileExt(name.replace(/^output\./, "")) || fallbackFileType;
  if (name === "Editor.bin") {
    return "application/octet-stream";
  }
  return getOnlyOfficeMimeType(filetype);
}

function getDataUrl(data: Uint8Array, mimeType = "application/octet-stream") {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function parseClipboardImage(input: string) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(input);
  if (!match) {
    return null;
  }

  const mime = match[1];
  const binary = atob(match[2]);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    data[i] = binary.charCodeAt(i);
  }

  const subtype = mime.split("/")[1]?.split("+")[0] || "png";
  const ext = subtype === "jpeg" ? "jpg" : subtype;
  return { data, mime, ext };
}

async function fetchClipboardImage(input: string) {
  let url: URL;
  try {
    url = new URL(input, window.location.href);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const response = await fetch(url.href);
  if (!response.ok) {
    return null;
  }

  const data = new Uint8Array(await response.arrayBuffer());
  const headerMime = response.headers.get("Content-Type")?.split(";")[0] ?? "";
  const mime = headerMime.startsWith("image/") ? headerMime : detectImageMime(data);
  if (!mime.startsWith("image/")) {
    return null;
  }

  const ext = getFileExt(url.pathname) || getImageExt(mime);
  return { data, mime, ext };
}

function detectImageMime(data: Uint8Array) {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}

function detectImageMimeForName(name: string) {
  switch (getFileExt(name)) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}

function getImageExt(mime: string) {
  const subtype = mime.split("/")[1]?.split("+")[0] || "png";
  return subtype === "jpeg" ? "jpg" : subtype;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function getStringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function getBooleanField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function truncateText(value: string, maxLength = 80) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function getArrayField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}

function getJsonArrayField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = tryParseJson(value);
  return Array.isArray(parsed) ? parsed : undefined;
}

function getPayloadByteLength(value: unknown): number | undefined {
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (typeof value === "string") {
    return value.length;
  }
  return undefined;
}

function describeValue(value: unknown, maxLength = 120): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncateText(value, maxLength);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).slice(0, 6);
    return `{${keys.join(", ")}}`;
  }
  return typeof value;
}

function collectTextFragments(
  value: unknown,
  fragments: string[] = [],
  depth = 0,
) {
  if (fragments.length >= 3 || depth > 4 || value == null) {
    return fragments;
  }

  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== value) {
      return collectTextFragments(parsed, fragments, depth + 1);
    }
    const text = value.trim();
    if (
      text.length > 0 &&
      text.length <= 200 &&
      /[\p{L}\p{N}\u4e00-\u9fff]/u.test(text)
    ) {
      fragments.push(truncateText(text));
    }
    return fragments;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectTextFragments(item, fragments, depth + 1);
      if (fragments.length >= 3) break;
    }
    return fragments;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = [
      "text",
      "Text",
      "value",
      "insert",
      "m_sText",
      "data",
      "items",
    ];
    const keys = [
      ...preferredKeys.filter((key) => key in record),
      ...Object.keys(record).filter((key) => !preferredKeys.includes(key)),
    ];
    for (const key of keys.slice(0, 12)) {
      collectTextFragments(record[key], fragments, depth + 1);
      if (fragments.length >= 3) break;
    }
  }

  return fragments;
}

function summarizeLockBlock(block: unknown) {
  const blocks = normalizeCoAuthoringLockBlocks(block);
  return {
    lockCount: blocks.length,
    locks: blocks.slice(0, 3).map((item) => {
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        return {
          guid: getStringField(record, "guid"),
          sheetId: record.sheetId ?? record.sheet ?? record.tabId,
          range: record.range ?? record.bbox ?? record.bounds,
          raw: describeValue(record),
        };
      }
      return { raw: describeValue(item) };
    }),
  };
}

function getBase64ByteLength(value: string) {
  const normalized = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return undefined;
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function summarizeChangePacket(value: unknown) {
  if (typeof value !== "string") {
    return {
      kind: typeof value,
      byteLength: getPayloadByteLength(value),
      preview: describeValue(value),
    };
  }

  const separatorIndex = value.indexOf(";");
  if (separatorIndex < 0) {
    return {
      kind: "string",
      charLength: value.length,
      preview: truncateText(value),
    };
  }

  const declaredLength = Number(value.slice(0, separatorIndex));
  const base64 = value.slice(separatorIndex + 1);
  const byteLength = getBase64ByteLength(base64);

  return {
    kind: "binary-change",
    declaredLength: Number.isFinite(declaredLength) ? declaredLength : undefined,
    byteLength,
    byteLengthMatches:
      Number.isFinite(declaredLength) && byteLength != null
        ? declaredLength === byteLength
        : undefined,
    base64Preview: truncateText(base64, 32),
  };
}

function summarizeSaveChanges(record: Record<string, unknown>) {
  const changes =
    getJsonArrayField(record, "changes") ??
    getJsonArrayField(record, "changesData") ??
    getJsonArrayField(record, "data");
  const firstChange = changes?.[0] ?? record.change ?? record.data;
  const parsedFirstChange =
    typeof firstChange === "string" ? tryParseJson(firstChange) : firstChange;
  const textPreview = collectTextFragments(changes ?? firstChange);
  const packets = changes?.map(summarizeChangePacket);
  const changeBytes =
    packets?.reduce((total, packet) => total + (packet.byteLength ?? 0), 0) ??
    getPayloadByteLength(firstChange);

  return {
    start: getBooleanField(record, "startSaveChanges"),
    end: getBooleanField(record, "endSaveChanges"),
    isCoAuthoring: getBooleanField(record, "isCoAuthoring"),
    isExcel: getBooleanField(record, "isExcel"),
    deleteIndex: getNumberField(record, "deleteIndex"),
    unlock: getBooleanField(record, "unlock"),
    releaseLocks: getBooleanField(record, "releaseLocks"),
    changesCount: changes?.length,
    changeBytes,
    packets: packets?.slice(0, 4),
    firstChange: describeValue(parsedFirstChange),
    textPreview,
  };
}

function getSaveTypeLabel(value: unknown) {
  switch (value) {
    case AscSaveTypes.PartStart:
      return "PartStart";
    case AscSaveTypes.Part:
      return "Part";
    case AscSaveTypes.Complete:
      return "Complete";
    case AscSaveTypes.CompleteAll:
      return "CompleteAll";
    default:
      return value == null ? undefined : String(value);
  }
}

function summarizeWsPayload(payloads: unknown[]) {
  const first = payloads[0];
  const record = asRecord(first);
  const data = asRecord(record?.data);
  const type = getStringField(record, "type");
  const dataType = getStringField(data, "type");
  const extraParts: string[] = [];
  let extra: Record<string, unknown> = {};

  if (type === "saveChanges" && record) {
    const saveSummary = summarizeSaveChanges(record);
    extra = saveSummary;
    if (saveSummary.changesCount != null) {
      extraParts.push(`changes=${saveSummary.changesCount}`);
    }
    if (saveSummary.changeBytes != null) {
      extraParts.push(`bytes=${saveSummary.changeBytes}`);
    }
    if (saveSummary.start || saveSummary.end) {
      extraParts.push(
        `${saveSummary.start ? "start" : ""}${saveSummary.end ? "+end" : ""}`,
      );
    }
    if (saveSummary.isExcel) {
      extraParts.push("excel");
    }
    if (saveSummary.deleteIndex != null) {
      extraParts.push(`deleteIndex=${saveSummary.deleteIndex}`);
    }
    if (saveSummary.textPreview.length > 0) {
      extraParts.push(`text="${saveSummary.textPreview.join(" | ")}"`);
    }
  } else if (type === "getLock" && record) {
    const lockSummary = summarizeLockBlock(record.block);
    extra = lockSummary;
    extraParts.push(`locks=${lockSummary.lockCount}`);
    const firstLock = lockSummary.locks[0];
    if (firstLock?.guid) {
      extraParts.push(`guid=${firstLock.guid}`);
    } else if (firstLock?.raw) {
      extraParts.push(`block=${firstLock.raw}`);
    }
  } else if (
    (type === "getLock" || type === "releaseLock") &&
    record?.locks &&
    typeof record.locks === "object"
  ) {
    const lockKeys = Object.keys(record.locks as Record<string, unknown>);
    extra = { lockCount: lockKeys.length, lockKeys: lockKeys.slice(0, 3) };
    extraParts.push(`locks=${lockKeys.length}`);
    if (lockKeys[0]) extraParts.push(`key=${truncateText(lockKeys[0], 32)}`);
  } else if (type === "unSaveLock" && record) {
    const index = getNumberField(record, "index");
    const syncChangesIndex = getNumberField(record, "syncChangesIndex");
    extra = { index, syncChangesIndex };
    if (index != null) extraParts.push(`index=${index}`);
    if (syncChangesIndex != null) {
      extraParts.push(`sync=${syncChangesIndex}`);
    }
  }

  const labelParts = [
    type ?? typeof first,
    dataType,
    getStringField(data, "status"),
  ].filter(Boolean);
  const label = [
    labelParts.join(" / "),
    extraParts.length > 0 ? `(${extraParts.join(", ")})` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    label,
    type,
    dataType,
    status: getStringField(data, "status"),
    payloadCount: payloads.length,
    ...extra,
  };
}

function summarizeDownloadCommand(
  cmd: Record<string, unknown>,
  buffer: ArrayBuffer,
) {
  const outputFormat = getNumberField(cmd, "outputformat");
  const filetype =
    outputFormat == null ? undefined : extensionFromOutputFormat(outputFormat);
  const saveType = getSaveTypeLabel(cmd.savetype);

  return {
    label: [
      saveType,
      filetype ? `to ${filetype}` : undefined,
      cmd.isSaveAs ? "saveAs" : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    saveType,
    outputFormat,
    filetype,
    title: getStringField(cmd, "title"),
    byteLength: buffer.byteLength,
  };
}

export class EditorServer {
  private id = "";
  private sockets = new Set<MockSocket>();
  private messageHandlers = new WeakMap<
    MockSocket,
    (msg: unknown, ...args: unknown[]) => void
  >();
  private sessionId: string = "session-id";
  private user: User = {
    id: "uid",
    name: "Me",
  };
  private client = {
    buildVersion: "9.4.0",
    buildNumber: 129,
  };
  private participants: Participant[] = [];
  private syncChangesIndex = 0;
  private loadPromise: Promise<void> | null = null;
  private loadBlocked = false;

  private fileType: string = "docx";
  private title: string = "";
  private fsMap: Map<string, Uint8Array> = new Map();
  private urlsMap: Map<string, string> = new Map();

  private downloadId: string = "";
  /**
   * @description downloadAs multipart 分片缓冲；保存与导出共用 HTTP 管道，需与 pendingExport 配合区分意图。
   */
  private downloadParts: Uint8Array[] = [];
  /**
   * @description 当前 downloadAs 请求的 cmd（含 outputformat / isSaveAs / title）。
   */
  private downloadCmd: Record<string, unknown> | null = null;
  /**
   * @description 另存为 GET 响应 Content-Disposition 使用的文件名。
   */
  private downloadFileNames = new Map<string, string>();
  /**
   * @description 用户保存 downloadAs 进行中时阻塞 export，避免分片交错污染 Editor.bin。
   */
  private savingDone: Promise<void> = Promise.resolve();
  private finishSaving: (() => void) | null = null;
  /**
   * @description export() 调用 downloadAs("bin") 后等待 resolvePendingExport 完成。
   */
  private pendingExport:
    | {
        resolve: (snapshot: ReturnType<EditorServer["getDocumentSnapshot"]>) => void;
        reject: (error: Error) => void;
        timer: number;
      }
    | null = null;

  private options: ServerOptions = {};
  private officeXmlEventConfig: Required<OfficeXmlEventConfig> = {
    ...OFFICE_XML_EVENT_CONFIG.default,
  };

  constructor(options: ServerOptions = {}) {
    this.options = options;
    this.handleConnect = this.handleConnect.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
  }

  private logRaw(
    level: EditorLogLevel,
    category: EditorLogCategory,
    message: string,
    consoleArgs: unknown[],
    ...details: unknown[]
  ) {
    const logger = this.options.logger;
    if (logger) {
      logger.raw(level, category, message, consoleArgs, ...details);
      return;
    }
    console[level](...consoleArgs);
  }

  setOfficeXmlEventConfig(config?: OfficeXmlEventConfig) {
    this.officeXmlEventConfig = {
      ...OFFICE_XML_EVENT_CONFIG.default,
      ...config,
    };
  }

  private createLoadPromise(
    buffer: ArrayBuffer | (() => Promise<ArrayBuffer>),
    fileType: string,
  ) {
    return this.loadDocument(buffer, fileType).catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.notifyLoadError(error);
      if (isOfficeXmlSizeLimitExceededError(error)) {
        this.loadBlocked = true;
        return;
      }
      throw error;
    });
  }

  private notifyLoadError(error: Error) {
    try {
      this.options.onLoadError?.(error);
    } catch (callbackError) {
      console.error("[EditorServer] onLoadError callback failed", callbackError);
    }
  }

  /**
   * @description CDN iframe 与主站跨域：Editor.bin 必须用相对 /cache/files/，由 bridge 代拉。
   */
  private getCacheFileUrl(name: string) {
    return `/cache/files/data/${this.id}/${name}`;
  }

  private setEditorBinUrl(data: Uint8Array) {
    this.fsMap.set("Editor.bin", data);
    if (typeof window !== "undefined" && isOnlyOfficeCdnMode()) {
      this.urlsMap.set("Editor.bin", this.getCacheFileUrl("Editor.bin"));
      return;
    }
    this.urlsMap.set("Editor.bin", getUrl(data));
  }

  reset() {
    if (this.pendingExport) {
      window.clearTimeout(this.pendingExport.timer);
      this.pendingExport.reject(new Error("Editor server reset"));
      this.pendingExport = null;
    }

    for (const socket of this.sockets) {
      const handler = this.messageHandlers.get(socket);
      if (handler) {
        socket.server.off("message", handler);
      }
    }
    this.sockets.clear();
    this.messageHandlers = new WeakMap();

    if (this.urlsMap.size > 0) {
      this.urlsMap.forEach((url) => URL.revokeObjectURL(url));
    }

    this.id = "";
    this.fileType = "docx";
    this.title = "";
    this.fsMap.clear();
    this.urlsMap.clear();
    this.loadPromise = null;
    this.loadBlocked = false;
    this.downloadId = "";
    this.downloadParts = [];
    this.downloadCmd = null;
    this.downloadFileNames.clear();
    this.endSaving();
    this.syncChangesIndex = 0;
    this.participants = [];
  }

  async open(
    file: File,
    { fileType, fileName }: { fileType?: string; fileName?: string } = {},
  ) {
    this.fileType = fileType || getFileExt(file.name) || "docx";
    const title = ensureTitleWithExtension(fileName || file.name, this.fileType);
    const documentType = getDocumentType(this.fileType);
    this.id = randomId();
    this.title = title;
    const buffer = await file.arrayBuffer();
    const sizeLimitError = this.getOfficeXmlSizeLimitError(
      buffer,
      this.fileType,
    );
    if (sizeLimitError) {
      this.loadBlocked = true;
      this.loadPromise = Promise.resolve();
      this.notifyLoadError(sizeLimitError);
      return {
        id: this.id,
        documentType,
      };
    }

    this.loadPromise = this.createLoadPromise(buffer, this.fileType);

    return {
      id: this.id,
      documentType,
    };
  }

  openNew(fileType?: string, fileName?: string) {
    this.fileType = fileType || "docx";
    this.id = randomId();
    this.loadPromise = null;
    this.title = ensureTitleWithExtension(
      fileName || "New Document",
      this.fileType,
    );
    const documentType = getDocumentType(this.fileType);

    let binData: Uint8Array | null = null;

    switch (documentType) {
      case "word":
        binData = Uint8Array.from(emptyDocx, (v) => v.charCodeAt(0));
        break;
      case "cell":
        binData = Uint8Array.from(emptyXlsx, (v) => v.charCodeAt(0));
        break;
      case "slide":
        binData = Uint8Array.from(emptyPptx, (v) => v.charCodeAt(0));
        break;
      case "pdf":
        binData = Uint8Array.from(emptyPdf, (v) => v.charCodeAt(0));
        break;
    }

    if (!binData) {
      throw new Error("Failed to create new document");
    }

    this.fsMap.set("Editor.bin", binData);
    this.setEditorBinUrl(binData);
    this.loadBlocked = false;

    return {
      id: this.id,
      documentType: documentType,
    };
  }

  async openUrl(
    url: string,
    {
      fileType,
      fileName,
      loader = (url: string) => fetch(url).then((res) => res.arrayBuffer()),
    }: {
      fileType?: string;
      fileName?: string;
      loader?: (url: string) => Promise<ArrayBuffer>;
    } = {},
  ) {
    const rawTitle =
      fileName || decodeURIComponent(url.split("/").pop() || "Document");
    this.fileType = fileType || getFileExt(rawTitle) || "docx";
    const documentType = getDocumentType(this.fileType);
    this.id = randomId();
    this.loadBlocked = false;
    this.title = ensureTitleWithExtension(rawTitle, this.fileType);
    this.loadPromise = this.createLoadPromise(() => loader(url), this.fileType);

    return {
      id: this.id,
      documentType,
    };
  }

  getDocument() {
    if (!this.id) {
      this.openNew();
    }

    return {
      fileType: this.fileType,
      key: this.id,
      title: this.title,
      url: this.urlsMap.get("Editor.bin") || this.getCacheFileUrl("Editor.bin"),
    };
  }

  /**
   * @description 更新当前内存文档标题。文件内容与 document key 保持不变。
   */
  rename(fileName: string) {
    const requestedName = fileName.trim();
    if (!requestedName) {
      throw new Error("OnlyOffice document name cannot be empty");
    }

    this.title = ensureTitleWithExtension(requestedName, this.fileType);
    this.options.onDocumentRename?.(this.title);
    return this.title;
  }

  /**
   * @description 另存为产物 blob URL，cache GET 失败时供 getFile 回退下载。
   */
  getStoredOutputUrl(outputName: string) {
    return this.urlsMap.get(outputName) ?? null;
  }

  getStoredOutputFileName(outputName: string) {
    return this.downloadFileNames.get(outputName) ?? null;
  }

  getUser() {
    return { ...this.user };
  }

  setUser(user: Partial<User>) {
    this.user = {
      ...this.user,
      ...user,
    };
  }

  getDocumentSnapshot() {
    const binData = this.fsMap.get("Editor.bin");
    const media = this.getStoredMedia();
    const themes = this.getStoredThemes();

    return {
      fileName: this.title,
      fileType: this.fileType,
      binData,
      media,
      themes,
    };
  }

  private getStoredMedia() {
    return Object.fromEntries(
      Array.from(this.fsMap.entries()).filter(([key]) =>
        key.startsWith("media/"),
      ),
    );
  }

  private getStoredThemes() {
    return Object.fromEntries(
      Array.from(this.fsMap.entries()).filter(([key]) =>
        key.startsWith("themes/"),
      ),
    );
  }

  private getExportSafeMedia() {
    const media: Record<string, Uint8Array> = {};

    for (const [key, value] of Object.entries(this.getStoredMedia())) {
      if (/\.(emf|svg|webp)$/i.test(key)) {
        media[key.replace(/\.(emf|svg|webp)$/i, ".png")] = TRANSPARENT_PNG;
        continue;
      }

      media[key] = value;
    }

    return media;
  }

  private getExportSafeEditorBin(binData: Uint8Array) {
    const hasUnsupportedVectorMedia = Object.keys(this.getStoredMedia()).some(
      (key) => /\.(emf|svg)$/i.test(key),
    );
    if (!hasUnsupportedVectorMedia) {
      return binData;
    }

    return rewriteEditorBinUnsupportedMediaRefs(binData);
  }

  /**
   * @description 用户保存：更新 Editor.bin 并通知接入层，不触发浏览器下载。
   */
  commitUserSave(data: Uint8Array) {
    if (!isValidEditorBin(data)) {
      console.warn(
        "[EditorServer] Ignoring invalid Editor.bin from save, length:",
        data.length,
      );
      return;
    }

    this.downloadParts = [];
    this.downloadId = "";
    this.updateEditorBin(data);
    this.options.onUserSave?.(this.getDocumentSnapshot());
  }

  private beginSaving() {
    this.savingDone = new Promise<void>((resolve) => {
      this.finishSaving = resolve;
    });
  }

  private endSaving() {
    this.finishSaving?.();
    this.finishSaving = null;
    this.savingDone = Promise.resolve();
  }

  /**
   * @description 捕获当前文档快照；通过 downloadAs("bin") 让 iframe 把最新 Editor.bin 回传到 mock 服务。
   */
  async captureCurrentDocument(
    trigger: () => void,
    timeout = 30000,
  ): Promise<ReturnType<EditorServer["getDocumentSnapshot"]>> {
    await this.savingDone;

    this.downloadParts = [];
    this.downloadId = "";
    this.downloadCmd = null;

    if (this.pendingExport) {
      window.clearTimeout(this.pendingExport.timer);
      this.pendingExport.reject(
        new DOMException("OnlyOffice export was superseded", "AbortError"),
      );
      this.pendingExport = null;
    }

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingExport = null;
        reject(new Error("Timed out waiting for OnlyOffice export data"));
      }, timeout);

      this.pendingExport = { resolve, reject, timer };

      try {
        trigger();
      } catch (err) {
        window.clearTimeout(timer);
        this.pendingExport = null;
        reject(err instanceof Error ? err : new Error("Failed to start export"));
      }
    });
  }

  /**
   * @description 打开文档：x2t 将 doc.{fileType} 转为 Editor.bin 写入 fsMap，供 iframe 加载。
   */
  private async loadDocument(
    buffer: ArrayBuffer | (() => Promise<ArrayBuffer>),
    fileType: string,
  ) {
    if (typeof buffer == "function") {
      buffer = await buffer();
    }

    const bytes = new Uint8Array(buffer);
    const fallback =
      isOfficeZipFileType(fileType) && !isZipBytes(bytes)
        ? createPlainTextOfficeFallback(buffer, fileType)
        : null;
    if (fallback) {
      buffer = fallback.buffer;
    }
    const sourceFileType = fallback?.fileType ?? fileType;

    let output: Uint8Array | null = null;
    let media: { [key: string]: Uint8Array } = {};
    let themes: { [key: string]: Uint8Array } = {};

    if (sourceFileType == "pdf") {
      output = new Uint8Array(buffer);
    } else if (sourceFileType === "csv") {
      ({ output, media } = await this.loadCsvDocument(buffer));
    } else {
      ({ output, media, themes } = await this.convertBufferToEditorBin(
        buffer,
        sourceFileType,
      ));
    }

    if (!output) {
      throw new Error(`Failed to convert ${sourceFileType} file`);
    }

    if (this.urlsMap.size > 0) {
      this.urlsMap.forEach((url) => URL.revokeObjectURL(url));
    }
    this.fsMap.set("Editor.bin", output);
    this.setEditorBinUrl(output);
    for (const name in media) {
      this.addMedia(name, media[name]);
    }
    for (const [name, data] of Object.entries(themes)) {
      this.fsMap.set(name, data);
    }
  }

  private async convertBufferToEditorBin(buffer: ArrayBuffer, fileType: string) {
    this.assertOfficeXmlSizeWithinLimit(buffer, fileType);
    buffer = await this.rewriteUnsupportedPptxImages(buffer, fileType);
    const { formatFrom, formatTo } = getX2tConvertFormats(fileType);
    const result = await converter.convert(
      {
        data: buffer,
        fileFrom: "doc." + fileType,
        fileTo: "Editor.bin",
        formatFrom,
        formatTo,
      },
      this.options.logger,
    );
    return {
      output: result.output,
      media: result.media,
      themes: result.themes ?? {},
    };
  }

  private assertOfficeXmlSizeWithinLimit(buffer: ArrayBuffer, fileType: string) {
    const error = this.getOfficeXmlSizeLimitError(buffer, fileType);
    if (error) {
      throw error;
    }
  }

  private getOfficeXmlSizeLimitError(buffer: ArrayBuffer, fileType: string) {
    if (!this.officeXmlEventConfig.isEnable) {
      return null;
    }

    if (!isOfficeZipFileType(fileType)) {
      return null;
    }

    const entries = readZipEntries(buffer);
    if (!entries) {
      return null;
    }

    const { totalSize, entryCount } = getZipXmlUncompressedSize(entries);
    this.logRaw("error", "operation", "office xml total size", [
      "onlyoffice-totalSize:",
      `${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    ]);
    if (totalSize <= this.officeXmlEventConfig.limitBytes) {
      return null;
    }

    return new OfficeXmlSizeLimitExceededError({
      fileName: this.title || `Document.${getFileExt(fileType) || fileType}`,
      fileType: getFileExt(fileType) || fileType,
      errorDescription: "文件过大，不支持解析",
      xmlBytes: totalSize,
      limitBytes: this.officeXmlEventConfig.limitBytes,
      entryCount,
    });
  }

  private async rewriteUnsupportedPptxImages(
    buffer: ArrayBuffer,
    fileType: string,
  ) {
    if (getFileExt(fileType) !== "pptx") {
      return buffer;
    }

    const entries = readZipEntries(buffer);
    if (!entries) {
      return buffer;
    }

    const replacements = new Map<string, string>();
    const entryReplacements = new Map<string, ZipReplacement>();

    const mediaFiles = entries.filter(
      (entry) =>
        !entry.name.endsWith("/") &&
        /^ppt\/media\/[^/]+\.(emf|svg|webp)$/i.test(entry.name),
    );

    for (const entry of mediaFiles) {
      const pngName = entry.name.replace(/\.(emf|svg|webp)$/i, ".png");
      const source = await readZipEntryData(entry);
      if (!source) {
        continue;
      }

      const pngData = /\.svg$/i.test(entry.name)
        ? await rasterizeSvgToPng(source)
        : /\.webp$/i.test(entry.name)
          ? await rasterizeWebpToPng(source)
        : TRANSPARENT_PNG;

      entryReplacements.set(pngName, {
        data: pngData,
        modTime: entry.modTime,
        modDate: entry.modDate,
      });
      replacements.set(entry.name, pngName);
    }

    if (replacements.size === 0) {
      return buffer;
    }

    const relFiles = entries.filter(
      (entry) => !entry.name.endsWith("/") && entry.name.endsWith(".rels"),
    );
    for (const relFile of relFiles) {
      const source = await readZipEntryData(relFile);
      if (!source) {
        continue;
      }

      let text = new TextDecoder().decode(source);
      let changed = false;

      for (const [from, to] of replacements) {
        const fromName = from.split("/").pop();
        const toName = to.split("/").pop();
        if (!fromName || !toName) {
          continue;
        }

        const nextText = text.replace(
          new RegExp(escapeRegExp(fromName), "g"),
          toName,
        );
        if (nextText !== text) {
          text = nextText;
          changed = true;
        }
      }

      if (changed) {
        entryReplacements.set(relFile.name, {
          data: new TextEncoder().encode(text),
          modTime: relFile.modTime,
          modDate: relFile.modDate,
        });
      }
    }

    const contentTypes = entries.find(
      (entry) => entry.name === "[Content_Types].xml",
    );
    if (contentTypes) {
      const source = await readZipEntryData(contentTypes);
      if (source) {
        entryReplacements.set(contentTypes.name, {
          data: new TextEncoder().encode(
            ensurePngContentType(new TextDecoder().decode(source)),
          ),
          modTime: contentTypes.modTime,
          modDate: contentTypes.modDate,
        });
      }
    }

    return writeZipEntries(entries, entryReplacements);
  }

  private async loadCsvDocument(buffer: ArrayBuffer) {
    if (isMultilineCsv(buffer)) {
      return this.convertCsvViaXlsx(buffer);
    }

    const convertBuffer = sanitizeCsvBufferForX2t(buffer);
    const { formatFrom, formatTo } = getX2tConvertFormats("csv");

    try {
      const result = await converter.convert(
        {
          data: convertBuffer,
          fileFrom: "doc.csv",
          fileTo: "Editor.bin",
          formatFrom,
          formatTo,
          ...getX2tCsvConvertOptions(convertBuffer),
        },
        this.options.logger,
      );
      if (result.output?.byteLength) {
        return { output: result.output, media: result.media };
      }
    } catch (err) {
      console.warn("[EditorServer] CSV x2t failed, retry via xlsx:", err);
    }

    return this.convertCsvViaXlsx(buffer);
  }

  private async convertCsvViaXlsx(buffer: ArrayBuffer) {
    const xlsxBuffer = await convertCsvBufferToXlsxBuffer(buffer);
    return this.convertBufferToEditorBin(xlsxBuffer, "xlsx");
  }

  private addMedia(name: string, data: Uint8Array, mimeType?: string) {
    const pathname = "media/" + name;
    this.fsMap.set(pathname, data);
    const url = getDataUrl(data, mimeType || detectImageMime(data));
    this.urlsMap.set(pathname, url);
    return url;
  }

  private updateEditorBin(data: Uint8Array) {
    this.setEditorBinUrl(data);
  }

  /**
   * @description 与 Document Server 一致：/cache/files/data/{id}/output.{ext}（站点根绝对路径，便于 iframe 代理命中）
   */
  private buildDownloadFileUrl(outputName: string, downloadFileName: string) {
    const params = new URLSearchParams({ filename: downloadFileName });
    return `/cache/files/data/${this.id}/${outputName}?${params}`;
  }

  /**
   * @description 另存为：写入 fsMap，返回带文件名的 HTTP 路径（非 blob URL）。
   */
  private storeDownloadOutput(
    outputName: string,
    data: Uint8Array,
    downloadFileName: string,
  ) {
    this.fsMap.set(outputName, data);
    this.downloadFileNames.set(outputName, downloadFileName);
    const mimeType = getOnlyOfficeMimeType(
      getFileExt(outputName.replace(/^output\./, "")),
    );
    this.urlsMap.set(outputName, getUrl(data, mimeType));
    return this.buildDownloadFileUrl(outputName, downloadFileName);
  }

  /**
   * @description 判断 downloadAs 请求是否属于「另存为」输出；该路径通常需要服务端 x2t 转换。
   */
  private isDownloadAsOutput(
    cmd: Record<string, unknown> | null,
    input: Uint8Array,
  ) {
    if (cmd?.isSaveAs === true) {
      return true;
    }
    if (!isValidEditorBin(input)) {
      return true;
    }

    const outputFormat =
      typeof cmd?.outputformat === "number" ? cmd.outputformat : undefined;
    if (outputFormat == null || isCanvasBinOutputFormat(outputFormat)) {
      return false;
    }

    const targetExt = extensionFromOutputFormat(outputFormat);
    return Boolean(targetExt && targetExt !== "bin");
  }

  private async convertEditorBinToOutput(binData: Uint8Array, filetype: string) {
    binData = this.getExportSafeEditorBin(binData);
    const media = this.getExportSafeMedia();
    const themes = this.getStoredThemes();
    const { formatFrom, formatTo } = getX2tExportFormats(filetype, this.fileType);
    const result = await converter.convert(
      {
        data: binData.slice().buffer,
        fileFrom: "Editor.bin",
        fileTo: `doc.${filetype}`,
        formatFrom,
        formatTo,
        media,
        themes,
      },
      this.options.logger,
    );

    if (!result.output?.byteLength) {
      throw new Error(`Failed to convert Editor.bin to ${filetype}`);
    }

    return result.output;
  }

  /**
   * @description Web 表格 PDF 另存为 POST 的是渲染器 Memory 流，需回退 fsMap 中的 Editor.bin。
   */
  private resolveEditorBinSource(input: Uint8Array): Uint8Array | null {
    if (isValidEditorBin(input)) {
      return input;
    }

    /** @description downloadAs 等 HTTP 响应期间不能调用 asc_nativeGetFile。 */
    const cached = this.fsMap.get("Editor.bin");
    if (cached && isValidEditorBin(cached)) {
      return cached;
    }
    return null;
  }

  /** 将 Editor.bin 和 Web SDK 渲染器 Memory 流组合导出为 PDF。 */
  private async convertEditorBinToPdf(
    binData: Uint8Array,
    pdfRendererStream?: Uint8Array,
  ) {
    binData = this.getExportSafeEditorBin(binData);
    const media = this.getExportSafeMedia();
    const themes = this.getStoredThemes();
    const { formatFrom, formatTo } = getX2tExportFormats("pdf", this.fileType);

    if (pdfRendererStream?.byteLength) {
      const result = await converter.convert(
        {
          data: binData.slice().buffer,
          fileFrom: "output.bin",
          fileTo: "output.pdf",
          media,
          themes,
          pdfBin: pdfRendererStream,
        },
        this.options.logger,
      );

      if (!result.output?.byteLength) {
        throw new Error("Failed to convert Editor.bin + pdf.bin to PDF");
      }

      assertValidPdfOutput(new Uint8Array(result.output), "pdf.bin");
      return result.output;
    }

    const result = await converter.convert(
      {
        data: binData.slice().buffer,
        fileFrom: "Editor.bin",
        fileTo: "doc.pdf",
        formatFrom,
        formatTo,
        media,
        themes,
      },
      this.options.logger,
    );

    if (!result.output?.byteLength) {
      throw new Error("Failed to convert Editor.bin to PDF");
    }

    assertValidPdfOutput(new Uint8Array(result.output));
    return result.output;
  }

  private async resolveDownloadOutputData(input: Uint8Array, filetype: string) {
    const ext = getFileExt(filetype);

    if (ext === "pdf" && isPdfBytes(input)) {
      return input;
    }

    if (ext === "pdf") {
      const binSource = this.resolveEditorBinSource(input);
      if (!binSource) {
        throw new Error("PDF export failed: document snapshot unavailable");
      }

      const pdfRendererStream = isValidEditorBin(input) ? undefined : input;

      try {
        return new Uint8Array(
          await withTimeout(
            this.convertEditorBinToPdf(binSource, pdfRendererStream),
            PDF_CONVERT_TIMEOUT_MS,
            "PDF conversion",
          ),
        );
      } catch (err) {
        throw err instanceof Error
          ? err
          : new Error("PDF export failed", { cause: err });
      }
    }

    if (!isValidEditorBin(input)) {
      return input;
    }

    return new Uint8Array(
      await this.convertEditorBinToOutput(input, filetype),
    );
  }

  private resolveDownloadFileType(cmd: Record<string, unknown> | null) {
    const fromOutput = extensionFromOutputFormat(
      typeof cmd?.outputformat === "number" ? cmd.outputformat : undefined,
    );
    if (fromOutput) {
      return normalizeX2tExportFileType(fromOutput);
    }

    const title = typeof cmd?.title === "string" ? cmd.title : "";
    return normalizeX2tExportFileType(getFileExt(title) || this.fileType);
  }

  private resolveDownloadFileName(
    cmd: Record<string, unknown> | null,
    filetype: string,
  ) {
    const title = typeof cmd?.title === "string" ? cmd.title.trim() : "";
    if (title) {
      return ensureTitleWithExtension(title, filetype);
    }
    return ensureTitleWithExtension(this.title, filetype);
  }

  private resolvePendingExport(data: Uint8Array) {
    const pendingExport = this.pendingExport;
    if (!pendingExport) return false;

    window.clearTimeout(pendingExport.timer);
    this.pendingExport = null;

    /**
     * @description 校验魔数后再写入 fsMap，避免脏分片进入 x2t 导出链路。
     */
    if (!isValidEditorBin(data)) {
      pendingExport.reject(
        new Error("OnlyOffice export returned invalid document data"),
      );
      return true;
    }

    this.updateEditorBin(data);
    pendingExport.resolve(this.getDocumentSnapshot());
    return true;
  }

  setClient(info: Partial<typeof this.client>) {
    this.client = {
      ...this.client,
      ...info,
    };
  }

  registerSocketTransport(socket: MockSocket) {
    if (this.sockets.has(socket)) {
      return;
    }

    this.sockets.add(socket);

    const handler = (msg: unknown, ...args: unknown[]) => {
      void this.handleMessage(socket, msg as Record<string, unknown>, ...args);
    };
    this.messageHandlers.set(socket, handler);
    socket.server.on("message", handler);
  }

  sendCoAuthoringHandshake(socket: MockSocket) {
    const { sessionId, client } = this;
    const readOnly = this.options.getState?.()?.readOnly ?? false;

    this.participants = [
      {
        connectionId: this.sessionId,
        encrypted: false,
        id: this.user.id,
        idOriginal: this.user.id,
        indexUser: 1,
        isCloseCoAuthoring: false,
        isLiveViewer: readOnly,
        username: this.user.name,
        view: readOnly,
      },
    ];

    this.sendTo(socket, {
      maxPayload: 100000000,
      pingInterval: 25000,
      pingTimeout: 20000,
      sid: sessionId,
      upgrades: [],
    });

    this.sendTo(socket, {
      type: "license",
      license: {
        type: 3,
        buildNumber: client.buildNumber,
        buildVersion: client.buildVersion,
        light: false,
        mode: 0,
        rights: 1,
        protectionSupport: true,
        isAnonymousSupport: true,
        liveViewerSupport: true,
        branding: false,
        customization: true,
        // Developer Edition Connector 通过 advancedApi 门控；关闭时编辑器会
        // 静默忽略 createConnector() 的 postMessage 请求。
        advancedApi: true,
      },
    });
  }

  handleConnect({ socket }: { socket: MockSocket }) {
    this.logRaw("log", "socket", "connect", ["connect: ", socket]);
    this.registerSocketTransport(socket);
    this.sendCoAuthoringHandshake(socket);
  }

  handleDisconnect({ socket }: { socket: MockSocket }) {
    this.logRaw("log", "socket", "disconnect", ["disconnect: ", socket]);

    const handler = this.messageHandlers.get(socket);
    if (handler) {
      socket.server.off("message", handler);
      this.messageHandlers.delete(socket);
    }
    this.sockets.delete(socket);
  }

  private async handleImgUrls(
    socket: MockSocket,
    message: Record<string, unknown>,
  ) {
    const send = (...payload: unknown[]) => this.sendTo(socket, ...payload);
    const images = Array.isArray(message.data) ? message.data : [];
    const urls: Array<{ path: string; url: string }> = [];

    for (let i = 0; i < images.length; i++) {
      const item = images[i];
      if (typeof item !== "string") {
        continue;
      }

      let parsed = parseClipboardImage(item);
      if (!parsed) {
        try {
          parsed = await fetchClipboardImage(item);
        } catch (err) {
          console.warn("[EditorServer] failed to fetch image url:", item, err);
        }
      }
      if (!parsed) {
        continue;
      }

      const filename = `${Date.now()}_${i}.${parsed.ext}`;
      const pathname = `media/${filename}`;
      const url = this.addMedia(filename, parsed.data, parsed.mime);
      urls.push({ path: pathname, url });
    }

    send({
      type: "documentOpen",
      data: {
        type: "imgurls",
        status: "ok",
        /**
         * @description SDK 用 $dc(error) 判断是否弹错；缺省 undefined 会变成未知错误。
         */
        data: { urls, error: 0 },
      },
    });
  }

  private sendTo(socket: MockSocket, ...msg: unknown[]) {
    const summary = summarizeWsPayload(msg);
    this.logRaw(
      "log",
      "socket",
      `ws outgoing: ${summary.label}`,
      ["[ws] >> ", ...msg],
      summary,
    );
    socket.server.emit("message", ...msg);
  }

  private broadcast(...msg: unknown[]) {
    for (const socket of this.sockets) {
      this.sendTo(socket, ...msg);
    }
  }

  async handleMessage(
    socket: MockSocket,
    msg: Record<string, unknown>,
    ...args: unknown[]
  ) {
    const incomingSummary = summarizeWsPayload([msg, ...args]);
    this.logRaw(
      "log",
      "socket",
      `ws incoming: ${incomingSummary.label}`,
      ["[ws] << ", msg, args],
      incomingSummary,
    );

    const send = (...payload: unknown[]) => this.sendTo(socket, ...payload);
    const { sessionId, participants, user, client } = this;
    const type =
      typeof msg === "object" && msg && "type" in msg ? msg.type : null;
    switch (type) {
      case "auth": {
        const changes: unknown[] = [];
        const readOnly = this.options.getState?.()?.readOnly ?? false;
        send({
          type: "authChanges",
          changes: changes,
        });
        send({
          type: "auth",
          result: 1,
          sessionId: sessionId,
          participants: participants,
          locks: [],
          indexUser: 1,
          buildVersion: client.buildVersion || "9.4.0",
          buildNumber: client.buildNumber || 9,
          licenseType: 3,
          editorType: 2,
          mode: readOnly ? "view" : "edit",
          permissions: {
            comment: true,
            chat: true,
            download: true,
            edit: !readOnly,
            fillForms: false,
            modifyFilter: !readOnly,
            protect: !readOnly,
            print: true,
            review: true,
            copy: true,
          },
        });

        try {
          if (this.loadPromise) {
            await this.loadPromise;
          }
          if (this.loadBlocked) {
            break;
          }
          send({
            type: "documentOpen",
            data: {
              type: "open",
              status: "ok",
              data: {
                ...Object.fromEntries(this.urlsMap),
              },
            },
          });
        } catch (err) {
          console.error(err);
          const message = err instanceof Error ? err.message : String(err);
          if (isOfficeXmlSizeLimitExceededError(err)) {
            break;
          }
          send({
            type: "documentOpen",
            data: {
              type: "open",
              status: "err",
              data: {
                error: message,
                message,
              },
            },
          });
        }
        break;
      }
      case "isSaveLock":
        send({
          type: "saveLock",
          saveLock: false,
        });
        break;
      case "saveChanges":
        send({
          type: "unSaveLock",
          index:
            typeof msg.startSaveChanges === "number"
              ? msg.startSaveChanges
              : typeof msg.endSaveChanges === "number"
                ? msg.endSaveChanges
                : -1,
          syncChangesIndex: ++this.syncChangesIndex,
          time: +new Date(),
        });
        break;
      case "getLock":
        if (msg.block == null) {
          break;
        }

        {
          const locks = buildCoAuthoringLocks(
            msg.block,
            this.fileType,
            user?.id,
          );
          send({ type: "getLock", locks });
          send({ type: "releaseLock", locks });
        }
        break;
      case "openDocument": {
        const message = (msg as { message?: Record<string, unknown> }).message;
        if (message?.c === "imgurls") {
          void this.handleImgUrls(socket, message);
        }
        break;
      }
      case "rpc": {
        const rpc = msg.data as Record<string, unknown> | undefined;
        if (rpc?.type !== "wopi_RenameFile") {
          break;
        }

        const responseKey = msg.responseKey;
        if (typeof responseKey !== "number") {
          break;
        }

        try {
          const title = this.rename(String(rpc.name ?? ""));
          const extension = getFileExt(title);
          const name = extension
            ? title.slice(0, -(extension.length + 1))
            : title;

          // asc_wopi_renameFile 期望 { Name }，SDK 会自行补回当前扩展名并广播 asc_onMeta。
          send({ type: "rpc", responseKey, data: { Name: name } });
        } catch (error) {
          this.logRaw("warn", "socket", "wopi rename failed", [
            "[EditorServer] wopi rename failed:",
            error,
          ]);
          send({ type: "rpc", responseKey, data: null });
        }
        break;
      }
    }
  }

  /**
   * @description Mock 协作 HTTP 入口，OnlyOffice iframe 内 XHR/fetch 会被代理到这里。
   */
  async handleRequest(req: Request) {
    const u = new URL(req.url);

    const { id: key } = this;
    const cacheMatch = u.pathname.match(/\/cache\/files\/data\/([^/]+)\/(.+)$/);
    if (cacheMatch && req.method === "GET") {
      const [, , rawName] = cacheMatch;
      const outputName = decodeURIComponent(rawName.split("?")[0]);
      if (!this.fsMap.has(outputName) && this.loadPromise) {
        await this.loadPromise;
      }

      const data = this.fsMap.get(outputName);
      if (!data) {
        return new Response("Not Found", { status: 404 });
      }

      const filetype = getFileExt(outputName.replace(/^output\./, "")) || this.fileType;
      const downloadName = getCacheDownloadName(
        outputName,
        this.title,
        filetype,
        this.downloadFileNames,
      );
      const mimeType = getCacheResponseMimeType(outputName, this.fileType);

      return new Response(data as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": buildContentDisposition(downloadName),
          "Content-Length": String(data.byteLength),
        },
      });
    }

    if (u.pathname.endsWith("/downloadas/" + key)) {
      const cmd = JSON.parse(u.searchParams.get("cmd") || "{}") as Record<
        string,
        unknown
      >;
      const buffer = await req.arrayBuffer();

      const downloadSummary = summarizeDownloadCommand(cmd, buffer);
      this.logRaw(
        "log",
        "download",
        `downloadAs chunk: ${downloadSummary.label || "unknown"}`,
        ["downloadAs -> ", cmd, buffer],
        downloadSummary,
      );

      if (
        cmd.savetype === AscSaveTypes.PartStart ||
        cmd.savetype === AscSaveTypes.CompleteAll
      ) {
        this.downloadCmd = cmd;
      }

      type DownloadResult = {
        status: "ok" | "err";
        isExport: boolean;
        isSaveAs: boolean;
        downloadUrl: string;
        filetype: string;
        error?: string;
      };

      const download = async (): Promise<DownloadResult> => {
        const input = mergeBuffers(this.downloadParts);
        const cmdSnapshot = this.downloadCmd;
        this.downloadCmd = null;

        const resolvedExport = this.resolvePendingExport(input);
        if (resolvedExport) {
          this.endSaving();
          return {
            status: "ok",
            isExport: true,
            isSaveAs: false,
            downloadUrl: "",
            filetype: "bin",
          };
        }

        if (this.isDownloadAsOutput(cmdSnapshot, input)) {
          const filetype = this.resolveDownloadFileType(cmdSnapshot);
          const outputName = `output.${filetype}`;
          const downloadFileName = this.resolveDownloadFileName(
            cmdSnapshot,
            filetype,
          );
          const outputData = await this.resolveDownloadOutputData(
            input,
            filetype,
          );
          const downloadUrl = this.storeDownloadOutput(
            outputName,
            outputData,
            downloadFileName,
          );
          this.endSaving();
          return {
            status: "ok",
            isExport: false,
            isSaveAs: true,
            downloadUrl,
            filetype,
          };
        }

        /**
         * @description 用户保存时保留 Editor.bin 并走 EventBus，不触发浏览器下载。
         */
        this.commitUserSave(input);
        this.endSaving();
        return {
          status: "ok",
          isExport: false,
          isSaveAs: false,
          downloadUrl: this.urlsMap.get("Editor.bin") || "",
          filetype: this.fileType,
        };
      };

      let result: DownloadResult = {
        status: "ok",
        isExport: false,
        isSaveAs: false,
        downloadUrl: "",
        filetype: this.fileType,
      };
      let isFinalChunk = false;

      const finalizeDownload = async () => {
        try {
          result = await download();
        } catch (err) {
          this.logRaw("error", "download", "downloadAs failed", [
            "[EditorServer] downloadAs failed:",
            err,
          ]);
          this.endSaving();
          result = {
            status: "err",
            isExport: false,
            isSaveAs: false,
            downloadUrl: "",
            filetype: this.fileType,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        this.downloadParts = [];
        isFinalChunk = true;
      };

      /**
       * @description OnlyOffice downloadAs 按 PartStart、Part、Complete/CompleteAll 分片 POST。
       */
      switch (cmd.savetype) {
        case AscSaveTypes.PartStart:
          if (!this.pendingExport) {
            this.beginSaving();
          }
          this.downloadId = "_" + Math.round(Math.random() * 1000);
          this.downloadParts = [new Uint8Array(buffer)];
          break;
        case AscSaveTypes.Part:
          this.downloadParts.push(new Uint8Array(buffer));
          break;
        case AscSaveTypes.Complete:
          this.downloadParts.push(new Uint8Array(buffer));
          await finalizeDownload();
          break;
        case AscSaveTypes.CompleteAll:
          if (!this.pendingExport) {
            this.beginSaving();
          }
          this.downloadId = "_" + Math.round(Math.random() * 1000);
          this.downloadParts = [new Uint8Array(buffer)];
          await finalizeDownload();
          break;
      }

      /**
       * @description 程序化导出广播占位 URL，让 SDK 标记成功但不触发 getFile 下载。
       */
      if (isFinalChunk) {
        const { downloadUrl, filetype, status, error } = result;

        setTimeout(() => {
          this.broadcast({
            type: "documentOpen",
            data: {
              type: "save",
              status,
              data:
                status === "ok"
                  ? result.isExport
                    ? PROGRAMMATIC_EXPORT_ACK_URL
                    : downloadUrl
                  : error || "download failed",
              filetype,
            },
          });
        }, 100);
      }

      return Response.json({
        status: result.status,
        type: "save",
        data: this.downloadId,
      });
    }

    if (u.pathname.endsWith("/upload/" + key)) {
      const buffer = await req.arrayBuffer();
      const data = new Uint8Array(buffer);
      const mime = detectImageMime(data);
      const filename = `${Date.now()}.${getImageExt(mime)}`;
      const pathname = "media/" + filename;
      const url = this.addMedia(filename, data, mime);
      return Response.json({ [pathname]: url });
    }

    return null;
  }
}
