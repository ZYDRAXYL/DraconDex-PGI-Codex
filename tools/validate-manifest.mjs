#!/usr/bin/env node
// Validate dracondex-plugin.json offline, before you push — the app validates
// only AFTER resolving your repo over the network, so the alternative feedback
// loop is "commit, push, paste the link, read a toast".
//
//   node tools/validate-manifest.mjs
//   node tools/validate-manifest.mjs path/to/dracondex-plugin.json
//
// The verdict is the APP'S OWN: tools/plugin-manifest.cjs is a byte-identical
// copy of electron/src/db/plugin-manifest.js in DraconDex-EXE, vendored at the
// release pinned in plugin-contract.lock.json (node tools/plugin-contract.mjs
// checks the copy, --vendor moves the pin). Before DraconDex 5 these rules
// were re-typed here by hand and drifted — one template accepted panels the
// app refused, the other refused loopback origins the app allowed. Calling
// the real validateManifest() makes that class of bug impossible.
//
// The trade: the app stops at its FIRST error, so this does too. Fix it, run
// again.
//
// On top of the app's verdict it checks what the app cannot see from a URL:
// every `files` path exists here and fits the per-file cap, runtime-looking
// files that were left out of `files`, the .dracondex marker, and a few
// sandbox rules a shipped page can break without any error (markup built from
// strings, remote resources, inline styles a strict CSP drops).
//
// Source: DraconDex-APP tools/plugin-template/validate-manifest.mjs, mirrored
// into DraconDex-PGI-Template and DraconDex-EXT-Template. In a plugin MADE from
// one of those templates this file is yours — keep it next to
// plugin-manifest.cjs and plugin-contract.lock.json.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = createRequire(import.meta.url)(join(HERE, 'plugin-manifest.cjs'));
const {
  validateManifest, parseRepoUrl, manifestNetOrigins, MAX_FILE_BYTES, MANIFEST_NAMES,
} = contract;

// ids the templates ship with. A plugin still carrying one collides with every
// other copy of the template (same plg_<id>_* tables).
const TEMPLATE_IDS = new Set(['ext_template', 'example_plugin']);

// Not runtime: never downloaded, never worth listing in `files`.
const IGNORED_DIRS = new Set(['.git', '.github', 'node_modules', '.claude', 'tools', 'scripts', 'docs', 'test', 'tests', 'chain']);
const IGNORED_FILES = new Set([...MANIFEST_NAMES, 'package.json', 'package-lock.json', 'plugin-contract.lock.json']);
const RUNTIME_EXT = /\.(html?|js|mjs|css|svg|png|jpe?g|gif|webp|json|woff2?)$/i;

export function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORED_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/** Everything this tool reports, without printing — so a test can call it. */
export function check(manifest, root) {
  const errors = [];
  const warnings = [];

  const verdict = validateManifest(manifest);
  if (!verdict.ok) errors.push(verdict.error);

  const files = Array.isArray(manifest?.files) ? manifest.files.filter((f) => typeof f === 'string') : [];

  if (TEMPLATE_IDS.has(manifest?.id)) {
    warnings.push(`"id" is still ${manifest.id} — change it before anyone installs, or this plugin collides with every other copy of the template`);
  }
  if (typeof manifest?.entry === 'string' && !/\.html?$/i.test(manifest.entry)) {
    warnings.push(`"entry" is ${manifest.entry} — the app opens it with loadFile, so it should be an HTML file`);
  }

  const net = manifestNetOrigins(manifest);
  if (net.length) {
    warnings.push(`declares ${net.length} network origin(s) (${net.join(', ')}) — each is shown to the user before they accept; drop any no code calls`);
  }
  for (const dep of Array.isArray(manifest?.dependencies) ? manifest.dependencies : []) {
    const p = parseRepoUrl(dep);
    if (p.ok && p.host === 'github' && p.owner.toLowerCase() === 'zydraxyl' && /-template$/i.test(p.repo)) {
      warnings.push(`dependency ${dep} is a template repo — installing it yields an empty plugin, not a capability`);
    }
  }

  // Files on disk — only meaningful once the manifest itself is sound, or the
  // list being checked is not the one the app would use.
  let totalBytes = 0;
  if (!errors.length) {
    for (const f of files) {
      const p = join(root, f);
      if (!existsSync(p)) { errors.push(`"files" lists ${f}, which does not exist in this repo — the install would fail on it`); continue; }
      const size = statSync(p).size;
      totalBytes += size;
      if (size > MAX_FILE_BYTES) errors.push(`${f} is ${(size / 1048576).toFixed(2)}MB — the per-file cap is ${MAX_FILE_BYTES / 1048576}MB`);
    }
    for (const p of walk(root)) {
      if (files.includes(p) || IGNORED_FILES.has(p) || p.startsWith('.')) continue;
      if (RUNTIME_EXT.test(p)) warnings.push(`${p} looks like a runtime file but is not in "files" — it will NOT be downloaded`);
    }
    if (!existsSync(join(root, '.dracondex'))) {
      warnings.push('no .dracondex marker at the repo root — the app will not offer this repo in its "install from @ZYDRAXYL" list (pasting the link still works)');
    }
    warnings.push(...lintShipped(files, root));
  }

  return { errors, warnings, totalBytes };
}

// Shipped pages break the sandbox's rules silently: nothing errors, the page
// just renders wrong or does something the user never saw in the preview.
function lintShipped(files, root) {
  const out = [];
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    // Comments explain the rules (and so mention innerHTML, window.api,
    // style=""); only code counts. Blanked rather than removed, so line
    // numbers still point at the right place.
    const keepLines = (m) => m.replace(/[^\n]/g, ' ');
    const code = /\.html?$/i.test(f)
      ? text.replace(/<!--[\s\S]*?-->/g, keepLines)
      : text.replace(/\/\*[\s\S]*?\*\//g, keepLines).replace(/^\s*\/\/.*$/gm, '');
    const lines = code.split('\n');
    const at = (re) => lines.findIndex((l) => re.test(l)) + 1;
    if (/\.m?js$/i.test(f)) {
      const n = at(/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\s*\(|document\.write\s*\(/);
      if (n) out.push(`${f}:${n} builds markup from a string — table rows and network bodies are text; build nodes and set .textContent`);
      const w = at(/\bwindow\.api\s*(\.|\?\.|\[)|\brequire\s*\(\s*['"`]/);
      if (w) out.push(`${f}:${w} reaches for window.api/require — neither exists in a plugin window; window.pluginApi is the whole surface`);
    }
    if (/\.html?$/i.test(f)) {
      const r = at(/<(script|link|img)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i);
      if (r) out.push(`${f}:${r} loads a remote resource — only files in "files" are downloaded; a remote one is an unreviewed fetch on every launch`);
      const csp = /Content-Security-Policy/i.test(code);
      if (!csp) out.push(`${f} has no Content-Security-Policy <meta> — the templates ship one that forbids remote script and style; keep it`);
      const s = at(/\sstyle\s*=\s*["']/i);
      if (csp && s && !/unsafe-inline/.test(code)) out.push(`${f}:${s} uses an inline style="" attribute — a style-src 'self' CSP drops it without an error; use a class`);
    }
  }
  return out;
}

function main() {
  const manifestPath = resolve(process.argv[2] || 'dracondex-plugin.json');
  const root = resolve(manifestPath, '..');
  if (!existsSync(manifestPath)) {
    console.error(`no manifest at ${manifestPath}`);
    process.exit(2);
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { console.error(`${manifestPath} is not valid JSON: ${e.message}`); process.exit(2); }

  const { errors, warnings, totalBytes } = check(manifest, root);
  for (const w of warnings) console.log(`warn   ${w}`);
  for (const e of errors) console.log(`ERROR  ${e}`);
  if (errors.length) {
    console.log(`\nDraconDex would refuse to install this. (The app stops at its first error — fix it and run again.)`);
    process.exit(1);
  }
  const n = (k) => (Array.isArray(manifest[k]) ? manifest[k].length : 0);
  console.log(`\nok — ${manifest.name} (${manifest.id}) v${manifest.version ?? '—'}: ${n('files')} file(s), ${(totalBytes / 1024).toFixed(1)}KB, ${n('tables')} table(s), ${n('panels')} panel(s), ${n('dependencies')} dependenc${n('dependencies') === 1 ? 'y' : 'ies'}${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
