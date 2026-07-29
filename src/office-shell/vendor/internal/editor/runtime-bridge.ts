import { EventEmitter } from "../../util/event-emitter";
import type { EditorLogger } from "./logger";
import type { EditorServer } from "./server";

type Callback = (...args: any[]) => void;

export interface MockSocketOptions {
  /**
   * @description 是否开启调试日志。
   */
  debug?: boolean;
  /**
   * @description 跨域 bridge 父页侧仅路由消息，不自动 connect
   */
  deferConnect?: boolean;
  logger?: EditorLogger;
}

/**
 * @description 基于内部 EventEmitter 模拟 socket.io-client 的最小运行时。
 */
export class MockSocket<
  ListenEvents extends Record<string, Callback> = any,
  EmitEvents extends Record<string, Callback> = any
> {
  private static _staticEmitter = new EventEmitter();
  static on<E extends string>(event: E, listener: Callback) {
    MockSocket._staticEmitter.on(event, listener);
  }
  static off<E extends string>(event: E, listener?: Callback) {
    MockSocket._staticEmitter.off(event, listener);
  }

  public active = true;
  public connected: boolean = false;
  public disconnected: boolean = true;
  public recovered = false;
  public id: string = "";
  public io = {
    setOpenToken: () => {

    },
    setSessionToken: () => {

    },
    on: function () {
      return this;
    },
    reconnectionAttempts: function () {
      return this;
    },
    reconnectionDelay: function () {
      return this;
    },
    reconnectionDelayMax: function () {
      return this;
    },
    timeout: function () {
      return this;
    },
    transports: function () {
      return this;
    },
    upgrade: function () {
      return this;
    },
    upgradeTransport: function () {
      return this;
    },
    upgradeTimeout: function () {
      return this;
    },
  };

  private _clientEmitter = new EventEmitter();
  private _serverEmitter = new EventEmitter();

  private _debug: boolean;
  private _logger?: EditorLogger;

  constructor(options: MockSocketOptions = {}) {
    this._debug = options.debug;
    this._logger = options.logger;
    if (!options.deferConnect) {
      this.connect();
    }
  }

  private _log(...args: any[]): void {
    if (this._logger) {
      this._logger.raw("log", "socket", "mock socket", ["[MockSocket]", ...args]);
      return;
    }
    if (this._debug) {
      console.log("[MockSocket]", ...args);
    }
  }

  open() {
    return this.connect();
  }

  compress() {}

  /**
   * @description 模拟连接建立并生成新的 session id。
   */
  connect() {
    this.connected = true;
    this.disconnected = false;
    this.id = Math.random().toString(36).substring(2, 15);
    setTimeout(() => {
      this._trigger("connect");
      MockSocket._staticEmitter.emit("connect", { socket: this });
    }, 0);
    return this;
  }

  disconnect() {
    this.connected = false;
    this.disconnected = true;
    this._trigger("disconnect");
    MockSocket._staticEmitter.emit("disconnect", { socket: this });
    return this;
  }

  close(): this {
    return this.disconnect();
  }

  /**
   * @description 触发本地监听器，用于模拟服务端下行事件。
   */
  private _trigger(event: string, ...args: any[]): this {
    this._log(`trigger event: ${event}`, ...args);
    this._clientEmitter.emit(event, ...args);
    return this;
  }

  /**
   * @description 注册服务端下行事件监听器。
   */
  on<E extends keyof ListenEvents & string>(
    event: E,
    listener: ListenEvents[E]
  ): this {
    this._clientEmitter.on(event, listener);
    return this;
  }

  /**
   * @description 注册一次性的服务端下行事件监听器。
   */
  once<E extends keyof ListenEvents & string>(
    event: E,
    listener: ListenEvents[E]
  ): this {
    this._clientEmitter.once(event, listener);
    return this;
  }

  /**
   * @description 移除事件监听器。
   */
  off<E extends keyof ListenEvents & string>(
    event: E,
    listener?: ListenEvents[E]
  ): this {
    this._clientEmitter.off(event, listener);
    return this;
  }

  /**
   * @description 移除全部监听器，或移除指定事件的监听器。
   */
  removeAllListeners(event?: string): this {
    this._clientEmitter.removeAllListeners(event);
    return this;
  }

  /**
   * @description 使用 message 事件向服务端发送消息。
   */
  send(...args: Parameters<EmitEvents["message"]>): this {
    if (!this.connected) return this;
    this.emit("message", ...args);
    return this;
  }

  /**
   * @description 向服务端发送事件消息。
   */
  emit<E extends keyof EmitEvents & string>(
    event: E,
    ...args: Parameters<EmitEvents[E]>
  ): this {
    this._log(`emit: ${event}`, ...args);

    if (!this.connected) return this;

    const processEmit = async () => {
      this._serverEmitter.emit(event, ...args);
    };

    setTimeout(() => processEmit(), 0);
    return this;
  }

  public server = {
    on: (event: string, listener: Callback) => {
      this._serverEmitter.on(event, listener);
    },
    off: (event: string, listener?: Callback) => {
      this._serverEmitter.off(event, listener);
    },
    emit: (event: string, ...args: any[]) => {
      this._clientEmitter.emit(event, ...args);
    },
  };
}

/**
 * @description 兼容 socket.io-client 调用方式的工厂函数。
 */
export function io(_url?: string, options?: MockSocketOptions): MockSocket {
  return new MockSocket(options);
}

/**
 * @description 为 socket.io 兼容层保留函数命名空间类型。
 */
export interface SocketIOStatic {
  (url?: string, options?: MockSocketOptions): MockSocket;
}

const ioWithStatics = io as SocketIOStatic;

/**
 * @description 默认导出保持 socket.io-client 兼容。
 */
export default ioWithStatics;


export interface XHRMiddleware {
  (request: Request): Response | null | Promise<Response | null>;
}

export interface XHRProxyOptions {
  baseUrl?: string;
  shouldBypass?: (url: string, method: string) => boolean;
}

export interface FetchProxyOptions {
  baseUrl?: string;
}

function isForbiddenRequestHeader(name: string) {
  const lowerName = name.toLowerCase();
  return (
    lowerName === "accept-charset" ||
    lowerName === "accept-encoding" ||
    lowerName === "access-control-request-headers" ||
    lowerName === "access-control-request-method" ||
    lowerName === "connection" ||
    lowerName === "content-length" ||
    lowerName === "cookie" ||
    lowerName === "cookie2" ||
    lowerName === "date" ||
    lowerName === "dnt" ||
    lowerName === "expect" ||
    lowerName === "host" ||
    lowerName === "keep-alive" ||
    lowerName === "origin" ||
    lowerName === "referer" ||
    lowerName === "te" ||
    lowerName === "trailer" ||
    lowerName === "transfer-encoding" ||
    lowerName === "upgrade" ||
    lowerName === "via" ||
    lowerName.startsWith("proxy-") ||
    lowerName.startsWith("sec-")
  );
}

/**
 * @description 创建支持中间件拦截的 XMLHttpRequest 代理类。
 * @param BaseXHR 原始 XMLHttpRequest 构造器。
 */
export function createXHRProxy(
  BaseXHR = globalThis.XMLHttpRequest,
  options: XHRProxyOptions = {},
) {
  return class ProxyXMLHttpRequest extends BaseXHR {
    private static _middlewares: XHRMiddleware[] = [];

    private _isMocked: boolean = false;
    private _requestMethod: string = "GET";
    private _requestUrl: string = "";
    private _requestHeaders: Headers = new Headers();
    private _requestBody: any = null;
    private _responseHeaders: Headers = new Headers();

    /**
     * @description 注册全局 XHR 中间件。
     */
    static use(middleware: XHRMiddleware) {
      this._middlewares.push(middleware);
    }

    /**
     * @description 清空全部 XHR 中间件。
     */
    static clearMiddlewares() {
      this._middlewares = [];
    }

    open(
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ): void {
      const normalizedUrl = (() => {
        try {
          return options.baseUrl
            ? new URL(url.toString(), options.baseUrl).href
            : url.toString();
        } catch {
          return url.toString();
        }
      })();

      this._requestMethod = method;
      this._requestUrl = normalizedUrl;
      this._requestHeaders = new Headers();
      this._responseHeaders = new Headers();
      this._isMocked = false;

      super.open(
        method,
        normalizedUrl,
        async,
        username ?? undefined,
        password ?? undefined,
      );
    }

    setRequestHeader(name: string, value: string): void {
      if (isForbiddenRequestHeader(name)) {
        return;
      }

      this._requestHeaders.append(name, value);

      if (!this._isMocked) {
        super.setRequestHeader(name, value);
      }
    }

    getResponseHeader(name: string): string | null {
      if (this._isMocked) {
        return this._responseHeaders.get(name);
      }
      return super.getResponseHeader(name);
    }

    getAllResponseHeaders(): string {
      if (!this._isMocked) {
        return super.getAllResponseHeaders();
      }
      return Array.from(this._responseHeaders.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
    }

    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      this._requestBody = body;

      if (options.shouldBypass?.(this._requestUrl, this._requestMethod)) {
        super.send(body);
        return;
      }

      this._tryMiddlewares()
        .then((handled) => {
          if (!handled) {
            super.send(body);
          }
        })
        .catch((err) => {
          console.error("ProxyXMLHttpRequest middleware error:", err);
          super.send(body);
        });
    }

    private async _tryMiddlewares(): Promise<boolean> {
      let request: Request;
      try {
        const reqInit: RequestInit = {
          method: this._requestMethod,
          headers: this._requestHeaders,
          body: this._requestBody as BodyInit,
          mode: "cors",
        };

        if (this.withCredentials) {
          reqInit.credentials = "include";
        }

        request = new Request(this._requestUrl, reqInit);
        console.log("ProxyXHR created request:", {
          url: this._requestUrl,
          method: request.method,
          hasBody: !!request.body,
          originalBody: this._requestBody,
        });
      } catch (e) {
        return false;
      }

      for (const mw of ProxyXMLHttpRequest._middlewares) {
        const response = await mw(request.clone());
        if (response) {
          this._isMocked = true;
          await this._handleMockResponse(response);
          return true;
        }
      }

      return false;
    }

    private async _handleMockResponse(response: Response) {
      this._responseHeaders = new Headers(response.headers);

      const emit = (event: Event) => {
        this.dispatchEvent(event);
      };

      emit(new ProgressEvent("loadstart"));

      Object.defineProperty(this, "readyState", {
        value: 2,
        writable: false,
        configurable: true,
      });
      emit(new Event("readystatechange"));

      Object.defineProperty(this, "readyState", {
        value: 3,
        writable: false,
        configurable: true,
      });
      emit(new Event("readystatechange"));

      try {
        let responseData: any;

        if (this.responseType === "json") {
          responseData = await response.json();
        } else if (this.responseType === "arraybuffer") {
          responseData = await response.arrayBuffer();
        } else if (this.responseType === "blob") {
          responseData = await response.blob();
        } else if (this.responseType === "document") {
          const text = await response.text();
          responseData = new DOMParser().parseFromString(text, "text/xml");
        } else {
          responseData = await response.text();
        }

        Object.defineProperty(this, "status", {
          value: response.status,
          writable: false,
          configurable: true,
        });

        Object.defineProperty(this, "statusText", {
          value: response.statusText,
          writable: false,
          configurable: true,
        });

        Object.defineProperty(this, "response", {
          value: responseData,
          writable: false,
          configurable: true,
        });

        Object.defineProperty(this, "responseText", {
          value:
            typeof responseData === "string"
              ? responseData
              : JSON.stringify(responseData),
          writable: false,
          configurable: true,
        });

        Object.defineProperty(this, "responseURL", {
          value: response.url,
          writable: false,
          configurable: true,
        });

        emit(
          new ProgressEvent("progress", {
            lengthComputable: true,
            loaded: 100,
            total: 100,
          }),
        );

        Object.defineProperty(this, "readyState", {
          value: 4,
          writable: false,
          configurable: true,
        });
        emit(new Event("readystatechange"));

        emit(new ProgressEvent("load"));

        emit(new ProgressEvent("loadend"));
      } catch (e) {
        console.error("ProxyXHR: error handling response", e);

        Object.defineProperty(this, "readyState", {
          value: 4,
          writable: false,
          configurable: true,
        });
        emit(new Event("readystatechange"));

        emit(new ProgressEvent("error"));
        emit(new ProgressEvent("loadend"));
      }
    }
  };
}


export type FetchProxy = typeof fetch & {
  use(middleware: XHRMiddleware): void;
  clearMiddlewares(): void;
};

/**
 * @description 创建支持中间件拦截的 fetch 代理函数。
 */
export function createFetchProxy(
  target: (Window & { fetch: typeof fetch }) | typeof fetch = globalThis.fetch,
  options: FetchProxyOptions = {},
): FetchProxy {
  const middlewares: XHRMiddleware[] = [];
  const BaseFetch =
    typeof target === "function" ? target : target.fetch.bind(target);

  const proxy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let request: Request;
    try {
      const normalizedInput =
        options.baseUrl && !(input instanceof Request)
          ? new URL(input.toString(), options.baseUrl).href
          : input;
      request = new Request(normalizedInput, init);
    } catch (e) {
      return BaseFetch(input, init);
    }

    try {
      for (const mw of middlewares) {
        const response = await mw(request.clone());
        if (response) {
          return response;
        }
      }
    } catch (err) {
      console.error("ProxyFetch middleware error:", err);
      return BaseFetch(request);
    }

    return BaseFetch(request);
  }) as FetchProxy;

  proxy.use = (middleware: XHRMiddleware) => {
    middlewares.push(middleware);
  };

  proxy.clearMiddlewares = () => {
    middlewares.length = 0;
  };

  return proxy;
}


export const CROSS_ORIGIN_BRIDGE_MESSAGE = {
  EDITOR_COMMAND: "editor:command",
  EDITOR_RESPONSE: "editor:response",
  EDITOR_EVENT: "editor:event",
  EDITOR_SET_READONLY: "editor:set-readonly",
} as const;

export const CROSS_ORIGIN_EDITOR_COMMAND = {
  EDITOR_SUBSCRIBE: "editor:subscribe",
  DOCUMENT_RENAME: "document:rename",
  COMMENT_ADD: "comment:add",
  COMMENT_UPDATE: "comment:update",
  COMMENT_REMOVE: "comment:remove",
  COMMENT_GO_TO: "comment:go-to",
  COMMENT_LIST: "comment:list",
  COMMENT_SUBSCRIBE: "comment:subscribe",
  REVISION_ADD_DEMO: "revision:add-demo",
  REVISION_LIST: "revision:list",
  REVISION_SET_TRACK: "revision:set-track",
  REVISION_IS_TRACK: "revision:is-track",
  REVISION_HAVE_CHANGES: "revision:have-changes",
  REVISION_PREPARE_REVIEW: "revision:prepare-review",
  REVISION_NEXT: "revision:next",
  REVISION_PREV: "revision:prev",
  REVISION_GO_TO: "revision:go-to",
  REVISION_ACCEPT: "revision:accept",
  REVISION_REJECT: "revision:reject",
  REVISION_ACCEPT_ALL: "revision:accept-all",
  REVISION_REJECT_ALL: "revision:reject-all",
  REVISION_ACCEPT_SELECTION: "revision:accept-selection",
  REVISION_REJECT_SELECTION: "revision:reject-selection",
  REVISION_SUBSCRIBE: "revision:subscribe",
} as const;

export const CROSS_ORIGIN_EDITOR_EVENT = {
  ADD_COMMENT: "asc_onAddComment",
  CHANGE_COMMENT: "asc_onChangeCommentData",
  REMOVE_COMMENT: "asc_onRemoveComment",
  SHOW_REVISIONS_CHANGE: "asc_onShowRevisionsChange",
  TRACK_REVISIONS_CHANGE: "asc_onOnTrackRevisionsChange",
  DOCUMENT_MODIFIED_CHANGED: "asc_onDocumentModifiedChanged",
} as const;


export function shouldBypassOnlyOfficeProxy(url: string, baseUrl: string) {
  const pathname = new URL(url, baseUrl).pathname;

  return (
    pathname.includes("/sdkjs/common/AllFonts.js") ||
    pathname.includes("/sdkjs/common/libfont/") ||
    pathname.includes("/fonts/")
  );
}

export type ScopedIoFactory = (
  url?: string,
  options?: MockSocketOptions,
) => MockSocket;

export type OnlyOfficeParentWindow = Window & {
  __ONLYOFFICE_SCOPED_IO__?: Record<string, ScopedIoFactory>;
};

export function getScopedIoRegistry(
  win: Window = window,
): Record<string, ScopedIoFactory> {
  const parent = win as OnlyOfficeParentWindow;
  if (!parent.__ONLYOFFICE_SCOPED_IO__) {
    parent.__ONLYOFFICE_SCOPED_IO__ = {};
  }
  return parent.__ONLYOFFICE_SCOPED_IO__;
}

export function registerScopedIo(
  containerId: string,
  factory: ScopedIoFactory,
  win: Window = window,
) {
  getScopedIoRegistry(win)[containerId] = factory;
}

export function unregisterScopedIo(containerId: string, win: Window = window) {
  const registry = (win as OnlyOfficeParentWindow).__ONLYOFFICE_SCOPED_IO__;
  if (registry) {
    delete registry[containerId];
  }
}

export type OnlyOfficeProxyWindow = Window & {
  __ONLYOFFICE_PROXIES_INSTALLED__?: boolean;
  __ONLYOFFICE_GETFILE_PATCHED__?: boolean;
  __ONLYOFFICE_PROXY_SERVER__?: EditorServer;
  XMLHttpRequest: typeof XMLHttpRequest;
  Worker: typeof Worker;
  AscCommon?: {
    getFile?: (url: string) => void;
  };
};

export type InstallOnlyOfficeProxyOptions = {
  installIo?: boolean;
};

function extractDownloadFileName(url: string) {
  if (!url) {
    return "download";
  }

  try {
    const parsed = new URL(url, window.location.href);
    const fromQuery = parsed.searchParams.get("filename");
    if (fromQuery) {
      return decodeURIComponent(fromQuery);
    }

    const pathname = parsed.pathname;
    const name = decodeURIComponent(pathname.split("/").pop() || "");
    if (name.startsWith("output.")) {
      return name;
    }
    if (name) {
      return name;
    }
  } catch {
    const fallback = url.split("/").pop() || url.split("?")[0];
    if (fallback) {
      return decodeURIComponent(fallback);
    }
  }

  return "download";
}

function parseContentDispositionFileName(header: string | null) {
  if (!header) {
    return "";
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const asciiMatch = /filename="([^"]+)"/i.exec(header);
  if (asciiMatch?.[1]) {
    return asciiMatch[1];
  }

  return "";
}

function scheduleNamedDownloadPatch(
  win: OnlyOfficeProxyWindow,
  server: EditorServer,
  retries = 100,
) {
  if (win.__ONLYOFFICE_GETFILE_PATCHED__) {
    return;
  }

  if (win.AscCommon?.getFile) {
    installNamedDownloadPatch(win, server);
    return;
  }

  if (retries > 0) {
    win.setTimeout(
      () => scheduleNamedDownloadPatch(win, server, retries - 1),
      50,
    );
  }
}

function extractOutputNameFromCacheUrl(url: string) {
  const match = /\/cache\/files\/data\/[^/]+\/(output\.[^/?#]+)/i.exec(url);
  return match?.[1] ?? "";
}

function triggerBlobDownload(win: Window, blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = win.document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  link.style.display = "none";
  win.document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

/**
 * @description mock cache URL 无法通过 iframe 下载携带文件名，改为 fetch + <a download>。
 */
function installNamedDownloadPatch(
  win: OnlyOfficeProxyWindow,
  server: EditorServer,
) {
  win.__ONLYOFFICE_PROXY_SERVER__ = server;
  const ascCommon = win.AscCommon;
  if (!ascCommon?.getFile || win.__ONLYOFFICE_GETFILE_PATCHED__) {
    return;
  }

  const nativeGetFile = ascCommon.getFile.bind(ascCommon);
  const fetchFile = win.fetch.bind(win);

  ascCommon.getFile = (url: string) => {
    if (typeof url !== "string" || !url) {
      nativeGetFile(url);
      return;
    }

    const needsNamedDownload =
      url.includes("/cache/files/") || url.startsWith("blob:");

    if (!needsNamedDownload) {
      nativeGetFile(url);
      return;
    }

    const fallbackName = extractDownloadFileName(url);
    void fetchFile(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Download failed: ${response.status}`);
        }
        const fileName =
          parseContentDispositionFileName(
            response.headers.get("Content-Disposition"),
          ) || fallbackName;
        return response.blob().then((blob) => ({ blob, fileName }));
      })
      .then(({ blob, fileName }) => {
        triggerBlobDownload(win, blob, fileName);
      })
      .catch((err) => {
        console.warn("[OnlyOffice] named download fetch failed:", err);
        const outputName = extractOutputNameFromCacheUrl(url);
        const currentServer = win.__ONLYOFFICE_PROXY_SERVER__ ?? server;
        const blobUrl = outputName
          ? currentServer.getStoredOutputUrl(outputName)
          : null;
        const fileName =
          (outputName && currentServer.getStoredOutputFileName(outputName)) ||
          fallbackName;
        if (blobUrl) {
          void fetchFile(blobUrl)
            .then((response) => response.blob())
            .then((blob) => triggerBlobDownload(win, blob, fileName))
            .catch((fallbackErr) => {
              console.warn("[OnlyOffice] blob download fallback:", fallbackErr);
              nativeGetFile(url);
            });
          return;
        }
        nativeGetFile(url);
      });
  };

  win.__ONLYOFFICE_GETFILE_PATCHED__ = true;
}

export function installOnlyOfficeProxies(
  win: OnlyOfficeProxyWindow,
  server: EditorServer,
  createIo: ScopedIoFactory,
  options: InstallOnlyOfficeProxyOptions = {},
) {
  win.__ONLYOFFICE_PROXY_SERVER__ = server;

  if (win.__ONLYOFFICE_PROXIES_INSTALLED__) {
    scheduleNamedDownloadPatch(win, server);
    return;
  }

  const xhr = createXHRProxy(win.XMLHttpRequest, {
    baseUrl: win.location.href,
    shouldBypass: (url) => shouldBypassOnlyOfficeProxy(url, win.location.href),
  });
  const fetchProxy = createFetchProxy(win, { baseUrl: win.location.href });
  const WorkerCtor = win.Worker;

  xhr.use((request) => win.__ONLYOFFICE_PROXY_SERVER__?.handleRequest(request) ?? null);
  fetchProxy.use(
    (request) => win.__ONLYOFFICE_PROXY_SERVER__?.handleRequest(request) ?? null,
  );

  const patches: Partial<OnlyOfficeProxyWindow> & { io?: ScopedIoFactory } = {
    XMLHttpRequest: xhr,
    fetch: fetchProxy,
    Worker: function Worker(url: string, options?: WorkerOptions) {
      const u = new URL(url, win.location.origin);
      return new WorkerCtor(
        u.href.replace(u.origin, win.location.origin),
        options,
      );
    } as unknown as typeof Worker,
  };
  if (options.installIo !== false) {
    patches.io = createIo;
  }

  Object.assign(win, patches);
  win.__ONLYOFFICE_PROXIES_INSTALLED__ = true;
  scheduleNamedDownloadPatch(win, server);
}

export const REPORTER_HTML = "index.reporter.html";

export type ReporterBridge = {
  install: (target: Window) => void;
};

export type ReporterHookWindow = Window & {
  open: typeof window.open;
  __ONLYOFFICE_REPORTER_HOOK__?: boolean;
  __ONLYOFFICE_REPORTER_BRIDGE__?: ReporterBridge;
};

export function installReporterWindowHook(
  win: ReporterHookWindow,
  installProxies: (target: Window) => void,
) {
  if (win.__ONLYOFFICE_REPORTER_HOOK__) {
    return;
  }

  win.__ONLYOFFICE_REPORTER_BRIDGE__ = { install: installProxies };
  win.__ONLYOFFICE_REPORTER_HOOK__ = true;

  const nativeOpen = win.open.bind(win);
  win.open = function openReporter(
    url?: string | URL,
    target?: string,
    features?: string,
  ) {
    const popup = nativeOpen(url, target, features);
    const href = typeof url === "string" ? url : url?.toString() ?? "";

    if (popup && href.includes(REPORTER_HTML)) {
      watchReporterWindow(popup, installProxies);
    }

    return popup;
  };
}

function watchReporterWindow(
  popup: Window,
  installProxies: (target: Window) => void,
) {
  const tryInstall = () => {
    if (popup.closed) {
      return true;
    }

    try {
      if (popup.location.href.includes(REPORTER_HTML)) {
        installProxies(popup);
        return true;
      }
    } catch {
      /**
       * @description 弹窗仍在导航过程中，继续轮询等待 reporter 页面可访问。
       */
    }

    return false;
  };

  if (tryInstall()) {
    return;
  }

  const interval = window.setInterval(() => {
    if (tryInstall()) {
      window.clearInterval(interval);
    }
  }, 1);

  popup.addEventListener(
    "load",
    () => {
      tryInstall();
      window.clearInterval(interval);
    },
    { once: true },
  );
}


const BRIDGE_SOURCE = "onlyoffice-bridge";

type BridgeMessage = {
  source?: string;
  type?: string;
  frameEditorId?: string;
  requestId?: string;
  command?: string;
  payload?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  event?: string;
  args?: unknown[];
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | null;
  bodyEncoding?: "base64";
  readOnly?: boolean;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
  responseType?: XMLHttpRequestResponseType;
};

type BridgeSession = {
  frameEditorId: string;
  server: EditorServer;
  createIo: ScopedIoFactory;
  iframe: HTMLIFrameElement;
  targetOrigin: string;
  socket: MockSocket | null;
  bridgeReady: boolean;
  handshakeSent: boolean;
  pendingReadOnly: boolean | null;
};

const sessions = new Map<string, BridgeSession>();
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: number;
  }
>();
const pendingReadyWaiters = new Map<
  string,
  Set<{
    resolve: (session: BridgeSession) => void;
    reject: (reason?: unknown) => void;
    timer: number;
  }>
>();
const editorEventSubscribers = new Map<
  string,
  Map<string, Set<(args: unknown[]) => void>>
>();
let listenerInstalled = false;

function isBridgeMessage(data: unknown): data is BridgeMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as BridgeMessage).source === BRIDGE_SOURCE
  );
}

function getTargetOrigin(iframe: HTMLIFrameElement): string {
  try {
    return new URL(iframe.src, window.location.href).origin;
  } catch {
    return "*";
  }
}

function postToIframe(
  session: BridgeSession,
  message: BridgeMessage,
  targetWindow?: Window | null,
) {
  const target = targetWindow ?? session.iframe.contentWindow;
  if (!target) {
    return;
  }
  target.postMessage(
    { ...message, source: BRIDGE_SOURCE },
    session.targetOrigin,
  );
}

function getIframeByWindow(source: MessageEventSource | null) {
  if (!source || !("postMessage" in source)) {
    return null;
  }

  const frames = document.querySelectorAll<HTMLIFrameElement>(
    'iframe[name="frameEditor"]',
  );
  for (const frame of frames) {
    if (frame.contentWindow === source) {
      return frame;
    }
  }

  return null;
}

function updateSessionIframe(
  session: BridgeSession,
  iframe: HTMLIFrameElement,
) {
  if (session.iframe === iframe) {
    return;
  }

  detachSocket(session);
  session.iframe = iframe;
  session.targetOrigin = getTargetOrigin(iframe);
  session.bridgeReady = false;
  session.handshakeSent = false;
}

function attachSocket(session: BridgeSession) {
  if (session.socket) {
    return;
  }

  const socket = session.createIo();
  session.socket = socket;
  session.server.registerSocketTransport(socket);

  const nativeServerEmit = socket.server.emit.bind(socket.server);
  socket.server.emit = (event: string, ...args: unknown[]) => {
    postToIframe(session, {
      type: "socket:event",
      frameEditorId: session.frameEditorId,
      event,
      args,
    });
    return nativeServerEmit(event, ...args);
  };
}

function detachSocket(session: BridgeSession) {
  if (!session.socket) {
    return;
  }
  session.server.handleDisconnect({ socket: session.socket });
  session.socket = null;
  session.handshakeSent = false;
}

async function handleHttpRequest(
  session: BridgeSession,
  message: BridgeMessage,
) {
  const requestId = message.requestId;
  if (!requestId || !message.url || !message.method) {
    return;
  }

  try {
    const init: RequestInit = {
      method: message.method,
      headers: message.headers,
    };
    if (message.method !== "GET" && message.method !== "HEAD") {
      init.body = decodeRequestBody(message);
    }

    let response = await session.server.handleRequest(
      new Request(message.url, init),
    );
    if (!response) {
      response = await fetch(message.url, init);
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let responseBody: string | null = null;
    if (message.responseType === "arraybuffer") {
      const buffer = await response.arrayBuffer();
      responseBody = arrayBufferToBase64(buffer);
    } else {
      responseBody = await response.text();
    }

    postToIframe(session, {
      type: "http:response",
      frameEditorId: session.frameEditorId,
      requestId,
      status: response.status,
      responseHeaders,
      responseBody,
      responseType: message.responseType,
    });
  } catch (error) {
    postToIframe(session, {
      type: "http:response",
      frameEditorId: session.frameEditorId,
      requestId,
      status: 0,
      responseBody: null,
    });
    console.error("[OnlyOfficeBridge] HTTP proxy failed:", error);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function decodeRequestBody(
  message: BridgeMessage,
): BodyInit | null | undefined {
  if (message.body == null) {
    return null;
  }
  if (message.bodyEncoding === "base64") {
    return base64ToArrayBuffer(message.body);
  }
  return message.body;
}

function describeBridgeState(frameEditorId: string) {
  const session = sessions.get(frameEditorId);
  if (!session) {
    return `OnlyOffice cross-origin bridge is not ready for ${frameEditorId}: session is not registered`;
  }

  return `OnlyOffice cross-origin bridge is not ready for ${frameEditorId}: iframe=${session.iframe.src || "(empty)"}`;
}

function resolveReadyWaiters(frameEditorId: string, session: BridgeSession) {
  const waiters = pendingReadyWaiters.get(frameEditorId);
  if (!waiters) {
    return;
  }

  pendingReadyWaiters.delete(frameEditorId);
  waiters.forEach((waiter) => {
    window.clearTimeout(waiter.timer);
    waiter.resolve(session);
  });
}

function rejectReadyWaiters(frameEditorId: string, error: Error) {
  const waiters = pendingReadyWaiters.get(frameEditorId);
  if (!waiters) {
    return;
  }

  pendingReadyWaiters.delete(frameEditorId);
  waiters.forEach((waiter) => {
    window.clearTimeout(waiter.timer);
    waiter.reject(error);
  });
}

function waitForBridgeReady(frameEditorId: string, timeout: number) {
  const session = sessions.get(frameEditorId);
  if (session?.bridgeReady) {
    return Promise.resolve(session);
  }

  return new Promise<BridgeSession>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const waiters = pendingReadyWaiters.get(frameEditorId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) {
        pendingReadyWaiters.delete(frameEditorId);
      }
      reject(new Error(describeBridgeState(frameEditorId)));
    }, timeout);
    const waiter = { resolve, reject, timer };

    let waiters = pendingReadyWaiters.get(frameEditorId);
    if (!waiters) {
      waiters = new Set();
      pendingReadyWaiters.set(frameEditorId, waiters);
    }
    waiters.add(waiter);
  });
}

function handleBridgeMessage(event: MessageEvent) {
  if (!isBridgeMessage(event.data)) {
    return;
  }

  const message = event.data;
  if (
    message.type === CROSS_ORIGIN_BRIDGE_MESSAGE.EDITOR_RESPONSE &&
    message.requestId
  ) {
    const pending = pendingRequests.get(message.requestId);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingRequests.delete(message.requestId);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }

  if (
    message.type === CROSS_ORIGIN_BRIDGE_MESSAGE.EDITOR_EVENT &&
    message.event
  ) {
    const frameEditorId = message.frameEditorId;
    const frameSubscribers = frameEditorId
      ? editorEventSubscribers.get(frameEditorId)
      : undefined;
    const subscribers = frameSubscribers?.get(message.event);
    subscribers?.forEach((handler) => {
      handler(message.args ?? []);
    });
    return;
  }

  const frameEditorId = message.frameEditorId;
  if (!frameEditorId) {
    return;
  }

  const session = sessions.get(frameEditorId);
  if (!session) {
    return;
  }

  const sourceIframe = getIframeByWindow(event.source);
  if (sourceIframe) {
    updateSessionIframe(session, sourceIframe);
  }

  switch (message.type) {
    case "hello": {
      session.bridgeReady = true;
      resolveReadyWaiters(frameEditorId, session);
      attachSocket(session);
      const targetWindow =
        event.source && "postMessage" in event.source
          ? (event.source as Window)
          : undefined;
      postToIframe(session, { type: "hello:ack", frameEditorId }, targetWindow);
      if (!session.handshakeSent) {
        session.handshakeSent = true;
        setTimeout(() => {
          if (session.socket) {
            session.server.sendCoAuthoringHandshake(session.socket);
          }
        }, 0);
      }
      if (session.pendingReadOnly !== null) {
        postToIframe(session, {
          type: CROSS_ORIGIN_BRIDGE_MESSAGE.EDITOR_SET_READONLY,
          frameEditorId,
          readOnly: session.pendingReadOnly,
        });
        session.pendingReadOnly = null;
      }
      break;
    }
    case "socket:emit": {
      if (!session.socket || !message.event) {
        break;
      }
      (
        session.socket as { emit: (event: string, ...args: unknown[]) => void }
      ).emit(message.event, ...(message.args ?? []));
      break;
    }
    case "http": {
      void handleHttpRequest(session, message);
      break;
    }
    default:
      break;
  }
}

export function registerCrossOriginBridge(
  frameEditorId: string,
  iframe: HTMLIFrameElement,
  server: EditorServer,
  createIo: ScopedIoFactory,
) {
  const existing = sessions.get(frameEditorId);
  if (existing) {
    existing.server = server;
    existing.createIo = createIo;
    updateSessionIframe(existing, iframe);
    return;
  }

  sessions.set(frameEditorId, {
    frameEditorId,
    server,
    createIo,
    iframe,
    targetOrigin: getTargetOrigin(iframe),
    socket: null,
    bridgeReady: false,
    handshakeSent: false,
    pendingReadOnly: null,
  });

  if (!listenerInstalled) {
    window.addEventListener("message", handleBridgeMessage);
    listenerInstalled = true;
  }
}

export function unregisterCrossOriginBridge(frameEditorId: string) {
  const session = sessions.get(frameEditorId);
  if (session) {
    detachSocket(session);
    sessions.delete(frameEditorId);
    rejectReadyWaiters(
      frameEditorId,
      new Error(
        `OnlyOffice cross-origin bridge was unregistered: ${frameEditorId}`,
      ),
    );
  }
  editorEventSubscribers.delete(frameEditorId);
}

export function setCrossOriginReadOnly(
  frameEditorId: string,
  readOnly: boolean,
) {
  const session = sessions.get(frameEditorId);
  if (!session) {
    return false;
  }

  session.pendingReadOnly = readOnly;
  if (!session.bridgeReady) {
    return true;
  }

  postToIframe(session, {
    type: CROSS_ORIGIN_BRIDGE_MESSAGE.EDITOR_SET_READONLY,
    frameEditorId,
    readOnly,
  });
  session.pendingReadOnly = null;
  return true;
}

export function callCrossOriginEditor(
  frameEditorId: string,
  command: string,
  payload: Record<string, unknown> = {},
  timeout = 5000,
) {
  const requestId = `editor-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;

  return waitForBridgeReady(frameEditorId, timeout).then(
    (session) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(
            new Error(`OnlyOffice cross-origin command timed out: ${command}`),
          );
        }, timeout);

        pendingRequests.set(requestId, { resolve, reject, timer });
        postToIframe(session, {
          type: CROSS_ORIGIN_BRIDGE_MESSAGE.EDITOR_COMMAND,
          frameEditorId,
          requestId,
          command,
          payload,
        });
      }),
  );
}

export function subscribeCrossOriginEditorEvent(
  frameEditorId: string,
  event: string,
  handler: (args: unknown[]) => void,
) {
  let frameSubscribers = editorEventSubscribers.get(frameEditorId);
  if (!frameSubscribers) {
    frameSubscribers = new Map();
    editorEventSubscribers.set(frameEditorId, frameSubscribers);
  }

  let subscribers = frameSubscribers.get(event);
  if (!subscribers) {
    subscribers = new Set();
    frameSubscribers.set(event, subscribers);
  }

  subscribers.add(handler);

  return () => {
    subscribers?.delete(handler);
    if (subscribers?.size === 0) {
      frameSubscribers?.delete(event);
    }
    if (frameSubscribers?.size === 0) {
      editorEventSubscribers.delete(frameEditorId);
    }
  };
}

export function canAccessIframeWindow(
  iframe: HTMLIFrameElement | null | undefined,
) {
  if (!iframe) {
    return false;
  }
  try {
    void iframe.contentWindow?.location.href;
    return true;
  } catch {
    return false;
  }
}

export function watchCrossOriginIframe(
  frameEditorId: string,
  getIframe: () => HTMLIFrameElement | null | undefined,
  server: EditorServer,
  createIo: ScopedIoFactory,
) {
  let registered = false;

  const tryRegister = () => {
    const iframe = getIframe();
    if (!iframe?.src || canAccessIframeWindow(iframe)) {
      return false;
    }
    if (registered) {
      registerCrossOriginBridge(frameEditorId, iframe, server, createIo);
      return true;
    }
    registered = true;
    registerCrossOriginBridge(frameEditorId, iframe, server, createIo);
    return true;
  };

  tryRegister();

  const timer = window.setInterval(() => {
    if (tryRegister()) {
      window.clearInterval(timer);
    }
  }, 10);

  const observer = new MutationObserver(() => {
    tryRegister();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    window.clearInterval(timer);
    observer.disconnect();
    if (registered) {
      unregisterCrossOriginBridge(frameEditorId);
    }
  };
}
