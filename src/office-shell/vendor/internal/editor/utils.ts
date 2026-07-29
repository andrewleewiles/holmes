import { getDocumentType, getNewUrl } from "../../const";
import {
  AvsFileType,
  DocumentType,
  X2T_CSV_DELIMITER_COMMA,
  X2T_CSV_DELIMITER_SEMICOLON,
  X2T_CSV_DELIMITER_TAB,
  X2T_CSV_ENCODING_GBK,
  X2T_CSV_ENCODING_UTF8,
} from "./types";

export { getDocumentType, getNewUrl };

export function getFileExt(name: string) {
  const type = name.split(".").pop() || "";
  return type.toLowerCase();
}

const x2tSourceFormatByExt: Record<string, AvsFileType> = {
  docx: AvsFileType.AVS_FILE_DOCUMENT_DOCX,
  doc: AvsFileType.AVS_FILE_DOCUMENT_DOC,
  odt: AvsFileType.AVS_FILE_DOCUMENT_ODT,
  rtf: AvsFileType.AVS_FILE_DOCUMENT_RTF,
  txt: AvsFileType.AVS_FILE_DOCUMENT_TXT,
  html: AvsFileType.AVS_FILE_DOCUMENT_HTML,
  mht: AvsFileType.AVS_FILE_DOCUMENT_MHT,
  epub: AvsFileType.AVS_FILE_DOCUMENT_EPUB,
  fb2: AvsFileType.AVS_FILE_DOCUMENT_FB2,
  mobi: AvsFileType.AVS_FILE_DOCUMENT_MOBI,
  docm: AvsFileType.AVS_FILE_DOCUMENT_DOCM,
  dotx: AvsFileType.AVS_FILE_DOCUMENT_DOTX,
  dotm: AvsFileType.AVS_FILE_DOCUMENT_DOTM,
  fodt: AvsFileType.AVS_FILE_DOCUMENT_ODT_FLAT,
  ott: AvsFileType.AVS_FILE_DOCUMENT_OTT,
  oform: AvsFileType.AVS_FILE_DOCUMENT_OFORM,
  docxf: AvsFileType.AVS_FILE_DOCUMENT_DOCXF,
  xlsx: AvsFileType.AVS_FILE_SPREADSHEET_XLSX,
  xls: AvsFileType.AVS_FILE_SPREADSHEET_XLS,
  ods: AvsFileType.AVS_FILE_SPREADSHEET_ODS,
  csv: AvsFileType.AVS_FILE_SPREADSHEET_CSV,
  xlsm: AvsFileType.AVS_FILE_SPREADSHEET_XLSM,
  xltx: AvsFileType.AVS_FILE_SPREADSHEET_XLTX,
  xltm: AvsFileType.AVS_FILE_SPREADSHEET_XLTM,
  xlsb: AvsFileType.AVS_FILE_SPREADSHEET_XLSB,
  fods: AvsFileType.AVS_FILE_SPREADSHEET_ODS_FLAT,
  ots: AvsFileType.AVS_FILE_SPREADSHEET_OTS,
  pptx: AvsFileType.AVS_FILE_PRESENTATION_PPTX,
  ppt: AvsFileType.AVS_FILE_PRESENTATION_PPT,
  odp: AvsFileType.AVS_FILE_PRESENTATION_ODP,
  ppsx: AvsFileType.AVS_FILE_PRESENTATION_PPSX,
  pptm: AvsFileType.AVS_FILE_PRESENTATION_PPTM,
  ppsm: AvsFileType.AVS_FILE_PRESENTATION_PPSM,
  potx: AvsFileType.AVS_FILE_PRESENTATION_POTX,
  potm: AvsFileType.AVS_FILE_PRESENTATION_POTM,
  fodp: AvsFileType.AVS_FILE_PRESENTATION_ODP_FLAT,
  otp: AvsFileType.AVS_FILE_PRESENTATION_OTP,
  pdf: AvsFileType.AVS_FILE_CROSSPLATFORM_PDF,
  pdfa: AvsFileType.AVS_FILE_CROSSPLATFORM_PDFA,
  djvu: AvsFileType.AVS_FILE_CROSSPLATFORM_DJVU,
  xps: AvsFileType.AVS_FILE_CROSSPLATFORM_XPS,
  vsdx: AvsFileType.AVS_FILE_DRAW_VSDX,
  vssx: AvsFileType.AVS_FILE_DRAW_VSSX,
  vstx: AvsFileType.AVS_FILE_DRAW_VSTX,
  vsdm: AvsFileType.AVS_FILE_DRAW_VSDM,
  vssm: AvsFileType.AVS_FILE_DRAW_VSSM,
  vstm: AvsFileType.AVS_FILE_DRAW_VSTM,
  zip: AvsFileType.AVS_FILE_OTHER + 0x0009,
  json: AvsFileType.AVS_FILE_OTHER_JSON,
};

function getDefaultX2tSourceFormat(fileType: string) {
  switch (getDocumentType(fileType)) {
    case DocumentType.Cell:
      return AvsFileType.AVS_FILE_SPREADSHEET_XLSX;
    case DocumentType.Slide:
      return AvsFileType.AVS_FILE_PRESENTATION_PPTX;
    case DocumentType.Draw:
      return AvsFileType.AVS_FILE_DRAW_VSDX;
    default:
      return AvsFileType.AVS_FILE_DOCUMENT_DOCX;
  }
}

function getX2tBinFormat(fileType: string) {
  switch (getDocumentType(fileType)) {
    case DocumentType.Cell:
      return AvsFileType.AVS_FILE_CANVAS_SPREADSHEET;
    case DocumentType.Slide:
      return AvsFileType.AVS_FILE_CANVAS_PRESENTATION;
    case DocumentType.Draw:
      return AvsFileType.AVS_FILE_CANVAS + 0x0005;
    default:
      return AvsFileType.AVS_FILE_CANVAS_WORD;
  }
}

function getX2tExportBinFormat(fileType: string) {
  switch (getDocumentType(fileType)) {
    case DocumentType.Slide:
      return AvsFileType.AVS_FILE_TEAMLAB_PPTY;
    default:
      return getX2tBinFormat(fileType);
  }
}

export function getX2tConvertFormats(fileType: string) {
  const ext = getFileExt(fileType);
  const formatFrom =
    x2tSourceFormatByExt[ext] ?? getDefaultX2tSourceFormat(fileType);

  return {
    formatFrom,
    formatTo: getX2tBinFormat(fileType),
  };
}

function isValidUtf8(bytes: Uint8Array) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeCsvBytes(bytes: Uint8Array, encoding: number) {
  const withoutBom =
    encoding === X2T_CSV_ENCODING_UTF8 &&
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;

  if (encoding === X2T_CSV_ENCODING_UTF8) {
    return new TextDecoder("utf-8").decode(withoutBom);
  }

  try {
    return new TextDecoder("gbk").decode(withoutBom);
  } catch {
    return new TextDecoder("latin1").decode(withoutBom);
  }
}

function decodeCsvSample(buffer: ArrayBuffer, encoding: number) {
  const bytes = new Uint8Array(buffer);
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  return decodeCsvBytes(sample, encoding);
}

function decodeCsvBuffer(buffer: ArrayBuffer, encoding: number) {
  return decodeCsvBytes(new Uint8Array(buffer), encoding);
}

function encodeCsvBuffer(text: string, withUtf8Bom: boolean) {
  const encoded = new TextEncoder().encode(text);
  if (!withUtf8Bom) {
    return encoded.slice().buffer;
  }
  const withBom = new Uint8Array(encoded.length + 3);
  withBom.set([0xef, 0xbb, 0xbf], 0);
  withBom.set(encoded, 3);
  return withBom.slice().buffer;
}

/**
 * @description RFC 4180 风格解析，支持引号内换行与逗号。
 */
function parseCsvText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (text[i + 1] === "\n") {
        i++;
      }
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }

    field += ch;
  }

  row.push(field);
  if (row.length > 1 || row[0] !== "") {
    rows.push(row);
  }

  return rows;
}

function serializeCsvRow(fields: string[], delimiter: string) {
  return fields.map((field) => serializeCsvField(field, delimiter)).join(delimiter);
}

function serializeCsvField(field: string, delimiter: string) {
  if (
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  ) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function toCsvFormulaCell(value: string) {
  if (/^=".*"$/.test(value)) {
    return value;
  }
  return `="${value.replace(/"/g, '""')}"`;
}

/**
 * @description 仅包裹「以数字结尾且不像日期/时间」的单元格，避免误包 2018/9/6 9:32 引发 x2t 异常。
 */
function shouldApplyCsvFormulaWrap(value: string) {
  if (!/[0-9]$/.test(value)) {
    return false;
  }
  if (/^=".*"$/.test(value)) {
    return false;
  }
  if (/[/\-:.Tt]/.test(value)) {
    return false;
  }
  return true;
}

function getCsvDelimiterChar(delimiter: number) {
  if (delimiter === X2T_CSV_DELIMITER_TAB) return "\t";
  if (delimiter === X2T_CSV_DELIMITER_SEMICOLON) return ";";
  return ",";
}

/**
 * @description 引号内换行会导致按行 split 破坏结构；物理行数明显多于逻辑行数即视为复杂 CSV。
 */
export function isMultilineCsv(buffer: ArrayBuffer) {
  const csvEncoding = detectX2tCsvEncoding(buffer);
  const delimiter = getCsvDelimiterChar(
    detectX2tCsvDelimiter(buffer, csvEncoding),
  );
  const text = decodeCsvBuffer(buffer, csvEncoding);
  const physicalLines = text.split(/\r?\n/).filter((line) => line.length > 0).length;
  const logicalRows = parseCsvText(text, delimiter).length;
  return physicalLines > logicalRows + 2;
}

/**
 * @description 解析 CSV 为二维数组，供 xlsx 兜底转换等场景复用。
 */
export function parseCsvBuffer(buffer: ArrayBuffer) {
  const csvEncoding = detectX2tCsvEncoding(buffer);
  const delimiter = getCsvDelimiterChar(
    detectX2tCsvDelimiter(buffer, csvEncoding),
  );
  return parseCsvText(decodeCsvBuffer(buffer, csvEncoding), delimiter);
}

/**
 * @description x2t CSV 解析 bug：某列单元格以 ASCII 数字结尾时，下一列会误走 DateReader 并崩溃
 * （如 login1.csv 的「用户3」+「2018/9/6 9:32」）。用 ="value" 包裹前一格可绕过。
 */
export function sanitizeCsvBufferForX2t(buffer: ArrayBuffer) {
  const csvEncoding = detectX2tCsvEncoding(buffer);
  const csvDelimiter = detectX2tCsvDelimiter(buffer, csvEncoding);
  const delimiter = getCsvDelimiterChar(csvDelimiter);
  const bytes = new Uint8Array(buffer);
  const withUtf8Bom =
    csvEncoding === X2T_CSV_ENCODING_UTF8 &&
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const text = decodeCsvBuffer(buffer, csvEncoding);
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const rows = parseCsvText(text, delimiter);

  const sanitized = rows.map((fields) => {
    for (let i = 0; i < fields.length - 1; i++) {
      if (shouldApplyCsvFormulaWrap(fields[i])) {
        fields[i] = toCsvFormulaCell(fields[i]);
      }
    }
    return serializeCsvRow(fields, delimiter);
  });

  return encodeCsvBuffer(sanitized.join(lineEnding), withUtf8Bom);
}

function getFirstCsvLine(text: string) {
  const newline = text.search(/\r?\n/);
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * @description 根据 CSV 第一行推断分隔符。
 */
export function detectX2tCsvDelimiter(buffer: ArrayBuffer, encoding: number) {
  const line = getFirstCsvLine(decodeCsvSample(buffer, encoding));
  const counts = { comma: 0, semicolon: 0, tab: 0 };
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ",") counts.comma++;
    else if (ch === ";") counts.semicolon++;
    else if (ch === "\t") counts.tab++;
  }

  if (counts.tab > counts.comma && counts.tab > counts.semicolon) {
    return X2T_CSV_DELIMITER_TAB;
  }
  if (counts.semicolon > counts.comma) {
    return X2T_CSV_DELIMITER_SEMICOLON;
  }
  return X2T_CSV_DELIMITER_COMMA;
}

/**
 * @description 根据 BOM 和字节特征推断 OnlyOffice x2t CSV 编码索引。
 */
export function detectX2tCsvEncoding(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return X2T_CSV_ENCODING_UTF8;
  }
  return isValidUtf8(bytes) ? X2T_CSV_ENCODING_UTF8 : X2T_CSV_ENCODING_GBK;
}

export function getX2tCsvConvertOptions(buffer: ArrayBuffer) {
  const csvEncoding = detectX2tCsvEncoding(buffer);
  return {
    csvEncoding,
    csvDelimiter: detectX2tCsvDelimiter(buffer, csvEncoding),
  };
}

/**
 * @description 获取 x2t 导出格式；导出 pdf 等目标格式时需要源文档类型，否则会误用 CANVAS_WORD。
 * @param sourceFileType 源文档类型，例如 xlsx。
 */
export function getX2tExportFormats(
  fileType: string,
  sourceFileType?: string,
) {
  const ext = normalizeX2tExportFileType(fileType);
  const source = sourceFileType ?? fileType;
  const formatTo =
    x2tSourceFormatByExt[ext] ?? getDefaultX2tSourceFormat(source);

  return {
    formatFrom: getX2tExportBinFormat(source),
    formatTo,
  };
}

/**
 * @description x2t wasm 无法稳定输出旧二进制 .doc；导出时降级为 docx。
 */
export function normalizeX2tExportFileType(fileType: string) {
  const ext = getFileExt(fileType);
  return ext === "doc" ? "docx" : ext;
}

const outputFormatToExt: Record<number, string> = Object.fromEntries(
  Object.entries(x2tSourceFormatByExt).map(([ext, format]) => [format, ext]),
);

Object.assign(outputFormatToExt, {
  [AvsFileType.AVS_FILE_DOCUMENT_HTML]: "html",
  [AvsFileType.AVS_FILE_DOCUMENT_MHT]: "mht",
  [AvsFileType.AVS_FILE_DOCUMENT_EPUB]: "epub",
  [AvsFileType.AVS_FILE_DOCUMENT_FB2]: "fb2",
  [AvsFileType.AVS_FILE_DOCUMENT_MOBI]: "mobi",
  [AvsFileType.AVS_FILE_DOCUMENT_DOTX]: "dotx",
  [AvsFileType.AVS_FILE_DOCUMENT_DOTM]: "dotm",
  [AvsFileType.AVS_FILE_DOCUMENT_ODT_FLAT]: "fodt",
  [AvsFileType.AVS_FILE_DOCUMENT_OTT]: "ott",
  [AvsFileType.AVS_FILE_DOCUMENT_OFORM]: "oform",
  [AvsFileType.AVS_FILE_DOCUMENT_DOCXF]: "docxf",
  [AvsFileType.AVS_FILE_PRESENTATION_PPSX]: "ppsx",
  [AvsFileType.AVS_FILE_PRESENTATION_PPTM]: "pptm",
  [AvsFileType.AVS_FILE_PRESENTATION_PPSM]: "ppsm",
  [AvsFileType.AVS_FILE_PRESENTATION_POTX]: "potx",
  [AvsFileType.AVS_FILE_PRESENTATION_POTM]: "potm",
  [AvsFileType.AVS_FILE_PRESENTATION_ODP_FLAT]: "fodp",
  [AvsFileType.AVS_FILE_PRESENTATION_OTP]: "otp",
  [AvsFileType.AVS_FILE_SPREADSHEET_XLSM]: "xlsm",
  [AvsFileType.AVS_FILE_SPREADSHEET_XLTX]: "xltx",
  [AvsFileType.AVS_FILE_SPREADSHEET_XLTM]: "xltm",
  [AvsFileType.AVS_FILE_SPREADSHEET_XLSB]: "xlsb",
  [AvsFileType.AVS_FILE_SPREADSHEET_ODS_FLAT]: "fods",
  [AvsFileType.AVS_FILE_SPREADSHEET_OTS]: "ots",
  [AvsFileType.AVS_FILE_CROSSPLATFORM_PDF]: "pdf",
  [AvsFileType.AVS_FILE_CROSSPLATFORM_PDFA]: "pdf",
  [AvsFileType.AVS_FILE_CROSSPLATFORM_DJVU]: "djvu",
  [AvsFileType.AVS_FILE_CROSSPLATFORM_XPS]: "xps",
  [AvsFileType.AVS_FILE_OTHER + 0x0009]: "zip",
  [AvsFileType.AVS_FILE_OTHER_JSON]: "json",
  [AvsFileType.AVS_FILE_CANVAS_WORD]: "bin",
  [AvsFileType.AVS_FILE_CANVAS_SPREADSHEET]: "bin",
  [AvsFileType.AVS_FILE_CANVAS_PRESENTATION]: "bin",
  [AvsFileType.AVS_FILE_DRAW_VSDX]: "vsdx",
  [AvsFileType.AVS_FILE_DRAW_VSSX]: "vssx",
  [AvsFileType.AVS_FILE_DRAW_VSTX]: "vstx",
  [AvsFileType.AVS_FILE_DRAW_VSDM]: "vsdm",
  [AvsFileType.AVS_FILE_DRAW_VSSM]: "vssm",
  [AvsFileType.AVS_FILE_DRAW_VSTM]: "vstm",
  [AvsFileType.AVS_FILE_TEAMLAB_DOCY]: "bin",
  [AvsFileType.AVS_FILE_TEAMLAB_XLSY]: "bin",
  [AvsFileType.AVS_FILE_TEAMLAB_PPTY]: "bin",
});

const canvasBinOutputFormats = new Set<number>([
  AvsFileType.AVS_FILE_CANVAS_WORD,
  AvsFileType.AVS_FILE_CANVAS_SPREADSHEET,
  AvsFileType.AVS_FILE_CANVAS_PRESENTATION,
  AvsFileType.AVS_FILE_TEAMLAB_DOCY,
  AvsFileType.AVS_FILE_TEAMLAB_XLSY,
  AvsFileType.AVS_FILE_TEAMLAB_PPTY,
]);

/**
 * @description EditorManager export() / downloadAs("bin") 使用的 canvas bin 格式，不是 UI 另存为。
 */
export function isCanvasBinOutputFormat(outputFormat?: number) {
  return outputFormat != null && canvasBinOutputFormats.has(outputFormat);
}

/**
 * @description OnlyOffice downloadAs cmd.outputformat（AvsFileType 数值）→ 文件扩展名。
 */
export function extensionFromOutputFormat(outputFormat?: number): string {
  if (outputFormat == null) {
    return "";
  }
  return outputFormatToExt[outputFormat] || "";
}

/**
 * @description 保证文档标题带正确后缀，供 OnlyOffice 内置「另存为」推导下载文件名。
 */
export function ensureTitleWithExtension(title: string, fileType: string): string {
  const ext = fileType.toLowerCase();
  if (!ext) {
    return title;
  }

  const currentExt = getFileExt(title);
  if (currentExt === ext) {
    return title;
  }

  const dotIndex = title.lastIndexOf(".");
  const base =
    dotIndex > 0 && dotIndex < title.length - 1
      ? title.slice(0, dotIndex)
      : title;
  return `${base}.${ext}`;
}
