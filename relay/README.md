# holmes-relay

A rendezvous relay for Holmes remote access. It pairs one **server** socket (a Mac
running Holmes) with up to four **client** sockets (phones) by an opaque
identifier and forwards bytes between them.

It is deliberately dumb. It does not parse Holmes frames, cannot decrypt them,
holds no user records, and requires no account. Read `docs/relay.md` in the repo
root for the threat model, the identifier scheme, cost projections, and the list
of desktop/mobile changes needed to use it.

## Layout

```
relay/
├── wrangler.toml        # Worker + Durable Object config
├── src/
│   ├── worker.ts        # routes /s/<id> and /c/<id> to the slot object
│   ├── slot.ts          # the Durable Object: auth, pairing, forwarding
│   ├── protocol.ts      # the 5-byte relay header and the close codes
│   └── base32.ts        # relayId = base32(sha256(pubkey)[0..16])
└── tools/relay-id.mjs   # generate an identity / act as a Mac, no deps
```

## Deploy

```bash
cd relay
npm install                  # wrangler + types. Do NOT run this from the repo root.
npx wrangler login
npx wrangler deploy
```

`relay/` is intentionally **not** a pnpm workspace package (`pnpm-workspace.yaml`
lists only `mobile`), so installing here cannot trigger a `better-sqlite3`
rebuild against a running Holmes — AGENTS.md landmine 2.

The deploy prints a `*.workers.dev` URL. For production put a real hostname in
front of it:

```bash
npx wrangler deploy --route relay.example.com/*
```

The URL the desktop stores must be `wss://` — see the ATS note in `docs/relay.md`.

### Plan

The Durable Object is declared with `new_sqlite_classes`, which makes it eligible
for the Workers Free plan. Nothing is written to storage; the SQLite backend is
simply the one that is free-tier eligible.

## Try it without a Mac

```bash
# Terminal 1 — the Worker
npx wrangler dev

# Terminal 2 — stand in for the Mac. Prints the relayId and the client URL.
node --experimental-strip-types tools/relay-id.mjs connect ws://127.0.0.1:8787
```

Then open the printed client URL in any WebSocket client and send text. The
stand-in Mac prints the stream id and payload and echoes it back.

Reusing the same identity across runs:

```bash
node --experimental-strip-types tools/relay-id.mjs new
node --experimental-strip-types tools/relay-id.mjs connect ws://127.0.0.1:8787 <privateKey>
```

## Protocol

### Server leg — `wss://relay/s/<relayId>`

1. Relay sends `{"t":"challenge","nonce":"<b64url 32B>","ts":<epoch ms>}`.
2. Mac sends `{"t":"auth","pub":"<b64url ed25519 pub>","sig":"<b64url>"}` where
   `sig` is Ed25519 over the UTF-8 bytes of
   `holmes-relay-auth-v1|<relayId>|<nonce>|<ts>`.
3. Relay checks `base32(sha256(pub)[0..16]) === relayId`, verifies the signature,
   and replies `{"t":"ready"}`. Any older server socket is closed with 4001.
4. Thereafter every message on this leg is **binary**:
   `[type u8][streamId u32 BE][payload...]`
   - `0x01` open (relay to Mac only)
   - `0x02` data, payload is UTF-8 text
   - `0x03` data, payload is binary
   - `0x04` close

The 5-byte header is the only thing the relay parses, and it belongs to the relay,
not to Holmes.

### Client leg — `wss://relay/c/<relayId>`

No authentication. Messages are forwarded verbatim in both directions. A client
that arrives with no authenticated server present is closed immediately with
4004, so scanning the identifier space yields only "occupied / not occupied" —
against a 128-bit space.

### Close codes

| Code | Meaning | What the client should do |
|---|---|---|
| 4001 | replaced by a newer server connection | stop reconnecting, surface it |
| 4002 | relay protocol error | bug; report |
| 4003 | authentication failed | check the key, do not retry in a loop |
| 4004 | no server attached | the Mac is offline or asleep |
| 4008 | too many client connections | back off |
| 4009 | message exceeded 1 MiB | do not retry the same message |
| 4010 | idle | reconnect on next use |
| 4029 | throughput budget exceeded | back off hard |

## Limits

| Limit | Value | Where |
|---|---|---|
| Max message | 1 MiB | `protocol.ts` (Cloudflare platform cap) |
| Max concurrent clients per slot | 4 | `slot.ts` |
| Auth window | 120 s | `slot.ts` |
| Client idle timeout | 5 min | `slot.ts` |
| Sweep interval | 60 s | `slot.ts` |
| Per-instance throughput budget | 256 MiB | `slot.ts`, best-effort |

Ping/pong keepalives are answered by `setWebSocketAutoResponse`, so a heartbeat
does not wake the object and does not accrue duration billing.

## Operational stance

`logpush = false` and `[observability] enabled = false` in `wrangler.toml`, no
Analytics Engine binding, no KV, no D1. The relay is designed so that it *cannot*
build a record of who talked to whom: the only durable identifier it sees is a
self-generated key fingerprint with no name, email, or account behind it.

Cloudflare's own edge still sees TLS connections and IP addresses regardless of
this configuration. `docs/relay.md` says so plainly rather than claiming
otherwise.
