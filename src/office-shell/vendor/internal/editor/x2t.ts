/**
 * @description x2t 主线程代理，将重型文档转换转交给 Web Worker，避免阻塞界面线程。
 */

import { X2tConvertParams, X2tConvertResult } from "./types";
import { getStaticResource, resolveSiteUrl, type StaticResource } from "../../const";
import type { EditorLogger } from "./logger";

interface PendingMessage {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface WorkerResponse {
  id: number;
  type: string;
  payload?: any;
  error?: string;
  errorDetails?: unknown;
}

export class X2tConverter {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private messageId = 0;
  private pendingMessages = new Map<number, PendingMessage>();
  private resourceKey = "";
  private logger?: EditorLogger;

  private getWorkerStaticResource(): StaticResource {
    const staticResource = getStaticResource();
    if (typeof window === "undefined") {
      return staticResource;
    }

    const origin = window.location.origin;
    return {
      ...staticResource,
      version: { ...staticResource.version },
      onlyoffice: { ...staticResource.onlyoffice },
      x2t: {
        ...staticResource.x2t,
        root: resolveSiteUrl(origin, staticResource.x2t.root),
        script: resolveSiteUrl(origin, staticResource.x2t.script),
        wasm: resolveSiteUrl(origin, staticResource.x2t.wasm),
        pdfFonts: {
          root: resolveSiteUrl(origin, staticResource.x2t.pdfFonts.root),
          default: resolveSiteUrl(origin, staticResource.x2t.pdfFonts.default),
        },
      },
    };
  }

  /**
   * @description 生成递增的 worker 消息 ID。
   */
  private getNextId(): number {
    return ++this.messageId;
  }

  private logRaw(
    level: "log" | "error",
    message: string,
    consoleArgs: unknown[],
  ) {
    if (this.logger) {
      this.logger.raw(level, "worker", message, consoleArgs);
      return;
    }
    console[level](...consoleArgs);
  }

  /**
   * @description 向 worker 发送请求并等待对应响应。
   */
  private sendMessage<T>(type: string, payload?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not initialized"));
        return;
      }

      const id = this.getNextId();
      this.pendingMessages.set(id, { resolve, reject });

      /**
       * @description 转换请求携带 ArrayBuffer 时使用 Transferable，减少主线程复制开销。
       */
      if (type === "convert" && payload?.data instanceof ArrayBuffer) {
        this.worker.postMessage({ id, type, payload }, [payload.data]);
      } else {
        this.worker.postMessage({ id, type, payload });
      }
    });
  }

  /**
   * @description 处理 worker 返回的响应消息。
   */
  private handleWorkerMessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, type, payload, error, errorDetails } = event.data;

    if (type === "ready") {
      this.logRaw("log", "worker ready", ["[X2tConverter] Worker ready"]);
      return;
    }

    const pending = this.pendingMessages.get(id);
    if (!pending) return;

    this.pendingMessages.delete(id);

    if (type === "error") {
      const errorMessage = error || "Unknown worker error";
      const details =
        errorDetails && typeof errorDetails === "object"
          ? { message: errorMessage, ...errorDetails }
          : { message: errorMessage };
      if (this.logger) {
        this.logger.error("worker", "worker request failed", details);
      } else {
        console.error("[X2tConverter] Worker request failed:", details);
      }
      pending.reject(new Error(errorMessage));
    } else {
      pending.resolve(payload);
    }
  };

  /**
   * @description 处理 worker 运行错误，并让所有等待中的请求失败。
   */
  private handleWorkerError = (error: ErrorEvent) => {
    this.logRaw("error", "worker error", [
      "[X2tConverter] Worker error:",
      error,
    ]);

    for (const [id, pending] of this.pendingMessages) {
      pending.reject(new Error(`Worker error: ${error.message}`));
      this.pendingMessages.delete(id);
    }
  };

  /**
   * @description 初始化 x2t worker；重复调用会复用同一个初始化 Promise。
   */
  public init(logger?: EditorLogger): Promise<void> {
    if (logger) {
      this.logger = logger;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        /**
         * @description 使用 Next.js 可识别的 URL 语法创建 module worker。
         */
        // HOLMES PATCH: upstream points at the .ts source, which Next.js/Vite
        // rewrite at build time. esbuild does not, so this names the built
        // worker that scripts/build-office-shell.mjs emits beside shell.js.
        this.worker = new Worker(new URL("./x2t.worker.js", import.meta.url), {
          type: "module",
        });

        this.worker.onmessage = this.handleWorkerMessage;
        this.worker.onerror = this.handleWorkerError;

        this.logRaw("log", "worker created", ["[X2tConverter] Worker created"]);
        resolve();
      } catch (err) {
        this.initPromise = null;
        reject(err);
      }
    });

    return this.initPromise;
  }

  /**
   * @description 将文档从一种格式转换为另一种格式。
   */
  public async convert({
    data,
    fileFrom,
    fileTo,
    formatFrom,
    formatTo,
    media,
    pdfBin,
    fonts,
    fontAliases,
    fontExportAliases,
    themes,
    csvEncoding,
    csvDelimiter,
    csvDelimiterChar,
  }: X2tConvertParams, logger?: EditorLogger): Promise<X2tConvertResult> {
    if (logger) {
      this.logger = logger;
    }
    const staticResource = this.getWorkerStaticResource();
    const resourceKey = JSON.stringify(staticResource.x2t);
    if (this.worker && this.resourceKey && this.resourceKey !== resourceKey) {
      this.terminate(logger);
    }
    this.resourceKey = resourceKey;

    await this.init(logger);

    const cloneMap = (map?: { [key: string]: Uint8Array }) => {
      if (!map) return undefined;
      return Object.fromEntries(
        Object.entries(map).map(([key, value]) => [key, value.slice(0)])
      );
    };

    /**
     * @description 发送给 worker 前复制数据，避免转移原始调用方持有的 ArrayBuffer。
     */
    const dataClone = data.slice(0);

    const payload = {
      data: dataClone,
      fileFrom,
      fileTo,
      formatFrom,
      formatTo,
      media: cloneMap(media),
      pdfBin: pdfBin?.slice(0),
      fonts: cloneMap(fonts),
      fontAliases,
      fontExportAliases,
      themes: cloneMap(themes),
      csvEncoding,
      csvDelimiter,
      csvDelimiterChar,
      staticResource,
    };
    this.logger?.worker("convert", {
      fileFrom,
      fileTo,
      formatFrom,
      formatTo,
    });
    return this.sendMessage<X2tConvertResult>("convert", payload);
  }

  /**
   * @description 终止 worker 并释放关联资源。
   */
  public terminate(logger?: EditorLogger): void {
    if (logger) {
      this.logger = logger;
    }
    if (this.worker) {
      for (const [id, pending] of this.pendingMessages) {
        pending.reject(new Error("Worker terminated"));
        this.pendingMessages.delete(id);
      }

      this.worker.terminate();
      this.worker = null;
      this.initPromise = null;
      this.logRaw("log", "worker terminated", [
        "[X2tConverter] Worker terminated",
      ]);
    }
  }

  /**
   * @description 判断 worker 是否已经初始化。
   */
  public get isInitialized(): boolean {
    return this.worker !== null && this.initPromise !== null;
  }
}

/** @description 浏览器端 Office 格式转换器。 */
export const converter = new X2tConverter();
