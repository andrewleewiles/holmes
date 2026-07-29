# Holmes relay

How a phone reaches a Mac that is behind NAT, without the user installing a VPN.

Read `docs/ios-app.md` first — this document assumes the pairing handshake, the
sealed-frame protocol and the default-deny channel allowlist described there.
The prototype relay lives in `relay/`.

## What this is

Today remote access requires both devices on a Tailscale tailnet. That is a good
transport and it stays. It is also a hard prerequisite that most people will not
clear: install a second app, make an account with a third party, understand what
a tailnet is.

The relay removes that prerequisite. The Mac holds one outbound WebSocket to a
rendezvous point; the phone connects to the same rendezvous point and the two
sockets are joined. Bytes are forwarded verbatim. The relay is **untrusted
infrastructure**: every Holmes frame crossing it is already AES-256-GCM sealed
under a key established at pairing, and the relay has no way to obtain that key.

This is the Plex model, one layer down: direct first, relay as fallback.

## What this is not

- Not a sync service. Nothing is stored. The relay holds no database, no queue,
  and no message history.
- Not an account system. There is no sign-up, no email, no password, no
  per-user record. See "The identifier".
- Not a privacy shield. The relay sees a great deal of metadata and this
  document says exactly what.
- Not on by default. It is a switch in Settings that ships **off**.

---

## 1. Threat model

Assume the relay operator is hostile, compelled, or breached. Assume the relay
logs everything it can see and keeps it forever.

### What the relay cannot do

- **Read any Holmes frame.** Frames are AES-256-GCM sealed with keys derived
  from an X25519 exchange that mixes both static keys and both ephemeral keys
  (`src/main/remoteCrypto.ts`, `deriveSessionKeys`). The relay holds none of
  them.
- **Forge a frame.** Anything it injects fails the GCM tag and the connection
  drops (`remoteServer.ts` → `fail(connection, 'bad-frame', ...)`).
- **Replay a frame.** The nonce counter is strictly increasing on both ends; a
  repeat is a fatal protocol error, not a re-execution.
- **Impersonate the Mac to a paired phone.** The Mac's static public key is
  pinned at pairing and never renegotiated. Substituting a key yields different
  session keys and the first sealed frame fails to open.
- **Learn which IPC channels are being called, conversation titles, filenames,
  health values, message text, or the provider key.** All of it is inside the
  sealed payload.

### What the relay can do

State this plainly. It is not nothing.

- **See both public IP addresses** — the Mac's and the phone's — and therefore
  approximate location, ISP, and whether the two are on the same network. Over
  time this is a movement log: home, work, travelling, abroad.
- **See a stable pseudonymous identifier** (the relay id) that links every
  session of one household forever, and the phone's identity is correlated to it
  by construction.
- **Know when the Mac is online.** The Mac holds a persistent socket, so
  connect/disconnect is a proxy for "the machine is awake", which is a proxy for
  the user's working hours, sleep schedule and holidays.
- **Know when the phone is in use, for how long, and how much was said.** Frame
  sizes are ciphertext lengths and AES-GCM does not pad. A 400-byte frame is a
  typed question; a 700 KB frame is a photo attachment; a rapid burst of small
  frames is a streaming answer, and its length estimates the answer's length.
- **Deny service.** Drop the socket, refuse the slot, black-hole the identifier.
  This is detectable but not preventable.
- **Truncate or reorder.** Detected — the connection dies — but that is still a
  denial.
- **Keep all of the above.** Traffic analysis works retrospectively.

### Explicitly not implemented

No padding, no cover traffic, no timing jitter, no onion routing. Each would cost
battery and latency for a threat model most Holmes users do not have. If you need
to hide *that* you use Holmes from a network observer, use the tailnet.

### The trust boundary this does move

Today the tailnet is the user's own infrastructure. A relay is somebody else's,
and that is a real change in the product's story. Section 9 deals with it
honestly rather than burying it.

---

## 2. Rendezvous: the identifier

The Mac holds an outbound socket keyed by a **relay id**. Requirements: it must
be unguessable, it must not leak who the user is, and establishing it must not
require an account.

### Scheme

```
relayKey  = Ed25519 keypair, generated once on the Mac, stored in electron-store
relayId   = base32( SHA-256( relayPublicKey )[0..16] )      # 128 bits, 26 chars
```

Three properties fall out of deriving the identifier from the key rather than
assigning it:

1. **No registration.** The Mac does not ask the relay for an identifier; it
   computes one. The relay has no allocation table to keep, so there is nothing
   to sign up for and nothing to leak.
2. **Ownership is checkable with no state.** The relay recomputes
   `base32(sha256(pub)[0..16])` from the key the Mac presents and compares it to
   the identifier in the URL. If they match and the signature verifies, the Mac
   owns the slot. The relay stores nothing between connections.
3. **No identity in it.** It is a hash of a random key. It contains no hostname,
   no username, no email, no device model. It is pseudonymous and stable — which
   is a real linkability cost, acknowledged in section 1.

128 bits makes enumeration meaningless: an attacker scanning identifiers to find
occupied slots is doing 2^128 work for the reward of "something is listening
here", and gets refused (close 4004) at every unoccupied one.

### How the phone learns it

The relay id, the direct address, the Mac's static public key and the pairing
code all travel together in the **pairing offer**, delivered out of band as a QR
code on the Mac's screen:

```
holmes://pair?v=1
  &code=<8 chars>
  &spk=<base64url X25519 static public key>
  &host=<magicdns-or-local-name>&port=<port>
  &rid=<26-char relay id>
  &rurl=<wss://relay.example>
```

The QR is what makes the whole thing safe — see section 4. `RemotePairingOffer`
in `src/shared/remote.ts` already carries `serverStaticPub`; it simply is not
delivered to the phone today, because the user types host, port and code by hand.

### Rotation

"Reset relay identity" in Settings generates a new keypair. Every paired phone
loses the relay path until it either reconnects directly once (over which the Mac
can push the new id inside the sealed channel) or is re-paired. The Settings
copy must say this before the button does anything.

---

## 3. How the Mac authenticates to the relay

Signature over a relay-issued challenge. Full exchange (implemented in
`relay/src/slot.ts`):

```
Mac  -> relay :  WebSocket upgrade  wss://relay/s/<relayId>
relay -> Mac  :  {"t":"challenge","nonce":"<32 random bytes, b64url>","ts":<epoch ms>}
Mac  -> relay :  {"t":"auth","pub":"<b64url ed25519 pub>","sig":"<b64url>"}
                 sig = Ed25519( "holmes-relay-auth-v1|<relayId>|<nonce>|<ts>" )
relay -> Mac  :  {"t":"ready"}
```

The relay checks, in order: the identifier is well-formed; the challenge is under
120 s old; the key is 32 bytes and the signature 64; `base32(sha256(pub)[0..16])`
equals the identifier in the URL; the signature verifies.

Why this shape:

- **Challenge-response, not a bearer token.** A token in a header is replayable
  by anything that logged it, including the relay's own infrastructure. A
  signature over a relay-chosen nonce is not.
- **The context string is in the signed bytes.** Without
  `holmes-relay-auth-v1|<relayId>|` a signature obtained in one context could be
  presented in another. Same reasoning as `TRANSCRIPT_LABEL` in `remoteCrypto.ts`.
- **Ed25519, not the existing X25519 key.** X25519 is for key agreement; reusing
  a key across primitives is the kind of shortcut that ages badly. Node's
  `crypto` and Workers' WebCrypto both do Ed25519 natively, so this adds no
  dependency on either side.

Clients (phones) do **not** authenticate to the relay. They cannot usefully be
authenticated without the relay holding per-user state, and they do not need to
be: knowing the relay id gets you a socket to the Mac and nothing else, because
the Mac's own handshake refuses anything that is not a paired device
(`unknown-device`). A leaked relay id is a nuisance — probing and DoS — not a
compromise. The concurrency cap and the rate limits in section 6 are what bound
the nuisance.

---

## 4. The pairing hole the relay opens, and how it closes

**This is the most important section in this document. The relay must not ship
until this is fixed.**

Pairing today is cleartext:

```
phone -> Mac : {"t":"pair","code":"ABCD1234","clientStaticPub":"..."}
Mac -> phone : {"t":"paired","deviceId":"...","serverStaticPub":"..."}
```

The pairing code authenticates the *phone* to the Mac. Nothing authenticates the
*Mac* to the phone, and the code crosses the wire in the clear. On a tailnet both
are covered by WireGuard. Over an untrusted relay, neither is. Two attacks
follow, and both are practical for the relay operator:

1. **Key substitution.** The relay forwards the phone's `pair` frame but replaces
   `serverStaticPub` in the reply with its own. The phone pins the wrong key. The
   relay now holds one session with the phone and one with the Mac and reads
   everything.
2. **Code theft.** The relay reads the pairing code out of the cleartext frame
   and registers *itself* as a device. It then has a legitimately paired session
   with full allowlist access — health records, timeline, people, chat.

Two changes close both. Neither touches the session KDF.

### 4a. Pin the Mac's static key before the socket opens

The QR carries `serverStaticPub`. The phone stores it *before* connecting and
rejects any `paired` frame whose `serverStaticPub` differs. Key substitution now
requires forging a value the phone already has from a channel the relay is not
on — a camera pointed at a screen.

### 4b. Seal the pair frame to that key

With `serverStaticPub` known in advance, the phone can encrypt the `pair` frame
to it: ephemeral X25519 → static X25519, HKDF, AES-256-GCM, exactly the
primitives already in `remoteCrypto.ts`. The relay sees `{"t":"pair-sealed",
"epk":"...","d":"..."}` and never sees the code.

Add to `src/shared/remote.ts` a `RemotePairSealedFrame`, and to
`remoteCrypto.ts` a `sealToStatic` / `openFromStatic` pair. The existing cleartext
`pair` frame stays valid on the direct path for one release, then goes.

### The shortcut, if 4a/4b slip

**Pair over a direct connection only; relay carries sessions, not pairings.** The
user must be on the same Wi-Fi (or tailnet) exactly once, ever. Plex does this.
It is a genuinely acceptable v1 and it eliminates both attacks without any
protocol change — the relay only ever sees frames sealed under keys agreed while
it was not on the path.

Ship the shortcut if the QR work is not ready. Do not ship relay pairing without
4a and 4b.

---

## 5. Connection preference and failover

Direct first, relay as fallback, decided by the phone.

`PairedIdentity` grows a list of addresses instead of one `{host, port}`:

```ts
type RemoteAddress =
  | { kind: 'direct'; host: string; port: number }   // MagicDNS or .local
  | { kind: 'relay';  url: string; relayId: string } // wss://
```

### The race

```
t = 0 ms      open every direct candidate
t = 600 ms    if no direct socket has finished the Holmes handshake, open the relay too
t = 2500 ms   abandon direct sockets that have not finished the handshake
winner        the first socket to reach hello-ok and derive session keys
losers        closed immediately
```

**The finish line is the derived session key, not the TCP connect and not the
WebSocket open.** A hotel captive portal will accept a TCP connection and
sometimes complete an HTTP upgrade; only a completed X25519 handshake against the
pinned static key proves the thing on the other end is the Mac.

600 ms is chosen so that a phone on the home Wi-Fi essentially never opens a
relay socket (a `.local` handshake on a LAN is 20–80 ms), while a phone on
cellular has already started the fallback before the user notices. Worst case —
direct DNS resolves but the host is unreachable — the user is connected via relay
in roughly 1–1.5 s.

### Upgrading back to direct

While connected over the relay, re-probe direct every 60 s when the app is in
the foreground, and immediately on a foreground or network-change event (walking
in the front door is the case that matters). On a successful direct handshake,
migrate.

**Migrate only when idle.** Sessions are per-socket: each connection performs its
own ephemeral exchange, and there is no session resumption. Switching mid-stream
would abort the chat turn. Wait for no in-flight request and no active stream.

### Cost of relay-only connectivity

Latency: one extra hop to a Cloudflare edge, typically 20–60 ms round trip added.
Chat streaming is not latency-sensitive at that scale. Bulk transfer is — see
section 6 on media.

---

## 6. Abuse, limits and cost

### Limits (all enforced in `relay/src/slot.ts`)

| Limit | Value | Why |
|---|---|---|
| Max WebSocket message | 1 MiB | Cloudflare platform cap, not a policy choice |
| Concurrent client sockets per slot | 4 | A household has a phone, maybe an iPad, maybe a spare |
| Concurrent server sockets per slot | 1 | Last valid claimant wins; the older is closed 4001 |
| Auth window | 120 s | Bounds the nonce's validity |
| Unauthenticated server socket lifetime | ~130 s | Reaped by the sweep |
| Client idle timeout | 5 min | The phone reconnects on next use |
| Throughput budget per live object | 256 MiB | Best-effort runaway catch |
| Sweep interval | 60 s | Durable Object alarm |

Two more belong in front of the Worker rather than inside it, as Cloudflare rules:
**connections per IP** (60/min is generous for a phone that reconnects on every
network change) and **connections per relay id** (10/min).

Keepalives use `setWebSocketAutoResponse('ping' → 'pong')`, so a heartbeat is
answered by the runtime without waking the Durable Object. That single line is
the difference between "billed continuously" and "billed while talking".

### The 1 MiB problem

`REMOTE_MAX_FRAME_BYTES` is **8 MiB**. Cloudflare caps a WebSocket message at
**1 MiB**. Sealed frames are JSON with a base64 payload, so 1 MiB on the wire is
about 780 KB of plaintext. A chat attachment will exceed that.

Options, in order of preference:

1. **v1: cap and explain.** Add `REMOTE_RELAY_MAX_FRAME_BYTES = 900_000`. On the
   relay path, refuse an over-large frame locally with a clear message
   ("Attachments over ~700 KB need your Mac on the same network") rather than
   letting the relay close the socket with 4009 and the app show a generic
   disconnect.
2. **v2: chunk.** A length-prefixed fragment layer under the sealed frame, in
   `remoteServer.ts` and `mobile/src/transport/client.ts`. Straightforward, but it
   is new protocol surface and should not be rushed into v1.

Do not silently downscale attachments to fit. A photo the user attached and a
photo the app shrank are different photos, and the model's answer depends on it.

### Cost

Cloudflare Workers Paid is $5/mo and includes 10M Worker requests, 1M Durable
Object requests and 400,000 GB-s of Durable Object duration. WebSocket messages
bill at 20 messages per DO request. Egress is free. Durable Objects declared with
`new_sqlite_classes` are eligible for the **free** plan, which is what
`wrangler.toml` does.

Assume a user profile of: Mac connected 24/7 (hibernated, so ~free while idle),
phone active 30 min/day, ~3,000 messages/day.

| Scale | DO duration | DO requests | Monthly cost |
|---|---|---|---|
| 1 user | ~6,750 GB-s | ~4.5k | **$0** on free, $5 on paid — all within the base |
| 100 users | ~675,000 GB-s (275k over) | ~450k | **~$8–9** total, i.e. ~$3.50 over the $5 base |
| 10,000 users | ~67.5M GB-s (67.1M over) | ~45M | **~$850–900**, ~$0.09/user/month |

At 10k users the bill is ~95% Durable Object *duration*. Requests, CPU and
bandwidth are rounding errors.

**Media changes this completely.** Holmes is heading towards audiobooks and ROM
emulation. One hour of audiobook streamed through the relay keeps the object
awake for an hour: 0.125 GB × 3,600 s = 450 GB-s. Ten thousand users listening an
hour a day is ~135M GB-s, about **$1,700/mo on top** — the media bill exceeds the
chat bill by 2×. Conclusion, and it should be a product rule, not a config value:
**bulk media does not go over the relay by default.** Audiobook and e-book
streaming require a direct connection, and the UI says so. Chat, browsing and
control are what the relay is for.

### At the free-tier boundary

When the account's quota or credit is exhausted, Cloudflare stops serving. The
Mac's relay socket closes and does not reopen. Required behaviour:

- The desktop shows "Relay unavailable" in Settings, not a silent failure.
- Direct access keeps working — the relay is strictly additive.
- The phone falls back to direct-only and, if that fails, reports "Your Mac isn't
  reachable" rather than "not paired".
- The relay URL is user-editable. The Worker is ~250 lines and deploys in one
  command, so any user who does not want to depend on the project's instance can
  run their own. This is the escape hatch that keeps the self-hosted story true.

---

## 7. Failure modes and their UX

| Failure | What happens | What the user should see |
|---|---|---|
| **Relay down / unreachable** | The relay socket never opens or closes with a transport error | Settings: "Relay unavailable — direct connections still work". Phone: falls back silently to direct; if that also fails, "Can't reach your Mac". Never "pair again" |
| **Mac offline or asleep** | The phone's client socket is closed with **4004** immediately | "Your Mac is offline. Holmes needs to be running and awake." Offer "Wake on LAN?" only if it is actually implemented; otherwise say nothing |
| **Two Macs, same relay id** (restored backup, cloned profile) | Second valid signature wins; the first is closed with **4001** | Desktop of the loser: "Another copy of Holmes is using this relay identity." **Do not auto-reconnect on 4001** — two machines would fight forever. Offer "Reset relay identity" |
| **Two phones at once** | Both attach; up to 4 client sockets per slot | Works. Note the known constraint in `docs/ios-app.md`: chat holds a single global `AbortController`, so both phones share one stream. That is unchanged by the relay |
| **Stale relay id** (relay turned off, identity reset) | Every attempt closes 4004 forever | After three consecutive 4004s *and* a failed direct attempt: "Remote access may be turned off on your Mac." Only the Mac's own `unknown-device` means "pair again" |
| **Slot busy** (4008) | More than 4 client sockets | "Too many devices are connected." Back off 30 s |
| **Frame too large** (4009) | An 8 MiB attachment hit the 1 MiB cap | Caught locally before sending (see 6). If it ever reaches 4009, that is a bug |
| **Idle disconnect** (4010) | Phone backgrounded 5 min | Invisible: reconnect on the next request. Do not show a disconnect banner for a backgrounded app |
| **Relay quota exhausted** (4029) | Throughput budget hit | "Too much data for the relay — connect to the same network as your Mac." This is the audiobook case |
| **Auth failure** (4003) | Key/id mismatch or bad signature | Desktop only. "Could not claim the relay identity." Retry once with backoff, then stop and log — a retry loop against a signature failure is pure cost |

Reconnection discipline on the desktop: exponential backoff from 1 s to 5 min,
with jitter. Ten thousand Macs reconnecting in lockstep after a relay deploy is a
self-inflicted DDoS.

---

## 8. Exactly what changes in the existing code

Nothing in this section has been done. No file under `src/` or `mobile/src/` has
been touched by this work.

### `src/shared/remote.ts`

- `REMOTE_RELAY_PROTOCOL_VERSION = 1`, `REMOTE_RELAY_MAX_FRAME_BYTES = 900_000`,
  `REMOTE_RELAY_SERVER_PATH = '/s/'`, `REMOTE_RELAY_CLIENT_PATH = '/c/'`, and the
  default relay URL.
- `export type RemoteAddress = { kind: 'direct'; host; port } | { kind: 'relay'; url; relayId }`.
- `RemotePairingOffer` gains `relayId: string | null` and `relayUrl: string | null`.
  It already carries `serverStaticPub`; that field becomes load-bearing (section 4a).
- `RemoteServerStatus` gains `relay: { enabled, state: 'off'|'connecting'|'online'|'replaced'|'error', relayId, url, error }`.
- New `RemoteErrorCode`s: `'relay-unavailable'`, `'relay-replaced'`, `'too-large-for-relay'`.
- New `RemotePairSealedFrame` (section 4b) added to the `RemoteFrame` union.
- `isAllowedRemoteHost` is unchanged and still governs the direct path. Add
  `isAllowedRelayUrl(url)` requiring `wss:` — a real certificate means **no ATS
  exception is needed for the relay path at all**, which is a small win over the
  current cleartext direct path.
- **Do not** add the new relay IPC channels to `REMOTE_CALLABLE_CHANNELS`. A
  paired phone must not be able to turn the relay on, off, or repoint it.

### `src/main/remoteCrypto.ts`

Additions only; the session KDF is untouched.

- `generateRelayIdentity(): { publicKey, privateKey }` (Ed25519).
- `relayIdFromPublicKey(pub): string` — base32 of the first 16 bytes of SHA-256.
  Must match `relay/src/base32.ts` byte for byte.
- `signRelayChallenge(privateKey, relayId, nonce, ts): string`.
- `sealToStatic` / `openFromStatic` for the sealed pair frame (section 4b).

### `src/main/settings.ts`

Mirror the existing `getRemoteServerKey()` shape:

- `isRelayEnabled()` / `setRelayEnabled()` — defaults to **false**.
- `getRelayUrl()` / `setRelayUrl()` — user-editable, for self-hosting.
- `getRelayKey()` — generate once, keep forever. Same comment as
  `getRemoteServerKey`: rotating it silently breaks every paired device.

### `src/main/relayClient.ts` — NEW

The outbound half. Connects to `wss://<relayUrl>/s/<relayId>`, answers the
challenge, and then demultiplexes the 5-byte relay header into one logical
connection per stream id.

Two things make this small:

- **`globalThis.WebSocket` exists** in Electron 39's Node 22 main process
  (undici). No `ws` dependency, which matters given how dependency-averse
  AGENTS.md is.
- **`WsConnection` is structurally typed.** Each logical stream implements
  `{ remoteAddress, send, close, onMessage, onClose, isOpen }` and is handed to
  the existing connection handler. **`src/main/wsServer.ts` needs no changes at
  all.**

Also here: backoff with jitter, and the 4001 rule (never auto-reconnect on
`replaced`).

### `src/main/remoteServer.ts`

- Export the existing `onConnection`, or add
  `attachRelayConnection(connection: WsConnection)` that routes into the same
  path. Each relay stream is an independent connection and does its own
  handshake, so pairing, sessions, revocation and the one-session-per-device rule
  all work unchanged.
- `createPairingOffer()` includes `relayId` and `relayUrl` when the relay is on.
- `startRemoteServer` / `stopRemoteServer` start and stop the relay client.
- `getStatus()` gains the `relay` block; `publishStatus()` fires on relay state
  changes so Settings is live.
- `handlePaired` learns the sealed pair frame.
- `detectHost()` is unchanged.

### The 4-file IPC sync (AGENTS.md)

1. `src/main/ipcChannels.ts` — `REMOTE.SET_RELAY_ENABLED`, `REMOTE.SET_RELAY_URL`,
   `REMOTE.RESET_RELAY_IDENTITY`.
2. `src/main/ipc.ts` — three `handle(...)` registrations next to the existing
   REMOTE block (around `ipc.ts:4314`).
3. `src/preload/preload.ts` — three bindings in the `remote` namespace
   (`preload.ts:482`).
4. `src/shared/types.ts` — three methods on `ElectronAPI.remote`
   (`types.ts:2673`).

### `src/renderer/components/RemoteAccessPanel.tsx`

- Relay toggle, live state row, and the relay id.
- **Replace the host/port/code display with a QR** encoding the full pairing
  offer. This is not cosmetic: section 4 depends on it.
- "Advanced" disclosure for a self-hosted relay URL, and "Reset relay identity"
  with its warning.
- One honest paragraph of what the relay can see, in the panel itself. The
  existing copy already explains what a paired phone can and cannot do; this is
  the same register.

### `mobile/src/transport/secureStore.ts`

`PairedIdentity` becomes:

```ts
interface PairedIdentity {
  v: 2
  deviceId: string
  addresses: RemoteAddress[]   // was { host, port }
  serverStaticPub: string
  privateKey: string
  publicKey: string
}
```

`loadIdentity()` migrates a v1 blob by reading `{host, port}` into
`[{ kind: 'direct', host, port }]`. This is the only file that touches the stored
blob, and it is also the file that still needs its Keychain backing before
shipping (`docs/ios-app.md`) — do both in one pass.

### `mobile/src/transport/client.ts`

- `socketUrl(host, port)` becomes `addressToUrl(address)`: direct →
  `ws://host:port/holmes`, relay → `${url}/c/${relayId}`.
- `connect()` becomes the staggered race in section 5. Today it opens exactly one
  socket and stores it in `this.socket`; it will need per-attempt state and a
  "first to derive keys wins" resolution.
- `pair()` takes a parsed `holmes://pair?...` payload, pins `serverStaticPub`
  before opening the socket, sends the sealed pair frame, and stores both the
  direct and relay addresses from the offer.
- Reconnect backoff becomes per-address, and must special-case the relay close
  codes: 4001 stop, 4003 stop, 4004 slow down, 4010 reconnect on demand.
- New: the opportunistic direct-upgrade probe, gated on "no in-flight request".

### `mobile/src/screens/PairScreen.tsx`

Camera QR scan as the primary path; the existing host/port/code fields stay as a
manual fallback for the direct-only case.

### `mobile/ios/App/App/Info.plist`

No change. The relay is `wss://` with a public certificate, so ATS is satisfied
without an exception. The existing `ts.net` / `NSAllowsLocalNetworking` block
stays for the direct path.

### Tests

New `test-relay.mjs`, in the style of `test-remote.mjs` (which already runs under
`--experimental-strip-types` with the bootstrap loader):

- `relayIdFromPublicKey` matches a fixed vector, and matches `relay/src/base32.ts`.
- `signRelayChallenge` produces a signature that `crypto.verify` accepts against
  the exact context string.
- Address preference: given direct + relay candidates, direct wins when both
  succeed; relay wins when direct times out.
- The relay frame-size gate rejects at `REMOTE_RELAY_MAX_FRAME_BYTES`.
- The sealed pair frame round-trips, and a wrong static key fails to open.

Add `test:relay` to `package.json` and to the `test` chain.

### Docs

- `docs/ios-app.md` — the "Transport: Tailscale" section becomes "Transport:
  direct first, relay fallback". Tailscale stops being a prerequisite and becomes
  one of the direct candidates.
- `AGENTS.md` — line 7's "no telemetry, no account, no cloud", and the remote
  access row in the subsystem table. See section 9.

---

## 9. What this costs the project's claim

`AGENTS.md:7` and `docs/ios-app.md:9` both say **"no account, no cloud, no
telemetry."** A relay changes exactly one of those three, and pretending
otherwise would be the worst outcome here.

### No account — still true, and worth defending

The identifier is a self-generated key fingerprint. The relay has no user table,
no email, no password, no session cookie, no billing link to a person. It cannot
ban a user; it can only refuse an identifier or an IP. That is a genuine
constraint on abuse handling, and it is the right trade.

Is an account genuinely needed? **No, for this feature.** Accounts would buy
per-user quotas, a way to contact someone abusing the service, and a paid tier.
All three are solvable-enough without one: quotas per identifier and per IP,
proof-of-work on slot claim if it ever comes to that, and the fact that a Holmes
relay slot is worth almost nothing to an attacker — it forwards bytes to a Mac
that will refuse to talk to them. If the relay ever becomes a paid service, that
is when an account becomes unavoidable, and it should be introduced as a separate
decision rather than smuggled in with this one.

### No telemetry — still true, with a caveat that must be stated

The relay has no analytics binding, `logpush = false`, `[observability] enabled = false`,
and writes nothing to storage. Holmes collects nothing.

But Cloudflare is an infrastructure provider and sees TLS connections and IP
addresses at the edge regardless of what the Worker does. "No telemetry" honestly
means *we* collect none. It does not mean nobody observes anything. Say the
second sentence too.

### No cloud — this is the one that breaks

It cannot survive verbatim once a relay is on. The narrowest honest replacement:

> **Local-first, no account, no telemetry.** Your data lives on your Mac and
> never leaves it. Remote access is off by default. Turn it on and your phone
> talks to your Mac directly whenever it can. When it can't — you're on cellular,
> your Mac is behind a router you don't control — an encrypted relay forwards the
> bytes. The relay cannot read them: everything is end-to-end encrypted with keys
> that only your Mac and your phone hold. It does see that two IP addresses
> talked, when, and roughly how much. You can point Holmes at your own relay
> instead, or use Tailscale and no relay at all.

Rules that keep that paragraph true:

1. **Opt-in, off by default.** A user who never enables remote access has no
   relationship with any server, and the app makes no outbound connection to one.
2. **Never route anything else through it.** No update checks, no crash reports,
   no model metadata. The relay carries paired-device traffic only. The moment
   something else uses it, the sentence becomes a lie.
3. **The URL stays user-editable and the Worker stays open.** "You can run your
   own" must remain true in practice, not just in principle.
4. **The disclosure lives in the UI, not only in this file.** The Settings panel
   says what the relay can see, before the toggle is flipped.

---

## 10. Not done, and known gaps

- **Sections 4a and 4b are prerequisites, not follow-ups.** Relay pairing without
  them is a working man-in-the-middle. Ship direct-only pairing if they are not
  ready.
- **No chunking.** Attachments above ~700 KB do not cross the relay.
- **No traffic padding.** Frame sizes and timing are visible; see section 1.
- **The throughput budget in `slot.ts` is in-memory** and resets when the object
  is evicted. It catches a runaway session, not a determined abuser. Real quota
  enforcement needs durable state, which needs an identity to attach it to.
- **Per-IP rate limiting is not in the Worker.** It belongs in Cloudflare's rules
  engine, configured at deploy time; the README lists the two rules.
- **Nothing verifies the relay's own TLS beyond the platform's trust store.**
  That is fine — the relay is untrusted by design and the Holmes layer does not
  rely on TLS for confidentiality — but it means a TLS-terminating middlebox sees
  exactly what the relay sees, which is exactly what section 1 says it sees.
