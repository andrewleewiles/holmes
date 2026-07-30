import { DocumentType } from "../internal/editor/types";

// ── 编辑器容器 / 事件 ──────────────────────────────────────────

export const ONLYOFFICE_ID = "iframe-office-id";

export const ONLYOFFICE_CONTAINER_CONFIG = {
  PARENT_SELECTOR: ".onlyoffice-container",
  PARENT_CLASS_NAME: "onlyoffice-container",
  STYLE: {
    position: "absolute",
    inset: 0,
  },
} as const;

export const ONLYOFFICE_EVENT_KEYS = {
  SAVE_DOCUMENT: "saveDocument",
  DOCUMENT_READY: "documentReady",
  LOADING_CHANGE: "loadingChange",
  ONSAVE: "onSave",
  OFFICE_XML_SIZE_LIMIT_EXCEEDED: "officeXmlSizeLimitExceeded",
} as const;

export type OnlyOfficeEventKey =
  (typeof ONLYOFFICE_EVENT_KEYS)[keyof typeof ONLYOFFICE_EVENT_KEYS];

export const ONLYOFFICE_LANG_KEY = {
  ZH: "zh",
  EN: "en",
} as const;

/** OnlyOffice 界面主题（对应 editorConfig.customization.uiTheme） */
export const OFFICE_THEME = {
  LIGHT: "theme-light",
  CLASSIC_LIGHT: "theme-classic-light",
  WHITE: "theme-white",
  DARK: "theme-dark",
  NIGHT: "theme-night",
  CONTRAST_DARK: "theme-contrast-dark",
} as const;

export type OfficeThemeId =
  (typeof OFFICE_THEME)[keyof typeof OFFICE_THEME];

export const DEFAULT_OFFICE_THEME: OfficeThemeId = OFFICE_THEME.WHITE;

/** 示例 / UI 切换用的主题列表 */
export const OFFICE_THEME_OPTIONS: ReadonlyArray<{
  id: OfficeThemeId;
  label: string;
}> = [
  { id: OFFICE_THEME.WHITE, label: "浅色" },
  { id: OFFICE_THEME.CLASSIC_LIGHT, label: "经典浅色" },
  { id: OFFICE_THEME.LIGHT, label: "Light" },
  { id: OFFICE_THEME.DARK, label: "深色" },
  { id: OFFICE_THEME.NIGHT, label: "夜间" },
  { id: OFFICE_THEME.CONTRAST_DARK, label: "高对比深色" },
];

/** 只读 ↔ 编辑切换时，loading 最少展示时长（ms） */
export const READONLY_SWITCH_MIN_DELAY_MS = 200;

export type OfficeXmlEventConfig = {
  isEnable?: boolean;
  limitBytes?: number;
};

/** Office ZIP 内 XML 包内容解压后大小限制；超过时会在 x2t 转换前拦截。 */
export const OFFICE_XML_EVENT_CONFIG = {
  default: {
    isEnable: false,
    limitBytes: 1024 * 1024 * 2048,
  },
} as const satisfies { default: Required<OfficeXmlEventConfig> };

/** Asc.c_oAscRestrictionType（sdk-all-min.js: k.Mf / k.Hca） */
export const ASC_RESTRICTION_NONE = 0;
export const ASC_RESTRICTION_VIEW = 128;

/** OnlyOffice 编辑器左上角 logo（jsDelivr 固定版本，避免依赖站点本地资源） */
/**
 * HOLMES PATCH: upstream points this at a Microsoft Office icon on jsdelivr.
 * The editor CSP has no `https:` in `img-src`, so it was blocked and rendered
 * as a broken image in the toolbar — and unblocking it would mean the editor
 * fetching from a CDN every time a document opens. Holmes shows no editor logo
 * rather than borrowing someone else's brand.
 */
export const OFFICE_EDITOR_LOGO = { visible: false } as const;

// ── 静态资源（SDK / x2t）────────────────────────────────────────

export type StaticResource = {
  /** 版本目录：升级资源时只改这里 */
  version: {
    onlyofficeSdk: string;
    x2t: string;
  };
  onlyoffice: {
    root: string;
    apiJs: string;
    preloadHtml: string;
    apiUrl: string;
    preloadUrl: string;
  };
  x2t: {
    root: string;
    script: string;
    wasm: string;
    /** PDF 导出字体目录（见 X2T_PDF_FONT_MANIFEST） */
    pdfFonts: {
      root: string;
      default: string;
    };
  };
};

export type OnlyOfficeStaticResourceOptions = {
  /** CDN packages 根地址，例如 https://b26830b7.onlyoffice-packages.pages.dev。 */
  cdnOrigin?: string | null;
  /** CDN 上的 OnlyOffice 目录版本；未传时使用当前 SDK 版本。 */
  onlyofficeVersion?: string | null;
};

const X2T_PDF_DEFAULT_FONT_FILE = "Carlito-Regular.ttf";

/**
 * x2t PDF 字体：每款 TTF 独立二进制 + 别名。
 * - Carlito 四款 → Calibri（表格 styles 粗斜体）
 * - Arial 四款 → Arial（西文/数字，勿映射到 DroidSansFallback 否则会乱码）
 * - DroidSansFallback → 仅中文常用名（宋体/微软雅黑等）
 */
export const X2T_PDF_FONT_MANIFEST = [
  {
    file: "Carlito-Regular.ttf",
    aliases: ["Carlito.ttf", "Calibri.ttf"],
  },
  {
    file: "Carlito-Bold.ttf",
    aliases: ["Carlito_Bold.ttf", "Calibri_Bold.ttf"],
  },
  {
    file: "Carlito-Italic.ttf",
    aliases: ["Carlito_Italic.ttf", "Calibri_Italic.ttf"],
  },
  {
    file: "Carlito-BoldItalic.ttf",
    aliases: ["Carlito_Bold_Italic.ttf", "Calibri_Bold_Italic.ttf"],
  },
  {
    file: "Arial-Regular.ttf",
    aliases: ["Arial.ttf"],
  },
  {
    file: "Arial-Bold.ttf",
    aliases: ["Arial_Bold.ttf"],
  },
  {
    file: "Arial-Italic.ttf",
    aliases: ["Arial_Italic.ttf"],
  },
  {
    file: "Arial-BoldItalic.ttf",
    aliases: ["Arial_Bold_Italic.ttf"],
  },
  {
    file: "DroidSansFallback.ttf",
    aliases: [
      "Droid Sans Fallback.ttf",
      "SimSun.ttf",
      "NSimSun.ttf",
      "宋体.ttf",
      "Microsoft YaHei.ttf",
      "微软雅黑.ttf",
      "PingFang SC.ttf",
    ],
  },
] as const;

/** 与 public/packages/onlyoffice 下的 Document Server 导出目录保持一致。 */
const DEFAULT_ONLYOFFICE_VERSION = "9.4.0-develop";
const DEFAULT_ONLYOFFICE_ROOT = `/packages/onlyoffice/${DEFAULT_ONLYOFFICE_VERSION}`;

let staticResourceOptions: OnlyOfficeStaticResourceOptions | null = null;

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function buildStaticResource(): StaticResource {
  const apiJs = "/web-apps/apps/api/documents/api.js";
  const preloadHtml = "/web-apps/apps/api/documents/preload.html";
  const cdnOrigin = staticResourceOptions?.cdnOrigin
    ? trimTrailingSlash(staticResourceOptions.cdnOrigin)
    : "";
  const onlyofficeVersion = staticResourceOptions?.onlyofficeVersion || DEFAULT_ONLYOFFICE_VERSION;
  const onlyofficeRoot = cdnOrigin
    ? `${cdnOrigin}/onlyoffice/${onlyofficeVersion}`
    : DEFAULT_ONLYOFFICE_ROOT;
  const x2tRoot = `${onlyofficeRoot}/x2t`;
  const x2tPdfFontsRoot = `${onlyofficeRoot}/x2t-fonts`;

  return {
    version: {
      onlyofficeSdk: onlyofficeRoot,
      x2t: x2tRoot,
    },
    onlyoffice: {
      root: onlyofficeRoot,
      apiJs,
      preloadHtml,
      apiUrl: onlyofficeRoot + apiJs,
      preloadUrl: onlyofficeRoot + preloadHtml,
    },
    x2t: {
      root: x2tRoot,
      script: `${x2tRoot}/x2t.js`,
      wasm: `${x2tRoot}/x2t.wasm`,
      pdfFonts: {
        root: x2tPdfFontsRoot,
        default: `${x2tPdfFontsRoot}/${X2T_PDF_DEFAULT_FONT_FILE}`,
      },
    },
  };
}

let staticResourceCache: StaticResource | null = null;

/** 运行时注册 OnlyOffice 静态资源地址；须在首次初始化 DocsAPI / x2t 前调用。 */
export function registerOnlyOfficeStaticResource(
  options: OnlyOfficeStaticResourceOptions,
): StaticResource {
  staticResourceOptions = { ...options };
  staticResourceCache = null;
  return getStaticResource();
}

/** 清空运行时注册地址，恢复默认静态资源地址。 */
export function resetOnlyOfficeStaticResource(): StaticResource {
  staticResourceOptions = null;
  staticResourceCache = null;
  return getStaticResource();
}

/** 延迟构建，支持主实例初始化前运行时注册资源地址。 */
export function getStaticResource(): StaticResource {
  if (!staticResourceCache) {
    staticResourceCache = buildStaticResource();
  }
  return staticResourceCache;
}

/** 静态资源走外部 CDN（iframe 与主站跨域）。 */
export function isOnlyOfficeCdnMode(): boolean {
  const root = getStaticResource().onlyoffice.root;
  if (!/^https?:\/\//i.test(root) || typeof window === "undefined") {
    return false;
  }
  try {
    return new URL(root).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** 延迟读取，避免 Worker / SSR 在模块加载时固定资源地址。 */
export const STATIC_RESOURCE = {
  get version() {
    return getStaticResource().version;
  },
  get onlyoffice() {
    return getStaticResource().onlyoffice;
  },
  get x2t() {
    return getStaticResource().x2t;
  },
} as StaticResource;

/** 站点相对路径 → 绝对 URL（Worker 内 origin 用 self.location.origin） */
export function resolveSiteUrl(origin: string, path: string): string {
  // HOLMES PATCH: upstream only recognises http(s) as already-absolute, so a
  // custom scheme got the origin prepended — repeatedly, producing
  // `holmes-office://editor/holmes-office://editor/...`. Any scheme counts.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return path;
  }
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getX2tBaseUrl(origin: string): string {
  return resolveSiteUrl(origin, `${getStaticResource().x2t.root}/`);
}

// ── 文档类型 ────────────────────────────────────────────────────

/** x2t / 编辑器入参用的三类主格式（大写） */
export const FILE_TYPE = {
  DOCX: "DOCX",
  XLSX: "XLSX",
  PPTX: "PPTX",
} as const;

export type FileType = (typeof FILE_TYPE)[keyof typeof FILE_TYPE];

/** 与 SDK AppType 数值一致，仅内部映射用 */
const AppType = {
  word: 1,
  slide: 3,
  cell: 2,
  draw: 4,
  pdf: 5,
} as const;

const docTypeMap: Record<string, (typeof AppType)[keyof typeof AppType]> = {
  docx: AppType.word,
  doc: AppType.word,
  odt: AppType.word,
  rtf: AppType.word,
  txt: AppType.word,
  html: AppType.word,
  mht: AppType.word,
  epub: AppType.word,
  fb2: AppType.word,
  mobi: AppType.word,
  docm: AppType.word,
  dotx: AppType.word,
  dotm: AppType.word,
  oform: AppType.word,
  docxf: AppType.word,
  pptx: AppType.slide,
  ppt: AppType.slide,
  odp: AppType.slide,
  ppsx: AppType.slide,
  pptm: AppType.slide,
  ppsm: AppType.slide,
  potx: AppType.slide,
  potm: AppType.slide,
  otp: AppType.slide,
  odg: AppType.slide,
  xlsx: AppType.cell,
  xls: AppType.cell,
  ods: AppType.cell,
  csv: AppType.cell,
  xlsm: AppType.cell,
  xltx: AppType.cell,
  xltm: AppType.cell,
  xlsb: AppType.cell,
  ots: AppType.cell,
  vsdx: AppType.draw,
  vssx: AppType.draw,
  vstx: AppType.draw,
  vsdm: AppType.draw,
  vssm: AppType.draw,
  vstm: AppType.draw,
  pdf: AppType.pdf,
};

const appTypeName: Record<number, DocumentType> = {
  [AppType.word]: DocumentType.Word,
  [AppType.slide]: DocumentType.Slide,
  [AppType.cell]: DocumentType.Cell,
  [AppType.draw]: DocumentType.Draw,
  [AppType.pdf]: DocumentType.Pdf,
};

export function getDocumentType(ext: string) {
  const code = docTypeMap[ext.toLowerCase()];
  if (code === undefined) {
    return DocumentType.Word;
  }
  return appTypeName[code] ?? DocumentType.Word;
}

/** 新建文档页 URL */
export function getNewUrl(type: string) {
  return `/editor?new=${type}`;
}
