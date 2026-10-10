#!/usr/bin/env node
// The plugin contract, pinned. DraconDex-EXE owns the rules every plugin is
// installed under (electron/src/db/plugin-manifest.js) and the API it runs
// against (electron/preload-plugin.js). A plugin repo carries:
//
//   tools/plugin-manifest.cjs    byte-identical copy of plugin-manifest.js —
//                                what tools/validate-manifest.mjs runs
//   plugin-contract.lock.json    which EXE ref it came from, plus the hash of
//                                preload-plugin.js at that ref (watched, not
//                                vendored: a change there means the code and
//                                docs that call pluginApi need a look)
//
//   node tools/plugin-contract.mjs                 offline: the copy matches the lock
//   node tools/plugin-contract.mjs --upstream      also: has EXE moved past the pin?
//   node tools/plugin-contract.mjs --vendor        re-fetch at the pinned ref
//   node tools/plugin-contract.mjs --vendor --ref v5.2.0     move the pin
//   node tools/plugin-contract.mjs --vendor --from ../DraconDex-EXE
//                                                  take it from a local checkout
//                                                  (what chain-propagate does)
//
// Standalone on purpose — no chain-lib, no chain.json — so the same file works
// in the two template repos (which sit in the chain, EXE > PGI, EXT) and in
// any plugin made from them (which does not).
//
// Source: DraconDex-APP tools/plugin-template/plugin-contract.mjs.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'plugin-contract.lock.json');
const SOURCE_REPO = 'ZYDRAXYL/DraconDex-EXE';

// What the contract is made of. Paths on the left are in EXE.
const VENDORED = { 'electron/src/db/plugin-manifest.js': 'tools/plugin-manifest.cjs' };
const WATCHED = {
  'electron/preload-plugin.js': 'the window.pluginApi surface — a change means app code and docs that call it need review',
};

const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const VENDOR = args.includes('--vendor');
const UPSTREAM = args.includes('--upstream');
const FROM = argOf('--from');

// CRLF-insensitive, like sdb-vendor: a Windows checkout must not read as drift.
const digest = (text) => createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
const readLock = () => (existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : null);

async function fetchAt(ref, path) {
  if (FROM) {
    // A local EXE checkout: read the tree at `ref` if one was named, else HEAD.
    return execFileSync('git', ['show', `${ref || 'HEAD'}:${path}`], { cwd: resolve(FROM), encoding: 'utf8', maxBuffer: 8 << 20 });
  }
  const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${ref}/${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} fetching ${path} from ${SOURCE_REPO}@${ref}`);
  return res.text();
}

async function vendor() {
  const lock = readLock();
  let ref = argOf('--ref') || (FROM ? null : lock?.source?.ref);
  if (!ref && !FROM) { console.error('no --ref and no lock to take one from — pass --ref vX.Y.Z'); process.exit(2); }
  let commit = null;
  if (FROM) {
    commit = execFileSync('git', ['rev-parse', `${ref || 'HEAD'}^{commit}`], { cwd: resolve(FROM), encoding: 'utf8' }).trim();
    ref = ref || commit;
  }
  const next = { lockVersion: 1, source: { repo: SOURCE_REPO, ref, ...(commit ? { commit } : {}) }, vendored: {}, watched: {} };
  for (const [from, dest] of Object.entries(VENDORED)) {
    const body = await fetchAt(ref, from);
    const abs = join(ROOT, dest);
    const changed = !existsSync(abs) || readFileSync(abs, 'utf8') !== body;
    if (changed) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body); }
    next.vendored[dest] = { from, sha256: digest(body) };
    console.log(`${changed ? 'wrote ' : 'same  '} ${dest}  <-  ${from}`);
  }
  for (const [from, why] of Object.entries(WATCHED)) {
    next.watched[from] = { sha256: digest(await fetchAt(ref, from)), why };
  }
  const prevWatched = lock?.watched || {};
  for (const [from, w] of Object.entries(next.watched)) {
    if (prevWatched[from] && prevWatched[from].sha256 !== w.sha256) {
      console.log(`review ${from} changed since ${lock.source.ref} — ${w.why}`);
    }
  }
  writeFileSync(LOCK, JSON.stringify(next, null, 2) + '\n');
  console.log(`pinned ${SOURCE_REPO}@${ref}`);
}

async function check() {
  const lock = readLock();
  if (!lock) {
    console.error('::error::no plugin-contract.lock.json — run: node tools/plugin-contract.mjs --vendor --ref vX.Y.Z');
    process.exit(1);
  }
  let bad = 0;
  for (const [dest, v] of Object.entries(lock.vendored || {})) {
    const abs = join(ROOT, dest);
    if (!existsSync(abs)) { console.error(`::error::${dest} is missing — run: node tools/plugin-contract.mjs --vendor`); bad++; continue; }
    if (digest(readFileSync(abs, 'utf8')) !== v.sha256) {
      // The one thing that must never happen: a hand-edited copy means the
      // validator answers for rules the app does not have.
      console.error(`::error::${dest} was edited — it must stay byte-identical to EXE ${v.from}@${lock.source.ref}. Re-vendor instead of editing.`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`contract ok — ${Object.keys(lock.vendored).length} vendored file(s) match ${lock.source.repo}@${lock.source.ref}`);

  if (!UPSTREAM) return;
  // Advisory: the pin can be behind without anything being wrong. Exit 0 and
  // say what moved, so CI can show it without going red on EXE's schedule.
  let moved = 0;
  const all = {
    ...Object.fromEntries(Object.entries(lock.vendored || {}).map(([, v]) => [v.from, v.sha256])),
    ...Object.fromEntries(Object.entries(lock.watched || {}).map(([from, w]) => [from, w.sha256])),
  };
  for (const [from, sha] of Object.entries(all)) {
    let body;
    try { body = await fetchAt(FROM ? 'HEAD' : 'main', from); }
    catch (e) { console.log(`::warning::could not read ${from} upstream: ${e.message}`); continue; }
    if (digest(body) !== sha) { console.log(`::warning::${from} has changed on ${SOURCE_REPO} main since ${lock.source.ref}`); moved++; }
  }
  console.log(moved
    ? `${moved} contract file(s) moved upstream — review, then: node tools/plugin-contract.mjs --vendor --ref <new tag>`
    : 'upstream main matches the pin');
}

(VENDOR ? vendor() : check()).catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
