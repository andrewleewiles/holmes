import {
  installOnlyOfficeProxies,
  installReporterWindowHook,
  registerScopedIo,
  unregisterScopedIo,
  type OnlyOfficeProxyWindow,
  type ReporterHookWindow,
  type ScopedIoFactory,
} from "../internal/editor/runtime-bridge";
import {
  callCrossOriginEditor,
  canAccessIframeWindow,
  setCrossOriginReadOnly,
  subscribeCrossOriginEditorEvent,
  unregisterCrossOriginBridge,
  watchCrossOriginIframe,
} from "../internal/editor/runtime-bridge";
import {
  CROSS_ORIGIN_EDITOR_COMMAND,
  CROSS_ORIGIN_EDITOR_EVENT,
} from "../internal/editor/runtime-bridge";
import { EditorServer } from "../internal/editor/server";
import io, { type MockSocketOptions } from "../internal/editor/runtime-bridge";
import { EditorLogger } from "../internal/editor/logger";
import {
  type DocEditor,
  DocumentType,
  isOfficeXmlSizeLimitExceededError,
  type OfficeXmlSizeLimitExceededPayload,
  type OfficeTheme,
  type OnlyOfficeConnector,
  type OnlyOfficeConnectorOptions,
  type User,
} from "../internal/editor/types";
import { getDocumentType, isOnlyOfficeCdnMode } from "../const";
import type { AscWordApiCallback, AscWordApiMethod } from "../type/word-api";
import { type OnlyOfficeIframeWindow } from "../type/sdk-internal";
import {
  ONLYOFFICE_CONTAINER_CONFIG,
  ONLYOFFICE_EVENT_KEYS,
  ONLYOFFICE_ID,
  ASC_RESTRICTION_NONE,
  ASC_RESTRICTION_VIEW,
  OFFICE_EDITOR_LOGO,
  type OfficeXmlEventConfig,
} from "../const";
import {
  type CommentChangeHandlers,
  type CommentData,
  type CommentInput,
  type CommentItem,
  isResolvedComment,
  normalizeCommentInput,
  toPluginCommentPayload,
} from "../feature/comments";
import { onlyofficeEventbus } from "./eventbus";
import {
  type RevisionChangeHandlers,
  type RevisionItem,
  type RevisionsEditorApi,
  collectRevisionItems,
  resolveRevisionShowChanges,
  goToRevision as goToRevisionInSdk,
  applyRevisionChange,
  prepareRevisionReviewDisplay,
} from "../feature/revisions";
import { getOnlyOfficeLang, type OnlyOfficeLang } from "../store/lang";
import { getDocumentObj, setDocumentObj } from "../store/document";
import { initializeOnlyOffice } from "../util/initialize";
import {
  removeOfficeXmlSizeLimitOverlay,
  showOfficeXmlSizeLimitOverlay,
} from "../internal/ui/office-xml-size-limit-overlay";

export type CreateEditorViewOptions = {
  isNew: boolean;
  fileName: string;
  file?: File;
  url?: string;
  loader?: (url: string) => Promise<ArrayBuffer>;
  fileType?: string;
  readOnly?: boolean;
  user?: User;
  lang?: string;
  containerId?: string;
  editorManager?: EditorManager;
  editing?: boolean;
  theme?: OfficeTheme;
  /** 由 EditorManagerFactory.beginLoadSession 生成，用于丢弃过期的异步初始化 */
  loadSession?: number;
  /** 修订审阅页：开启 markup 显示与页边修订气泡 */
  revisionReview?: boolean;
  officeXmlEvent?: OfficeXmlEventConfig;
};

function getFileType(fileName: string, fileType?: string) {
  return fileType || fileName.split(".").pop()?.toLowerCase() || "docx";
}

type OnlyOfficeSdkApi = {
  i1f?: (priority?: number) => void;
  asyncFontsDocumentEndLoaded?: (priority?: number) => void;
  ra?: { Ghj?: () => void };
  asc_registerCallback?: (type: string, fn: AscWordApiCallback) => void;
  asc_unregisterCallback?: (type: string, fn: AscWordApiCallback) => void;
  asc_addComment?: (data: CommentData) => string | undefined;
  asc_changeComment?: (id: string, data: CommentData) => void;
  asc_removeComment?: (id: string) => void;
  sync_ChangeCommentData?: (
    id: string,
    data: unknown,
    ...args: unknown[]
  ) => unknown;
  __ONLYOFFICE_RESOLVE_PATCHED__?: boolean;
  asc_selectComment?: (id: string) => void;
  asc_showComment?: (id: string) => void;
  asc_showComments?: () => void;
  asc_hideComments?: () => void;
  asc_SetGlobalTrackRevisions?: (enabled: boolean) => void;
  asc_GetGlobalTrackRevisions?: () => boolean;
  asc_GetRevisionsChangesStack?: () => unknown[];
  asc_HaveRevisionsChanges?: (all?: boolean) => boolean;
  asc_GetTrackRevisionsReportByAuthors?: () => Record<string, unknown[]>;
  asc_BeginViewModeInReview?: (finalMode?: boolean) => void;
  asc_EndViewModeInReview?: () => void;
  asc_SetLocalTrackRevisions?: (enabled: boolean) => void;
  asc_GetNextRevisionsChange?: () => unknown;
  asc_GetPrevRevisionsChange?: () => unknown;
  asc_FollowRevisionMove?: (change: unknown) => void;
  pluginMethod_MoveToNextReviewChange?: (next: boolean) => void;
  pluginMethod_SetDisplayModeInReview?: (mode: string) => void;
  te?: () => unknown;
  asc_AcceptChanges?: (change?: unknown) => void;
  asc_RejectChanges?: (change?: unknown) => void;
  asc_AcceptChangesBySelection?: (all?: boolean) => void;
  asc_RejectChangesBySelection?: (all?: boolean) => void;
  pluginMethod_GetAllComments?: () => Array<{ Id: string; Data: CommentData }>;
  pluginMethod_AddComment?: (data: CommentData) => string | null;
  pluginMethod_ChangeComment?: (id: string, data: CommentData) => void;
  pluginMethod_InputText?: (text: string) => void;
  pluginMethod_PasteText?: (text: string) => void;
  asc_AddText?: (text: string) => void;
  /** OnlyOffice 内部 WOPI 重命名通道；通过 socket rpc 请求宿主重命名。 */
  asc_wopi_renameFile?: (fileName: string) => void;
};

/** iframe 内运行时；混淆字段见 type/sdk-internal.ts，asc_* 为公开 API */
type OnlyOfficeWindow = OnlyOfficeIframeWindow & {
  Asc?: Omit<NonNullable<OnlyOfficeIframeWindow["Asc"]>, "editor"> & {
    editor?: OnlyOfficeSdkApi & {
      asc_Recalculate?: () => void;
    };
  };
};

type ShellMainController = {
  mode?: { isEdit?: boolean; canEdit?: boolean };
};

type WordHeaderView = {
  btnDocMode?: { setVisible?: (visible: boolean) => void };
  btnPDFMode?: { setVisible?: (visible: boolean) => void };
};

export class EditorManager {
  private editor: DocEditor | null = null;
  /**
   * Connector 和 logger 一样属于一个 EditorManager（也就是一个编辑器 iframe）。
   * 9.4 的 DocsAPI 每创建一个 Connector 都会注册一组 postMessage 监听器；
   * 因此不能由业务调用方重复创建。
   */
  private connector: OnlyOfficeConnector | null = null;
  private server: EditorServer;
  private dirty = false;
  private readOnly = false;
  private editorLang: OnlyOfficeLang = getOnlyOfficeLang();
  private uiTheme: OfficeTheme = "theme-white";
  /** 与容器一一对应，供事件与 Connector 使用同一稳定路由键。 */
  private instanceId: string;
  private containerId: string;
  private logger: EditorLogger;
  private fileName = "New Document.docx";
  private fileType = "docx";
  private media: Record<string, Uint8Array> = {};
  private comments = new Map<string, CommentData>();
  private crossOriginCommentRefreshPromise: Promise<CommentItem[]> | null =
    null;
  private revisions: RevisionItem[] = [];
  private refreshingRevisions = false;
  private crossOriginRevisionRefreshPromise: Promise<RevisionItem[]> | null =
    null;
  private trackRevisions = false;
  private revisionReviewMode = false;
  private wordContentSyncPromise: Promise<void> | null = null;
  private wordContentSyncTeardown: (() => void) | null = null;
  private crossOriginBridgeTeardown: (() => void) | null = null;
  private officeXmlSizeLimitOverlayTeardown: (() => void) | null = null;
  private officeXmlSizeLimitPayload: OfficeXmlSizeLimitExceededPayload | null =
    null;
  private pendingRename:
    | {
        resolve: (fileName: string) => void;
        reject: (error: Error) => void;
        timer: number;
      }
    | null = null;

  constructor(containerId = ONLYOFFICE_ID) {
    this.containerId = containerId;
    this.instanceId = containerId;
    this.logger = new EditorLogger(containerId);
    this.server = new EditorServer({
      getState: () => ({ readOnly: this.readOnly }),
      logger: this.logger,
      onUserSave: (snapshot) => {
        this.dirty = false;
        this.notifyUserSave(snapshot);
      },
      onLoadError: (error) => {
        this.handleServerLoadError(error);
      },
      onDocumentRename: (fileName) => {
        this.syncRenamedDocument(fileName);
      },
    });
  }

  private getContainerElement() {
    return document.getElementById(this.containerId);
  }

  private getOfficeOverlayHostElement() {
    const container = this.getContainerElement();
    return (
      container?.closest<HTMLElement>(
        ONLYOFFICE_CONTAINER_CONFIG.PARENT_SELECTOR,
      ) ?? container
    );
  }

  private clearOfficeXmlSizeLimitOverlay() {
    this.officeXmlSizeLimitOverlayTeardown?.();
    this.officeXmlSizeLimitOverlayTeardown = null;
    this.officeXmlSizeLimitPayload = null;
    const container = this.getOfficeOverlayHostElement();
    if (container) {
      removeOfficeXmlSizeLimitOverlay(container);
    }
  }

  private renderOfficeXmlSizeLimitOverlay() {
    if (!this.officeXmlSizeLimitPayload) {
      return;
    }

    const container = this.getOfficeOverlayHostElement();
    if (container) {
      this.officeXmlSizeLimitOverlayTeardown = showOfficeXmlSizeLimitOverlay(
        container,
        this.officeXmlSizeLimitPayload,
      );
    }
  }

  private handleServerLoadError(error: Error) {
    if (!isOfficeXmlSizeLimitExceededError(error)) {
      return;
    }

    this.officeXmlSizeLimitPayload = error.payload;
    this.renderOfficeXmlSizeLimitOverlay();

    const data = {
      ...error.payload,
      instanceId: this.instanceId,
      containerId: this.containerId,
    };

    try {
      onlyofficeEventbus.emit(
        ONLYOFFICE_EVENT_KEYS.OFFICE_XML_SIZE_LIMIT_EXCEEDED,
        data,
      );
    } catch (eventError) {
      console.error(
        "[EditorManager] officeXmlSizeLimitExceeded handler failed",
        eventError,
      );
    }
  }

  private createScopedIo() {
    return (url?: string, options: MockSocketOptions = {}) => {
      const socket = io(url, { ...options, logger: this.logger });

      socket.on("connect", () => {
        this.server.handleConnect({ socket });
      });
      socket.on("disconnect", () => {
        this.server.handleDisconnect({ socket });
      });

      return socket;
    };
  }

  private createCrossOriginServerIo(): ScopedIoFactory {
    return () => {
      const socket = io(undefined, {
        deferConnect: true,
        logger: this.logger,
      });
      socket.connected = true;
      socket.disconnected = false;
      return socket;
    };
  }

  private syncEditorBridge() {
    this.crossOriginBridgeTeardown?.();
    this.crossOriginBridgeTeardown = null;
    unregisterScopedIo(this.containerId);

    registerScopedIo(this.containerId, this.createScopedIo());
    if (!isOnlyOfficeCdnMode()) {
      return;
    }

    this.crossOriginBridgeTeardown = watchCrossOriginIframe(
      this.containerId,
      () => this.getEditorFrameElement(),
      this.server,
      this.createCrossOriginServerIo(),
    );
  }

  private syncCrossOriginReadOnly(readOnly: boolean, retries = 10) {
    if (setCrossOriginReadOnly(this.containerId, readOnly)) {
      return true;
    }

    if (retries > 0) {
      window.setTimeout(() => {
        this.syncCrossOriginReadOnly(readOnly, retries - 1);
      }, 50);
    }

    return false;
  }

  private getEditorFrameElement() {
    const containerFrame = document
      .getElementById(this.containerId)
      ?.querySelector<HTMLIFrameElement>('iframe[name="frameEditor"]');

    if (containerFrame) {
      return containerFrame;
    }

    const frames = Array.from(
      document.querySelectorAll<HTMLIFrameElement>(
        'iframe[name="frameEditor"]',
      ),
    );
    const matchedFrame = frames.find((frame) => {
      try {
        const url = new URL(frame.src, window.location.origin);
        return url.searchParams.get("frameEditorId") === this.containerId;
      } catch {
        return false;
      }
    });

    if (matchedFrame) {
      return matchedFrame;
    }

    if (this.containerId === ONLYOFFICE_ID) {
      return frames[0];
    }

    return document
      .querySelector<HTMLElement>(
        `${ONLYOFFICE_CONTAINER_CONFIG.PARENT_SELECTOR}[data-onlyoffice-container-id="${this.containerId}"]`,
      )
      ?.querySelector<HTMLIFrameElement>('iframe[name="frameEditor"]');
  }

  private installProxiesOnWindow(win: OnlyOfficeProxyWindow) {
    // 9.4 的协作客户端会把 socket.io 请求相对解析到静态 SDK 根目录。
    // 必须替换 iframe 内的 io，才能将 /doc/... 连接交给内存 EditorServer。
    installOnlyOfficeProxies(win, this.server, this.createScopedIo());
  }

  /**
   * 劫持 iframe 内 XHR/fetch/io，将协作与 downloadAs 请求路由到 mock EditorServer。
   * 必须在 downloadAs 前安装，否则 export 无法收到 /downloadas/ 分片。
   */
  private installIframeProxies() {
    const iframe = this.getEditorFrameElement();
    if (!iframe) {
      throw new Error("Iframe not loaded");
    }

    if (!canAccessIframeWindow(iframe)) {
      return;
    }

    const win = iframe.contentWindow as
      (OnlyOfficeWindow & ReporterHookWindow) | undefined;
    const iframeDoc = iframe.contentDocument;

    if (!iframeDoc || !win) {
      throw new Error("Iframe not loaded");
    }

    if (win.__ONLYOFFICE_PROXIES_INSTALLED__) {
      return;
    }

    this.installProxiesOnWindow(win);
    installReporterWindowHook(win, (target) => {
      this.installProxiesOnWindow(target as OnlyOfficeProxyWindow);
    });
    this.installSaveShortcutBlocker();
  }

  private getEditorFrameWindow() {
    const iframe = this.getEditorFrameElement();

    if (!iframe || !canAccessIframeWindow(iframe)) {
      return undefined;
    }

    return iframe.contentWindow as OnlyOfficeWindow | undefined;
  }

  private getSdkApi() {
    return this.getEditorFrameWindow()?.Asc?.editor;
  }

  private requireSdkApi() {
    const api = this.getSdkApi();

    if (!api) {
      throw new Error("OnlyOffice SDK API is not ready");
    }

    return api;
  }

  private installCommentResolveCleanup() {
    const api = this.getSdkApi();

    if (!api || api.__ONLYOFFICE_RESOLVE_PATCHED__) {
      return;
    }

    api.__ONLYOFFICE_RESOLVE_PATCHED__ = true;

    const removeResolvedComment = (id: unknown) => {
      // OnlyOffice resolves comments through an internal change event first.
      // Removing synchronously during that event can race its own render pass,
      // so schedule the delete for the next tick after the resolved state lands.
      window.setTimeout(() => {
        api.asc_removeComment?.(String(id));
        this.comments.delete(String(id));
      }, 0);
    };

    const originalSyncChange = api.sync_ChangeCommentData?.bind(api);
    if (originalSyncChange) {
      api.sync_ChangeCommentData = (id, data, ...args) => {
        const result = originalSyncChange(id, data, ...args);

        if (isResolvedComment(data)) {
          removeResolvedComment(id);
        }

        return result;
      };
    }

    api.asc_registerCallback?.("asc_onChangeCommentData", (id, data) => {
      if (!isResolvedComment(data)) {
        return;
      }

      removeResolvedComment(id);
    });
  }

  private getDocumentPermissions(editing: boolean) {
    const doc = this.server.getDocument();
    return {
      edit: editing && doc.fileType !== "pdf",
      chat: false,
      rename: editing,
      protect: editing,
      // 允许接受/拒绝文档内已有修订；不自动进入「修订」录制模式
      review: true,
      print: false,
    };
  }

  /** 关闭 autosave 与保存按钮；保存快捷键由 installSaveShortcutBlocker 拦截。 */
  private buildEditorCustomization() {
    return {
      uiTheme: this.uiTheme,
      autosave: false,
      layout: {
        header: {
          save: false,
          // Word 头部「编辑 / 审阅 / 查看」切换（PPT/Excel 无此入口）
          editMode: false,
        },
        toolbar: {
          file: {
            save: false,
          },
          save: false,
        },
      },
      review: {
        trackChanges: this.revisionReviewMode,
        // showReviewChanges:true 会在加载时弹出 asc-window review-changes modal-dlg
        showReviewChanges: false,
        ...(this.revisionReviewMode
          ? { reviewDisplay: "markup" as const }
          : {}),
      },
      features: {
        spellcheck: {
          change: false,
        },
      },
      logo: {
        image: OFFICE_EDITOR_LOGO.image,
        imageDark: OFFICE_EDITOR_LOGO.imageDark,
      },
    };
  }

  /** 禁用 Ctrl/Cmd+S 与工具栏保存，避免与 export/downloadAs 共用管道冲突。 */
  private installSaveShortcutBlocker() {
    const win = this.getEditorFrameWindow();
    const doc = win?.document;

    if (!doc || win?.__ONLYOFFICE_SAVE_BLOCKED__) {
      return;
    }

    const blockSaveShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    doc.addEventListener("keydown", blockSaveShortcut, true);
    win.__ONLYOFFICE_SAVE_BLOCKED__ = true;
  }

  /** 文档若自带 w:trackRevisions，OnlyOffice 默认会跟进入修订模式；接入层强制关闭录制。 */
  private applyDefaultReviewSettings() {
    this.trackRevisions = false;
    if (isOnlyOfficeCdnMode()) {
      void this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_SET_TRACK,
        {
          enabled: false,
        },
      ).catch(() => {});
      return;
    }

    const api = this.getSdkApi();
    api?.asc_SetGlobalTrackRevisions?.(false);
  }

  private mergeCommentItems(items: CommentItem[]) {
    for (const item of items) {
      if (isResolvedComment(item.Data)) {
        this.comments.delete(item.Id);
        continue;
      }

      this.comments.set(item.Id, item.Data);
    }
  }

  private fetchCommentsFromSdk(): CommentItem[] {
    const raw = this.getSdkApi()?.pluginMethod_GetAllComments?.();
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((item, index) => {
        const source =
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : {};
        const id = String(source.Id ?? source.id ?? `comment-${index}`);
        const data = (source.Data ?? source.data ?? source) as CommentData;

        return { Id: id, Data: data };
      })
      .filter((item) => !isResolvedComment(item.Data));
  }

  private refreshCommentsFromSdk() {
    if (isOnlyOfficeCdnMode()) {
      void this.refreshCrossOriginComments().catch(() => {});
      return;
    }

    this.mergeCommentItems(this.fetchCommentsFromSdk());
  }

  private normalizeCrossOriginComments(value: unknown): CommentItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item, index) => {
      const source =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      const data =
        source.Data && typeof source.Data === "object"
          ? (source.Data as CommentData)
          : {};

      return {
        Id: String(source.Id ?? `comment-${index}`),
        Data: data,
      };
    });
  }

  private refreshCrossOriginComments() {
    if (this.crossOriginCommentRefreshPromise) {
      return this.crossOriginCommentRefreshPromise;
    }

    this.crossOriginCommentRefreshPromise = this.callCrossOriginComment(
      CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_LIST,
      {},
    )
      .then((items) => {
        const normalized = this.normalizeCrossOriginComments(items);
        this.comments.clear();
        this.mergeCommentItems(normalized);
        return Array.from(this.comments.entries()).map(([Id, Data]) => ({
          Id,
          Data,
        }));
      })
      .finally(() => {
        this.crossOriginCommentRefreshPromise = null;
      });

    return this.crossOriginCommentRefreshPromise;
  }

  private refreshRevisionsFromSdk(options?: { forceRefreshStack?: boolean }) {
    if (isOnlyOfficeCdnMode()) {
      void this.refreshCrossOriginRevisions(options).catch(() => {});
      return;
    }

    if (this.refreshingRevisions) return;

    const api = this.getSdkApi();
    const frameWin = this.getEditorFrameWindow();
    if (!api || !frameWin) {
      this.revisions = [];
      return;
    }

    this.refreshingRevisions = true;
    try {
      this.revisions = collectRevisionItems(
        api as RevisionsEditorApi,
        frameWin,
        options,
      );
    } finally {
      this.refreshingRevisions = false;
    }
  }

  private applyRevisionsFromSdkStack(stack: unknown) {
    if (isOnlyOfficeCdnMode()) {
      this.revisions = this.normalizeCrossOriginRevisions(stack);
      return;
    }

    const api = this.getSdkApi();
    const frameWin = this.getEditorFrameWindow();
    if (!api || !frameWin) return;

    this.revisions = resolveRevisionShowChanges(
      stack,
      api as RevisionsEditorApi,
      frameWin,
    );
  }

  private syncRevisionsAfterMutation() {
    this.refreshRevisionsFromSdk({ forceRefreshStack: true });
  }

  private applyAllRevisionChanges(mode: "accept" | "reject") {
    if (isOnlyOfficeCdnMode()) {
      void this.callCrossOriginRevision(
        mode === "accept"
          ? CROSS_ORIGIN_EDITOR_COMMAND.REVISION_ACCEPT_ALL
          : CROSS_ORIGIN_EDITOR_COMMAND.REVISION_REJECT_ALL,
      ).then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
      });
      return;
    }

    const api = this.requireSdkApi() as RevisionsEditorApi;
    const frameWin = this.getEditorFrameWindow();
    if (!frameWin) {
      return;
    }

    const applyBulk =
      mode === "accept"
        ? () => api.asc_AcceptChanges?.()
        : () => api.asc_RejectChanges?.();

    this.refreshRevisionsFromSdk({ forceRefreshStack: true });
    let guard = 0;
    let stagnant = 0;
    let lastCount = this.revisions.length;

    while (this.haveRevisionsChanges() && guard++ < 20) {
      this.refreshRevisionsFromSdk({ forceRefreshStack: true });
      const [first] = this.revisions;

      if (!first) {
        applyBulk();
        this.syncRevisionsAfterMutation();
        continue;
      }

      applyRevisionChange(mode, first, api, frameWin, this.revisions);
      this.syncRevisionsAfterMutation();

      const nextCount = this.revisions.length;
      if (nextCount >= lastCount && this.haveRevisionsChanges()) {
        stagnant += 1;
        if (stagnant >= 3) {
          applyBulk();
          this.syncRevisionsAfterMutation();
          stagnant = 0;
        }
      } else {
        stagnant = 0;
      }

      lastCount = nextCount;
    }

    this.syncRevisionsAfterMutation();
  }

  private normalizeCrossOriginRevisions(value: unknown): RevisionItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item, index) => {
      const source =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      const data =
        source.Data && typeof source.Data === "object"
          ? (source.Data as RevisionItem["Data"])
          : {};

      return {
        Id: String(source.Id ?? `rev-stack-${index}`),
        Index:
          typeof source.Index === "number" && Number.isFinite(source.Index)
            ? source.Index
            : index,
        Data: data,
        Raw: (source.Raw ?? {}) as RevisionItem["Raw"],
      };
    });
  }

  private refreshCrossOriginRevisions(options?: {
    forceRefreshStack?: boolean;
  }) {
    if (this.crossOriginRevisionRefreshPromise) {
      return this.crossOriginRevisionRefreshPromise;
    }

    this.crossOriginRevisionRefreshPromise = this.callCrossOriginRevision(
      CROSS_ORIGIN_EDITOR_COMMAND.REVISION_LIST,
      {
        forceRefreshStack: !!options?.forceRefreshStack,
      },
    )
      .then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
        return this.revisions;
      })
      .finally(() => {
        this.crossOriginRevisionRefreshPromise = null;
      });

    return this.crossOriginRevisionRefreshPromise;
  }

  private callCrossOriginRevision(
    command: string,
    payload: Record<string, unknown> = {},
  ) {
    return callCrossOriginEditor(this.containerId, command, payload);
  }

  private revisionTargetId(revision: RevisionItem | string) {
    return typeof revision === "string" ? revision : revision.Id;
  }

  addDemoRevision(text = `审批修订 ${new Date().toLocaleTimeString()}`) {
    this.trackRevisions = true;
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_ADD_DEMO,
        { text },
      ).then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
        return this.revisions;
      });
    }

    const api = this.requireSdkApi() as OnlyOfficeSdkApi;
    api.asc_SetGlobalTrackRevisions?.(true);
    api.asc_SetLocalTrackRevisions?.(true);
    if (api.pluginMethod_InputText) {
      api.pluginMethod_InputText(text);
    } else if (api.pluginMethod_PasteText) {
      api.pluginMethod_PasteText(text);
    } else if (api.asc_AddText) {
      api.asc_AddText(text);
    } else {
      throw new Error("OnlyOffice text insertion API is not available");
    }
    this.syncRevisionsAfterMutation();
    return this.revisions;
  }

  private teardownWordContentSync() {
    this.wordContentSyncTeardown?.();
    this.wordContentSyncTeardown = null;
    this.wordContentSyncPromise = null;
  }

  private scheduleWordContentSync() {
    window.setTimeout(() => {
      this.refreshCommentsFromSdk();
      this.refreshRevisionsFromSdk();
    }, 0);
  }

  private ensureWordContentSync() {
    if (this.fileType !== "docx" && getDocumentType(this.fileType) !== "word") {
      return Promise.resolve();
    }

    if (this.wordContentSyncPromise) {
      return this.wordContentSyncPromise;
    }

    this.wordContentSyncPromise = (async () => {
      if (isOnlyOfficeCdnMode()) {
        await Promise.all([
          this.refreshCrossOriginComments(),
          this.refreshCrossOriginRevisions(),
          this.callCrossOriginComment(
            CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_SUBSCRIBE,
            {},
          ),
          this.callCrossOriginRevision(
            CROSS_ORIGIN_EDITOR_COMMAND.REVISION_SUBSCRIBE,
          ),
        ]);

        const unsubscribers = [
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.ADD_COMMENT,
            ([id, data]) => {
              const commentId = String(id);
              const commentData = data as CommentData;
              if (isResolvedComment(commentData)) {
                this.comments.delete(commentId);
                return;
              }

              this.comments.set(commentId, commentData);
            },
          ),
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.CHANGE_COMMENT,
            ([id, data]) => {
              const commentId = String(id);
              const commentData = data as CommentData;
              if (isResolvedComment(commentData)) {
                this.comments.delete(commentId);
                return;
              }

              this.comments.set(commentId, commentData);
            },
          ),
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.REMOVE_COMMENT,
            ([id]) => {
              this.comments.delete(String(id));
            },
          ),
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.SHOW_REVISIONS_CHANGE,
            ([items]) => {
              this.revisions = this.normalizeCrossOriginRevisions(items);
            },
          ),
        ];

        this.wordContentSyncTeardown = () => {
          unsubscribers.forEach((unsubscribe) => unsubscribe());
        };
        return;
      }

      const api = this.requireSdkApi();

      this.refreshCommentsFromSdk();
      this.refreshRevisionsFromSdk();

      const unsubscribers = await Promise.all([
        this.subscribe({
          type: "asc_onAddComment",
          fn: (id, data) => {
            const commentId = String(id);
            const commentData = data as CommentData;
            if (isResolvedComment(commentData)) {
              this.comments.delete(commentId);
              return;
            }

            this.comments.set(commentId, commentData);
          },
        }),
        this.subscribe({
          type: "asc_onChangeCommentData",
          fn: (id, data) => {
            const commentId = String(id);
            const commentData = data as CommentData;
            if (isResolvedComment(commentData)) {
              this.comments.delete(commentId);
              return;
            }

            this.comments.set(commentId, commentData);
          },
        }),
        this.subscribe({
          type: "asc_onRemoveComment",
          fn: (id) => {
            this.comments.delete(String(id));
          },
        }),
        this.subscribe({
          type: CROSS_ORIGIN_EDITOR_EVENT.SHOW_REVISIONS_CHANGE,
          fn: (stack) => {
            this.applyRevisionsFromSdkStack(stack);
          },
        }),
      ]);

      this.wordContentSyncTeardown = () => {
        unsubscribers.forEach((unsubscribe) => unsubscribe?.());
      };

      this.scheduleWordContentSync();
      api.asc_Recalculate?.();
    })().catch(() => {
      this.teardownWordContentSync();
    });

    return this.wordContentSyncPromise;
  }

  private getRestrictionSdkApi() {
    return this.getSdkApi() as
      | {
          asc_setRestriction?: (type: number) => void;
          asc_removeRestriction?: (type: number) => void;
          asc_setCanSendChanges?: (enabled: boolean) => void;
        }
      | undefined;
  }

  private getShellMainController() {
    const win = this.getEditorFrameWindow() as OnlyOfficeIframeWindow & {
      PE?: { getController?: (name: string) => ShellMainController };
      DE?: { getController?: (name: string) => ShellMainController };
      getApplication?: () => {
        getController?: (name: string) => ShellMainController;
      };
    };

    return (
      win?.PE?.getController?.("Main") ??
      win?.getApplication?.()?.getController?.("Main") ??
      win?.DE?.getController?.("Main")
    );
  }

  private getWordHeaderView() {
    const win = this.getEditorFrameWindow() as OnlyOfficeIframeWindow & {
      DE?: {
        getController?: (name: string) => {
          getView?: (name: string) => WordHeaderView;
        };
      };
    };

    return win?.DE?.getController?.("Viewport")?.getView?.(
      "Common.Views.Header",
    );
  }

  /** 隐藏 Word 头部「编辑 / 审阅 / 查看」切换（customization + 运行时兜底）。 */
  private hideWordDocModeSwitcher() {
    if (getDocumentType(this.fileType) !== DocumentType.Word) {
      return;
    }

    const header = this.getWordHeaderView();
    header?.btnDocMode?.setVisible?.(false);
    header?.btnPDFMode?.setVisible?.(false);

    const hedset = this.getEditorFrameWindow()?.document?.querySelector(
      '[data-layout-name="header-editMode"]',
    );
    if (hedset instanceof HTMLElement) {
      hedset.style.display = "none";
    }
  }

  private scheduleWordDocModeHide() {
    this.hideWordDocModeSwitcher();
    window.setTimeout(() => this.hideWordDocModeSwitcher(), 0);
  }

  /** 同步 web-apps 工具栏/侧栏的 editing:disable（viewMode 与只读一致）。 */
  private syncShellEditingDisable(
    disabled: boolean,
    documentType = getDocumentType(this.fileType),
  ) {
    const nc = this.getEditorFrameWindow()?.Common?.NotificationCenter;
    if (!nc?.trigger) {
      return;
    }

    if (documentType === DocumentType.Slide) {
      nc.trigger("editing:disable", disabled, {
        viewMode: disabled,
        allowSignature: !disabled,
        rightMenu: { clear: false, disable: true },
        statusBar: true,
        leftMenu: { disable: disabled, previewMode: disabled },
        fileMenu: false,
        comments: { disable: false, previewMode: disabled },
        chat: false,
        review: true,
        viewport: disabled,
        documentHolder: { clear: disabled, disable: true },
        toolbar: true,
        header: { search: false },
        shortcuts: disabled ? false : undefined,
      });
      return;
    }

    if (documentType === DocumentType.Word) {
      if (disabled) {
        nc.trigger("editing:disable", true, {
          viewMode: true,
          reviewMode: false,
          fillFormMode: false,
          viewDocMode: false,
          allowMerge: false,
          allowSignature: false,
          allowProtect: false,
          rightMenu: { clear: true, disable: true },
          statusBar: true,
          leftMenu: { disable: true, previewMode: true },
          fileMenu: { protect: true, history: false },
          navigation: { disable: false, previewMode: true },
          comments: { disable: false, previewMode: true },
          chat: false,
          review: true,
          viewport: true,
          documentHolder: { clear: true, disable: true },
          toolbar: true,
          protect: true,
          header: { search: false, startfill: false },
          shortcuts: false,
        });
      } else {
        nc.trigger("editing:disable", false, {
          viewMode: false,
          reviewMode: false,
          fillFormMode: false,
          viewDocMode: false,
          allowMerge: true,
          allowSignature: false,
          allowProtect: false,
          rightMenu: { clear: false, disable: true },
          statusBar: true,
          leftMenu: { disable: false, previewMode: false },
          fileMenu: false,
          navigation: { disable: false, previewMode: false },
          comments: { disable: false, previewMode: false },
          chat: false,
          review: true,
          viewport: false,
          documentHolder: { clear: false, disable: true },
          toolbar: true,
          protect: true,
        });
      }

      this.scheduleWordDocModeHide();
      return;
    }

    nc.trigger("editing:disable", disabled, {
      viewMode: disabled,
      reviewMode: false,
      fillFormMode: false,
      viewDocMode: false,
      allowMerge: true,
      allowSignature: false,
      allowProtect: false,
      rightMenu: { clear: false, disable: true },
      statusBar: true,
      leftMenu: { disable: false, previewMode: disabled },
      fileMenu: false,
      navigation: { disable: false, previewMode: disabled },
      comments: { disable: false, previewMode: disabled },
      chat: false,
      review: true,
      viewport: false,
      documentHolder: { clear: false, disable: true },
      toolbar: true,
    });
  }

  /** PPT 在通用只读逻辑之上追加：锁定 Main 控制器 + 禁用幻灯片侧栏。 */
  private syncSlideReadOnlyExtras(locked: boolean) {
    if (getDocumentType(this.fileType) !== DocumentType.Slide || !locked) {
      return;
    }
    this.lockShellEditMode();
  }

  /**
   * processRightsChange(true) 在 OnlyOffice 内无效果；false 会 asc_coAuthoringDisconnect 且 mode.isEdit=false。
   * 本地/mock 场景用 asc_setRestriction + 外壳 UI 同步，避免切回编辑仍停留在只读。
   */
  private restoreShellEditMode() {
    const main = this.getShellMainController();

    if (main?.mode) {
      main.mode.isEdit = true;
      main.mode.canEdit = true;
    }

    this.getRestrictionSdkApi()?.asc_setCanSendChanges?.(true);
  }

  private lockShellEditMode() {
    const main = this.getShellMainController();

    if (main?.mode) {
      main.mode.isEdit = false;
      main.mode.canEdit = false;
    }

    this.getRestrictionSdkApi()?.asc_setCanSendChanges?.(false);
  }

  /** 兜底：拦截 SDK 层新增/复制幻灯片（toolbar 锁定之外）。 */
  private installSlideStructureEditBlocker() {
    if (getDocumentType(this.fileType) !== DocumentType.Slide) {
      return;
    }

    const patchApi = (
      api:
        | {
            AddSlide?: (...args: unknown[]) => unknown;
            DublicateSlide?: (...args: unknown[]) => unknown;
            __ONLYOFFICE_SLIDE_BLOCK_PATCHED__?: boolean;
          }
        | undefined,
    ) => {
      if (!api || api.__ONLYOFFICE_SLIDE_BLOCK_PATCHED__) {
        return;
      }

      const guard = <T extends (...args: unknown[]) => unknown>(fn?: T) => {
        if (!fn) {
          return fn;
        }

        const bound = fn.bind(api);
        return (...args: unknown[]) => {
          if (this.readOnly) {
            return undefined;
          }
          return bound(...args);
        };
      };

      api.AddSlide = guard(api.AddSlide);
      api.DublicateSlide = guard(api.DublicateSlide);
      api.__ONLYOFFICE_SLIDE_BLOCK_PATCHED__ = true;
    };

    patchApi(
      this.getSdkApi() as unknown as {
        AddSlide?: (...args: unknown[]) => unknown;
        DublicateSlide?: (...args: unknown[]) => unknown;
        __ONLYOFFICE_SLIDE_BLOCK_PATCHED__?: boolean;
      },
    );
    patchApi(
      (
        this.getShellMainController() as {
          api?: {
            AddSlide?: (...args: unknown[]) => unknown;
            DublicateSlide?: (...args: unknown[]) => unknown;
            __ONLYOFFICE_SLIDE_BLOCK_PATCHED__?: boolean;
          };
        }
      )?.api,
    );
  }

  /** downloadAs → /downloadas/ → 更新 fsMap 中的 Editor.bin。 */
  private async captureDocumentSnapshot() {
    if (!this.editor) {
      return this.server.getDocumentSnapshot();
    }

    return await this.server.captureCurrentDocument(() => {
      this.installIframeProxies();
      this.editor?.downloadAs("bin");
    });
  }

  /**
   * 只读模式下 downloadAs 可能被 SDK 拦截；导出前临时恢复编辑权再抓取。
   */
  private async captureDocumentSnapshotAllowingReadOnly() {
    if (!this.editor) {
      return this.server.getDocumentSnapshot();
    }

    const locked = this.readOnly;
    if (locked) {
      this.syncEditingRights(true);
    }

    try {
      return await this.captureDocumentSnapshot();
    } finally {
      if (locked) {
        this.syncEditingRights(false);
        this.syncSlideReadOnlyExtras(true);
      }
    }
  }

  private async captureDocumentIfDirty() {
    if (!this.editor || this.readOnly || !this.dirty) {
      return;
    }

    await this.captureDocumentSnapshot();
    this.dirty = false;
  }

  private destroyDocEditorInstance() {
    this.disconnectConnector();
    this.editor?.destroyEditor?.();
    this.editor = null;
    this.comments.clear();
    this.revisions = [];
    this.teardownWordContentSync();
  }

  /**
   * 创建 Developer Edition Connector。
   * Connector 运行在父页面，借助 DocsAPI 与编辑器 iframe 通信，因此可用于 CDN 跨域场景。
   */
  createConnector(options?: OnlyOfficeConnectorOptions): OnlyOfficeConnector {
    if (!this.editor) {
      throw new Error("OnlyOffice editor is not ready");
    }

    // 同一编辑器始终复用同一个 Connector。调用方可以在不再使用时主动
    // disconnect；下一次默认创建请求会重新 connect，而不会注册第二套监听器。
    if (this.connector) {
      if (options?.autoconnect !== false && !this.connector.isConnected) {
        this.connector.connect();
      }
      return this.connector;
    }

    const iframe = this.getEditorFrameElement();
    if (!iframe?.contentWindow) {
      throw new Error("OnlyOffice editor iframe is not ready");
    }

    // 9.4 的 DocsAPI 把 Connector 消息固定发送给 `iframeEditor`，但本组件
    // 以 containerId 生成 frameEditorId。先禁止自动连接，替换发送函数后再 connect。
    const connector = this.editor.createConnector({
      ...options,
      autoconnect: false,
    }) as OnlyOfficeConnector & {
      guid?: string;
      sendMessage?: (data: Record<string, unknown>) => void;
    };
    // DocsAPI 将 guid 仅作为 connector 回调的路由键。一个 EditorManager
    // 只维护一个 connector，因此用 containerId 可稳定地与编辑器一一对应。
    connector.guid = this.containerId;
    const iframeUrl = new URL(iframe.src, window.location.href);
    const frameEditorId =
      iframeUrl.searchParams.get("frameEditorId") ?? "iframeEditor";
    connector.sendMessage = (data) => {
      iframe.contentWindow?.postMessage(
        JSON.stringify({
          frameEditorId,
          type: "onExternalPluginMessage",
          subType: "connector",
          data: { ...data, guid: connector.guid },
        }),
        iframeUrl.origin,
      );
    };
    if (options?.autoconnect !== false) {
      connector.connect();
    }
    this.connector = connector;
    return this.connector;
  }

  private disconnectConnector() {
    if (this.connector?.isConnected) {
      this.connector.disconnect();
    }
    this.connector = null;
  }

  /**
   * 初始只读与运行时切只读走同一套 asc_setRestriction。
   * 挂载阶段若 permissions.edit=false，xlsx 等会在打开时样式/格式异常；
   * 因此挂载时保持完整编辑权限，documentReady 后再施加只读限制。
   * CDN 跨域模式通过 iframe 内 bridge 执行同样的 SDK/UI 同步，避免跨域访问 window.Asc。
   */
  private applyInitialReadOnlyState(documentType: DocumentType) {
    if (isOnlyOfficeCdnMode()) {
      this.syncCrossOriginReadOnly(this.readOnly);
      return;
    }

    this.installSlideStructureEditBlocker();
    this.syncEditingRights(false);

    if (documentType === DocumentType.Slide) {
      // 工具栏 delayed render 后再锁一次，确保「新增幻灯片」按钮被 DisableToolbar 处理。
      window.setTimeout(() => {
        if (this.readOnly) {
          this.syncShellEditingDisable(true, documentType);
        }
      }, 0);
    }

    if (documentType === DocumentType.Cell) {
      this.getSdkApi()?.asc_Recalculate?.();
    }
  }

  /** 语言写在 iframe URL 的 lang 参数里，运行时 refreshFile 不会更新界面语言。 */
  private mountDocEditor() {
    const doc = this.server.getDocument();
    const user = this.server.getUser();
    const documentType = getDocumentType(doc.fileType);

    this.server.setClient({
      buildVersion: window.DocsAPI!.DocEditor.version(),
    });

    this.editor = new window.DocsAPI!.DocEditor(this.containerId, {
      document: {
        fileType: doc.fileType,
        key: doc.key,
        title: doc.title,
        url: doc.url,
        permissions: this.getDocumentPermissions(true),
      },
      documentType,
      editorConfig: {
        lang: this.editorLang,
        coEditing: {
          mode: "fast",
          change: false,
        },
        user: {
          ...user,
        },
        customization: this.buildEditorCustomization(),
      },
      events: {
        onAppReady: () => {
          // 尽早安装代理，供 WebSocket auth 与后续 downloadAs 使用。
          this.installIframeProxies();
        },
        onDocumentReady: () => {
          this.installSaveShortcutBlocker();
          this.installCommentResolveCleanup();
          this.installSlideStructureEditBlocker();
          this.applyDefaultReviewSettings();
          void this.ensureWordContentSync();
          onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.DOCUMENT_READY, {
            fileName: doc.title,
            fileType: doc.fileType,
            instanceId: this.instanceId,
          });

          if (this.readOnly) {
            this.applyInitialReadOnlyState(documentType);
          } else if (documentType === DocumentType.Word) {
            this.scheduleWordDocModeHide();
          }
        },
        onDocumentStateChange: (event: { data: boolean }) => {
          if (event.data) {
            this.dirty = true;
          }
        },
        // DocsAPI 仅在注册此回调时暴露「文件 → 重命名」入口。
        // 回调由 OnlyOffice 的内部 Gateway 发出；标题显示已由 iframe 更新，
        // 使用 iframe 内 asc_wopi_renameFile 发起 RPC，由内存服务按 WOPI 协议回包。
        // onRequestRename: (event: { data?: unknown }) => {
        //   const fileName =
        //     typeof event.data === "string" ? event.data : "";
        //   void this.renameDocument(fileName).catch((error) => {
        //     this.logger.error("operation", "OnlyOffice document rename failed", {
        //       fileName,
        //       instanceId: this.instanceId,
        //       containerId: this.containerId,
        //       error: error instanceof Error ? error.message : String(error),
        //     });
        //   });
        // },
        // 不注册 onSave/onSaveDocument：内部保存已禁用，导出统一走 export() → downloadAs。
        onDownloadAs: () => {
          // Required so DocsAPI.downloadAs can request the current editor binary.
        },
      },
      type: "desktop",
      width: "100%",
      height: "100%",
    });
  }

  private buildRefreshFileConfig(editing: boolean) {
    const doc = this.server.getDocument();
    return {
      document: {
        fileType: doc.fileType,
        key: doc.key,
        title: doc.title,
        url: doc.url,
        permissions: this.getDocumentPermissions(editing),
      },
      documentType: getDocumentType(doc.fileType),
      editorConfig: {
        mode: editing ? "edit" : "view",
        lang: this.editorLang,
      },
      type: "desktop",
      width: "100%",
      height: "100%",
    };
  }

  /** 就地切换编辑权限（主路径 asc_setRestriction；PPT 只读额外 syncSlideReadOnlyExtras）。 */
  private syncEditingRights(editing: boolean) {
    if (!this.editor) {
      return;
    }

    const documentType = getDocumentType(this.fileType);

    if (isOnlyOfficeCdnMode()) {
      this.syncCrossOriginReadOnly(!editing);
      return;
    }

    const sdk = this.getRestrictionSdkApi();

    if (sdk?.asc_setRestriction) {
      if (editing) {
        sdk.asc_removeRestriction?.(ASC_RESTRICTION_VIEW);
        sdk.asc_setRestriction(ASC_RESTRICTION_NONE);
        this.restoreShellEditMode();
      } else {
        sdk.asc_setRestriction(ASC_RESTRICTION_VIEW);
        this.syncSlideReadOnlyExtras(true);
      }
      this.syncShellEditingDisable(!editing, documentType);
      return;
    }

    if (editing) {
      this.restoreShellEditMode();
      this.syncShellEditingDisable(false, documentType);
      this.editor.refreshFile?.(this.buildRefreshFileConfig(true));
    } else {
      this.syncSlideReadOnlyExtras(true);
      if (documentType !== DocumentType.Slide) {
        this.editor.denyEditingRights?.("");
      }
      this.syncShellEditingDisable(true, documentType);
    }
  }

  private createExportData(
    snapshot: ReturnType<EditorServer["getDocumentSnapshot"]>,
  ) {
    const binData = snapshot.binData;

    if (!binData) {
      throw new Error("No OnlyOffice document data is available to export");
    }

    return {
      fileName: snapshot.fileName || this.fileName,
      fileType: snapshot.fileType || this.fileType,
      binData,
      instanceId: this.instanceId,
      media: {
        ...snapshot.media,
        ...this.media,
      },
      themes: snapshot.themes,
    };
  }

  private userSaveTimer: number | null = null;
  private pendingUserSaveSnapshot: ReturnType<
    EditorServer["getDocumentSnapshot"]
  > | null = null;

  /** 用户保存：更新快照并广播 SAVE_DOCUMENT + ONSAVE（同 tick 内合并重复回调）。 */
  private notifyUserSave(
    snapshot?: ReturnType<EditorServer["getDocumentSnapshot"]>,
  ) {
    if (snapshot) {
      this.pendingUserSaveSnapshot = snapshot;
    }

    if (this.userSaveTimer !== null) {
      window.clearTimeout(this.userSaveTimer);
    }

    this.userSaveTimer = window.setTimeout(() => {
      this.userSaveTimer = null;
      this.dirty = false;

      const snap =
        this.pendingUserSaveSnapshot ?? this.server.getDocumentSnapshot();
      this.pendingUserSaveSnapshot = null;

      const data = this.createExportData(snap);
      onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.SAVE_DOCUMENT, data);
      onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.ONSAVE, {
        fileName: data.fileName,
        instanceId: this.instanceId,
      });
    }, 0);
  }

  private isLoadSessionActive(containerId: string, loadSession?: number) {
    return (
      loadSession === undefined ||
      editorManagerFactory.isLoadSessionActive(containerId, loadSession)
    );
  }

  async create(options: CreateEditorViewOptions) {
    const containerId =
      options.containerId || this.containerId || ONLYOFFICE_ID;

    if (!this.isLoadSessionActive(containerId, options.loadSession)) {
      return this;
    }

    this.destroy();
    this.readOnly = !!options.readOnly;
    this.revisionReviewMode = !!options.revisionReview;
    this.server.setOfficeXmlEventConfig(options.officeXmlEvent);
    if (options.user) {
      this.server.setUser(options.user);
    }
    this.containerId = containerId;

    const fileType = getFileType(options.fileName, options.fileType);
    this.fileName = options.fileName;
    this.fileType = fileType;
    this.media = {};
    this.comments.clear();
    this.revisions = [];
    this.clearOfficeXmlSizeLimitOverlay();
    this.teardownWordContentSync();

    if (options.isNew) {
      this.server.openNew(fileType, options.fileName);
    } else if (options.file) {
      await this.server.open(options.file, {
        fileName: options.fileName,
        fileType,
      });
    } else if (options.url) {
      await this.server.openUrl(options.url, {
        fileName: options.fileName,
        fileType,
        loader: options.loader,
      });
    } else {
      throw new Error("OnlyOffice requires a file, url, or new document type");
    }

    if (this.officeXmlSizeLimitPayload) {
      this.renderOfficeXmlSizeLimitOverlay();
      return this;
    }

    if (!this.isLoadSessionActive(containerId, options.loadSession)) {
      return this;
    }

    await initializeOnlyOffice();

    if (!this.isLoadSessionActive(containerId, options.loadSession)) {
      return this;
    }

    this.editorLang =
      (options.lang as OnlyOfficeLang | undefined) || getOnlyOfficeLang();
    this.uiTheme = options.theme || "theme-white";

    this.syncEditorBridge();
    this.mountDocEditor();
    this.renderOfficeXmlSizeLimitOverlay();

    return this;
  }

  exists() {
    return !!this.editor;
  }

  /** 导出链路：downloadAs("bin") → server.resolvePendingExport → SAVE_DOCUMENT 事件。 */
  async export() {
    let snapshot;
    if (this.editor && (!this.readOnly || this.dirty)) {
      snapshot = await this.captureDocumentSnapshotAllowingReadOnly();
      this.dirty = false;
    } else {
      snapshot = this.server.getDocumentSnapshot();
    }
    const data = this.createExportData(snapshot);

    onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.SAVE_DOCUMENT, data);

    return data;
  }

  getUser(): User {
    return this.server.getUser();
  }

  setUser(user: User) {
    this.server.setUser(user);
    this.editor?.setUsers?.([{ id: user.id, name: user.name }]);
  }

  /** 就地切换只读；切到只读前先 downloadAs 落盘，避免后续导出仍是打开时的 Editor.bin。 */
  async setReadOnly(readOnly: boolean) {
    if (this.readOnly === readOnly) {
      return;
    }

    onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, {
      loading: true,
    });

    try {
      if (readOnly && this.editor) {
        await this.captureDocumentSnapshot();
        this.dirty = false;
      }

      this.readOnly = readOnly;
      if (isOnlyOfficeCdnMode()) {
        this.syncCrossOriginReadOnly(readOnly);
        return;
      }

      this.installSlideStructureEditBlocker();
      this.syncEditingRights(!readOnly);
    } finally {
      onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, {
        loading: false,
      });
    }
  }

  getReadOnly() {
    return this.readOnly;
  }

  async setLanguage(lang: OnlyOfficeLang) {
    if (this.editorLang === lang) {
      return;
    }

    this.editorLang = lang;

    if (!this.editor) {
      return;
    }

    onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, {
      loading: true,
    });

    try {
      await this.captureDocumentIfDirty();
      this.destroyDocEditorInstance();
      this.mountDocEditor();
    } finally {
      onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, {
        loading: false,
      });
    }
  }

  getTheme(): OfficeTheme {
    return this.uiTheme;
  }

  /** uiTheme 写在 iframe URL 参数里，运行时需 remount 才能生效。 */
  async setTheme(theme: OfficeTheme) {
    if (this.uiTheme === theme) {
      return;
    }

    this.uiTheme = theme;

    if (!this.editor) {
      return;
    }

    onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, {
      loading: true,
    });

    try {
      await this.captureDocumentIfDirty();
      this.destroyDocEditorInstance();
      this.mountDocEditor();
    } finally {
      onlyofficeEventbus.emit(ONLYOFFICE_EVENT_KEYS.LOADING_CHANGE, {
        loading: false,
      });
    }
  }

  getInstanceId() {
    return this.instanceId;
  }

  isOfficeXmlSizeLimitExceeded() {
    return !!this.officeXmlSizeLimitPayload;
  }

  getContainerId() {
    return this.containerId;
  }

  getLogger() {
    return this.logger;
  }

  printLogs() {
    this.logger.print();
  }

  getFileName() {
    return this.fileName;
  }

  /**
   * @description 通过 iframe 内 asc_wopi_renameFile 重命名当前实例。
  * SDK 经 socket rpc 收到内存 WOPI 回包后才更新本地标题，因此返回 Promise。
   */
  renameDocument(fileName: string): Promise<string> {
    const requestedName =
      typeof fileName === "string" ? fileName.trim() : "";
    if (!requestedName) {
      return Promise.reject(
        new Error("OnlyOffice document name cannot be empty"),
      );
    }

    if (this.pendingRename) {
      return Promise.reject(new Error("OnlyOffice document rename is pending"));
    }

    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pendingRename?.timer !== timer) {
          return;
        }
        this.pendingRename = null;
        reject(new Error("OnlyOffice document rename timed out"));
      }, 5000);

      this.pendingRename = { resolve, reject, timer };

      try {
        if (isOnlyOfficeCdnMode()) {
          void callCrossOriginEditor(
            this.containerId,
            CROSS_ORIGIN_EDITOR_COMMAND.DOCUMENT_RENAME,
            { fileName: requestedName },
          )
            .then(() => {
              // 跨域 bridge 只能确认 iframe 已调用 SDK API；原生「文件 → 重命名」
              // 路径不一定把 WOPI RPC 回包转回父页。由宿主提交标题，确保导出
              // 快照与当前文件名同步；若 RPC 已先到达，pendingRename 已被清空。
              if (this.pendingRename) {
                this.server.rename(requestedName);
              }
            })
            .catch((error) => this.rejectPendingRename(error));
          return;
        }

        const api = this.requireSdkApi();
        if (!api.asc_wopi_renameFile) {
          throw new Error("OnlyOffice WOPI rename API is not available");
        }
        api.asc_wopi_renameFile(requestedName);
      } catch (error) {
        this.rejectPendingRename(error);
      }
    });
  }

  private syncRenamedDocument(renamedFileName: string) {
    this.fileName = renamedFileName;

    const document = getDocumentObj(this.containerId);
    setDocumentObj(
      {
        ...document,
        fileName: renamedFileName,
      },
      this.containerId,
    );

    const pendingRename = this.pendingRename;
    if (pendingRename) {
      window.clearTimeout(pendingRename.timer);
      this.pendingRename = null;
      pendingRename.resolve(renamedFileName);
    }

    this.logger.operation("OnlyOffice document renamed through WOPI RPC", {
      fileName: renamedFileName,
      instanceId: this.instanceId,
      containerId: this.containerId,
    });
  }

  private rejectPendingRename(error: unknown) {
    const pendingRename = this.pendingRename;
    if (!pendingRename) {
      return;
    }

    window.clearTimeout(pendingRename.timer);
    this.pendingRename = null;
    pendingRename.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  getContainerParentSelector() {
    return `${ONLYOFFICE_CONTAINER_CONFIG.PARENT_SELECTOR}[data-onlyoffice-container-id="${this.containerId}"], ${ONLYOFFICE_CONTAINER_CONFIG.PARENT_SELECTOR}`;
  }

  getContainerStyle() {
    return ONLYOFFICE_CONTAINER_CONFIG.STYLE;
  }

  updateMedia(key: string, data: Uint8Array) {
    this.media[key] = data;
  }

  getMedia() {
    return { ...this.media };
  }

  isDirty() {
    return this.dirty;
  }

  async subscribe({
    type,
    fn,
  }: {
    type: AscWordApiMethod;
    fn: AscWordApiCallback;
  }) {
    if (isOnlyOfficeCdnMode()) {
      if (
        type === CROSS_ORIGIN_EDITOR_EVENT.ADD_COMMENT ||
        type === CROSS_ORIGIN_EDITOR_EVENT.CHANGE_COMMENT ||
        type === CROSS_ORIGIN_EDITOR_EVENT.REMOVE_COMMENT
      ) {
        await this.callCrossOriginComment(
          CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_SUBSCRIBE,
          {},
        );
        return subscribeCrossOriginEditorEvent(this.containerId, type, (args) =>
          fn(...args),
        );
      }

      if (
        type === CROSS_ORIGIN_EDITOR_EVENT.SHOW_REVISIONS_CHANGE ||
        type === CROSS_ORIGIN_EDITOR_EVENT.TRACK_REVISIONS_CHANGE
      ) {
        await this.callCrossOriginRevision(
          CROSS_ORIGIN_EDITOR_COMMAND.REVISION_SUBSCRIBE,
        );
        return subscribeCrossOriginEditorEvent(this.containerId, type, (args) =>
          fn(...args),
        );
      }

      if (type === CROSS_ORIGIN_EDITOR_EVENT.DOCUMENT_MODIFIED_CHANGED) {
        await callCrossOriginEditor(
          this.containerId,
          CROSS_ORIGIN_EDITOR_COMMAND.EDITOR_SUBSCRIBE,
          { event: type },
        );
        return subscribeCrossOriginEditorEvent(this.containerId, type, (args) =>
          fn(...args),
        );
      }

      throw new Error(
        `OnlyOffice cross-origin callback is not supported: ${type}`,
      );
    }

    const api = this.requireSdkApi();

    if (!api.asc_registerCallback || !api.asc_unregisterCallback) {
      throw new Error("OnlyOffice callback subscription is not supported");
    }

    api.asc_registerCallback(type, fn);

    return () => {
      api.asc_unregisterCallback?.(type, fn);
    };
  }

  async getAllComments(): Promise<CommentItem[]> {
    if (isOnlyOfficeCdnMode()) {
      return this.refreshCrossOriginComments();
    }

    this.refreshCommentsFromSdk();
    return Array.from(this.comments.entries()).map(([Id, Data]) => ({
      Id,
      Data,
    }));
  }

  refreshComments() {
    return this.getAllComments();
  }

  private createSdkCommentPayload(data: CommentData): unknown {
    const asc = this.getEditorFrameWindow()?.Asc as
      | (Record<string, unknown> & {
          asc_CCommentDataWord?: new (value: unknown) => {
            asc_putText?: (value: string) => void;
            asc_putUserName?: (value: string) => void;
            asc_putTime?: (value: string) => void;
            asc_putQuoteText?: (value: string) => void;
            asc_putSolved?: (value: boolean) => void;
            asc_putUserData?: (value: string) => void;
          };
        })
      | undefined;
    const CommentDataWord = asc?.asc_CCommentDataWord;

    if (!CommentDataWord) {
      return data;
    }

    const comment = new CommentDataWord(null);
    const payload = toPluginCommentPayload(data);

    if (payload.Text != null) {
      comment.asc_putText?.(String(payload.Text));
    }
    if (payload.UserName != null) {
      comment.asc_putUserName?.(String(payload.UserName));
    }
    if (payload.Time != null) {
      comment.asc_putTime?.(String(payload.Time));
    }
    if (payload.QuoteText != null) {
      comment.asc_putQuoteText?.(String(payload.QuoteText));
    }
    if (typeof payload.Solved === "boolean") {
      comment.asc_putSolved?.(payload.Solved);
    }
    if (payload.UserData != null) {
      comment.asc_putUserData?.(String(payload.UserData));
    }

    return comment;
  }

  async callCrossOriginComment(
    command: string,
    payload: Record<string, unknown>,
  ) {
    return callCrossOriginEditor(this.containerId, command, payload);
  }

  addComment(input: CommentInput) {
    if (isOnlyOfficeCdnMode()) {
      const data = toPluginCommentPayload(normalizeCommentInput(input));
      return this.callCrossOriginComment(
        CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_ADD,
        { data },
      ).then((id) => {
        if (id) {
          this.comments.set(String(id), data);
        }
        return id ? String(id) : "";
      });
    }

    const api = this.requireSdkApi();
    const data = toPluginCommentPayload(normalizeCommentInput(input));
    const id =
      api.pluginMethod_AddComment?.(data) ??
      api.asc_addComment?.(this.createSdkCommentPayload(data) as CommentData);
    if (id) {
      this.comments.set(String(id), data);
    }
    return id ? String(id) : "";
  }

  updateComment(id: string, data: CommentData) {
    if (isResolvedComment(data)) {
      return this.removeComment(id);
    }

    if (isOnlyOfficeCdnMode()) {
      const payload = toPluginCommentPayload(data);
      return this.callCrossOriginComment(
        CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_UPDATE,
        {
          id,
          data: payload,
        },
      ).then(() => {
        this.comments.set(id, payload);
      });
    }

    const api = this.requireSdkApi();
    const payload = toPluginCommentPayload(data);

    if (typeof api.pluginMethod_ChangeComment === "function") {
      api.pluginMethod_ChangeComment(id, payload);
    } else {
      api.asc_changeComment?.(
        id,
        this.createSdkCommentPayload(payload) as CommentData,
      );
    }
    this.comments.set(id, payload);
  }

  removeComment(id: string) {
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginComment(
        CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_REMOVE,
        { id },
      ).then(() => {
        this.comments.delete(id);
      });
    }

    this.requireSdkApi().asc_removeComment?.(id);
    this.comments.delete(id);
  }

  goToComment(
    id: string,
    { showBalloon = false }: { showBalloon?: boolean } = {},
  ) {
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginComment(
        CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_GO_TO,
        { id, showBalloon },
      );
    }

    const api = this.requireSdkApi();
    api.asc_selectComment?.(id);
    if (showBalloon) {
      api.asc_showComment?.(id);
    }
  }

  async registerCommentCallbacks(handlers: CommentChangeHandlers) {
    if (isOnlyOfficeCdnMode()) {
      const unsubscribers: Array<() => void> = [];
      await this.callCrossOriginComment(
        CROSS_ORIGIN_EDITOR_COMMAND.COMMENT_SUBSCRIBE,
        {},
      );

      if (handlers.onAdd) {
        unsubscribers.push(
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.ADD_COMMENT,
            ([id, data]) => {
              const commentId = String(id);
              const commentData = data as CommentData;
              this.comments.set(commentId, commentData);
              handlers.onAdd?.(commentId, commentData);
            },
          ),
        );
      }

      if (handlers.onChange) {
        unsubscribers.push(
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.CHANGE_COMMENT,
            ([id, data]) => {
              const commentId = String(id);
              const commentData = data as CommentData;
              if (isResolvedComment(commentData)) {
                this.comments.delete(commentId);
                handlers.onRemove?.(commentId);
                return;
              }

              this.comments.set(commentId, commentData);
              handlers.onChange?.(commentId, commentData);
            },
          ),
        );
      }

      if (handlers.onRemove) {
        unsubscribers.push(
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.REMOVE_COMMENT,
            ([id]) => {
              const commentId = String(id);
              this.comments.delete(commentId);
              handlers.onRemove?.(commentId);
            },
          ),
        );
      }

      return () => {
        unsubscribers.forEach((unsubscribe) => unsubscribe());
      };
    }

    const unsubscribers = await Promise.all([
      handlers.onAdd
        ? this.subscribe({
            type: "asc_onAddComment",
            fn: (id, data) => {
              const commentId = String(id);
              const commentData = data as CommentData;
              this.comments.set(commentId, commentData);
              handlers.onAdd?.(commentId, commentData);
            },
          })
        : undefined,
      handlers.onChange
        ? this.subscribe({
            type: "asc_onChangeCommentData",
            fn: (id, data) => {
              const commentId = String(id);
              const commentData = data as CommentData;
              if (isResolvedComment(commentData)) {
                window.setTimeout(() => {
                  this.removeComment(commentId);
                  handlers.onRemove?.(commentId);
                }, 0);
                return;
              }

              this.comments.set(commentId, commentData);
              handlers.onChange?.(commentId, commentData);
            },
          })
        : undefined,
      handlers.onRemove
        ? this.subscribe({
            type: "asc_onRemoveComment",
            fn: (id) => {
              const commentId = String(id);
              this.comments.delete(commentId);
              handlers.onRemove?.(commentId);
            },
          })
        : undefined,
    ]);

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe?.());
    };
  }

  setTrackRevisions(enabled: boolean) {
    this.trackRevisions = enabled;
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_SET_TRACK,
        { enabled },
      );
    }

    const api = this.requireSdkApi() as RevisionsEditorApi;
    api.asc_SetGlobalTrackRevisions?.(enabled);
    api.asc_SetLocalTrackRevisions?.(enabled);
  }

  /** 修订审阅页初始化：开启追踪 + markup 显示模式（不会批量接受/拒绝） */
  prepareRevisionReview() {
    this.trackRevisions = true;
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_PREPARE_REVIEW,
      ).then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
      });
    }

    const api = this.requireSdkApi() as RevisionsEditorApi;
    api.asc_SetGlobalTrackRevisions?.(true);
    prepareRevisionReviewDisplay(api, this.getEditorFrameWindow());
  }

  isTrackRevisions() {
    if (isOnlyOfficeCdnMode()) {
      void this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_IS_TRACK,
      ).then((enabled) => {
        this.trackRevisions = !!enabled;
      });
      return this.trackRevisions;
    }

    return !!this.getSdkApi()?.asc_GetGlobalTrackRevisions?.();
  }

  haveRevisionsChanges() {
    if (isOnlyOfficeCdnMode()) {
      void this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_HAVE_CHANGES,
      ).then((hasChanges) => {
        if (!hasChanges) {
          this.revisions = [];
        } else {
          void this.refreshCrossOriginRevisions();
        }
      });
      return this.revisions.length > 0;
    }

    const api = this.getSdkApi() as RevisionsEditorApi | undefined;
    if (typeof api?.asc_HaveRevisionsChanges === "function") {
      if (api.asc_HaveRevisionsChanges(true)) {
        return true;
      }
      if (api.asc_HaveRevisionsChanges()) {
        return true;
      }
    }

    return this.revisions.length > 0;
  }

  async getAllRevisions(): Promise<RevisionItem[]> {
    if (isOnlyOfficeCdnMode()) {
      return this.refreshCrossOriginRevisions({ forceRefreshStack: true });
    }

    this.refreshRevisionsFromSdk({ forceRefreshStack: true });
    return this.revisions;
  }

  refreshRevisions() {
    return this.getAllRevisions();
  }

  goToNextRevision() {
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_NEXT,
      );
    }

    (
      this.getSdkApi() as RevisionsEditorApi | undefined
    )?.asc_GetNextRevisionsChange?.();
  }

  goToPrevRevision() {
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_PREV,
      );
    }

    (
      this.getSdkApi() as RevisionsEditorApi | undefined
    )?.asc_GetPrevRevisionsChange?.();
  }

  goToRevision(id: string) {
    if (isOnlyOfficeCdnMode()) {
      const cached = this.revisions.find((entry) => entry.Id === id);
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_GO_TO,
        {
          id,
          index: cached?.Index,
        },
      );
    }

    const api = this.getSdkApi();
    const frameWin = this.getEditorFrameWindow();
    if (!api || !frameWin) return;

    let cached = this.revisions.find((entry) => entry.Id === id);
    if (!cached) {
      this.refreshRevisionsFromSdk();
      cached = this.revisions.find((entry) => entry.Id === id);
    }

    goToRevisionInSdk(
      cached ?? id,
      api as RevisionsEditorApi,
      frameWin,
      this.revisions,
    );
  }

  acceptRevision(revision: RevisionItem | string) {
    if (isOnlyOfficeCdnMode()) {
      const id = this.revisionTargetId(revision);
      const cached = this.revisions.find((entry) => entry.Id === id);
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_ACCEPT,
        {
          id,
          index: cached?.Index,
        },
      ).then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
      });
    }

    const api = this.getSdkApi();
    const frameWin = this.getEditorFrameWindow();
    if (!api || !frameWin) {
      return;
    }

    if (
      applyRevisionChange(
        "accept",
        revision,
        api as RevisionsEditorApi,
        frameWin,
        this.revisions,
      )
    ) {
      this.syncRevisionsAfterMutation();
    }
  }

  rejectRevision(revision: RevisionItem | string) {
    if (isOnlyOfficeCdnMode()) {
      const id = this.revisionTargetId(revision);
      const cached = this.revisions.find((entry) => entry.Id === id);
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_REJECT,
        {
          id,
          index: cached?.Index,
        },
      ).then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
      });
    }

    const api = this.getSdkApi();
    const frameWin = this.getEditorFrameWindow();
    if (!api || !frameWin) {
      return;
    }

    if (
      applyRevisionChange(
        "reject",
        revision,
        api as RevisionsEditorApi,
        frameWin,
        this.revisions,
      )
    ) {
      this.syncRevisionsAfterMutation();
    }
  }

  acceptAllRevisions() {
    this.applyAllRevisionChanges("accept");
  }

  rejectAllRevisions() {
    this.applyAllRevisionChanges("reject");
  }

  acceptRevisionsBySelection(all?: boolean) {
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_ACCEPT_SELECTION,
        { all },
      ).then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
      });
    }

    this.requireSdkApi().asc_AcceptChangesBySelection?.(all);
  }

  rejectRevisionsBySelection(all?: boolean) {
    if (isOnlyOfficeCdnMode()) {
      return this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_REJECT_SELECTION,
        { all },
      ).then((items) => {
        this.revisions = this.normalizeCrossOriginRevisions(items);
      });
    }

    this.requireSdkApi().asc_RejectChangesBySelection?.(all);
  }

  async registerRevisionCallbacks(handlers: RevisionChangeHandlers) {
    if (isOnlyOfficeCdnMode()) {
      const unsubscribers: Array<() => void> = [];
      await this.callCrossOriginRevision(
        CROSS_ORIGIN_EDITOR_COMMAND.REVISION_SUBSCRIBE,
      );

      if (handlers.onShowChanges) {
        unsubscribers.push(
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.SHOW_REVISIONS_CHANGE,
            ([items]) => {
              this.revisions = this.normalizeCrossOriginRevisions(items);
              handlers.onShowChanges?.(this.revisions);
            },
          ),
        );
      }

      if (handlers.onTrackRevisionsChange) {
        unsubscribers.push(
          subscribeCrossOriginEditorEvent(
            this.containerId,
            CROSS_ORIGIN_EDITOR_EVENT.TRACK_REVISIONS_CHANGE,
            ([enabled]) => {
              this.trackRevisions = !!enabled;
              handlers.onTrackRevisionsChange?.(!!enabled);
            },
          ),
        );
      }

      return () => {
        unsubscribers.forEach((unsubscribe) => unsubscribe());
      };
    }

    const unsubscribers = await Promise.all([
      handlers.onShowChanges
        ? this.subscribe({
            type: CROSS_ORIGIN_EDITOR_EVENT.SHOW_REVISIONS_CHANGE,
            fn: (stack) => {
              const api = this.getSdkApi();
              const frameWin = this.getEditorFrameWindow();
              if (!api || !frameWin) return;

              handlers.onShowChanges?.(
                resolveRevisionShowChanges(
                  stack,
                  api as RevisionsEditorApi,
                  frameWin,
                ),
              );
            },
          })
        : undefined,
      handlers.onTrackRevisionsChange
        ? this.subscribe({
            type: CROSS_ORIGIN_EDITOR_EVENT.TRACK_REVISIONS_CHANGE,
            fn: (enabled) => handlers.onTrackRevisionsChange?.(!!enabled),
          })
        : undefined,
    ]);
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe?.());
    };
  }

  destroy() {
    this.rejectPendingRename(new Error("OnlyOffice editor was destroyed"));
    if (this.userSaveTimer !== null) {
      window.clearTimeout(this.userSaveTimer);
      this.userSaveTimer = null;
    }
    this.pendingUserSaveSnapshot = null;
    this.teardownWordContentSync();
    this.crossOriginBridgeTeardown?.();
    this.crossOriginBridgeTeardown = null;
    this.clearOfficeXmlSizeLimitOverlay();
    unregisterScopedIo(this.containerId);
    unregisterCrossOriginBridge(this.containerId);
    this.disconnectConnector();
    this.editor?.destroyEditor?.();
    this.editor = null;
    this.dirty = false;
    this.comments.clear();
    this.revisions = [];
    this.server.reset();
  }
}

class EditorManagerFactory {
  private defaultManager = new EditorManager();
  private managers = new Map<string, EditorManager>();
  private loadSessions = new Map<string, number>();

  beginLoadSession(containerId: string) {
    const next = (this.loadSessions.get(containerId) ?? 0) + 1;
    this.loadSessions.set(containerId, next);
    return next;
  }

  isLoadSessionActive(containerId: string, loadSession: number) {
    return this.loadSessions.get(containerId) === loadSession;
  }

  getDefault() {
    return this.defaultManager;
  }

  create(containerId: string) {
    const manager =
      this.managers.get(containerId) || new EditorManager(containerId);
    this.managers.set(containerId, manager);
    return manager;
  }

  get(containerId: string) {
    return this.managers.get(containerId) || this.create(containerId);
  }

  getAll() {
    return [this.defaultManager, ...this.managers.values()];
  }

  destroy(containerId: string) {
    const manager = this.managers.get(containerId);
    manager?.destroy();
    this.managers.delete(containerId);
  }

  destroyAll() {
    this.defaultManager.destroy();
    for (const manager of this.managers.values()) {
      manager.destroy();
    }
    this.managers.clear();
  }
}
export const editorManagerFactory = new EditorManagerFactory();
export const editorManager = editorManagerFactory.getDefault();
if (typeof window !== "undefined") {
  (window as any).editorManagerFactory = editorManagerFactory;
}
