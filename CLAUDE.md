# DraconDex-PGI-Codex

A Codex (OpenAI) chat plugin for [DraconDex](https://github.com/ZYDRAXYL/DraconDex-APP),
in DraconDex 5's side panel or run as a standalone window. Sibling
of [DraconDex-PGI-Claude](https://github.com/ZYDRAXYL/DraconDex-PGI-Claude) and
[DraconDex-PGI-Ollama](https://github.com/ZYDRAXYL/DraconDex-PGI-Ollama) — same
shape, different provider.

Full background (connection modes including the OAuth loopback-port catch,
data-handling, the manifest, why the panel's constraints exist) is in
[README.md](README.md) — read that first for anything not covered below.

## Architecture

Two HTML entries share the same five `src/` modules and differ only in
chrome:

| File | Purpose |
| --- | --- |
| `dracondex-plugin.json` | Manifest: id `codex_chat`, files, panel, permissions, table schema. |
| `index.html` + `app.js` | Standalone-window entry (draws its own frameless title bar). |
| `panel.html` + `panel.js` | Side-panel entry; asks the host for module context and follows the pushes v5 sends on every page change (`setModuleContext` in `src/chat.js` — never mid-reply). |
| `src/store.js` | The three tables, via `window.pluginApi.table.*`. |
| `src/provider.js` | OpenAI Responses API client + both auth modes (API key, OAuth/Local CLI). |
| `src/catalog.js` | Fetches/caches AI Native's `catalog.json`; composes the app-context preamble onto the system prompt. Independent of `provider.js` — different origin, own `pluginApi.net` call. |
| `src/chat.js` | Session and turn state — no DOM. |
| `src/ui.js` | Rendering. Builds DOM nodes directly, never HTML strings. |
| `test/provider.test.mjs` | Drives `provider.js` against canned SSE. |
| `test/catalog.test.mjs` | Drives `catalog.js` against a fake `pluginApi.net`/`Store`/page `fetch`. |

Only paths listed in the manifest's `files` are downloaded on install —
README, scripts, and tests cost an installing user nothing.

## Hard constraints — read before editing panel/state code

- **The panel can go away at any moment** — DraconDex 5's side panel keeps it
  open across page changes but destroys it on close or quit (4.x hosts also
  reloaded it on every pane re-render). Nothing may live only in a JS variable: every message must be written to its table at the moment
  it exists (the question before the request goes out, the answer as soon as
  the stream ends), and the panel rebuilds itself from the tables on every
  load. A reply still streaming when a reload happens is the only thing that
  can be lost — don't make that window bigger.
- **The manifest `id` (`codex_chat`) is load-bearing** — it's baked into the
  real SQLite table names (`plg_codex_chat_session` etc.). Don't change it.
- **Sandbox**: this plugin has no access to the main app's data, `window.api`,
  or any other plugin's tables/files — only `window.pluginApi` and the
  origins declared in `permissions.net` (`https://api.openai.com`,
  `https://auth.openai.com`, `https://chatgpt.com`,
  `https://raw.githubusercontent.com`). `permissions.net` also gates OAuth —
  DraconDex checks the authorize URL's origin against this same list before
  opening the browser. It can't run the Codex CLI itself; Local-CLI auth only
  accepts a token the user already produced with `codex login`.
- **No tool use / function calling, no file attachments, no server-side
  conversation state** (`store` is `false` in Responses API calls) — the
  transcript is always replayed from this plugin's own tables each turn.
  Don't assume any of those are available when extending `provider.js`.
- **`src/catalog.js` is independent of `src/provider.js`** — its failure must
  never break chat: if the AI Native fetch fails or is unavailable, chat
  still works, just without the app-context preamble.
- Treat all rendered content as data: build DOM nodes / use `textContent` in
  `src/ui.js`, never `innerHTML`.
- Credentials (API key, OAuth tokens) are stored in the plugin's own
  `config` table in **plain text** — consistent with the rest of the app,
  not an exception to be "fixed" locally.

## Commands

```bash
node tools/validate-manifest.mjs     # the app's own rules (vendored), first error first
node tools/plugin-contract.mjs       # the vendored copy matches plugin-contract.lock.json
node --check app.js panel.js src/*.js
node --test test/*.test.mjs
```

CI (`.github/workflows/validate.yml`) runs all three on every push/PR. No
dependencies to install, no build step — the app downloads these files as-is.

## Developing / testing locally

In DraconDex: **Settings → Plugin → Plugins**, paste this repo's link, confirm
the preview. Reinstalling after a change means uninstalling first (the same
`id` can't install twice) — and **uninstalling permanently deletes this
plugin's conversations**, so don't develop against a vault you care about.
