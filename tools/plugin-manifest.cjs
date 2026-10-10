'use strict';
// Pure logic for the Plugin system — manifest validation and git-URL parsing.
// Deliberately requires NOTHING (no electron, no ./core, no fs), so it can be
// imported by `node --test` directly; src/db/plugin.js (which does need
// electron + the DB) re-exports what it needs from here. See docs/PLUGINS.md.
//
// Identifier safety is the whole security boundary at this layer: no
// prepared-statement parameter can bind a table/column name, so every dynamic
// SQL identifier composed from a manifest is checked against a strict
// whitelist regex before it ever reaches a query string.

const PLUGIN_ID_RE     = /^[a-z0-9_]{1,20}$/;
const PLUGIN_TABLE_RE  = /^[a-z0-9_]{1,20}$/;
const PLUGIN_COLUMN_RE = /^[a-z][a-z0-9_]{0,29}$/;
const FULL_TABLE_RE    = /^plg_[a-z0-9_]{1,41}$/; // 'plg_' + id(<=20) + '_' + name(<=20)
const LEGACY_TABLE_RE  = /^ext_[a-z0-9_]{1,41}$/; // pre-v4.2.0 prefix, migration only
// One path segment of a repo URL (owner, repo name, or a GitLab namespace
// level). Same character class the old GITHUB_ID_RE allowed.
const REPO_SEG_RE      = /^[A-Za-z0-9._-]{1,100}$/;
const COL_TYPES        = new Set(['TEXT', 'INTEGER', 'REAL']);
const RESERVED_COLS    = new Set(['id', 'rowid', 'oid', '_rowid_']);
const MAX_TABLES_PER_PLUGIN = 10;
const MAX_COLS_PER_TABLE = 25;
const MAX_FILES = 30;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB/file
const MAX_GITLAB_NS_DEPTH = 5;          // gitlab.com/a/b/c/d/project

// --- Plugin panels (v4.3.0) -------------------------------------------------
// A panel is a second entry HTML the main window embeds in a <webview> in place
// of the Module Inspector dock. Unlike `tables[].name`, a panel id never
// reaches SQL — it is a lookup key in the renderer — so the character class is
// only as strict as it needs to be to stay a safe DOM/attribute value.
const PANEL_ID_RE = /^[a-z0-9_-]{1,24}$/;
const MAX_PANELS = 5;
const MAX_PANEL_TITLE = 40;
const MAX_PANEL_ICON = 8;               // an emoji is up to ~7 UTF-16 units
// Hosts a plugin may reach through pluginApi.net.* . Declared here so the
// install preview can show them BEFORE any code is downloaded — see
// docs/PLUGINS.md §2.4 for why this is an allowlist and not a free-for-all.
const MAX_NET_ORIGINS = 10;
// Host->plugin context a plugin may receive. One value today; kept as a list so
// a second context kind doesn't change the manifest shape.
const CONTEXT_KINDS = new Set(['module']);
const MAX_CONTEXT_KINDS = CONTEXT_KINDS.size;
// Other plugins (by repo URL, same shapes §1.1 accepts) this one wants
// installed alongside it — see §1.8. Small cap: this is for "the AI plugins
// share a common capability plugin", not a general package manager.
const MAX_DEPENDENCIES = 5;

// The manifest filename is looked up in this order, so a repo written for the
// pre-v4.2.0 "extension" naming still installs unchanged.
const MANIFEST_NAMES = ['dracondex-plugin.json', 'dracondex-extension.json'];
// Tried in order when the URL carries no explicit branch/tag.
const REF_CANDIDATES = ['main', 'master'];

// Repos that exist to be COPIED, not installed. Both carry a `.dracondex`
// marker on purpose — so a repo made from one already opts into the
// recommend list without its author doing anything — which is exactly why
// the marker cannot be the thing that filters them back out. Recommending a
// template to a user looking for a plugin is nonsense: installing it yields
// a working-but-empty plugin whose id collides with every other copy.
//
// Matched on the repo NAME, lowercased, and only ever consulted by
// pluginListOrgRepos(). It is NOT an install block: pasting either link
// still installs, which is what someone poking at the template expects.
// Lives here rather than next to that function so `node --test` can reach it
// without pulling in electron, the same reason the validators are here.
const TEMPLATE_REPOS = new Set(['dracondex-pgi-template', 'dracondex-ext-template']);

function isTemplateRepoName(name) {
  return TEMPLATE_REPOS.has(String(name == null ? '' : name).toLowerCase());
}

// ---------------------------------------------------------------------------
// Manifest validation — rejects before anything is written to disk or the DB.
// ---------------------------------------------------------------------------
// Loopback is the one place a plaintext origin is defensible: the bytes never
// leave the machine, so there is no transport to downgrade — and a local model
// server (Ollama on 11434 is the case this was added for) has no https to offer.
// The explicit port is REQUIRED, and is the whole reason this is narrow: a bare
// `http://localhost` grant would quietly mean port 80, and the point is to name
// ONE local service, not everything bound to loopback. `new URL()` keeps IPv6
// hosts bracketed, hence '[::1]'.
//
// Still deliberately not allowed: http:// on any non-loopback host. That would
// be a real downgrade (plaintext over a network) plus an SSRF path into the
// user's LAN, and no amount of manifest declaring makes it visible to them.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function isLoopbackOrigin(u) {
  return LOOPBACK_HOSTS.has(u.hostname) && u.port !== '';
}

function netSchemeAllowed(u) {
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackOrigin(u);
}

// An entry of `permissions.net`: an https:// ORIGIN (or a loopback http:// one,
// see above) and nothing else. Rejecting a path/query/fragment keeps the runtime
// check a plain `origin ===` compare — a prefix match on a full URL would let
// `https://api.example.com/safe` be satisfied by
// `https://api.example.com/safe.evil.com`.
function normalizeNetOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  let u;
  try { u = new URL(value); } catch (_) { return null; }
  if (!netSchemeAllowed(u)) return null;
  if (u.username || u.password) return null;
  if (u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return u.origin;
}

// `panels` and `permissions` are both optional and both absent from every
// plugin written before v4.3.0, so a manifest that omits them stays valid.
function validatePanels(panels, files) {
  if (panels == null) return { ok: true };
  if (!Array.isArray(panels) || panels.length > MAX_PANELS) {
    return { ok: false, error: `"panels" must be an array of at most ${MAX_PANELS} entries` };
  }
  const seen = new Set();
  for (const p of panels) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'invalid panel entry' };
    if (!PANEL_ID_RE.test(String(p.id || ''))) return { ok: false, error: `invalid panel id: ${p?.id}` };
    if (seen.has(p.id)) return { ok: false, error: `duplicate panel id: ${p.id}` };
    seen.add(p.id);
    if (!p.title || typeof p.title !== 'string' || p.title.length > MAX_PANEL_TITLE) {
      return { ok: false, error: `invalid panel title for "${p.id}"` };
    }
    if (p.icon != null && (typeof p.icon !== 'string' || p.icon.length > MAX_PANEL_ICON)) {
      return { ok: false, error: `invalid panel icon for "${p.id}"` };
    }
    if (!p.entry || typeof p.entry !== 'string' || !/\.html?$/i.test(p.entry)) {
      return { ok: false, error: `panel "${p.id}" needs an HTML "entry"` };
    }
    // Same rule the top-level entry gets: the app only ever downloads paths
    // listed in `files`, so a panel entry outside it could never be loaded.
    if (!files.includes(p.entry)) return { ok: false, error: `panel "${p.id}" entry must be listed in "files"` };
  }
  return { ok: true };
}

function validatePermissions(permissions) {
  if (permissions == null) return { ok: true };
  if (typeof permissions !== 'object' || Array.isArray(permissions)) {
    return { ok: false, error: '"permissions" must be an object' };
  }
  const { net, context } = permissions;
  if (net != null) {
    if (!Array.isArray(net) || net.length > MAX_NET_ORIGINS) {
      return { ok: false, error: `"permissions.net" must be an array of at most ${MAX_NET_ORIGINS} origins` };
    }
    for (const origin of net) {
      if (!normalizeNetOrigin(origin)) {
        return { ok: false, error: `invalid net origin (https:// origin, or http:// on loopback with an explicit port): ${origin}` };
      }
    }
  }
  if (context != null) {
    if (!Array.isArray(context) || context.length > MAX_CONTEXT_KINDS) {
      return { ok: false, error: '"permissions.context" must be an array' };
    }
    for (const k of context) {
      if (!CONTEXT_KINDS.has(k)) return { ok: false, error: `unknown context permission: ${k}` };
    }
  }
  return { ok: true };
}

// `dependencies` (v4.8.0): other plugins to auto-install alongside this one —
// see §1.8. Each entry is a repo URL in any shape §1.1 accepts; parseRepoUrl
// is the same parser the paste-a-link install box uses, so anything a human
// could paste there a manifest can name here. Deliberately NOT recursive: a
// dependency's own "dependencies" are never consulted (pluginInstall in
// src/db/plugin.js resolves exactly one level), so no chain can form and there
// is no cycle to detect.
function validateDependencies(dependencies) {
  if (dependencies == null) return { ok: true };
  if (!Array.isArray(dependencies) || dependencies.length > MAX_DEPENDENCIES) {
    return { ok: false, error: `"dependencies" must be an array of at most ${MAX_DEPENDENCIES} entries` };
  }
  const seen = new Set();
  for (const dep of dependencies) {
    if (typeof dep !== 'string' || !dep.trim()) return { ok: false, error: `invalid dependency: ${dep}` };
    const parsed = parseRepoUrl(dep);
    if (!parsed.ok) return { ok: false, error: `invalid dependency url: ${dep}` };
    const key = `${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `duplicate dependency: ${dep}` };
    seen.add(key);
  }
  return { ok: true };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'manifest is not an object' };
  const { id, name, version, entry, files, tables, panels, permissions, dependencies } = manifest;

  if (!PLUGIN_ID_RE.test(String(id || ''))) return { ok: false, error: 'invalid or missing "id"' };
  if (!name || typeof name !== 'string' || name.length > 80) return { ok: false, error: 'invalid or missing "name"' };
  if (version != null && (typeof version !== 'string' || version.length > 40)) return { ok: false, error: 'invalid "version"' };
  if (!entry || typeof entry !== 'string') return { ok: false, error: 'invalid or missing "entry"' };

  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    return { ok: false, error: `"files" must be a non-empty array of at most ${MAX_FILES} entries` };
  }
  for (const f of files) {
    if (typeof f !== 'string' || !f || f.includes('..') || f.startsWith('/') || f.includes('\\')) {
      return { ok: false, error: `unsafe file path: ${f}` };
    }
  }
  if (!files.includes(entry)) return { ok: false, error: '"entry" must be listed in "files"' };

  const tableList = Array.isArray(tables) ? tables : [];
  if (tableList.length > MAX_TABLES_PER_PLUGIN) return { ok: false, error: `too many tables (max ${MAX_TABLES_PER_PLUGIN})` };
  const seenTables = new Set();
  for (const t of tableList) {
    if (!t || !PLUGIN_TABLE_RE.test(String(t.name || ''))) return { ok: false, error: `invalid table name: ${t?.name}` };
    if (seenTables.has(t.name)) return { ok: false, error: `duplicate table name: ${t.name}` };
    seenTables.add(t.name);

    const cols = Array.isArray(t.columns) ? t.columns : [];
    if (cols.length === 0 || cols.length > MAX_COLS_PER_TABLE) {
      return { ok: false, error: `table "${t.name}" must have 1-${MAX_COLS_PER_TABLE} columns` };
    }
    const seenCols = new Set();
    for (const c of cols) {
      const cname = String(c?.name || '');
      if (!c || !PLUGIN_COLUMN_RE.test(cname)) return { ok: false, error: `invalid column name in table "${t.name}": ${c?.name}` };
      if (RESERVED_COLS.has(cname.toLowerCase())) return { ok: false, error: `reserved column name: ${c.name}` };
      if (!COL_TYPES.has(String(c.type || '').toUpperCase())) return { ok: false, error: `invalid column type for "${c.name}": ${c.type}` };
      if (seenCols.has(cname)) return { ok: false, error: `duplicate column name: ${c.name}` };
      seenCols.add(cname);
    }
  }

  const panelCheck = validatePanels(panels, files);
  if (!panelCheck.ok) return panelCheck;
  const permCheck = validatePermissions(permissions);
  if (!permCheck.ok) return permCheck;
  const depsCheck = validateDependencies(dependencies);
  if (!depsCheck.ok) return depsCheck;

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reading the v4.3.0 fields back out of a stored manifest. `manifest_json` in
// the plugin row is the whole manifest verbatim, so these are the only place
// that knows how to shape it for the renderer and the pluginApi guards — and
// they re-validate rather than trusting what's on disk, since the row was
// written by whatever manifest the repo served at install time.
// ---------------------------------------------------------------------------
function manifestPanels(manifest) {
  if (!Array.isArray(manifest?.panels)) return [];
  return manifest.panels
    .filter((p) => p && PANEL_ID_RE.test(String(p.id || '')) && typeof p.entry === 'string')
    .map((p) => ({ id: p.id, title: String(p.title || p.id), icon: typeof p.icon === 'string' ? p.icon : null, entry: p.entry }));
}

function manifestNetOrigins(manifest) {
  const net = manifest?.permissions?.net;
  if (!Array.isArray(net)) return [];
  return net.map(normalizeNetOrigin).filter(Boolean);
}

function manifestContextKinds(manifest) {
  const context = manifest?.permissions?.context;
  if (!Array.isArray(context)) return [];
  return context.filter((k) => CONTEXT_KINDS.has(k));
}

function manifestDependencies(manifest) {
  if (!Array.isArray(manifest?.dependencies)) return [];
  return manifest.dependencies.filter((d) => typeof d === 'string' && d.trim());
}

// The single yes/no a pluginApi.net.* call is gated on. Compares ORIGINS, never
// prefixes — see normalizeNetOrigin above.
function netOriginAllowed(manifest, url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return false; }
  // Re-checked here and not just at install: manifest_json is whatever the repo
  // served back then, so the runtime never trusts it to have been validated by
  // the rules currently in force.
  if (!netSchemeAllowed(u)) return false;
  return manifestNetOrigins(manifest).includes(u.origin);
}

// ---------------------------------------------------------------------------
// Git URL parsing — one input field accepts every shape a user can copy out of
// GitHub/GitLab. Returns { ok, host, owner, repo, ref } or { ok:false, code }.
// `owner` may contain '/' for GitLab nested groups; `repo` never does.
// `ref` is null when the URL didn't name one (caller then tries
// REF_CANDIDATES). This function never touches the network.
// ---------------------------------------------------------------------------
const HOST_BY_DOMAIN = {
  'github.com': 'github', 'www.github.com': 'github',
  'gitlab.com': 'gitlab', 'www.gitlab.com': 'gitlab',
};

// Strips scheme/userinfo and the scp-style `git@host:path` form down to
// "host/path", so one path-splitting routine handles every shape below.
function stripToHostPath(raw) {
  let s = raw;
  const scp = s.match(/^(?:ssh:\/\/)?[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`;         // git@github.com:o/r.git
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // https:// http:// ssh:// git://
  s = s.replace(/^[A-Za-z0-9._-]+@/, '');        // ssh://git@github.com/o/r
  return s;
}

function parseRepoUrl(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { ok: false, code: 'bad_url' };
  if (/\s/.test(s)) return { ok: false, code: 'bad_url' };

  s = stripToHostPath(s);
  s = s.split('#')[0].split('?')[0];             // drop fragment/query
  s = s.replace(/\/+$/, '');                     // drop trailing slashes
  if (!s) return { ok: false, code: 'bad_url' };

  let segs = s.split('/').filter(Boolean);
  if (!segs.length) return { ok: false, code: 'bad_url' };

  // Leading segment is a host only if it looks like one. `owner/repo`
  // shorthand has no host at all and defaults to GitHub.
  let host = null;
  const first = segs[0].toLowerCase();
  if (HOST_BY_DOMAIN[first]) { host = HOST_BY_DOMAIN[first]; segs = segs.slice(1); }
  else if (first.includes('.')) return { ok: false, code: 'unsupported_host' };
  else host = 'github';

  if (segs.length < 2) return { ok: false, code: 'bad_url' };

  // Split "project path" from an optional "/tree/<ref>" | "/blob/<ref>/…"
  // suffix. GitLab puts a literal `/-/` marker before those; GitHub doesn't.
  let ref = null;
  const dash = segs.indexOf('-');
  let pathSegs;
  if (host === 'gitlab' && dash > 0) {
    pathSegs = segs.slice(0, dash);
    const rest = segs.slice(dash + 1);
    if (rest.length >= 2 && (rest[0] === 'tree' || rest[0] === 'blob' || rest[0] === 'raw')) {
      ref = rest.slice(1).join('/');
    }
  } else {
    const kw = segs.findIndex((v, i) => i >= 2 && (v === 'tree' || v === 'blob' || v === 'raw'));
    if (kw > 0) {
      pathSegs = segs.slice(0, kw);
      const rest = segs.slice(kw + 1);
      if (!rest.length) return { ok: false, code: 'bad_url' };
      // For /blob/<ref>/<file> the file path is unknowable from the ref alone;
      // take the first segment as the ref and ignore the rest. For /tree/<ref>
      // the whole remainder is the ref (branch names may contain '/').
      ref = segs[kw] === 'tree' ? rest.join('/') : rest[0];
    } else {
      pathSegs = segs;
    }
  }

  if (pathSegs.length < 2) return { ok: false, code: 'bad_url' };
  // Strip the .git suffix off the project segment only.
  pathSegs = pathSegs.slice();
  pathSegs[pathSegs.length - 1] = pathSegs[pathSegs.length - 1].replace(/\.git$/i, '');

  if (host === 'github' && pathSegs.length !== 2) return { ok: false, code: 'bad_url' };
  if (host === 'gitlab' && pathSegs.length > MAX_GITLAB_NS_DEPTH + 1) return { ok: false, code: 'bad_url' };
  for (const seg of pathSegs) {
    if (!REPO_SEG_RE.test(seg) || seg === '.' || seg === '..') return { ok: false, code: 'bad_url' };
  }

  if (ref != null) {
    const refSegs = ref.split('/').filter(Boolean);
    if (!refSegs.length || refSegs.length > 8) return { ok: false, code: 'bad_url' };
    for (const seg of refSegs) {
      if (!REPO_SEG_RE.test(seg) || seg === '.' || seg === '..') return { ok: false, code: 'bad_url' };
    }
    ref = refSegs.join('/');
  }

  const repo = pathSegs[pathSegs.length - 1];
  const owner = pathSegs.slice(0, -1).join('/');
  if (!owner || !repo) return { ok: false, code: 'bad_url' };
  return { ok: true, host, owner, repo, ref };
}

// Encodes each '/'-separated segment individually — encodeURIComponent on the
// whole string would turn the separators into %2F and break the URL.
const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

// Raw-file URL for one declared manifest file. GitHub serves bytes straight
// from raw.githubusercontent.com; GitLab from /-/raw/ on the main domain.
// Neither needs the Contents API (no base64 round-trip, no token).
function rawUrl(repoRef, filePath) {
  const { host, owner, repo, ref } = repoRef;
  if (host === 'gitlab') {
    return `https://gitlab.com/${encPath(owner)}/${encodeURIComponent(repo)}/-/raw/${encPath(ref)}/${encPath(filePath)}`;
  }
  return `https://raw.githubusercontent.com/${encPath(owner)}/${encodeURIComponent(repo)}/${encPath(ref)}/${encPath(filePath)}`;
}

module.exports = {
  PLUGIN_ID_RE, PLUGIN_TABLE_RE, PLUGIN_COLUMN_RE, FULL_TABLE_RE, LEGACY_TABLE_RE,
  REPO_SEG_RE, COL_TYPES, RESERVED_COLS,
  MAX_TABLES_PER_PLUGIN, MAX_COLS_PER_TABLE, MAX_FILES, MAX_FILE_BYTES,
  MANIFEST_NAMES, REF_CANDIDATES, TEMPLATE_REPOS, isTemplateRepoName,
  PANEL_ID_RE, MAX_PANELS, MAX_NET_ORIGINS, CONTEXT_KINDS, MAX_DEPENDENCIES,
  validateManifest, parseRepoUrl, rawUrl,
  manifestPanels, manifestNetOrigins, manifestContextKinds, manifestDependencies, netOriginAllowed,
};
