# Vendored: onlyoffice-web-comp

Source: https://github.com/electroluxcode/onlyoffice-web-comp
Commit: `ec555599bc689ae0b9725353b4ff96e463961912`
License: AGPL-3.0 (compatible with Holmes' AGPL-3.0-or-later)
Vendored: 2026-07-29

## Why this is vendored rather than depended on

It is not published to npm. It is also not usable as the upstream project uses
it: upstream runs it in the *host page* and reaches into the editor iframe to
hijack its XHR/fetch/io. Holmes' renderer is `file://` and the editor is
`holmes-office://`, so that access is cross-origin and blocked. Here the whole
wrapper runs *inside* a shell page served from `holmes-office://`, which is
same-origin with the editor iframe it creates. Holmes' renderer talks to the
shell only by postMessage and never loads any ONLYOFFICE code itself.

## Local modifications

Recorded in `../PATCHES.md`. Keep them minimal so re-vendoring stays a copy.

## Re-vendoring

    node scripts/vendor-office-shell.mjs

Then re-apply the patches listed above and re-run `pnpm test:work`.
