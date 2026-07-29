export const app = {
  getPath: () => process.env.HOLMES_USER_DATA || '/tmp/holmes-test',
  isPackaged: false,
  getAppPath: () => process.env.HOLMES_USER_DATA || '/tmp/holmes-test',
}

// The remote server registers channels through the same wrapper the renderer
// path uses, so the registry is exercised under test exactly as it ships.
export const ipcMain = {
  handle: () => {},
  removeHandler: () => {},
  on: () => {},
}

// No windows under test, so broadcast() reaches only the remote forwarder —
// which is the half test-remote.mjs is checking.
export const BrowserWindow = {
  getAllWindows: () => [],
  fromWebContents: () => null,
}

// The bulk-media resolver reads `audiobookRoot()` out of audioProtocol, which
// imports these. Named ESM imports are resolved at link time, so a missing
// export is a load failure rather than a runtime one — they have to exist even
// though no test registers a scheme.
export const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: () => {},
}

export const net = {
  fetch: async () => new Response(null, { status: 404 }),
}

// Always reports an empty image so photoContext falls through to its sips path,
// which is what actually runs under test on macOS.
export const nativeImage = {
  createFromPath: () => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    resize: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toJPEG: () => Buffer.alloc(0) }),
    toJPEG: () => Buffer.alloc(0),
  }),
}
