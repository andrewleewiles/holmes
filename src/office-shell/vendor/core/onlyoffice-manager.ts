/**
 * 面向业务页面的 OnlyOffice 门面：收敛 initialize / 开文档 / 导出 / 只读 / 语言 等调用。
 *
 * 底层仍由 EditorManager 驱动；本类负责 document store 与 x2t 转换编排。
 */
import {
  DEFAULT_OFFICE_THEME,
  ONLYOFFICE_ID,
  ONLYOFFICE_EVENT_KEYS,
  ONLYOFFICE_LANG_KEY,
  OFFICE_THEME,
  registerOnlyOfficeStaticResource,
  resetOnlyOfficeStaticResource,
  type FileType,
  type OfficeThemeId,
  type OfficeXmlEventConfig,
  type OnlyOfficeStaticResourceOptions,
} from "../const";
import type {
  OfficeTheme,
  OnlyOfficeConnector,
  OnlyOfficeConnectorOptions,
} from "../internal/editor/types";
import {
  clearDocumentObj,
  getDocumentObj,
  setDocumentObj,
} from "../store/document";
import {
  getCurrentLang,
  getOnlyOfficeLang,
  setCurrentLang,
  type OnlyOfficeLang,
} from "../store/lang";
import { getOnlyOfficeMimeType } from "../util/document-file";
import { downloadBlob } from "../util/download";
import { initializeOnlyOffice } from "../util/initialize";
import { convertBinToDocument } from "../util/x2t";
import type { User } from "../internal/editor/types";
import { EditorManager, editorManagerFactory } from "./editor-manager";
import {
  onlyofficeEventbus,
  type LoadingChangeData,
  type OfficeXmlSizeLimitExceededData,
} from "./eventbus";

export type OnlyOfficeManagerOptions = {
  /** DOM 容器 id，默认 ONLYOFFICE_ID */
  containerId?: string;
  /** 导出时使用的 Office 主格式 */
  fileType: FileType;
  /** 首次 bootstrap 打开的默认文件名 */
  defaultFileName: string;
  readOnly?: boolean;
  user?: User;
  lang?: OnlyOfficeLang;
  /** 编辑器界面主题，对应 customization.uiTheme */
  theme?: OfficeTheme;
  /** Office XML 解压体积事件配置；默认关闭。 */
  officeXmlEvent?: OfficeXmlEventConfig;
  /** 页面初始化会话，用于忽略路由切换后过期的 openDocument */
  loadSession?: number;
};

export type OpenDocumentInput = {
  fileName: string;
  file?: File;
  isNew?: boolean;
  readOnly?: boolean;
  loadSession?: number;
  officeXmlEvent?: OfficeXmlEventConfig;
};

export type OnlyOfficeExportBlobResult = {
  blob: Blob;
  fileName: string;
  /** true 表示未经过编辑器导出转换，而是返回当前打开的原始文件。 */
  isOriginalFileFallback?: boolean;
  fallbackReason?: "officeXmlSizeLimitExceeded";
};

export class OnlyOfficeManager {
  readonly containerId: string;
  readonly fileType: FileType;

  private editor: EditorManager;
  private readOnly: boolean;
  private theme: OfficeTheme;
  private officeXmlEvent?: OfficeXmlEventConfig;
  private ready = false;

  private constructor(
    editor: EditorManager,
    options: OnlyOfficeManagerOptions & { containerId: string },
  ) {
    this.containerId = options.containerId;
    this.fileType = options.fileType;
    this.editor = editor;
    this.readOnly = options.readOnly ?? false;
    this.theme = options.theme ?? DEFAULT_OFFICE_THEME;
    this.officeXmlEvent = options.officeXmlEvent;
    if (options.user) {
      editor.setUser(options.user);
    }
    if (options.lang) {
      setCurrentLang(options.lang);
    }
  }

  /** 主实例初始化前，可运行时注册 OnlyOffice / x2t 静态资源地址。 */
  static registerStaticResource(options: OnlyOfficeStaticResourceOptions) {
    return registerOnlyOfficeStaticResource(options);
  }

  /** 清空运行时注册地址，恢复默认静态资源地址。 */
  static resetStaticResource() {
    return resetOnlyOfficeStaticResource();
  }

  /** 多实例场景：绑定已有 EditorManager，不自动 open */
  static fromEditor(
    editor: EditorManager,
    options: OnlyOfficeManagerOptions & { containerId: string },
  ): OnlyOfficeManager {
    return new OnlyOfficeManager(editor, options);
  }

  /** 加载 DocsAPI 并打开 defaultFileName（新建或空白） */
  static async create(
    options: OnlyOfficeManagerOptions,
  ): Promise<OnlyOfficeManager> {
    const containerId = options.containerId ?? ONLYOFFICE_ID;
    await initializeOnlyOffice();

    const editor = editorManagerFactory.get(containerId);
    const manager = new OnlyOfficeManager(editor, { ...options, containerId });

    await manager.openDocument({
      fileName: options.defaultFileName,
      isNew: true,
      readOnly: options.readOnly,
      loadSession: options.loadSession,
      officeXmlEvent: options.officeXmlEvent,
    });

    return manager;
  }

  /** 加载 DocsAPI 并直接打开已有 File（先取文件再挂载） */
  static async createWithFile(
    options: OnlyOfficeManagerOptions,
    file: File,
  ): Promise<OnlyOfficeManager> {
    const containerId = options.containerId ?? ONLYOFFICE_ID;
    await initializeOnlyOffice();

    const editor = editorManagerFactory.get(containerId);
    const manager = new OnlyOfficeManager(editor, { ...options, containerId });

    await manager.openDocument({
      fileName: file.name,
      file,
      readOnly: options.readOnly,
      loadSession: options.loadSession,
      officeXmlEvent: options.officeXmlEvent,
    });

    return manager;
  }

  /** 打开/切换文档（上传、新建、重开） */
  async openDocument(input: OpenDocumentInput) {
    const readOnly = input.readOnly ?? this.readOnly;

    setDocumentObj(
      {
        fileName: input.fileName,
        file: input.file,
        isNew: input.isNew ?? !input.file,
      },
      this.containerId,
    );

    const { fileName, file } = getDocumentObj(this.containerId);

    await this.editor.create({
      file,
      fileName,
      isNew: !file,
      readOnly,
      user: this.editor.getUser(),
      lang: getOnlyOfficeLang(),
      theme: this.theme,
      containerId: this.containerId,
      editorManager: this.editor,
      loadSession: input.loadSession,
      officeXmlEvent: input.officeXmlEvent ?? this.officeXmlEvent,
    });

    this.readOnly = readOnly;
    this.ready = true;
  }

  async openNew(fileName: string, readOnly?: boolean) {
    await this.openDocument({ fileName, isNew: true, readOnly });
  }

  async openFile(file: File, readOnly?: boolean) {
    await this.openDocument({ fileName: file.name, file, readOnly });
  }

  isReady() {
    return this.ready;
  }

  getReadOnly() {
    return this.readOnly;
  }

  getUser() {
    return this.editor.getUser();
  }

  setUser(user: User) {
    this.editor.setUser(user);
  }

  async setReadOnly(readOnly: boolean) {
    await this.editor.setReadOnly(readOnly);
    this.readOnly = readOnly;
  }

  async toggleReadOnly() {
    return this.setReadOnly(!this.readOnly);
  }

  getLanguage() {
    return getCurrentLang();
  }

  async setLanguage(lang: OnlyOfficeLang) {
    setCurrentLang(lang);
    await this.editor.setLanguage(lang);
  }

  /** 在中/英之间切换并应用到 iframe */
  async toggleLanguage() {
    const nextLang =
      getCurrentLang() === ONLYOFFICE_LANG_KEY.ZH
        ? ONLYOFFICE_LANG_KEY.EN
        : ONLYOFFICE_LANG_KEY.ZH;
    await this.setLanguage(nextLang);
    return nextLang;
  }

  getTheme() {
    return this.editor.getTheme();
  }

  async setTheme(theme: OfficeTheme) {
    this.theme = theme;
    await this.editor.setTheme(theme);
  }

  /** 在浅色 / 深色主题之间切换 */
  async toggleTheme() {
    const darkThemes: OfficeThemeId[] = [
      OFFICE_THEME.DARK,
      OFFICE_THEME.NIGHT,
      OFFICE_THEME.CONTRAST_DARK,
    ];
    const nextTheme = darkThemes.includes(this.getTheme() as OfficeThemeId)
      ? OFFICE_THEME.WHITE
      : OFFICE_THEME.DARK;
    await this.setTheme(nextTheme);
    return nextTheme;
  }

  getEditor() {
    return this.editor;
  }

  /** 创建 OnlyOffice Developer Edition Connector。编辑器销毁或重开时会自动断开。 */
  createConnector(options?: OnlyOfficeConnectorOptions): OnlyOfficeConnector {
    if (!this.ready) {
      throw new Error("OnlyOffice editor is not ready");
    }
    return this.editor.createConnector(options);
  }

  getLogger() {
    return this.editor.getLogger();
  }

  printLogs() {
    this.editor.printLogs();
  }

  async exportDocument() {
    return this.editor.export();
  }

  /** 导出为 Office 文件 Blob：Editor.bin → x2t → doc.{fileType}。 */
  async exportAsBlob(): Promise<OnlyOfficeExportBlobResult> {
    if (this.editor.isOfficeXmlSizeLimitExceeded()) {
      const { file, fileName } = getDocumentObj(this.containerId);
      if (file) {
        return {
          blob: file,
          fileName: fileName || file.name,
          isOriginalFileFallback: true,
          fallbackReason: "officeXmlSizeLimitExceeded",
        };
      }
    }

    const binData = await this.editor.export();
    const exportFileType = binData.fileType || this.fileType.toLowerCase();
    const result = await convertBinToDocument(
      binData.binData,
      binData.fileName,
      exportFileType,
      binData.media,
      binData.themes,
      this.editor.getLogger(),
    );

    return {
      blob: new Blob([result.data as any], {
        type: getOnlyOfficeMimeType(exportFileType),
      }),
      fileName: result.fileName,
    };
  }

  /** 触发浏览器下载；内部先走 exportAsBlob 完整链路。 */
  async downloadExport() {
    const { blob, fileName } = await this.exportAsBlob();
    downloadBlob(blob, fileName);
  }

  onLoadingChange(handler: (data: LoadingChangeData) => void) {
    onlyofficeEventbus.on(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, handler);
    return () => {
      onlyofficeEventbus.off(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, handler);
    };
  }

  onOfficeXmlSizeLimitExceeded(
    handler: (data: OfficeXmlSizeLimitExceededData) => void,
  ) {
    onlyofficeEventbus.on(
      ONLYOFFICE_EVENT_KEYS.OFFICE_XML_SIZE_LIMIT_EXCEEDED,
      handler,
    );
    return () => {
      onlyofficeEventbus.off(
        ONLYOFFICE_EVENT_KEYS.OFFICE_XML_SIZE_LIMIT_EXCEEDED,
        handler,
      );
    };
  }

  destroy() {
    this.editor.destroy();
    clearDocumentObj(this.containerId);
    this.ready = false;
  }
}

/** 多容器场景（如三栏 Word/Excel/PPT）按 containerId 缓存门面实例 */
export class OnlyOfficeManagerFactory {
  private managers = new Map<string, OnlyOfficeManager>();

  async open(
    options: OnlyOfficeManagerOptions,
    document: OpenDocumentInput,
  ): Promise<OnlyOfficeManager> {
    const containerId = options.containerId ?? ONLYOFFICE_ID;
    let manager = this.managers.get(containerId);

    if (!manager) {
      await initializeOnlyOffice();
      const editor = editorManagerFactory.get(containerId);
      manager = OnlyOfficeManager.fromEditor(editor, {
        ...options,
        containerId,
      });
      this.managers.set(containerId, manager);
    }

    await manager.openDocument({
      ...document,
      readOnly: document.readOnly ?? options.readOnly,
    });

    return manager;
  }

  get(containerId: string) {
    return this.managers.get(containerId);
  }

  destroy(containerId: string) {
    this.managers.get(containerId)?.destroy();
    this.managers.delete(containerId);
  }

  destroyAll() {
    for (const manager of this.managers.values()) {
      manager.destroy();
    }
    this.managers.clear();
  }
}

export const onlyOfficeManagerFactory = new OnlyOfficeManagerFactory();

/** 单页预览默认门面（懒创建，需先 OnlyOfficeManager.create 或 factory.open） */
let defaultManager: OnlyOfficeManager | null = null;

export function getDefaultOnlyOfficeManager() {
  return defaultManager;
}

export function setDefaultOnlyOfficeManager(manager: OnlyOfficeManager | null) {
  defaultManager = manager;
}
