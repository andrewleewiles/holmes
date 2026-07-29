import {
  OFFICE_XML_SIZE_LIMIT_ERROR_MESSAGE,
  type OfficeXmlSizeLimitExceededPayload,
} from "../editor/types";

const OVERLAY_ATTR = "data-onlyoffice-xml-size-limit-overlay";

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function removeOfficeXmlSizeLimitOverlay(container: HTMLElement) {
  container
    .querySelector<HTMLElement>(`[${OVERLAY_ATTR}="true"]`)
    ?.remove();
}

export function showOfficeXmlSizeLimitOverlay(
  container: HTMLElement,
  payload: OfficeXmlSizeLimitExceededPayload,
) {
  removeOfficeXmlSizeLimitOverlay(container);

  const computedPosition = window.getComputedStyle(container).position;
  if (computedPosition === "static") {
    container.style.position = "relative";
  }

  const overlay = document.createElement("div");
  overlay.setAttribute(OVERLAY_ATTR, "true");
  overlay.setAttribute("role", "alert");
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.zIndex = "1";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.padding = "24px";
  overlay.style.background = "#f8fafc";
  overlay.style.color = "#172033";
  overlay.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const panel = document.createElement("div");
  panel.style.width = "min(520px, 100%)";
  panel.style.border = "1px solid #d8dee8";
  panel.style.borderRadius = "8px";
  panel.style.background = "#ffffff";
  panel.style.boxShadow = "0 16px 42px rgba(15, 23, 42, 0.12)";
  panel.style.padding = "24px";

  const title = document.createElement("div");
  title.textContent =
    payload.errorDescription || OFFICE_XML_SIZE_LIMIT_ERROR_MESSAGE;
  title.style.fontSize = "18px";
  title.style.lineHeight = "26px";
  title.style.fontWeight = "650";
  title.style.marginBottom = "10px";

  const description = document.createElement("div");
  description.textContent =
    "Office 文件内 XML 解压后超过安全阈值，请压缩或拆分文档后重试。";
  description.style.fontSize = "14px";
  description.style.lineHeight = "22px";
  description.style.color = "#475569";
  description.style.marginBottom = "16px";

  const details = document.createElement("div");
  details.textContent = `XML 总大小 ${formatBytes(payload.xmlBytes)}，限制 ${formatBytes(payload.limitBytes)}，文件数 ${payload.entryCount}`;
  details.style.fontSize = "12px";
  details.style.lineHeight = "18px";
  details.style.color = "#64748b";
  details.style.wordBreak = "break-word";

  panel.append(title, description, details);
  overlay.append(panel);
  container.append(overlay);

  return () => {
    overlay.remove();
  };
}
