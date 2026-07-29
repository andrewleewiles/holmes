import type { EditorLogger } from "./logger";

export type OnlyOfficeConnectorOptions = {
  /**
   * 默认 true；首次创建时设为 false 则由调用方显式调用 connect()。
   * 同一编辑器的后续 createConnector 调用会复用已有实例。
   */
  autoconnect?: boolean;
};

/** Developer Edition Connector API 的稳定子集。 */
export type OnlyOfficeConnector = {
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  callCommand: (
    command: string | (() => void),
    callback?: (result: unknown) => void,
    recalculate?: boolean,
  ) => void;
  executeMethod: (
    method: string,
    args: unknown[],
    callback?: (result: unknown) => void,
  ) => void;
  attachEvent: (name: string, handler: (data: unknown) => void) => void;
  detachEvent: (name: string) => void;
  callCommandAsync?: (command: string | (() => void)) => Promise<unknown>;
  callMethodAsync?: (method: string, args?: unknown[]) => Promise<unknown>;
};

export interface DocEditor {
  attachMouseEvents: () => void;
  blurFocus: (data: unknown) => void;
  createConnector: (options?: OnlyOfficeConnectorOptions) => OnlyOfficeConnector;
  denyEditingRights: (message: unknown) => void;
  processRightsChange: (enabled: boolean, message?: unknown) => void;
  destroyEditor: (cmd?: string) => void;
  detachMouseEvents: () => void;
  downloadAs: (data: unknown) => void;
  grabFocus: (data: unknown) => void;
  openDocument: (doc: unknown) => void;
  processMailMerge: (enabled: unknown, message: unknown) => void;
  refreshFile: (data: unknown) => void;
  refreshHistory: (data: unknown, message: unknown) => void;
  requestClose: (data: unknown) => void;
  requestRoles: (data: unknown) => void;
  serviceCommand: (command: string, data: unknown) => void;
  setActionLink: (data: unknown) => void;
  setEmailAddresses: (data: unknown) => void;
  setFavorite: (data: unknown) => void;
  setHistoryData: (data: unknown, message: unknown) => void;
  setMailMergeRecipients: (data: unknown) => void;
  setReferenceData: (data: unknown) => void;
  setReferenceSource: (data: unknown) => void;
  setRequestedDocument: (data: unknown) => void;
  setRequestedSpreadsheet: (data: unknown) => void;
  setRevisedFile: (data: unknown) => void;
  setSharingSettings: (data: unknown) => void;
  setUsers: (data: unknown) => void;
  showMessage: (title: string, msg: string) => void;
  showSharingSettings: (data: unknown) => void;
  startFilling: (data: unknown) => void;
}

export type User = {
  id: string;
  name: string;
};

export type Participant = {
  connectionId: string;
  encrypted: boolean;
  id: string;
  idOriginal: string;
  indexUser: number;
  isCloseCoAuthoring: boolean;
  isLiveViewer: boolean;
  username: string;
  view: boolean;
};

export const enum AscSaveTypes {
  PartStart = 0,
  Part = 1,
  Complete = 2,
  CompleteAll = 3,
}

export const enum DocumentType {
  Word = "word",
  Cell = "cell",
  Slide = "slide",
  Draw = "draw",
  Pdf = "pdf",
}

export const enum AvsFileType {
  AVS_FILE_UNKNOWN = 0x0000,

  /**
   * @description 文档格式。
   */
  AVS_FILE_DOCUMENT = 0x0040,
  AVS_FILE_DOCUMENT_DOCX = AVS_FILE_DOCUMENT + 0x0001,
  AVS_FILE_DOCUMENT_DOC = AVS_FILE_DOCUMENT + 0x0002,
  AVS_FILE_DOCUMENT_ODT = AVS_FILE_DOCUMENT + 0x0003,
  AVS_FILE_DOCUMENT_RTF = AVS_FILE_DOCUMENT + 0x0004,
  AVS_FILE_DOCUMENT_TXT = AVS_FILE_DOCUMENT + 0x0005,
  AVS_FILE_DOCUMENT_HTML = AVS_FILE_DOCUMENT + 0x0006,
  AVS_FILE_DOCUMENT_MHT = AVS_FILE_DOCUMENT + 0x0007,
  AVS_FILE_DOCUMENT_EPUB = AVS_FILE_DOCUMENT + 0x0008,
  AVS_FILE_DOCUMENT_FB2 = AVS_FILE_DOCUMENT + 0x0009,
  AVS_FILE_DOCUMENT_MOBI = AVS_FILE_DOCUMENT + 0x000a,
  AVS_FILE_DOCUMENT_DOCM = AVS_FILE_DOCUMENT + 0x000b,
  AVS_FILE_DOCUMENT_DOTX = AVS_FILE_DOCUMENT + 0x000c,
  AVS_FILE_DOCUMENT_DOTM = AVS_FILE_DOCUMENT + 0x000d,
  AVS_FILE_DOCUMENT_ODT_FLAT = AVS_FILE_DOCUMENT + 0x000e,
  AVS_FILE_DOCUMENT_OTT = AVS_FILE_DOCUMENT + 0x000f,
  AVS_FILE_DOCUMENT_DOC_FLAT = AVS_FILE_DOCUMENT + 0x0010,
  AVS_FILE_DOCUMENT_DOCX_FLAT = AVS_FILE_DOCUMENT + 0x0011,
  AVS_FILE_DOCUMENT_HTML_IN_CONTAINER = AVS_FILE_DOCUMENT + 0x0012,
  AVS_FILE_DOCUMENT_DOCX_PACKAGE = AVS_FILE_DOCUMENT + 0x0014,
  AVS_FILE_DOCUMENT_OFORM = AVS_FILE_DOCUMENT + 0x0015,
  AVS_FILE_DOCUMENT_DOCXF = AVS_FILE_DOCUMENT + 0x0016,
  AVS_FILE_DOCUMENT_OFORM_PDF = AVS_FILE_DOCUMENT + 0x0017,

  /**
   * @description 演示文稿格式。
   */
  AVS_FILE_PRESENTATION = 0x0080,
  AVS_FILE_PRESENTATION_PPTX = AVS_FILE_PRESENTATION + 0x0001,
  AVS_FILE_PRESENTATION_PPT = AVS_FILE_PRESENTATION + 0x0002,
  AVS_FILE_PRESENTATION_ODP = AVS_FILE_PRESENTATION + 0x0003,
  AVS_FILE_PRESENTATION_PPSX = AVS_FILE_PRESENTATION + 0x0004,
  AVS_FILE_PRESENTATION_PPTM = AVS_FILE_PRESENTATION + 0x0005,
  AVS_FILE_PRESENTATION_PPSM = AVS_FILE_PRESENTATION + 0x0006,
  AVS_FILE_PRESENTATION_POTX = AVS_FILE_PRESENTATION + 0x0007,
  AVS_FILE_PRESENTATION_POTM = AVS_FILE_PRESENTATION + 0x0008,
  AVS_FILE_PRESENTATION_ODP_FLAT = AVS_FILE_PRESENTATION + 0x0009,
  AVS_FILE_PRESENTATION_OTP = AVS_FILE_PRESENTATION + 0x000a,
  AVS_FILE_PRESENTATION_PPTX_PACKAGE = AVS_FILE_PRESENTATION + 0x000b,
  AVS_FILE_PRESENTATION_ODG = AVS_FILE_PRESENTATION + 0x000c,

  /**
   * @description 电子表格格式。
   */
  AVS_FILE_SPREADSHEET = 0x0100,
  AVS_FILE_SPREADSHEET_XLSX = AVS_FILE_SPREADSHEET + 0x0001,
  AVS_FILE_SPREADSHEET_XLS = AVS_FILE_SPREADSHEET + 0x0002,
  AVS_FILE_SPREADSHEET_ODS = AVS_FILE_SPREADSHEET + 0x0003,
  AVS_FILE_SPREADSHEET_CSV = AVS_FILE_SPREADSHEET + 0x0004,
  AVS_FILE_SPREADSHEET_XLSM = AVS_FILE_SPREADSHEET + 0x0005,
  AVS_FILE_SPREADSHEET_XLTX = AVS_FILE_SPREADSHEET + 0x0006,
  AVS_FILE_SPREADSHEET_XLTM = AVS_FILE_SPREADSHEET + 0x0007,
  AVS_FILE_SPREADSHEET_XLSB = AVS_FILE_SPREADSHEET + 0x0008,
  AVS_FILE_SPREADSHEET_ODS_FLAT = AVS_FILE_SPREADSHEET + 0x0009,
  AVS_FILE_SPREADSHEET_OTS = AVS_FILE_SPREADSHEET + 0x000a,
  AVS_FILE_SPREADSHEET_XLSX_FLAT = AVS_FILE_SPREADSHEET + 0x000b,
  AVS_FILE_SPREADSHEET_XLSX_PACKAGE = AVS_FILE_SPREADSHEET + 0x000c,

  /**
   * @description 跨平台输出格式。
   */
  AVS_FILE_CROSSPLATFORM = 0x0200,
  AVS_FILE_CROSSPLATFORM_PDF = AVS_FILE_CROSSPLATFORM + 0x0001,
  AVS_FILE_CROSSPLATFORM_SWF = AVS_FILE_CROSSPLATFORM + 0x0002,
  AVS_FILE_CROSSPLATFORM_DJVU = AVS_FILE_CROSSPLATFORM + 0x0003,
  AVS_FILE_CROSSPLATFORM_XPS = AVS_FILE_CROSSPLATFORM + 0x0004,
  AVS_FILE_CROSSPLATFORM_SVG = AVS_FILE_CROSSPLATFORM + 0x0005,
  AVS_FILE_CROSSPLATFORM_HTMLR = AVS_FILE_CROSSPLATFORM + 0x0006,
  AVS_FILE_CROSSPLATFORM_HTMLR_MENU = AVS_FILE_CROSSPLATFORM + 0x0007,
  AVS_FILE_CROSSPLATFORM_HTMLR_CANVAS = AVS_FILE_CROSSPLATFORM + 0x0008,
  AVS_FILE_CROSSPLATFORM_PDFA = AVS_FILE_CROSSPLATFORM + 0x0009,

  /**
   * @description 图片格式。
   */
  AVS_FILE_IMAGE = 0x0400,
  AVS_FILE_IMAGE_JPG = AVS_FILE_IMAGE + 0x0001,
  AVS_FILE_IMAGE_TIFF = AVS_FILE_IMAGE + 0x0002,
  AVS_FILE_IMAGE_TGA = AVS_FILE_IMAGE + 0x0003,
  AVS_FILE_IMAGE_GIF = AVS_FILE_IMAGE + 0x0004,
  AVS_FILE_IMAGE_PNG = AVS_FILE_IMAGE + 0x0005,
  AVS_FILE_IMAGE_EMF = AVS_FILE_IMAGE + 0x0006,
  AVS_FILE_IMAGE_WMF = AVS_FILE_IMAGE + 0x0007,
  AVS_FILE_IMAGE_BMP = AVS_FILE_IMAGE + 0x0008,
  AVS_FILE_IMAGE_CR2 = AVS_FILE_IMAGE + 0x0009,
  AVS_FILE_IMAGE_PCX = AVS_FILE_IMAGE + 0x000a,
  AVS_FILE_IMAGE_RAS = AVS_FILE_IMAGE + 0x000b,
  AVS_FILE_IMAGE_PSD = AVS_FILE_IMAGE + 0x000c,
  AVS_FILE_IMAGE_ICO = AVS_FILE_IMAGE + 0x000d,

  /**
   * @description 其他格式。
   */
  AVS_FILE_OTHER = 0x0800,
  AVS_FILE_OTHER_EXTRACT_IMAGE = AVS_FILE_OTHER + 0x0001,
  AVS_FILE_OTHER_MS_OFFCRYPTO = AVS_FILE_OTHER + 0x0002,
  AVS_FILE_OTHER_HTMLZIP = AVS_FILE_OTHER + 0x0003,
  AVS_FILE_OTHER_OLD_DOCUMENT = AVS_FILE_OTHER + 0x0004,
  AVS_FILE_OTHER_OLD_PRESENTATION = AVS_FILE_OTHER + 0x0005,
  AVS_FILE_OTHER_OLD_DRAWING = AVS_FILE_OTHER + 0x0006,
  AVS_FILE_OTHER_OOXML = AVS_FILE_OTHER + 0x0007,
  /**
   * @description mail-merge 使用的 JSON 数据格式。
   */
  AVS_FILE_OTHER_JSON = AVS_FILE_OTHER + 0x0008,
  AVS_FILE_OTHER_ODF = AVS_FILE_OTHER + 0x000a,
  AVS_FILE_OTHER_MS_MITCRYPTO = AVS_FILE_OTHER + 0x000b,
  AVS_FILE_OTHER_MS_VBAPROJECT = AVS_FILE_OTHER + 0x000c,
  AVS_FILE_OTHER_PACKAGE_IN_OLE = AVS_FILE_OTHER + 0x000d,

  /**
   * @description Teamlab 内部格式。
   */
  AVS_FILE_TEAMLAB = 0x1000,
  AVS_FILE_TEAMLAB_DOCY = AVS_FILE_TEAMLAB + 0x0001,
  AVS_FILE_TEAMLAB_XLSY = AVS_FILE_TEAMLAB + 0x0002,
  AVS_FILE_TEAMLAB_PPTY = AVS_FILE_TEAMLAB + 0x0003,

  /**
   * @description OnlyOffice 画布格式。
   */
  AVS_FILE_CANVAS = 0x2000,
  AVS_FILE_CANVAS_WORD = AVS_FILE_CANVAS + 0x0001,
  AVS_FILE_CANVAS_SPREADSHEET = AVS_FILE_CANVAS + 0x0002,
  AVS_FILE_CANVAS_PRESENTATION = AVS_FILE_CANVAS + 0x0003,
  AVS_FILE_CANVAS_PDF = AVS_FILE_CANVAS + 0x0004,

  /**
   * @description 绘图格式。
   */
  AVS_FILE_DRAW = 0x4000,
  AVS_FILE_DRAW_VSDX = AVS_FILE_DRAW + 0x0001,
  AVS_FILE_DRAW_VSSX = AVS_FILE_DRAW + 0x0002,
  AVS_FILE_DRAW_VSTX = AVS_FILE_DRAW + 0x0003,
  AVS_FILE_DRAW_VSDM = AVS_FILE_DRAW + 0x0004,
  AVS_FILE_DRAW_VSSM = AVS_FILE_DRAW + 0x0005,
  AVS_FILE_DRAW_VSTM = AVS_FILE_DRAW + 0x0006,
}

/**
 * @description OnlyOffice x2t CSV 编码索引，46 表示 UTF-8 / codepage 65001。
 */
export const X2T_CSV_ENCODING_UTF8 = 46;

/**
 * @description OnlyOffice x2t CSV 编码索引，18 表示 GB2312 / codepage 936。
 */
export const X2T_CSV_ENCODING_GBK = 18;

/**
 * @description OnlyOffice x2t CSV 分隔符枚举值。
 */
export const X2T_CSV_DELIMITER_TAB = 1;
export const X2T_CSV_DELIMITER_SEMICOLON = 2;
export const X2T_CSV_DELIMITER_COMMA = 4;

export interface X2tConvertParams {
  data: ArrayBuffer | never;
  fileFrom: string;
  fileTo: string;
  formatFrom?: number;
  formatTo?: number;
  csvEncoding?: number;
  csvDelimiter?: number;
  csvDelimiterChar?: string;
  media?: { [key: string]: Uint8Array };
  /**
   * @description Web SDK PDF 另存为 POST 的渲染器 Memory 流，x2t 需写入 /working/pdf.bin。
   */
  pdfBin?: Uint8Array;
  fonts?: { [key: string]: Uint8Array };
  fontAliases?: { [key: string]: string };
  fontExportAliases?: { [key: string]: string };
  themes?: { [key: string]: Uint8Array };
  staticResource?: {
    x2t: {
      root: string;
      script: string;
      wasm: string;
      pdfFonts: {
        root: string;
        default: string;
      };
    };
  };
}

export interface X2tConvertResult {
  output: Uint8Array | null;
  media: { [key: string]: Uint8Array };
  themes?: { [key: string]: Uint8Array };
}

export type OfficeTheme =
  | "theme-light"
  | "theme-classic-light"
  | "theme-white"
  | "theme-dark"
  | "theme-night"
  | "theme-contrast-dark";

export type EditorDocumentSnapshot = {
  fileName: string;
  fileType: string;
  binData: Uint8Array | undefined;
  media: Record<string, Uint8Array>;
  themes: Record<string, Uint8Array>;
};

export type OfficeXmlSizeLimitExceededPayload = {
  fileName: string;
  fileType: string;
  errorDescription: string;
  xmlBytes: number;
  limitBytes: number;
  entryCount: number;
};

export const OFFICE_XML_SIZE_LIMIT_ERROR_MESSAGE = "文件过大，不支持解析";

export class OfficeXmlSizeLimitExceededError extends Error {
  readonly payload: OfficeXmlSizeLimitExceededPayload;

  constructor(payload: OfficeXmlSizeLimitExceededPayload) {
    super(OFFICE_XML_SIZE_LIMIT_ERROR_MESSAGE);
    this.name = "OfficeXmlSizeLimitExceededError";
    this.payload = payload;
  }
}

export function isOfficeXmlSizeLimitExceededError(
  error: unknown,
): error is OfficeXmlSizeLimitExceededError {
  return (
    error instanceof OfficeXmlSizeLimitExceededError ||
    (error instanceof Error &&
      error.name === "OfficeXmlSizeLimitExceededError" &&
      "payload" in error)
  );
}

export interface ServerOptions {
  getState?: () => { readOnly?: boolean };
  logger?: EditorLogger;
  /** WOPI 重命名 RPC 成功后的回调，携带 SDK 最终采用的完整文件名。 */
  onDocumentRename?: (fileName: string) => void;
  /**
   * @description 用户触发保存（非 export/downloadAs 导出）时回调，携带最新文档快照。
   */
  onUserSave?: (snapshot: EditorDocumentSnapshot) => void;
  /**
   * @description 文档异步加载失败时回调；open() 返回后 x2t 转换仍可能在 loadPromise 中失败。
   */
  onLoadError?: (error: Error) => void;
}
