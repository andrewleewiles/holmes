import { converter } from "../internal/editor/x2t";
import {
  ensureTitleWithExtension,
  getX2tExportFormats,
  normalizeX2tExportFileType,
} from "../internal/editor/utils";
import {
  type CreateEditorViewOptions,
  editorManagerFactory,
} from "../core/editor-manager";
import type { FileType } from "../const";
import type { EditorLogger } from "../internal/editor/logger";

export async function createEditorView(options: CreateEditorViewOptions) {
  const manager =
    options.editorManager ||
    (options.containerId
      ? editorManagerFactory.get(options.containerId)
      : editorManagerFactory.getDefault());

  return manager.create(options);
}

/** x2t 反向转换：Editor.bin → doc.{fileType}，供 exportAsBlob / 下载使用。 */
export async function convertBinToDocument(
  binData: Uint8Array,
  fileName: string,
  fileType: FileType | string,
  media?: Record<string, Uint8Array>,
  themes?: Record<string, Uint8Array>,
  logger?: EditorLogger,
) {
  const targetExt = normalizeX2tExportFileType(fileType);
  const data = new Uint8Array(binData).buffer;
  const { formatFrom, formatTo } = getX2tExportFormats(targetExt);
  const result = await converter.convert(
    {
      data,
      fileFrom: "Editor.bin",
      fileTo: `doc.${targetExt}`,
      formatFrom,
      formatTo,
      media,
      themes,
    },
    logger,
  );

  if (!result.output) {
    throw new Error("Failed to convert OnlyOffice bin document");
  }

  return {
    fileName: ensureTitleWithExtension(fileName, targetExt),
    data: result.output,
  };
}
