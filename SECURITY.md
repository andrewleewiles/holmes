# Security Policy

Holmes holds an unusually complete picture of one person's life on their own machine. Security reports are taken seriously even though the project carries no formal support commitment.

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**. That opens a private advisory visible only to the maintainer.

Useful things to include: what you found, how to reproduce it, and what an attacker gets out of it. A proof of concept helps but is not required.

This is a one-person project. Expect an acknowledgement within a couple of weeks rather than a couple of hours, and no bounty — only credit in the advisory, if you want it.

## Supported versions

Only the current `main` branch. There are no maintained release branches and no backports.

## Threat model

### In scope

- **The remote access boundary.** The channel allowlist in `src/shared/remote.ts` is the security boundary between "paired device" and "remote shell." Anything reachable from a paired device that should not be, in either the `owner` or the `media` scope, is a real finding. The `media` scope in particular must never expose anything derived from the owner's life, and must never write.
- **The session crypto.** The X25519 / HKDF / AES-GCM session and the pairing-code flow in `remoteCrypto.ts` and `wsServer.ts` are hand-rolled and have never been independently audited. Weaknesses there are in scope and genuinely welcome.
- **Credential handling.** Provider API keys and account secrets belong in the macOS Keychain via `keytar`. Any path that writes one to disk, logs one, includes one in a context sent to a model, or returns one over the remote bridge is a serious finding.
- **The file access scope.** `fileScope.ts` constrains which parts of the disk Holmes will read. Escapes from it are in scope.
- **Redaction bypasses.** `redactMemoryContent` and `redactHealthContent` are mitigations, not guarantees, but a way to make them fail wholesale is worth reporting.
- **Sidecar handling.** The Swift sidecars run with Photos, location, and HealthKit entitlements. Anything that lets untrusted input influence what they are asked to do is in scope.
- Ordinary Electron hardening problems: context isolation, preload surface, arbitrary code execution through rendered content.

### Out of scope

- **Context being sent to your model provider.** This is what the application does, by design and by your configuration. It is documented in the README. Use a local Ollama model if you need the data to stay on the machine.
- **An attacker with the machine unlocked.** Holmes stores your life in a local database, on the assumption that access to your unlocked user account is already game over.
- **Third-party provider behaviour.** What OpenRouter or any other endpoint does with a request is between you and them.
- **A source file you deliberately pointed Holmes at containing something sensitive.** Choosing sources is the user's job.
- **The known failing tests and the missing linter.** Documented in the README; not security issues.

## Note on the license

Holmes is AGPL-3.0-or-later. If you run a modified version as a network service, section 13 requires you to offer its source to the people using it. That obligation exists partly for security reasons: people whose data a modified Holmes touches should be able to see what it actually does.
