# Holmes iOS app

Canonical reference for the Holmes mobile client. Read this before touching `src/main/remote*.ts`, `src/shared/remote.ts` or anything under `mobile/`.

## What it is

A Capacitor + React iOS client that is a **thin remote for a running Holmes desktop**. It holds no database, no provider key, and no derived context of its own. Every question it answers is answered by the Mac.

A device is paired into one of two scopes. `owner` is the user's own phone and reaches everything the desktop chooses to expose; `media` is a guest — someone the user shares the Library with — and reaches the shelf and the reader, nothing else. See "Authorization" below; this is the property the rest of the design serves.

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

- **Pairing is a three-step exchange (protocol v2), and the shape matters.** The client sends only an ephemeral public key; the Mac replies with its static public key plus `tag = HMAC(pairingCode, label || serverStaticPub || clientEphemeralPub)`; the client recomputes that tag from the code the user typed and **aborts if it does not match**. Only then does it seal `{code, clientStaticPub, deviceName}` to the verified key, and the Mac's reply is sealed back.
- Why it is built this way: in v1 the code and `serverStaticPub` both crossed in cleartext, because frame encryption only begins *after* pairing. Anything on the path could read the code and pair itself with full access, or substitute its own static key and sit in the middle of every later session forever. WireGuard was the only thing hiding that, which made pairing the one part of the design that could not survive an untrusted relay.
- The code is never transmitted — only an HMAC under it. Recovering it from a captured tag means an offline brute force of 40 bits, which buys nothing: by the time it finishes the offer is closed and the code is dead. It has to be brute-forced *within* the live round trip to be useful, which it cannot be.
- The bind tag is what makes the key trustworthy, so **a client that skips the tag check has no security at all**. `test-remote.mjs` asserts both halves: a substituted key fails the tag, and a client that ignores the tag still cannot pair because the Mac cannot open a frame sealed to someone else's key.
- HKDF-SHA256 derives per-direction keys from the shared secret, so client→server and server→client never share a key.
- Every frame after the handshake is AES-256-GCM with a monotonic nonce counter. A replayed or reordered frame fails the tag check and drops the connection.
- The device's long-term key is confined to `mobile/src/transport/secureStore.ts`. **It is currently backed by `@capacitor/preferences`, which is `UserDefaults` — readable from an unencrypted device backup.** Backing it with a Keychain plugin (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) is a prerequisite for shipping, and touches only that one file.
- The desktop stores paired devices with a name, a scope and a last-seen time, and any one of them can be revoked from Settings. Revocation kills the live socket, not just future connections.

## Authorization: the channel allowlist is default-deny, and it is per-device

`src/shared/remote.ts` names every channel a remote device may call. **Absent means denied.** A new IPC channel is not remotely callable until someone adds it deliberately.

This inverts the usual instinct and it is the single most important rule in this subsystem. The 220 channels include `fs:write`, `recall:open-file`, `library:apply-organize`, `settings:set-provider` and the file-access-scope editors. A blanket bridge would hand a paired phone — or anything that reached the port — arbitrary filesystem write access to the Mac and the ability to read the provider key. The allowlist is what stops "remote client" from becoming "remote shell".

### Two scopes, because Holmes is becoming a media server

The transport was designed for exactly one trusted device: the owner's own phone. It is not any more — the Library (e-books, audiobooks, later ROMs) is something other **people** connect to, and the same database holds health records, psychological test results, iMessage metadata, Memory, People and a life timeline.

So `RemoteDevice.scope` is `'owner' | 'media'`, fixed at pairing time and stored on the `remote_devices` row:

- **`MEDIA_CALLABLE_CHANNELS`** — the shelf and the reader, read-only: `library:get-state`, `library:list-books`, `library:get-book`, `library:get-chapter`, `library:get-resource`, `library:list-audiobooks`, `library:get-audiobook`. That is the whole set.
- **`OWNER_CALLABLE_CHANNELS`** — everything the single-device design allowed, plus the media set as a subset.

`isRemoteCallable(channel, scope)` takes the scope as a **required** argument. An optional one would default to the widest set, which is the exact failure the split exists to prevent.

A `media` device cannot name conversations, chat, memory, health, activity, documents, timeline, people, recall, context versions, roles, call history, provider credit, projects, models, or `remote:client-settings` — the last because the owner's welcome lines, assistant name and model tiers are theirs. It also cannot reach the reading-record writers (`set-reading-state`, `set-progress`, `record-session`): a guest's reading would be filed as the owner's, and the reading record reaches the life timeline. Nor any `generate`/`estimate`/`scan`/`refresh` channel, which spend the owner's provider credit.

### A guest's reading position is their own

`book_reading_state` is keyed by `book_id` alone — one row per book, and it is the
owner's: it carries their rating and notes and feeds the reading-record snapshot
onto the life timeline. A guest cannot write to it, and for a while that meant a
shared book restarted from page one every session.

`remote_device_reading_state` (keyed `device_id, book_id`) holds a guest's place
instead. It is deliberately a smaller thing: position, progress, status and
timestamps, with no rating and no notes, because the channels that set those are
not media-callable. Revoking a device cascades its reading history away with it.

`library:set-progress` is media-callable **only** because the handler branches on
`event.remote?.scope`: a guest's write lands on their own row and never on the
owner's. That branch is the entire justification for the channel being in the
media set — if it is ever removed, the channel must leave the set in the same
change.

**Events are scoped too.** Broadcasts fan out to every connected device, so `forwardToDevices` re-checks `isRemoteEvent(channel, session.scope)` per session — otherwise a guest reading a book would receive the owner's chat stream as it is generated. `MEDIA_EVENT_CHANNELS` is `library:state` alone. `broadcast()` in `remoteBridge.ts` filters on the owner set because it is the superset; the narrowing happens in the forwarder.

### The allowlist is not enough: the payloads are redacted too

A channel being safe to *call* does not make its return value safe to *read*. The Library types were designed for one reader, so `LibraryBook` carries `BookReadingState` — the owner's `rating`, `notes`, `status`, `startedAt`, `finishedAt`, `secondsRead` and `progressPercent` — and `Book` carries the absolute `filePath` and `sourcePath` on the Mac plus `identityHash` and `textHash`. Handing a stranger the shelf handed them all of that.

So `src/shared/books.ts` holds the narrowing as pure functions — `redactBookForGuest`, `guestReadingState`, `redactLibraryBookForGuest`, `redactAudiobookForGuest` — and the Library handlers apply them **only when `event.remote?.scope === 'media'`**. A renderer call has no `remote` at all and an `owner` device is not a guest, so both keep their current unredacted behaviour; the desktop UI is untouched.

What a guest sees of a book: `title`, `subtitle`, `authors`, `publisher`, `publishedDate`, `language`, `identifier`, `subjects`, `description`, `format`, `fileSize`, `coverDataUrl`, `chapterCount`, `wordCount`, `status`, `scanError`, `missingSince`, `addedAt`, `updatedAt`, and the full chapter list from `library:get-book`. What is blanked: `filePath`, `sourcePath`, `relativePath`, `identityHash`, `textHash`.

The reading record is replaced wholesale rather than filtered. **A guest gets no progress at all.** There is one reading row per book and it is the owner's; "73% read, finished 3 March" is a statement about the owner's month, and the reading record feeds the life timeline. Per-guest reading state does not exist and was not invented for this — a guest's reader simply opens at the beginning, which is the right behaviour for a copy they have never read. `lessonCount` and `annotationCount` are zeroed for the same reason: the channels that would fetch them are denied, and the number alone still reports how much attention the owner gave that book.

`library:get-chapter` and `library:get-resource` return derived content with no owner fields, so they are unchanged. `library:list-audiobooks` and `library:get-audiobook` drop `textHash` and replace the provider `error`, which quotes the owner's plan and quota back at them.

Rules for the allowlist:
- **Never expose a channel that writes to the filesystem, changes the file access scope, reveals or sets provider credentials, or executes a sidecar** — in either scope.
- Read-only browsing channels are fine for the owner. Chat is fine for the owner.
- For the media scope the bar is higher: a channel belongs there only if handing it to a stranger is uninteresting.
- When in doubt, leave it out and let the phone show "not available on mobile".

### Pairing chooses the scope

The pairing offer carries it (`RemotePairingOffer.scope`), the `paired` frame reports it back so the client knows what it holds, and `createRemoteDevice` records it. The scope never comes from anything the pairing device sends — the device asking to be paired does not get to say what it may reach. Settings' Remote access panel picks **Full access** or **Media only** before the code is generated, defaults to the narrower one, and labels every paired device in the list.

Devices paired before scopes existed migrate to `'owner'`: they were the user's own phone and keep what they had. New guests must be paired as `media` deliberately.

## Bulk media: a second path on the same port

The sealed WebSocket carries JSON frames capped at `REMOTE_MAX_FRAME_BYTES` (8 MiB), with the payload base64'd inside them. That is right for RPC and wrong for bytes: ~33% overhead, buffered whole on both ends, and no way to ask for the middle of a file. A 400 MB audiobook — later a ROM — needs a different shape.

So the remote port answers plain HTTP for one path prefix, `/holmes/media/<kind>/<id>`, and 426 for everything else. `wsServer.ts` gained an `onRequest` hook that claims a request or declines it; the upgrade path is exactly as narrow as it was.

### It addresses resources, never locations

**This is the single most important property.** The URL carries an opaque id — a book id or an audiobook segment id — and that id is used only as a database lookup key. There is no root directory that a client-supplied fragment is appended to, so there is nothing to escape from: `../../../health.db` is a lookup that finds no row. `parseRemoteMediaPathname` additionally refuses any id containing a slash, so a client cannot even describe a location.

Resolving a row to a path is not the end of it. A book row **outlives** the source it was scanned from, so `resolveBook` re-checks four things every request: the row is `ready` and not missing, its project is actually a Library, the file still sits under one of that project's currently connected source roots (realpath'd, `path.sep`-bounded), and `assertPathAllowed` still permits it. Disconnect the folder or narrow the file access scope and every outstanding URL for it starts returning 404. Audiobook segments are Holmes' own output, so they are checked against `audiobookRoot()` instead, plus the book still being on the shelf.

Book resources (chapter images) are deliberately **not** served here. They live inside the epub zip rather than on disk, they are already bounded and downscaled, and serving them would mean holding them in memory — which is the thing this endpoint exists to avoid. They stay on the RPC path as data URLs.

### Every request authenticates itself

The socket session proves device identity. An HTTP connection proves nothing, and a device id is not a credential — anything that ever logged one could replay it.

So `library:get-media-url`, callable only over an authenticated session, mints a URL carrying an HMAC-SHA256 token over a canonical payload of `version | kind | id | deviceId | scope | expiry`, domain-separated with `holmes-media-token-v1`. On the way back in the server verifies the signature **first**, in constant time, and only then reads the payload — nothing the client wrote is acted on before it is proved to be ours. Then:

- **expiry** — one hour, long enough to play a chapter through, short enough that a URL out of a screen recording is dead.
- **resource binding** — the payload's `kind` and `id` must equal the ones in the path. Without this a signature would only prove "some valid token exists", and any token would fetch any file.
- **device binding** — the device row is re-read from the database on every request, so revoking a device kills its outstanding URLs rather than leaving them live until expiry.
- **scope binding** — the token's scope must equal the device's current scope, and the kind must be allowed for that scope. The kind sets are default-deny per scope in the same shape as the channel allowlist.

The signing key is 32 random bytes generated when remote access starts and dropped when it stops. Nothing is persisted: there is no key at rest to steal, and turning the switch off invalidates every URL that was ever handed out. There is no cookie.

Every failure answers the same `403 Not authorized`. A caller that can tell "bad signature" from "expired" from "revoked" has an oracle.

### It is HTTP, properly

`Accept-Ranges: bytes`, `ETag` and `Last-Modified` from the file's own stat, `If-None-Match` → 304, `If-Range` falling back to the full entity when the validator has moved on, single ranges answered `206` with `Content-Range` and a correct `Content-Length`, an unsatisfiable range answered `416` with `bytes */<size>`, and `HEAD` returning the headers with no body. Multi-range and unknown range units are ignored and the whole entity sent, which RFC 7233 allows. The body is `fs.createReadStream(path, { start, end })` piped to the response — **never read into memory**, so a seek reads only the bytes it asked for.

### It requires a direct connection, and always will

`docs/relay.md` section 6 does the arithmetic: one hour of audiobook forwarded through the relay keeps a Durable Object awake for an hour, and at ten thousand users the media bill is roughly twice the chat bill. **Bulk media does not go over the relay.** That is a product rule, not a config value.

The mechanism is that a minted URL is **absolute** against the Mac's own direct host and port, resolved by `detectHost()`. A client connected over a relay cannot reach it, so there is no code path in which media is proxied — the rule cannot be forgotten because there is nothing to remember. `RemoteMediaTicket.directOnly` says so to the client, which is what the UI should use to explain "connect to the same network as your Mac" rather than showing a failure.

### What this path does not give you, stated plainly

The WebSocket carries a second layer of AES-256-GCM *underneath* the transport, on the reasoning in "Wire security" above. **The bulk path does not.** Bytes are protected by the tailnet's WireGuard tunnel and nothing else, and the token rides in the URL query in the clear. An observer positioned on the path — the same LAN with the server bound outside a tailnet, a hostile process on the machine — can read a book's bytes and can replay a captured token until it expires. That is why the TTL is an hour rather than a day, why the token is bound to one resource, and why revoking a device kills it immediately.

This is an accepted trade for now: the payloads here are Library media, not the health record, and sealing a 400 MB stream frame by frame would undo the reason for having this path at all. The clean fix is the same one named in "Why not `wss://`" — `tailscale serve` issues a real certificate for the MagicDNS name, and the media endpoint becomes `https://` with no plugin and no ATS exception. Do that before this path ever carries anything that is not media.

There is also **no rate limiting** on the endpoint. Forging a token is a 256-bit HMAC problem, and ids cannot be enumerated usefully because a token is bound to one of them, so the exposure is bandwidth rather than data.

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
src/shared/remoteMedia.ts     # bulk-media contract: kinds, token payload, Range parsing (pure)
src/shared/books.ts           # Library types + the guest redaction helpers (pure)
src/main/remoteCrypto.ts      # X25519, HKDF, AES-GCM
src/main/remoteDevices.ts     # paired device store
src/main/remoteServer.ts      # WebSocket server, handshake, RPC dispatch
src/main/remoteMedia.ts       # HMAC tokens, id -> path resolution, HTTP range serving
src/main/wsServer.ts          # the socket, plus the onRequest hook bulk media hangs off
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
