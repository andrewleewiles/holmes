![Holmes](website/logo.svg)

A desktop AI harness for the parts of your life that aren't code.

Most AI tooling assumes you are writing software. Holmes assumes you are living a life, and that an assistant is only as useful as what it actually knows about you. It ingests the data you already own — messages, mail, photos, health records, orders, e-books, your own files — and builds a durable, versioned context tree that every conversation draws on.

![The Holmes chat window](website/window.png)

Holmes runs on your machine. Your data goes into a local SQLite database, your keys go into the macOS Keychain, and there is no account, no telemetry, and no Holmes server. The one thing that does leave your computer is described plainly in [What leaves your machine](#what-leaves-your-machine) — please read that section before pointing this at your life.

## Status

Holmes is a personal project, made public because it may be useful or interesting to others. It works, it is used daily by its author, and it has no support commitment, no roadmap promises, and no stability guarantees. Version 0.1.0 means what it says. Expect rough edges, and expect the schema to move.

## What it does

**Chat** with streaming responses and branching, against OpenRouter, any OpenAI-compatible endpoint, or a local Ollama. Model tiers (budget / mid / frontier, each with a text and a vision model) let you point cheap work and expensive work at different models.

**Memory** across 17 categories, extracted automatically from conversations, with a rolling abridged summary and Detailed / Abridged / Anonymous context modes.

**A context tree.** Every file, folder, and source gets a short and a long context, composed upward into per-source and per-project super-contexts. Every derived node carries provenance back to the sources it came from, and nothing generated is ever destroyed — superseded contexts are archived, not overwritten.

**A timeline.** Contexts emit dated event blocks built from real dating evidence, harvested and merged into a life timeline whose precision never falsely sharpens.

**People**, resolved across sources by a seed-first resolver deliberately biased toward under-merging rather than collapsing two real people into one.

**Health**, in three layers: ingestion (Apple Health XML, MyChart CCDA, bloodwork CSV/PDF), rolling synthesis, and live HealthKit sync through a Swift sidecar.

**Activity accounts** — thirteen per-account sources: iMessage, Gmail, Google Search history, YouTube, Amazon, Instagram, Facebook, TikTok, Snapchat, Discord, LinkedIn, Tinder, Bumble. Some sync live; most ingest the official data export the service gives you.

**A library** of e-books with a reader, word-synced audiobook narration, and reading records. Book text is deliberately kept out of your profile.

**Remote access** from a paired iOS client, over an encrypted session with a default-deny channel allowlist. See [Remote access](#remote-access).

Also: Recall (Spotlight and conversation search), Projects with per-project scope and index style, psychological tests and analysis, product search, roles and session notes, and a call history that logs every provider request with its real cost.

## Requirements

- **macOS on Apple Silicon.** The Swift sidecars target `arm64-apple-macosx13`, and the iMessage, Photos, and HealthKit integrations are macOS-only. `electron-builder.yml` carries Windows and Linux targets, but those builds are untested and lose most of the data sources.
- **Node 22 or newer.** The test suite runs TypeScript directly via `--experimental-strip-types`.
- **pnpm.**
- **Xcode command line tools**, to build the sidecars.
- **An API key** for OpenRouter or another OpenAI-compatible provider, or a local Ollama install.

## Getting started

```bash
pnpm install
pnpm build:sidecar          # HealthKit sidecar
pnpm build:sidecar:holmes   # Photos / location / health sidecar
pnpm rebuild:electron       # better-sqlite3 against Electron's ABI
pnpm dev
```

Add your provider key in Settings on first launch. Nothing is indexed until you add a source and explicitly index it — Holmes does not go looking through your disk on its own.

### The native module gotcha

`better-sqlite3` is a native module, and Electron and Node use different ABIs. The app needs `pnpm rebuild:electron`; the test suite needs `pnpm rebuild:node`. You cannot have both at once, so switching between running the app and running tests means rebuilding each time.

Do not rebuild while the app is running. Rewriting `better_sqlite3.node` under a live process invalidates its code signature and macOS will SIGKILL the app.

## Tests and checks

```bash
pnpm typecheck   # electron + web, both must pass
pnpm test        # requires the Node-ABI build (see above)
```

Honest state of the suite, as of this writing:

- `pnpm typecheck` passes clean on both projects.
- `pnpm test` runs eighteen suites chained with `&&`, so the first failure stops the run.
- **`test:memory` has a known pre-existing failure.** It is documented as a landmine in `AGENTS.md` and is deliberately not fixed.
- **`test:psychology` has a known module-resolution failure**, also pre-existing.
- `pnpm lint` **will fail** — the script exists but eslint is not installed. There is no linter in this project.

There is no CI. Tests are run by hand.

## Data and privacy

This is the section that matters. Holmes is built to hold an unusually complete picture of one person's life, so it is worth being exact about where that picture lives and where it goes.

### What stays on your machine

| What | Where |
|---|---|
| All ingested data, contexts, timeline, memory | `~/Library/Application Support/holmes/holmes.db` |
| Settings | `electron-store`, in the same directory |
| Provider API keys and account secrets | macOS Keychain, via `keytar` |

There is no Holmes account, no Holmes server, no telemetry, no analytics, and no crash reporting. Nothing phones home, because there is no home to phone.

### What leaves your machine

**Your context is sent to whatever model provider you configure.** That is the entire point of the application, and it is the one place the local-first story stops.

When you chat, or when Holmes indexes a source, it sends the relevant context — which may include message excerpts, health observations, photo metadata, file contents, and your memory profile — to OpenRouter, your custom endpoint, or your local Ollama. What that provider does with it is governed by their policy, not by Holmes.

If you want none of it to leave, point Holmes at a local Ollama model. That is a supported configuration and the only one where the data genuinely never leaves the machine.

The Anonymous memory mode and the redaction paths (`redactMemoryContent`, `redactHealthContent`) reduce what is included in context. They are a real mitigation, not a guarantee.

### Consent, and other people

Holmes reads sources that contain other people's words. Your iMessage history is also your correspondents' iMessage history; your photos contain other people's faces; your mail contains what other people wrote to you. Those people did not install this application and cannot see what it inferred about them.

Holmes has a People feature that builds profiles of the humans in your life. Think about that before you index, and think about it particularly before you pair a phone, share a screen, or hand the machine to someone else. The law here varies by where you live and this is not legal advice.

## Remote access

Holmes can act as a server for a paired iOS client (`mobile/`, a Capacitor workspace).

The design is deliberately conservative:

- A hand-rolled WebSocket server behind an X25519 / HKDF / AES-GCM session.
- Single-use pairing codes and per-device revocation.
- **A default-deny channel allowlist.** All 205 IPC handlers are unreachable from a device unless explicitly listed. Channels that write to the filesystem, change the file access scope, read or set credentials, spawn a sidecar, or start a paid bulk run are excluded on purpose. `settings:get` is denied because it would return your API key.
- **Two device scopes.** An `owner` device reaches the app; a `media` device reaches eight Library channels, all read-only, and nothing else — no memory, health, conversations, chat, timeline, people, or recall. It defaults to `media`.

Understand the caveat: **this is hand-rolled cryptography and a hand-rolled WebSocket implementation, written by one person and never independently audited.** The allowlist is the meaningful security boundary, and it is the thing to review before you expose anything. Do not run this on a hostile network and assume it will hold.

## Architecture

Electron main + preload + React renderer, TypeScript throughout, SQLite via better-sqlite3, Tailwind, zustand. No LLM SDK — provider calls are plain `fetch`, all in `src/main/provider.ts`. No UI library; the interface is hand-rolled Tailwind. No router.

`AGENTS.md` is the real architectural document — a detailed reference covering the layout, the four-file IPC contract, database conventions, every feature subsystem, and a long list of specific landmines. Start there, and read `docs/memory.md` for the memory system.

Adding an IPC channel means touching four files in sync: `ipcChannels.ts`, `ipc.ts`, `preload.ts`, and `types.ts`.

## Contributing

Issues and pull requests are welcome, with the caveat in [Status](#status): this is one person's project and response times will be erratic.

If you do send a patch, `AGENTS.md` has a "What to NEVER do" section that encodes hard-won constraints. It is worth reading before you write code, and most of it is not guessable from the source alone. Run `pnpm typecheck` before submitting.

## Security

Please do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

The AGPL is a deliberate choice for an application that handles this kind of data: if someone runs a modified Holmes as a service that other people interact with over a network, section 13 obliges them to offer those users the source. Nobody should be able to take a personal-data tool built in the open, close it, and run it on other people's lives.

Third-party dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright (C) 2026 Wiles Creative.

## Support the project

If Holmes is useful to you: [ko-fi.com/wilescreative](https://ko-fi.com/wilescreative).
