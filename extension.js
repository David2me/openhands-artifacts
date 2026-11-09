const ROOT_PATH = '/extensions/artifacts/artifacts';
const KINDS = ['uploaded', 'created', 'edited', 'written', 'shared', 'mentioned', 'viewed'];
const KIND_LABEL = { uploaded: 'Uploaded by you', created: 'Created', edited: 'Edited', written: 'Written by a command', shared: 'Shown as image', mentioned: 'Mentioned', viewed: 'Viewed only' };
const IGNORED_PREFIXES = ['/proc/', '/sys/', '/dev/', '/usr/', '/etc/', '/bin/', '/sbin/', '/lib/', '/var/lib/', '/opt/conda/', '/root/.cache/'];
const IGNORED_PARTS = ['/node_modules/', '/.git/', '/__pycache__/', '/.venv/', '/site-packages/', '/.gradle/', '/build/intermediates/'];
const PROJECTS_PREFIX = '/projects/';
const INCLUDE_VIEWED = true;
const CHUNK_BYTES = 393216;
const REFRESH_MS = 60000;
const CACHE_VERSION = 1;
const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'log', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'html', 'htm', 'css', 'svg', 'sql', 'java', 'kt', 'rs', 'go', 'c', 'cpp', 'h', 'cs', 'gradle', 'cmd', 'bat', 'ps1'];
const MEDIA_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' };

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

function normalizePath(p, cwd) {
  if (!p) return null;
  let s = String(p).trim();
  s = s.replace(/^[`'"(<\[]+/, '').replace(/[`'">)\],.:;!?]+$/, '');
  if (!s || s === '.' || s === '..') return null;
  if (s.startsWith('~/')) s = '/home/openhands/' + s.slice(2);
  if (!s.startsWith('/')) {
    if (!cwd) return null;
    s = cwd.replace(/\/+$/, '') + '/' + s;
  }
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  s = '/' + parts.join('/');
  if (s === '/') return null;
  if (IGNORED_PREFIXES.some((pre) => s.startsWith(pre))) return null;
  if (IGNORED_PARTS.some((part) => s.includes(part))) return null;
  if (/[\s*?<>|\\:(){}\[\],;=+'"]/.test(s)) return null;
  if (/\$[{(]?\w/.test(s)) return null;
  return s;
}

function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('\n');
  if (content.text) return content.text;
  return '';
}

function snippet(s, n = 240) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
}

const ABS_PATH_RE = /(?:^|[\s`'"(\[<=:])((?:\/home\/[\w.-]+|\/projects|\/tmp|\/workspace|\/mnt|\/data|\/app|\/srv)\/[\w./@%+=-]+)/g;
const REL_PATH_RE = /`([\w@%+=-][\w./@%+=-]*\.[A-Za-z0-9]{1,8})`/g;

function pathsInText(text, cwd) {
  const out = new Set();
  if (!text) return out;
  let m;
  ABS_PATH_RE.lastIndex = 0;
  while ((m = ABS_PATH_RE.exec(text))) {
    const p = normalizePath(m[1], cwd);
    if (p) out.add(p);
  }
  REL_PATH_RE.lastIndex = 0;
  while ((m = REL_PATH_RE.exec(text))) {
    if (m[1].includes('://')) continue;
    const p = normalizePath(m[1], cwd);
    if (p && /\.[A-Za-z0-9]{1,8}$/.test(p)) out.add(p);
  }
  return out;
}

function stripShellNoise(command) {
  let out = String(command).replace(/\$\{?HOME\}?/g, '/home/openhands');
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (m) => m.split('\n')[0]);
  out = out.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => (/[\s()[\]{};<>|]/.test(q) ? '""' : q));
  return out;
}

function pathsInCommand(rawCommand, cwd) {
  const out = [];
  if (!rawCommand) return out;
  const command = stripShellNoise(rawCommand);
  let effectiveCwd = cwd;
  const push = (raw, kind) => {
    const p = normalizePath(raw, effectiveCwd);
    if (p && p !== '/dev/null') out.push({ path: p, kind });
  };
  for (const stmtRaw of command.split(/&&|\|\||;|\n|\(|\)/)) {
    const stmt = stmtRaw.trim();
    if (!stmt) continue;
    const cd = /^cd\s+(["']?)([^\s"'&;|]+)\1\s*$/.exec(stmt);
    if (cd) { effectiveCwd = normalizePath(cd[2], effectiveCwd) || effectiveCwd; continue; }
    const redir = /(?:^|[^<>])(?:\d?>>?|&>)\s*(["']?)([^\s"'&;|<>]+)\1/g;
    let m;
    while ((m = redir.exec(stmt))) { if (/^&\d$/.test(m[2])) continue; push(m[2], 'written'); }
    const tee = /(?:^|\|)\s*tee\s+(?:-[a-z]+\s+)*(["']?)([^\s"'&;|<>]+)\1/g;
    while ((m = tee.exec(stmt))) push(m[2], 'written');
    const cm = /^(?:sudo\s+)?(cp|mv|install)\b(.*)$/.exec(stmt);
    if (cm) {
      const args = cm[2].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      if (args.length >= 2) push(args[args.length - 1], 'written');
    }
    let zm = /^(?:sudo\s+)?zip\s+(?:-[a-zA-Z0-9]+\s+)*(["']?)([^\s"']+\.zip)\1/.exec(stmt);
    if (zm) push(zm[2], 'written');
    zm = /^(?:sudo\s+)?tar\s+(?:-?[a-zA-Z]*[cC][a-zA-Z]*f)\s+(["']?)([^\s"']+)\1/.exec(stmt);
    if (zm) push(zm[2], 'written');
    zm = /^(?:sudo\s+)?(?:curl|wget)\b.*?\s-[oO]\s+(["']?)([^\s"']+)\1/.exec(stmt);
    if (zm) push(zm[2], 'written');
    zm = /^(?:sudo\s+)?wget\b.*?--output-document[= ]+(["']?)([^\s"']+)\1/.exec(stmt);
    if (zm) push(zm[2], 'written');
    zm = /^(?:pandoc|ffmpeg|magick|convert|inkscape|gs|libreoffice|soffice)\b.*?\s(?:-o|--output|--outfile)[= ]+(["']?)([^\s"']+)\1/.exec(stmt);
    if (zm) push(zm[2], 'written');
  }
  return out;
}

function extractFromEvent(ev, ctx) {
  const found = [];
  const cwd = ctx.workingDir;
  if (ev.kind === 'MessageEvent') {
    const text = textOf(ev.llm_message && ev.llm_message.content);
    if (ev.source === 'user') {
      const re = /NEW FILES? ADDED:\s*([^\n]+)/gi;
      let m;
      while ((m = re.exec(text))) {
        for (const name of m[1].split(/,\s*/)) {
          const p = normalizePath(name.trim(), cwd);
          if (p) found.push({ path: p, kind: 'uploaded', note: 'Uploaded by you' });
        }
      }
      const parts = ev.llm_message && ev.llm_message.content;
      if (Array.isArray(parts)) {
        for (const c of parts) {
          if (c && c.type === 'file' && c.path) {
            const p = normalizePath(c.path, cwd);
            if (p) found.push({ path: p, kind: 'uploaded', note: 'Uploaded by you' });
          }
        }
      }
    } else {
      for (const p of pathsInText(text, cwd)) found.push({ path: p, kind: 'mentioned', note: snippet(text) });
    }
    return found;
  }
  if (ev.kind !== 'ActionEvent' || !ev.action) return found;
  const a = ev.action;
  const tool = String(ev.tool_name || '');
  const data = a.data && typeof a.data === 'object' ? a.data : a;
  if (tool === 'file_editor' || tool === 'planning_file_editor' || a.kind === 'FileEditorAction') {
    const p = normalizePath(a.path, cwd);
    if (p) {
      const cmd = a.command;
      if (cmd === 'create') found.push({ path: p, kind: 'created', note: 'Created with the file editor' });
      else if (cmd === 'view') { if (INCLUDE_VIEWED) found.push({ path: p, kind: 'viewed', note: 'Viewed' }); }
      else found.push({ path: p, kind: 'edited', note: 'Edited (' + (cmd || 'edit') + ')' });
    }
    return found;
  }
  if (tool === 'write_file' || /write_file$/.test(tool)) {
    const p = normalizePath(data.path || data.file_path, cwd);
    if (p) found.push({ path: p, kind: 'created', note: 'Written with write_file' });
    return found;
  }
  if (tool === 'edit' || /edit_file$/.test(tool) || /^(filesystem_)?edit$/.test(tool)) {
    const p = normalizePath(data.path || data.file_path, cwd);
    if (p) found.push({ path: p, kind: 'edited', note: 'Edited' });
    return found;
  }
  if (/read_media_file$/.test(tool) || tool === 'image_view' || /view_image$/.test(tool)) {
    const p = normalizePath(data.path || data.file_path, cwd);
    if (p) found.push({ path: p, kind: 'shared', note: 'Shown to the model as an image' });
    return found;
  }
  if (tool === 'read_file' || /read_file$/.test(tool) || /read_text_file$/.test(tool)) {
    if (INCLUDE_VIEWED) {
      const p = normalizePath(data.path || data.file_path, cwd);
      if (p) found.push({ path: p, kind: 'viewed', note: 'Read' });
    }
    return found;
  }
  if (/move_file$/.test(tool)) {
    const s = normalizePath(data.source, cwd);
    const d = normalizePath(data.destination, cwd);
    if (d) found.push({ path: d, kind: 'written', note: s ? 'Moved from ' + s : 'Moved' });
    return found;
  }
  if (tool === 'terminal' || tool === 'execute_bash' || a.kind === 'TerminalAction' || a.kind === 'ExecuteBashAction') {
    if (a.is_input) return found;
    const command = a.command || '';
    for (const f of pathsInCommand(command, cwd)) found.push({ ...f, note: snippet(command) });
    return found;
  }
  if (tool === 'finish' || a.kind === 'FinishAction') {
    const text = a.message || '';
    for (const p of pathsInText(text, cwd)) found.push({ path: p, kind: 'mentioned', note: snippet(text) });
    return found;
  }
  if (tool === 'browser_screenshot' || /screenshot$/.test(tool)) {
    const p = normalizePath(data.path || data.file_path || data.output_path, cwd);
    if (p) found.push({ path: p, kind: 'created', note: 'Screenshot' });
    return found;
  }
  return found;
}

function extractFiles(events, conv) {
  const ctx = { workingDir: (conv.workspace && conv.workspace.working_dir) || '/home/openhands/workspace' };
  const byPath = new Map();
  for (const ev of events) {
    let hits;
    try { hits = extractFromEvent(ev, ctx); } catch (e) { hits = []; }
    for (const h of hits) {
      let rec = byPath.get(h.path);
      if (!rec) {
        rec = { path: h.path, name: baseName(h.path), firstSeen: ev.timestamp, lastSeen: ev.timestamp, kinds: [], firstKind: h.kind, note: h.note || '', eventId: ev.id, appearances: 0 };
        byPath.set(h.path, rec);
      }
      rec.appearances += 1;
      if (ev.timestamp > rec.lastSeen) rec.lastSeen = ev.timestamp;
      if (ev.timestamp < rec.firstSeen) { rec.firstSeen = ev.timestamp; rec.firstKind = h.kind; rec.note = h.note || rec.note; rec.eventId = ev.id; }
      if (!rec.kinds.includes(h.kind)) rec.kinds.push(h.kind);
    }
  }
  const out = [];
  for (const rec of byPath.values()) {
    rec.kinds.sort((x, y) => KINDS.indexOf(x) - KINDS.indexOf(y));
    rec.kind = rec.kinds[0];
    out.push(rec);
  }
  return out;
}

function mergeFiles(base, extra) {
  const map = new Map(base.map((f) => [f.path, { ...f, kinds: [...f.kinds] }]));
  for (const f of extra) {
    const cur = map.get(f.path);
    if (!cur) { map.set(f.path, f); continue; }
    cur.appearances += f.appearances;
    if (f.lastSeen > cur.lastSeen) cur.lastSeen = f.lastSeen;
    if (f.firstSeen < cur.firstSeen) { cur.firstSeen = f.firstSeen; cur.firstKind = f.firstKind; cur.note = f.note; cur.eventId = f.eventId; }
    for (const k of f.kinds) if (!cur.kinds.includes(k)) cur.kinds.push(k);
    cur.kinds.sort((x, y) => KINDS.indexOf(x) - KINDS.indexOf(y));
    cur.kind = cur.kinds[0];
  }
  return [...map.values()];
}

function createApi(host) {
  const call = async (method, path, body) => {
    const res = await host.agentServer.request({ method, path, ...(body === undefined ? {} : { body }) });
    if (typeof res === 'string') { try { return JSON.parse(res); } catch (e) { return res; } }
    return res;
  };
  const pages = async (base, params) => {
    const items = [];
    let pageId = null;
    do {
      const q = new URLSearchParams(params);
      if (pageId) q.set('page_id', pageId);
      const page = await call('GET', base + '?' + q);
      items.push(...((page && page.items) || []));
      pageId = (page && page.next_page_id) || null;
    } while (pageId);
    return items;
  };
  return {
    listConversations: () => pages('/api/conversations/search', { limit: '100' }),
    listEvents: (id, since) => pages('/api/conversations/' + encodeURIComponent(id) + '/events/search', since ? { limit: '100', sort_order: 'TIMESTAMP', timestamp__gte: since } : { limit: '100', sort_order: 'TIMESTAMP' }),
    async runBash(command, timeout = 60) {
      const out = await call('POST', '/api/bash/execute_bash_command', { command, timeout });
      return { stdout: (out && out.stdout) || '', exitCode: out ? out.exit_code : null };
    },
  };
}

function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function statPaths(api, paths) {
  const result = new Map();
  for (let i = 0; i < paths.length; i += 400) {
    const chunk = paths.slice(i, i + 400);
    const b64 = utf8ToBase64(chunk.join('\n') + '\n');
    const script = 'echo ' + b64 + ' | base64 -d | while IFS= read -r p; do if [ -f "$p" ]; then echo "f|$(stat -c %s "$p")|$(stat -c %Y "$p")|$p"; elif [ -d "$p" ]; then echo "d|0|$(stat -c %Y "$p")|$p"; else echo "x|0|0|$p"; fi; done';
    try {
      const { stdout } = await api.runBash(script, 120);
      for (const line of stdout.split('\n')) {
        const [t, size, mtime, ...rest] = line.split('|');
        const p = rest.join('|');
        if (!p || !t) continue;
        result.set(p, { exists: t !== 'x', isDir: t === 'd', size: Number(size) || 0, mtime: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : null });
      }
    } catch (e) { /* leave unknown */ }
  }
  return result;
}

async function readBytes(api, path, size) {
  const out = new Uint8Array(size);
  let off = 0;
  while (off < size) {
    const n = Math.min(CHUNK_BYTES, size - off);
    const r = await api.runBash('tail -c +' + (off + 1) + ' ' + "'" + path + "'" + ' | head -c ' + n + ' | base64 -w0', 120);
    const bin = atob(r.stdout.trim());
    if (bin.length !== n) throw new Error('Short read from the container (' + bin.length + ' of ' + n + ' bytes). The file may have changed or the output was truncated.');
    for (let i = 0; i < n; i++) out[off + i] = bin.charCodeAt(i);
    off += n;
  }
  return out;
}

const cacheKey = (host) => 'oh-artifacts:v' + CACHE_VERSION + ':' + host.backend.id + ':' + (host.backend.orgId || 'local');
function loadCache(key) {
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.conversations) return c; } catch (e) { /* fresh cache */ }
  return { conversations: {} };
}
function saveCache(key, cache) {
  try { localStorage.setItem(key, JSON.stringify(cache)); } catch (e) { /* storage full: cache is optional */ }
}

async function scan(api, cache, signal, force) {
  const started = Date.now();
  const convs = await api.listConversations();
  const seen = new Set();
  for (const conv of convs) {
    if (signal.disposed) break;
    seen.add(conv.id);
    const cached = cache.conversations[conv.id];
    if (cached && !force && cached.leafEventId === conv.leaf_event_id && cached.updatedAt === conv.updated_at) {
      cached.title = conv.title || cached.title;
      continue;
    }
    let events;
    let base = [];
    if (cached && !force && cached.lastEventTimestamp) {
      const fresh = await api.listEvents(conv.id, cached.lastEventTimestamp);
      const known = new Set(cached.eventIds || []);
      events = fresh.filter((e) => !known.has(e.id));
      base = cached.files || [];
    } else {
      events = await api.listEvents(conv.id);
    }
    const merged = mergeFiles(base, extractFiles(events, conv));
    const lastTs = events.reduce((m, e) => (e.timestamp > m ? e.timestamp : m), (cached && cached.lastEventTimestamp) || '');
    cache.conversations[conv.id] = {
      id: conv.id,
      title: conv.title || '(untitled)',
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      leafEventId: conv.leaf_event_id,
      workingDir: conv.workspace && conv.workspace.working_dir,
      status: conv.execution_status,
      lastEventTimestamp: lastTs || null,
      eventIds: events.filter((e) => e.timestamp === lastTs).map((e) => e.id),
      files: merged,
    };
  }
  if (!signal.disposed) for (const id of Object.keys(cache.conversations)) if (!seen.has(id)) cache.conversations[id].deleted = true;
  return { at: new Date().toISOString(), ms: Date.now() - started, conversations: convs.length };
}

async function buildList(api, cache, check) {
  const convs = Object.values(cache.conversations).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const rows = [];
  for (const c of convs) {
    for (const f of c.files || []) {
      rows.push({ ...f, conversationId: c.id, conversationTitle: c.title, conversationCreatedAt: c.createdAt, conversationDeleted: !!c.deleted, inProjects: f.path.startsWith(PROJECTS_PREFIX) });
    }
  }
  if (check && rows.length) {
    const stats = await statPaths(api, [...new Set(rows.map((r) => r.path))]);
    for (const r of rows) {
      const s = stats.get(r.path);
      if (s) Object.assign(r, s); else r.exists = null;
    }
  }
  let list = rows.filter((r) => !(r.kinds.length === 1 && r.kinds[0] === 'mentioned' && r.exists === false));
  list = list.filter((r) => {
    const weak = r.kinds.every((k) => k === 'written' || k === 'mentioned' || k === 'viewed');
    return !(weak && r.exists === false && !/\.[A-Za-z0-9]{1,8}$/.test(r.name));
  });
  list = list.filter((r) => !(r.isDir && r.kinds.every((k) => k === 'mentioned' || k === 'viewed')));
  list.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0));
  return list;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const fmtSize = (n) => (n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function icon(name, isDir) {
  if (isDir) return '\uD83D\uDCC1';
  const e = extOf(name);
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(e)) return '\uD83D\uDDBC\uFE0F';
  if (/^(md|txt|rtf|docx?|pdf|odt)$/.test(e)) return '\uD83D\uDCC4';
  if (/^(zip|tar|gz|tgz|7z|rar|apk|aab|jar)$/.test(e)) return '\uD83D\uDCE6';
  if (TEXT_EXT.includes(e)) return '\uD83E\uDDE9';
  if (/^(mp3|wav|ogg|m4a|flac)$/.test(e)) return '\uD83C\uDFB5';
  if (/^(mp4|mov|webm|mkv)$/.test(e)) return '\uD83C\uDFAC';
  if (/^(csv|xlsx?|ods)$/.test(e)) return '\uD83D\uDCCA';
  return '\uD83D\uDCCE';
}

const CSS = `
.ohart{--a-bg:var(--oh-color-base,#0b0e14);--a-panel:var(--oh-color-base-secondary,#21252f);--a-panel2:var(--oh-surface-raised,#2c313f);--a-line:var(--oh-border,#3a4150);--a-text:var(--oh-foreground,#eef2f7);--a-contrast:var(--oh-contrast,#fff);--a-muted:var(--oh-muted,#a3b0c4);--a-accent:var(--oh-color-primary,#f3ce49);--a-hover:var(--oh-interactive-hover,#2a2f3b);--a-bad:var(--oh-danger,#ef6b73);--a-ok:#4cc38a;--a-warn:#f5b84f;--a-info:#6ea8fe;--a-up:#c7a2ff;--a-wr:#8fd3ff;--a-sh:#ffd166;color:var(--a-text);font-size:14px;line-height:1.4;min-height:100%;padding:16px;box-sizing:border-box}
.ohart *{box-sizing:border-box}
.ohart header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:12px}
.ohart h1{font-size:20px;margin:0;font-weight:650;color:var(--a-contrast)}
.ohart .sub,.ohart .hint{color:var(--a-muted);font-size:12.5px}
.ohart .spacer{flex:1}
.ohart .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.ohart input[type=search],.ohart select,.ohart button{background:var(--a-panel);border:1px solid var(--a-line);color:var(--a-text);border-radius:8px;height:36px;padding:0 12px;font:inherit}
.ohart input[type=search]{width:300px;max-width:100%}
.ohart button{cursor:pointer}
.ohart button:hover,.ohart select:hover{border-color:var(--a-accent)}
.ohart :focus-visible{outline:2px solid var(--a-accent);outline-offset:1px}
.ohart label.chk{display:inline-flex;align-items:center;gap:5px;color:var(--a-muted);cursor:pointer;padding:4px 6px;border-radius:6px}
.ohart label.chk:hover{background:var(--a-hover)}
.ohart .kinds{display:flex;gap:2px;align-items:center;flex-wrap:wrap}
.ohart .tablewrap{overflow-x:auto;border:1px solid var(--a-line);border-radius:12px;background:var(--a-panel)}
.ohart table{width:100%;border-collapse:collapse;min-width:900px}
.ohart th{text-align:left;font-weight:600;color:var(--a-muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px;padding:9px 12px;border-bottom:1px solid var(--a-line)}
.ohart tbody tr{border-bottom:1px solid var(--a-line);cursor:default}
.ohart tbody tr:last-child{border-bottom:0}
.ohart tbody tr:hover{background:var(--a-hover)}
.ohart tbody tr.sel{background:var(--a-panel2)}
.ohart tbody tr.gone{opacity:.62}
.ohart td{padding:8px 12px;vertical-align:top}
.ohart td.time{white-space:nowrap;color:var(--a-muted);width:150px}
.ohart td.name{font-weight:560;color:var(--a-contrast)}
.ohart td.name .path{display:block;color:var(--a-muted);font-weight:400;font-size:12px;font-family:ui-monospace,Consolas,monospace;word-break:break-all;margin-top:2px}
.ohart td.conv{color:var(--a-muted);max-width:260px}
.ohart td.conv a,.ohart tr.group a{color:inherit;text-decoration:none}
.ohart td.conv a:hover,.ohart tr.group a:hover{color:var(--a-accent)}
.ohart td.where{white-space:nowrap}
.ohart td.size{white-space:nowrap;color:var(--a-muted);text-align:right}
.ohart .ico{display:inline-block;width:20px;text-align:center;margin-right:6px}
.ohart .badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--a-line);color:var(--a-muted);margin-right:4px;white-space:nowrap}
.ohart .badge.uploaded{color:var(--a-up);border-color:var(--a-up)}
.ohart .badge.created{color:var(--a-ok);border-color:var(--a-ok)}
.ohart .badge.edited{color:var(--a-info);border-color:var(--a-info)}
.ohart .badge.written{color:var(--a-wr);border-color:var(--a-wr)}
.ohart .badge.shared{color:var(--a-sh);border-color:var(--a-sh)}
.ohart .badge.viewed{border-style:dashed}
.ohart .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.ohart .dot.ok{background:var(--a-ok)}.ohart .dot.warn{background:var(--a-warn)}.ohart .dot.bad{background:var(--a-bad)}.ohart .dot.unk{background:var(--a-muted)}
.ohart tr.group td{background:var(--a-panel2);color:var(--a-contrast);font-weight:600;padding:10px 12px}
.ohart tr.group small{color:var(--a-muted);font-weight:400;margin-left:8px}
.ohart .empty{padding:48px 20px;text-align:center;color:var(--a-muted)}
.ohart .menu{position:fixed;z-index:50;min-width:240px;background:var(--a-panel);border:1px solid var(--a-line);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.35);padding:6px;display:none}
.ohart .menu.open{display:block}
.ohart .menu div{padding:8px 12px;border-radius:7px;cursor:pointer;display:flex;justify-content:space-between;gap:16px}
.ohart .menu div:hover{background:var(--a-hover)}
.ohart .menu hr{border:0;border-top:1px solid var(--a-line);margin:5px 0}
.ohart .menu .k{color:var(--a-muted);font-size:12px}
.ohart .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--a-panel);border:1px solid var(--a-line);padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:80vw;display:none;z-index:60}
.ohart .toast.show{display:block}.ohart .toast.bad{border-color:var(--a-bad)}
.ohart footer{margin-top:10px;color:var(--a-muted);font-size:12px;display:flex;gap:18px;flex-wrap:wrap}
.ohart .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--a-line);border-top-color:var(--a-accent);border-radius:50%;animation:ohart-spin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes ohart-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ohart .spin{animation:none}}
`;

const SHELL = `
<header><h1>Artifacts</h1><span class='sub' id='summary'>Loading\u2026</span><span class='spacer'></span><span class='hint'>Right-click a file for Download, Preview and more. Double-click previews it.</span></header>
<div class='toolbar'>
  <input type='search' id='q' placeholder='Filter by name, path or conversation\u2026' aria-label='Filter files'>
  <select id='order' aria-label='Sort order'><option value='asc'>Oldest first</option><option value='desc'>Newest first</option></select>
  <label class='chk'><input type='checkbox' id='group'> Group by conversation</label>
  <label class='chk'><input type='checkbox' id='hideGone'> Hide missing files</label>
  <span class='kinds' id='kinds'></span>
  <span class='spacer'></span>
  <button id='rescan' type='button' title='Re-read all conversations'>Rescan</button>
</div>
<div class='tablewrap'><table>
  <thead><tr><th style='width:150px'>First seen</th><th>File</th><th style='width:180px'>How it appeared</th><th style='width:240px'>Conversation</th><th style='width:190px'>Where it is</th><th style='width:90px;text-align:right'>Size</th></tr></thead>
  <tbody id='rows'></tbody>
</table><div class='empty' id='empty' style='display:none'></div></div>
<footer><span>Files under <code>/projects</code> are synced to your PC; everything else lives only in the container, so use Download to keep it.</span><span class='spacer'></span><span id='scanInfo'></span></footer>
<div class='menu' id='menu'>
  <div data-act='download'>Download <span class='k'>Enter</span></div>
  <div data-act='preview'>Preview in new tab <span class='k'>Double-click</span></div>
  <hr>
  <div data-act='copyPath'>Copy container path</div>
  <div data-act='conv'>Open conversation</div>
</div>
<div class='toast' id='toast' role='status'></div>
`;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('oh-artifacts-prefs') || '{}');
    return { order: p.order === 'desc' ? 'desc' : 'asc', group: !!p.group, hideGone: !!p.hideGone, kinds: new Set(Array.isArray(p.kinds) ? p.kinds.filter((k) => KINDS.includes(k)) : KINDS.filter((k) => k !== 'viewed')) };
  } catch (e) {
    return { order: 'asc', group: false, hideGone: false, kinds: new Set(KINDS.filter((k) => k !== 'viewed')) };
  }
}

function mountArtifacts(host, ctx) {
  const { container } = ctx;
  if (ctx.path) { ctx.navigate(ROOT_PATH); return undefined; }
  const api = createApi(host);
  const key = cacheKey(host);
  const cache = loadCache(key);
  const signal = { disposed: false };
  const state = { items: [], view: [], q: '', sel: null, menuRow: null, error: null, busy: false, ...loadPrefs() };
  const urls = new Set();
  let toastTimer = 0;

  const style = document.createElement('style');
  style.setAttribute('data-app', 'artifacts');
  style.textContent = CSS;
  const root = document.createElement('div');
  root.className = 'ohart';
  root.innerHTML = SHELL;
  container.append(style, root);
  const $ = (s) => root.querySelector(s);
  const rows = $('#rows');
  const menu = $('#menu');
  const toastEl = $('#toast');

  const savePrefs = () => {
    try { localStorage.setItem('oh-artifacts-prefs', JSON.stringify({ order: state.order, group: state.group, hideGone: state.hideGone, kinds: [...state.kinds] })); } catch (e) { /* optional */ }
  };
  const toast = (msg, bad) => {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, bad ? 7000 : 3500);
  };
  const setSummary = (text, spin) => {
    const el = $('#summary');
    el.textContent = '';
    if (spin) { const s = document.createElement('span'); s.className = 'spin'; el.append(s); }
    el.append(text);
  };

  $('#order').value = state.order;
  $('#group').checked = state.group;
  $('#hideGone').checked = state.hideGone;
  for (const k of KINDS) {
    const l = document.createElement('label');
    l.className = 'chk';
    l.innerHTML = "<input type='checkbox'" + (state.kinds.has(k) ? ' checked' : '') + "> <span class='badge " + k + "'>" + esc(KIND_LABEL[k]) + '</span>';
    l.querySelector('input').addEventListener('change', (e) => { if (e.target.checked) state.kinds.add(k); else state.kinds.delete(k); savePrefs(); render(); });
    $('#kinds').append(l);
  }

  function whereCell(it) {
    if (it.exists === false) return "<span class='dot bad'></span>Missing (sandbox cleaned)";
    if (it.inProjects) return "<span class='dot ok'></span>In /projects (synced to your PC)";
    if (it.exists === true) return "<span class='dot warn'></span>Container only";
    return "<span class='dot unk'></span>Unknown";
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    let list = state.items.filter((it) => it.kinds.some((k) => state.kinds.has(k)));
    if (state.hideGone) list = list.filter((it) => it.exists !== false);
    if (q) list = list.filter((it) => (it.name + ' ' + it.path + ' ' + it.conversationTitle).toLowerCase().includes(q));
    if (state.order === 'desc') list = list.slice().reverse();
    return list;
  }

  function rowHtml(it, idx) {
    const cls = (it.exists === false ? 'gone' : '') + (state.sel === it.path + '|' + it.conversationId ? ' sel' : '');
    return "<tr data-i='" + idx + "' class='" + cls + "' title='" + esc(it.note) + "'>"
      + "<td class='time'>" + esc(fmtTime(it.firstSeen)) + '</td>'
      + "<td class='name'><span class='ico'>" + icon(it.name, it.isDir) + '</span>' + esc(it.name) + "<span class='path'>" + esc(it.path) + '</span></td>'
      + '<td>' + it.kinds.map((k) => "<span class='badge " + k + "'>" + esc(KIND_LABEL[k]) + '</span>').join('') + (it.appearances > 1 ? "<span class='badge' title='Times this file came up'>\u00D7" + it.appearances + '</span>' : '') + '</td>'
      + "<td class='conv'><a href='#' data-conv='" + esc(it.conversationId) + "'>" + esc(it.conversationTitle) + '</a></td>'
      + "<td class='where'>" + whereCell(it) + '</td>'
      + "<td class='size'>" + (it.isDir ? '' : esc(fmtSize(it.size))) + '</td></tr>';
  }

  function render() {
    const list = filtered();
    state.view = list;
    const empty = $('#empty');
    if (!list.length) {
      rows.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = state.items.length ? 'No files match the current filter.' : (state.busy ? 'Reading conversations\u2026' : 'No files found yet. Press Rescan once a conversation has produced files.');
      return;
    }
    empty.style.display = 'none';
    if (!state.group) { rows.innerHTML = list.map((it, i) => rowHtml(it, i)).join(''); return; }
    const groups = new Map();
    for (const it of list) { if (!groups.has(it.conversationId)) groups.set(it.conversationId, []); groups.get(it.conversationId).push(it); }
    let html = '';
    for (const [cid, its] of groups) {
      html += "<tr class='group'><td colspan='6'>" + esc(its[0].conversationTitle) + '<small>' + its.length + (its.length === 1 ? ' file' : ' files') + ' \u00B7 started ' + esc(fmtTime(its[0].conversationCreatedAt)) + "</small> <a href='#' data-conv='" + esc(cid) + "'>open conversation \u2197</a></td></tr>";
      html += its.map((it) => rowHtml(it, list.indexOf(it))).join('');
    }
    rows.innerHTML = html;
  }

  async function load(force, silent) {
    if (state.busy || signal.disposed) return;
    state.busy = true;
    if (!silent) { setSummary('Reading conversations\u2026', true); if (!state.items.length) render(); }
    let info = null;
    try {
      info = await scan(api, cache, signal, force);
      saveCache(key, cache);
      state.error = null;
    } catch (e) { state.error = e && e.message ? e.message : String(e); }
    try {
      if (!signal.disposed) state.items = await buildList(api, cache, !state.error);
    } catch (e) { state.error = state.error || (e && e.message ? e.message : String(e)); }
    state.busy = false;
    if (signal.disposed) return;
    const convCount = new Set(state.items.map((i) => i.conversationId)).size;
    setSummary(state.error ? 'Could not read conversations: ' + state.error : state.items.length + (state.items.length === 1 ? ' file' : ' files') + ' across ' + convCount + (convCount === 1 ? ' conversation' : ' conversations'));
    if (info) $('#scanInfo').textContent = 'Last scan ' + new Date(info.at).toLocaleTimeString() + ' (' + info.ms + ' ms)';
    render();
  }

  function trackUrl(blob) {
    const url = URL.createObjectURL(blob);
    urls.add(url);
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 120000);
    return url;
  }

  async function act(action, it) {
    if (!it) return;
    try {
      if (action === 'copyPath') { await navigator.clipboard.writeText(it.path); toast('Container path copied'); return; }
      if (action === 'conv') { ctx.navigate('/conversations/' + it.conversationId); return; }
      if (it.isDir) { toast('That is a folder. Open a file inside it instead.', true); return; }
      if (it.exists === false) { toast('That file no longer exists in the container.', true); return; }
      const win = action === 'preview' ? window.open('about:blank', '_blank') : null;
      toast('Fetching ' + it.name + '\u2026');
      let size = it.size;
      if (size == null) { const s = (await statPaths(api, [it.path])).get(it.path); if (!s || !s.exists) throw new Error('That file no longer exists in the container.'); size = s.size; }
      const bytes = await readBytes(api, it.path, size);
      if (signal.disposed) { if (win) win.close(); return; }
      const ext = extOf(it.name);
      const mime = MEDIA_MIME[ext] || (TEXT_EXT.includes(ext) || !bytes.includes(0) ? 'text/plain;charset=utf-8' : null);
      if (action === 'preview' && mime && win) {
        win.location.href = trackUrl(new Blob([bytes], { type: mime }));
        toast('Opened ' + it.name);
        return;
      }
      if (win) win.close();
      const a = document.createElement('a');
      a.href = trackUrl(new Blob([bytes], { type: 'application/octet-stream' }));
      a.download = it.name;
      root.append(a);
      a.click();
      a.remove();
      toast(action === 'preview' ? 'No preview for this type, so it was downloaded: ' + it.name : 'Downloaded ' + it.name);
    } catch (e) { toast(e && e.message ? e.message : String(e), true); }
  }

  const rowFromEvent = (e) => { const tr = e.target.closest('tr[data-i]'); return tr ? state.view[Number(tr.dataset.i)] : null; };
  const keyOf = (it) => it.path + '|' + it.conversationId;
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); return () => target.removeEventListener(type, fn, opts); };
  const off = [
    on($('#q'), 'input', (e) => { state.q = e.target.value; render(); }),
    on($('#order'), 'change', (e) => { state.order = e.target.value; savePrefs(); render(); }),
    on($('#group'), 'change', (e) => { state.group = e.target.checked; savePrefs(); render(); }),
    on($('#hideGone'), 'change', (e) => { state.hideGone = e.target.checked; savePrefs(); render(); }),
    on($('#rescan'), 'click', () => load(true, false)),
    on(root, 'click', (e) => {
      const link = e.target.closest('a[data-conv]');
      if (link) { e.preventDefault(); ctx.navigate('/conversations/' + link.dataset.conv); return; }
      const row = rowFromEvent(e);
      if (row) { state.sel = keyOf(row); render(); }
    }),
    on(rows, 'dblclick', (e) => { if (!e.target.closest('a')) act('preview', rowFromEvent(e)); }),
    on(rows, 'contextmenu', (e) => {
      const it = rowFromEvent(e);
      if (!it) return;
      e.preventDefault();
      state.sel = keyOf(it);
      state.menuRow = it;
      render();
      menu.classList.add('open');
      menu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    }),
    on(menu, 'click', (e) => { const d = e.target.closest('[data-act]'); if (!d) return; menu.classList.remove('open'); act(d.dataset.act, state.menuRow); }),
    on(document, 'click', (e) => { if (!e.target.closest('.menu')) menu.classList.remove('open'); }),
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape') menu.classList.remove('open');
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const i = state.view.findIndex((x) => keyOf(x) === state.sel);
      if (e.key === 'ArrowDown' && state.view.length) { state.sel = keyOf(state.view[Math.min(i + 1, state.view.length - 1)]); render(); e.preventDefault(); }
      if (e.key === 'ArrowUp' && state.view.length) { state.sel = keyOf(state.view[Math.max(i - 1, 0)]); render(); e.preventDefault(); }
      if (e.key === 'Enter' && i >= 0) act('download', state.view[i]);
    }),
    on(window, 'scroll', () => menu.classList.remove('open'), true),
  ];

  const timer = setInterval(() => { if (!document.hidden) load(false, true); }, REFRESH_MS);
  if (Object.keys(cache.conversations).length) {
    buildList(api, cache, true).then((items) => { if (!signal.disposed && !state.items.length) { state.items = items; render(); } }).catch(() => {});
  }
  load(false, false);

  return () => {
    signal.disposed = true;
    clearInterval(timer);
    clearTimeout(toastTimer);
    for (const fn of off) fn();
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
    root.remove();
    style.remove();
  };
}

export function activate(host) {
  if (host.apiVersion !== '1') throw new Error('Artifacts requires Canvas Extensions host API 1.');
  return host.registerPage('artifacts', (ctx) => mountArtifacts(host, ctx));
}
