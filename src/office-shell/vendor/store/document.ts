import { getFileExt } from "../internal/editor/utils";

export type OnlyOfficeDocumentState = {
  isNew: boolean;
  fileName: string;
  fileType?: string;
  file?: File;
  url?: string;
  loader?: (url: string) => Promise<ArrayBuffer>;
};

export type SetOnlyOfficeDocumentStateInput = Omit<
  OnlyOfficeDocumentState,
  "isNew" | "fileName"
> & {
  isNew?: boolean;
  fileName: string;
};

const DEFAULT_DOCUMENT_SCOPE = "__default__";

function createDefaultDocumentState(): OnlyOfficeDocumentState {
  return {
    isNew: true,
    fileName: "New Document.docx",
    fileType: "docx",
  };
}

function normalizeDocumentState(
  state: SetOnlyOfficeDocumentStateInput,
): OnlyOfficeDocumentState {
  return {
    ...state,
    isNew: state.isNew ?? !state.file,
    fileType: state.fileType || getFileExt(state.fileName) || "docx",
  };
}

const documentStates = new Map<string, OnlyOfficeDocumentState>();

documentStates.set(DEFAULT_DOCUMENT_SCOPE, createDefaultDocumentState());

function getScopeId(scopeId?: string) {
  return scopeId || DEFAULT_DOCUMENT_SCOPE;
}

export function setDocumentObj(
  state: SetOnlyOfficeDocumentStateInput,
  scopeId?: string,
) {
  documentStates.set(getScopeId(scopeId), normalizeDocumentState(state));
}

export function getDocumentObj(scopeId?: string) {
  const key = getScopeId(scopeId);
  let state = documentStates.get(key);
  if (!state) {
    state = createDefaultDocumentState();
    documentStates.set(key, state);
  }
  return state;
}
export function clearDocumentObj(scopeId?: string) {
  if (scopeId) {
    documentStates.delete(scopeId);
    return;
  }

  documentStates.set(DEFAULT_DOCUMENT_SCOPE, createDefaultDocumentState());
}

export function setNewDocument(fileType = "docx", scopeId?: string) {
  setDocumentObj(
    {
      isNew: true,
      fileName: `New Document.${fileType}`,
      fileType,
    },
    scopeId,
  );
}

export function setDocumentFile(
  file: File,
  fileName = file.name,
  scopeId?: string,
) {
  setDocumentObj(
    {
      isNew: false,
      file,
      fileName,
      fileType: getFileExt(fileName) || getFileExt(file.name) || "docx",
    },
    scopeId,
  );
}

export function setDocumentUrl(
  url: string,
  {
    fileType,
    fileName,
    loader,
  }: {
    fileType?: string;
    fileName?: string;
    loader?: (url: string) => Promise<ArrayBuffer>;
  } = {},
  scopeId?: string,
) {
  const name = fileName || decodeURIComponent(url.split("/").pop() || "Document");

  setDocumentObj(
    {
      isNew: false,
      url,
      loader,
      fileName: name,
      fileType: fileType || getFileExt(name) || "docx",
    },
    scopeId,
  );
}

export function clearAllDocumentObjs() {
  documentStates.clear();
  documentStates.set(DEFAULT_DOCUMENT_SCOPE, createDefaultDocumentState());
}

export function getAllDocumentObjs() {
  return new Map(documentStates);
}
