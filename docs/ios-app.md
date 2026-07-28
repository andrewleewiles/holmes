# Holmes iOS app

Canonical reference for the Holmes mobile client. Read this before touching `src/main/remote*.ts`, `src/shared/remote.ts` or anything under `mobile/`.

## What it is

A Capacitor + React iOS client that is a **thin remote for a running Holmes desktop**. It holds no database, no provider key, and no derived context of its own. Every question it answers is answered by the Mac.

This is the Plex model, and it is deliberate. Holmes is local-first: SQLite in `~/Library/Application Support/holmes/`, provider keys in `electron-store`, no account, no cloud, no telemetry. A mobile client that synced a copy of the health record, the psychology analysis and the iMessage graph to a phone would undo that in one step. The phone borrows the desktop's answers; it never owns them.

## Transport: Tailscale

The desktop opens a WebSocket server. The phone reaches it over the user's tailnet.

Tailscale was chosen over LAN-only discovery because it removes the two things that make a LAN client miserable: the desktop's address stops changing, and "same Wi-Fi" stops being a precondition. The phone reaches the Mac from anywhere, over WireGuard, with no port forwarding and no relay operated by us. Holmes gains no cloud dependency — the tailnet is the user's own.

### Address the desktop by MagicDNS name, never by raw IP

Non-obvious and load-bearing. iOS App Transport Security blocks cleartext `ws://`. ATS exceptions are declared per **domain**, so a MagicDNS name is exemptable:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSExceptionDomains</key>
  <dict>
    <key>ts.net</key>
    <dict>
      <key>NSIncludesSubdomains</key><true/>
      <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
    </dict>
  </dict>
  <key>NSAllowsLocalNetworking</key><true/>
</dict>
```

An **IP address cannot be listed in `NSExceptionDomains`**. Pairing to `100.x.y.z` would therefore force `NSAllowsArbitraryLoads`, which disables ATS for the entire app and invites App Review rejection. So the pairing payload carries `<machine>.<tailnet>.ts.net` and the client rejects a bare IP host. `NSAllowsLocalNetworking` is kept only so a same-Wi-Fi `<host>.local` fallback works without a second exception.

### Why not `wss://` with a self-signed cert

WKWebView will not let JavaScript `WebSocket` connect to an untrusted certificate, and there is no JS-side trust override. It would take a native Swift plugin doing `URLSession` with a pinning delegate before a single byte moved. That is a lot of native surface for Phase 1.

`tailscale cert` / `tailscale serve` is the genuinely clean upgrade — it issues a real Let's Encrypt certificate for the MagicDNS name that iOS already trusts, making `wss://` work with no plugin and no ATS exception at all. It is not Phase 1 only because it requires the user to run a Tailscale command and keep HTTPS serving enabled. **When this is revisited, `tailscale serve` is the answer, not self-signed pinning.**

## Wire security: encrypted frames

Tailscale already encrypts the tunnel. Frames are encrypted *again*, underneath it, on purpose: the server binds a real port, and the day someone enables it on a LAN, disables their tailnet ACLs, or a hostile process sits on the same machine, the payloads are health records, message metadata and psychological test results. Defence in depth is cheap here and the failure is not recoverable.

- Pairing performs X25519 ECDH. The desktop shows a short pairing code; it authenticates the exchange and is single-use with a short expiry.
- HKDF-SHA256 derives per-direction keys from the shared secret, so client→server and server→client never share a key.
- Every frame after the handshake is AES-256-GCM with a monotonic nonce counter. A replayed or reordered frame fails the tag check and drops the connection.
- The device's long-term key is confined to `mobile/src/transport/secureStore.ts`. **It is currently backed by `@capacitor/preferences`, which is `UserDefaults` — readable from an unencrypted device backup.** Backing it with a Keychain plugin (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) is a prerequisite for shipping, and touches only that one file.
- The desktop stores paired devices with a name and last-seen time, and any one of them can be revoked from Settings. Revocation kills the live socket, not just future connections.

## Authorization: the channel allowlist is default-deny

`src/shared/remote.ts` names every channel a remote device may call. **Absent means denied.** A new IPC channel is not remotely callable until someone adds it deliberately.

This inverts the usual instinct and it is the single most important rule in this subsystem. The 220 channels include `fs:write`, `recall:open-file`, `library:apply-organize`, `settings:set-provider` and the file-access-scope editors. A blanket bridge would hand a paired phone — or anything that reached the port — arbitrary filesystem write access to the Mac and the ability to read the provider key. The allowlist is what stops "remote client" from becoming "remote shell".

Rules for the allowlist:
- **Never expose a channel that writes to the filesystem, changes the file access scope, reveals or sets provider credentials, or executes a sidecar.**
- Read-only browsing channels are fine. Chat is fine.
- When in doubt, leave it out and let the phone show "not available on mobile".

## Trust check

`assertTrustedSender` (`ipc.ts:181`) compares the sender frame's URL against the renderer's origin and throws for anything else. That is correct and stays. Remote calls do not fake an Electron event; they arrive as an authenticated `RemoteCaller` and are checked against the allowlist instead. Two callers, two checks, neither weakened to accommodate the other.

## Known constraint: one chat stream, shared

Chat holds a **single module-level `AbortController`** (`ipc.ts:158`) and broadcasts chunks to every window. Desktop and phone therefore share one stream rather than getting one each: the phone sees a reply the desktop asked for, and either end can abort the other's turn.

For Phase 1 this is mostly a feature — walk away from the Mac mid-answer and the phone picks it up. It is recorded here because it will surprise anyone who assumes per-client sessions, and because making streams per-caller means threading a stream id through `runChatWithTools`, the abort map and all 25 broadcast sites. Do that deliberately, not by accident.

## Scope

**Phase 1** — pairing, chat (list/create conversations, streaming replies, model and tier, context and role selection, attachments), and read-only Dashboard, Data, Timeline and People.

**Later** — HealthKit reads pushed from the phone, camera bloodwork capture, RingConn BLE via OpenCircuitKit. Each needs a custom Swift Capacitor plugin; none of them needs the transport to change.

## Layout

```
mobile/                       # pnpm workspace package
├── src/
│   ├── transport/            # WS client, crypto, pairing, ElectronAPI impl
│   ├── screens/              # Pair, Conversations, Chat, Dashboard, Data
│   └── components/
├── ios/                      # Capacitor iOS project (requires Xcode + CocoaPods)
├── capacitor.config.ts
└── vite.config.ts

src/shared/remote.ts          # protocol + allowlist, shared by both sides
src/main/remoteCrypto.ts      # X25519, HKDF, AES-GCM
src/main/remoteDevices.ts     # paired device store
src/main/remoteServer.ts      # WebSocket server, handshake, RPC dispatch
```

`mobile/` imports `src/shared/types.ts` directly. The mobile client implements the same `ElectronAPI` interface the preload does, so a desktop type change breaks the mobile build immediately instead of drifting.

## Toolchain

Building the iOS app needs **full Xcode** (not just Command Line Tools) and **CocoaPods**. `pnpm --filter mobile build` produces the web bundle without either; `npx cap add ios`, `npx cap sync` and running on a device do not.

```bash
xcode-select --install          # not sufficient on its own
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo gem install cocoapods
```

## First run

Quit Holmes before installing — `pnpm install` can rebuild `better-sqlite3`, and
rewriting that binary under the live app invalidates its signature and macOS
SIGKILLs it (AGENTS.md landmine #2).

```bash
pnpm install                    # picks up the new mobile/ workspace package
pnpm --filter holmes-mobile build
cd mobile && npx cap add ios && npx cap sync ios
```

Then add the ATS block above to `mobile/ios/App/App/Info.plist` — `cap add ios`
generates that file, and without the exception every `ws://` connection is
blocked before it leaves the phone.

To run the transport test, `better-sqlite3` must be built for Node rather than
Electron:

```bash
pnpm rebuild:node && pnpm test:remote
pnpm rebuild:electron           # before running the desktop app again
```
