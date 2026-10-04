'use strict';
/*
  Linkboard server: accounts with passwords, sessions, and the shared board data.
  No outside packages: runs on Node 18 or newer.

  Data model (same as the page expects):
    docs[uid]  public document per person: username, created, posts, comments, votes, boards, joins, reports
    priv[uid]  private settings per person: saved, hidden, prefs, recent, visits, inbox read state
    site       moderation for the built-in boards, writable by admins only
  Each person can only change their own document. Passwords are stored as scrypt hashes.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Image and video uploads. With CLOUDINARY_URL set (cloudinary://<api key>:<api secret>@<cloud name>), files go
// straight from the browser to your Cloudinary account. Without it, they're saved in DATA_DIR/media on this
// server's disk, except when the data lives in Upstash: that means a host whose disk is wiped, so uploads are off.
const CLOUDINARY = (() => { const m = String(process.env.CLOUDINARY_URL || '').trim().match(/^cloudinary:\/\/([^:]+):([^@]+)@([A-Za-z0-9_-]+)/); return m ? { key: m[1], secret: m[2], cloud: m[3] } : null; })();

const MAX_BODY = 1024 * 1024;          // 1 MB per request
const MAX_DOC = 2 * 1024 * 1024;       // 2 MB per person's public document
const MAX_PRIV = 256 * 1024;           // 256 KB of private settings
const MAX_SITE = 1024 * 1024;          // 1 MB of site moderation
const SESSION_LONG = 365 * 24 * 3600e3;
const SESSION_SHORT = 24 * 3600e3;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const BUILT_IN_BOARDS = ['pics', 'askanything', 'worldnews', 'programming', 'gardening', 'todayilearned', 'cooking', 'hiking'];
const DOC_KEYS = new Set(['posts', 'comments', 'votes', 'boards', 'joins', 'reports']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ---------- storage ----------
   Everything lives in one JSON object. It is saved either to a file (DATA_DIR), or, when the
   UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN settings are present, to a free Upstash
   Redis database, for hosts whose disk is wiped on every restart. */
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_KEY = process.env.REDIS_KEY || 'linkboard';
const DB_FILE = path.join(DATA_DIR, 'linkboard.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const UPLOADS = process.env.UPLOADS === 'off' ? 'off' : CLOUDINARY ? 'cloudinary' : USE_REDIS ? 'off' : 'local';
const UPLOAD_MAX = { image: 20 * 1024 * 1024, video: 100 * 1024 * 1024 };
const MEDIA_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
// what a file really is, from its first bytes (never trust the name or the browser's label)
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return b.slice(8, 12).toString('latin1') === 'qt  ' ? 'mov' : 'mp4';
  return null;
}
let db = { version: 1, accounts: {}, docs: {}, priv: {}, site: { boards: {} }, sessions: {}, messages: [], boardmod: {}, chats: {} };
async function redis(cmd) {
  const r = await fetch(UPSTASH_URL, { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || j.error) throw new Error((j && j.error) || `Upstash answered ${r.status}`);
  return j.result;
}
async function load() {
  let text = null;
  if (USE_REDIS) text = await redis(['GET', REDIS_KEY]);
  else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { text = fs.readFileSync(DB_FILE, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (text) db = Object.assign(db, JSON.parse(text));
}
let saveTimer = null, saving = Promise.resolve(), dirty = false;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  dirty = false;
  const text = JSON.stringify(db);
  saving = saving.then(async () => {
    if (USE_REDIS) await redis(['SET', REDIS_KEY, text]);
    else { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, DB_FILE); }
  }).catch(e => { dirty = true; console.error('Saving failed, will retry:', e.message); save(); });
  return saving;
}
// Upstash's free plan allows 500,000 commands a month, so changes are batched into one save every few seconds.
function save() { dirty = true; if (!saveTimer) saveTimer = setTimeout(saveNow, USE_REDIS ? 3000 : 250); }
function changed() { db.version++; save(); broadcast('changed', { version: db.version }); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });
const ready = load();

/* ---------- passwords and sessions ---------- */
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return { salt: salt.toString('base64'), hash: key.toString('base64') };
}
async function checkPassword(pw, acct) {
  const key = await scrypt(pw, Buffer.from(acct.salt, 'base64'));
  const want = Buffer.from(acct.hash, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
const DUMMY = { salt: crypto.randomBytes(16).toString('base64'), hash: crypto.randomBytes(64).toString('base64') };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function findAccount(username) {
  const lower = String(username || '').toLowerCase();
  return Object.values(db.accounts).find(a => a.lower === lower) || null;
}
function newSession(res, uid, remember, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const life = remember ? SESSION_LONG : SESSION_SHORT;
  const ua = req ? String(req.headers['user-agent'] || '').slice(0, 200) : '';
  db.sessions[sha(token)] = { uid, expires: Date.now() + life, created: Date.now(), ua };
  save();
  const parts = [`lb_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (remember) parts.push(`Max-Age=${Math.floor(life / 1000)}`);
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSession(req, res) {
  const t = cookies(req).lb_session;
  if (t) { delete db.sessions[sha(t)]; save(); }
  res.setHeader('Set-Cookie', `lb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const t = cookies(req).lb_session;
  if (!t) return null;
  const s = db.sessions[sha(t)];
  if (!s) return null;
  if (s.expires < Date.now()) { delete db.sessions[sha(t)]; save(); return null; }
  return db.accounts[s.uid] || null;
}
setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) { delete db.sessions[k]; n++; }
  if (n) save();
}, 3600e3).unref();

/* ---------- login throttling: 10 failed tries per username or address per 15 minutes ---------- */
const failures = new Map();
const WINDOW = 15 * 60e3;
function tooMany(key) { const f = failures.get(key); return !!f && f.n >= 10 && Date.now() - f.t < WINDOW; }
function fail(key) { const f = failures.get(key); if (!f || Date.now() - f.t >= WINDOW) failures.set(key, { n: 1, t: Date.now() }); else f.n++; }
setInterval(() => { const now = Date.now(); for (const [k, f] of failures) if (now - f.t >= WINDOW) failures.delete(k); }, WINDOW).unref();
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const fail400 = (res, code, error) => send(res, 400, { code, error });
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject({ status: 413 }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject({ status: 400 }); } });
    req.on('error', () => reject({ status: 400 }));
  });
}
function cleanKeys(v, depth = 0) {
  if (depth > 30) throw new Error('too deep');
  if (Array.isArray(v)) return v.map(x => cleanKeys(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) { if (BAD_KEYS.has(k) || k.length > 200) throw new Error('bad key'); out[k] = cleanKeys(v[k], depth + 1); }
    return out;
  }
  return v;
}
function merge(a, b) {
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v);
    else a[k] = v;
  }
  return a;
}
const size = v => Buffer.byteLength(JSON.stringify(v));
function boardOwner(name) {
  const lower = name.toLowerCase();
  if (BUILT_IN_BOARDS.includes(lower)) return '*';
  for (const [uid, d] of Object.entries(db.docs)) for (const k of Object.keys(d.boards || {})) if (k.toLowerCase() === lower) return uid;
  return null;
}
/* ---------- "you are doing that too much": per-account limits on new posts, comments and messages ---------- */
const LIMITS = { upload: [20, 3600e3], post: [5, 10 * 60e3], comment: [40, 10 * 60e3], message: [15, 10 * 60e3], board: [3, 24 * 3600e3], chat: [40, 60e3], chatstart: [10, 3600e3] };
const recentActs = new Map();   // `${uid}:${kind}` -> timestamps
function tooFast(uid, kind, n = 1) {
  const [max, win] = LIMITS[kind]; const key = uid + ':' + kind; const now = Date.now();
  const list = (recentActs.get(key) || []).filter(t => now - t < win);
  if (list.length + n > max) { recentActs.set(key, list); return Math.ceil((win - (now - list[0])) / 60e3) || 1; }
  for (let i = 0; i < n; i++) list.push(now);
  recentActs.set(key, list); return 0;
}
const slowDown = (res, minutes) => send(res, 429, { code: 'doing_too_much', minutes, error: `you are doing that too much. try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
function myMessages(uid) {
  if (!uid) return null;
  const name = id => db.accounts[id]?.username || '[deleted]';
  const out = { inbox: [], sent: [] }, seenGroups = new Set();
  for (const m of db.messages || []) {
    if (m.to === uid && !m.delTo) out.inbox.push({ id: m.id, from: name(m.from), via: m.via || undefined, subj: m.subj, txt: m.txt, t: m.t, read: !!m.read });
    if (m.from === uid && !m.delFrom && !seenGroups.has(m.gid || m.id)) { seenGroups.add(m.gid || m.id); out.sent.push({ id: m.id, to: m.via || name(m.to), subj: m.subj, txt: m.txt, t: m.t }); }
  }
  out.inbox.sort((a, b) => b.t - a.t); out.sent.sort((a, b) => b.t - a.t);
  return out;
}
// moderation settings for any board: the site's for built-in boards, the board's own for created ones
function modDataFor(name) {
  const owner = boardOwner(name); if (!owner) return null;
  const lower = name.toLowerCase();
  if (owner === '*') return { owner, data: (db.site.boards || {})[BUILT_IN_BOARDS.find(b => b === lower)] || {} };
  const legacy = (Object.entries((db.docs[owner] || {}).boards || {}).find(([k]) => k.toLowerCase() === lower) || [])[1];
  return { owner, data: (db.boardmod || {})[lower] || (legacy && legacy.mod) || {} };
}
const lowerList = l => (Array.isArray(l) ? l : []).map(x => String(x).toLowerCase());
const isAdmin = acct => !!acct && (acct.admin || ADMIN_USERS.includes(acct.lower));

/* ---------- live updates: server-sent events and who is here ---------- */
const clients = new Map();   // id -> { res, board, uid }
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) c.res.write(msg);
}
// only to the given people (chat), never to everyone
function sendTo(uids, event, data) {
  const want = new Set(uids), msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) if (c.uid && want.has(c.uid)) c.res.write(msg);
}

/* ---------- chat: live one-to-one and group conversations, separate from private messages ----------
   db.chats[id] = { id, name, group, creator, created, members: [uid], pending: {uid: true}, read: {uid: time}, msgs: [{ id, from, txt, t, sys }] }
   Someone who hasn't friended the person starting a chat gets it as a request, which they can accept or ignore.
   Messages from people you've blocked are never shown to you. */
const CHAT_MAX_MSGS = 500, CHAT_MAX_MEMBERS = 20;
const blockedBy = (viewer, uid) => { const a = db.accounts[uid]; return !!a && ((db.priv[viewer] || {}).blocked || []).some(n => String(n).toLowerCase() === a.lower); };
const friendOf = (viewer, uid) => { const a = db.accounts[uid]; return !!a && ((db.priv[viewer] || {}).friends || []).some(n => String(n).toLowerCase() === a.lower); };
const uname = uid => db.accounts[uid]?.username || '[deleted]';
function chatView(c, viewer) {
  const others = c.members.filter(u => u !== viewer);
  if (!c.group && others.length && others.every(u => blockedBy(viewer, u))) return null;
  const msgs = c.msgs.filter(m => m.sys || m.from === viewer || !blockedBy(viewer, m.from));
  const last = msgs[msgs.length - 1] || null, seen = (c.read || {})[viewer] || 0;
  return {
    id: c.id, group: !!c.group, name: c.name || '', creator: uname(c.creator), created: c.created,
    members: c.members.map(uname), pair: c.pair ? c.pair.map(uname) : undefined, pending: !!(c.pending || {})[viewer],
    waiting: others.filter(u => (c.pending || {})[u]).map(uname),
    unread: msgs.filter(m => !m.sys && m.from !== viewer && m.t > seen).length,
    last: last ? { from: last.sys ? null : uname(last.from), txt: last.txt.slice(0, 120), t: last.t, sys: !!last.sys } : null,
    t: last ? last.t : c.created,
  };
}
function chatSys(c, txt) { c.msgs.push({ id: 'cm_' + crypto.randomBytes(8).toString('base64url'), from: null, sys: true, txt, t: Date.now() }); }
function chatChanged(c, extra = []) { save(); sendTo([...c.members, ...extra], 'chat', { id: c.id }); }
let onlineTimer = null;
function onlineSoon() {
  clearTimeout(onlineTimer);
  onlineTimer = setTimeout(() => {
    const boards = {};
    for (const c of clients.values()) if (c.board) boards[c.board] = (boards[c.board] || 0) + 1;
    broadcast('online', { total: clients.size, boards });
  }, 300);
}
setInterval(() => { for (const c of clients.values()) c.res.write(': keepalive\n\n'); }, 25e3).unref();

/* ---------- the page ---------- */
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; frame-src https://www.youtube-nocookie.com; connect-src 'self' https://api.cloudinary.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  // uploaded files saved on this server, with byte ranges so videos can seek
  const mediaMatch = req.method === 'GET' && p.match(/^\/media\/([A-Za-z0-9_-]{10,40})\.(jpg|png|gif|webp|mp4|webm|mov)$/);
  if (mediaMatch) {
    const file = path.join(MEDIA_DIR, `${mediaMatch[1]}.${mediaMatch[2]}`);
    let st; try { st = fs.statSync(file); } catch (e) { return send(res, 404, 'not found'); }
    const headers = { 'Content-Type': MEDIA_TYPES[mediaMatch[2]], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" };
    const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? +range[1] : Math.max(0, st.size - +range[2]), end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    return fs.createReadStream(file).pipe(res);
  }

  // RSS feeds: /rss for everything, /b/<board>/rss for one board
  const rssMatch = req.method === 'GET' && (p === '/rss' ? [null, null] : p.match(/^\/b\/([A-Za-z0-9_]{3,21})\/rss$/));
  if (rssMatch) {
    const board = rssMatch[1];
    if (board && !boardOwner(board)) return send(res, 404, 'no such board');
    const proto = (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0]) || (COOKIE_SECURE ? 'https' : 'http');
    const origin = `${proto}://${String(req.headers.host || 'localhost').replace(/[^A-Za-z0-9.:\-\[\]]/g, '')}`;
    const x = v => String(v == null ? '' : v).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const items = [];
    for (const [uid, d] of Object.entries(db.docs)) for (const [id, pst] of Object.entries(d.posts || {})) {
      if (!pst || pst.deleted || pst.nsfw || (board && String(pst.b).toLowerCase() !== board.toLowerCase())) continue;
      const md = modDataFor(String(pst.b || '')); if (!md) continue;
      if ((md.data.removed || {})[id] || md.data.nsfw) continue;
      items.push({ id, uid, pst });
    }
    items.sort((a, b) => (b.pst.time || 0) - (a.pst.time || 0));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${x(board ? 'b/' + board + ' on linkboard' : 'linkboard')}</title><link>${x(origin + (board ? '/#/b/' + board : '/'))}</link><description>${x(board ? 'newest posts in b/' + board : 'newest posts on linkboard')}</description>` +
      items.slice(0, 50).map(({ id, uid, pst }) => `<item><title>${x(pst.title)}</title><link>${x(`${origin}/#/b/${pst.b}/comments/${id}`)}</link><guid isPermaLink="false">${x(id)}</guid><pubDate>${new Date(+pst.time || Date.now()).toUTCString()}</pubDate><author>${x((db.docs[uid] || {}).username || '[deleted]')}</author><category>${x('b/' + pst.b)}</category><description>${x((pst.url ? pst.url + '\n\n' : '') + String(pst.self || '').slice(0, 2000))}</description></item>`).join('') +
      '</channel></rss>';
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    return res.end(xml);
  }

  if (req.method === 'GET' && p === '/api/events') {
    const id = crypto.randomBytes(9).toString('base64url');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ clientId: id })}\n\n`);
    const who = currentUser(req);
    clients.set(id, { res, board: '', uid: who ? who.uid : null });
    onlineSoon();
    req.on('close', () => { clients.delete(id); onlineSoon(); });
    return;
  }

  const me = currentUser(req);

  if (req.method === 'GET' && p === '/api/state') {
    return send(res, 200, {
      version: db.version,
      docs: db.docs,
      site: db.site,
      boardmod: db.boardmod || {},
      priv: me ? (db.priv[me.uid] || {}) : null,
      me: me ? { uid: me.uid, username: me.username, admin: isAdmin(me) } : null,
      messages: me ? myMessages(me.uid) : null,
      uploads: UPLOADS,
    });
  }

  if (req.method === 'GET' && p === '/api/sessions') {
    if (!me) return send(res, 401, { code: 'not_signed_in', error: 'log in first' });
    const cur = sha(cookies(req).lb_session || '');
    const list = Object.entries(db.sessions).filter(([, x]) => x.uid === me.uid && x.expires > Date.now())
      .map(([k, x]) => ({ current: k === cur, created: x.created || null, expires: x.expires, ua: x.ua || '' }))
      .sort((a, b) => (b.current - a.current) || ((b.created || 0) - (a.created || 0)));
    return send(res, 200, { sessions: list });
  }

  if (req.method === 'GET' && (p === '/api/chats' || p === '/api/chat')) {
    if (!me) return send(res, 401, { code: 'not_signed_in', error: 'log in first' });
    const chats = db.chats || {};
    if (p === '/api/chats') {
      const list = Object.values(chats).filter(c => c.members.includes(me.uid)).map(c => chatView(c, me.uid)).filter(Boolean).sort((a, b) => b.t - a.t);
      return send(res, 200, { chats: list });
    }
    const c = chats[url.searchParams.get('id') || ''];
    const view = c && c.members.includes(me.uid) ? chatView(c, me.uid) : null;
    if (!view) return send(res, 404, { code: 'no_chat', error: 'no such chat' });
    const msgs = c.msgs.filter(m => m.sys || m.from === me.uid || !blockedBy(me.uid, m.from)).slice(-200)
      .map(m => ({ id: m.id, from: m.sys ? null : uname(m.from), txt: m.txt, t: m.t, sys: !!m.sys }));
    return send(res, 200, { chat: view, msgs, read: Object.fromEntries(Object.entries(c.read || {}).filter(([u]) => u !== me.uid).map(([u, t]) => [uname(u), t])) });
  }

  if (req.method === 'POST' && p === '/api/upload') {
    if (req.headers['x-linkboard'] !== '1') return send(res, 403, { code: 'forbidden', error: 'missing request header' });
    if (!me) return send(res, 401, { code: 'not_signed_in', error: 'log in first' });
    if (UPLOADS !== 'local') return send(res, 400, { code: 'uploads_off', error: 'uploads go to Cloudinary on this site' });
    const declared = String(req.headers['content-type'] || '').startsWith('video/') ? 'video' : 'image';
    if (+req.headers['content-length'] > UPLOAD_MAX[declared]) return send(res, 413, { code: 'too_big', error: `that file is too big. ${declared}s can be up to ${UPLOAD_MAX[declared] / 1048576} MB.` });
    const wait = tooFast(me.uid, 'upload'); if (wait) return slowDown(res, wait);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const id = crypto.randomBytes(15).toString('base64url');
    const tmp = path.join(MEDIA_DIR, id + '.part');
    const result = await new Promise(resolve => {
      const out = fs.createWriteStream(tmp); let head = Buffer.alloc(0), ext = null, total = 0, done = false;
      const finish = r => { if (done) return; done = true; resolve(r); };
      const bail = (status, code, error) => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); req.unpipe?.(); req.resume(); finish({ status, code, error }); };
      req.on('data', chunk => {
        if (done) return;
        total += chunk.length;
        if (!ext) { head = Buffer.concat([head, chunk]); if (head.length >= 12) { ext = sniff(head); if (!ext) return bail(415, 'bad_type', 'that file type isn\'t supported. use a jpg, png, gif or webp image, or an mp4, webm or mov video.'); } }
        const kind = ext && MEDIA_TYPES[ext].startsWith('video/') ? 'video' : 'image';
        if (total > UPLOAD_MAX[ext ? kind : 'video']) return bail(413, 'too_big', `that file is too big. ${kind}s can be up to ${UPLOAD_MAX[kind] / 1048576} MB.`);
        out.write(chunk);
      });
      req.on('end', () => { if (done) return; if (!ext) return bail(415, 'bad_type', 'that file type isn\'t supported.'); out.end(() => finish({ ext })); });
      req.on('error', () => bail(400, 'invalid_argument', 'the upload was interrupted'));
    });
    if (!result.ext) return send(res, result.status, { code: result.code, error: result.error });
    fs.renameSync(tmp, path.join(MEDIA_DIR, `${id}.${result.ext}`));
    return send(res, 200, { ok: true, url: `/media/${id}.${result.ext}`, kind: MEDIA_TYPES[result.ext].split('/')[0] });
  }

  if (req.method !== 'POST' || !p.startsWith('/api/')) return send(res, 404, { code: 'not_found', error: 'not found' });
  // Every write comes from the page itself: JSON plus a custom header a cross-site form can't send.
  if (req.headers['x-linkboard'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 403, { code: 'forbidden', error: 'missing request header' });
  }
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { code: e.status === 413 ? 'quota_exceeded' : 'invalid_argument', error: 'bad request body' }); }

  if (p === '/api/signup') {
    const username = String(body.username || '').trim(), password = String(body.password || ''), email = String(body.email || '').trim().slice(0, 200);
    if (!USERNAME_RE.test(username)) return fail400(res, 'bad_username', 'bad username');
    if (password.length < 8 || password.length > 200) return fail400(res, 'bad_password', 'bad password');
    if (password.toLowerCase() === username.toLowerCase()) return fail400(res, 'same_as_username', 'password matches username');
    if (tooMany('ip:' + clientIp(req))) return send(res, 429, { code: 'too_many', error: 'too many tries' });
    if (findAccount(username)) { fail('ip:' + clientIp(req)); return send(res, 409, { code: 'taken', error: 'username taken' }); }
    const uid = 'u_' + crypto.randomBytes(12).toString('base64url');
    const first = Object.keys(db.accounts).length === 0;
    db.accounts[uid] = { uid, username, lower: username.toLowerCase(), email: email || undefined, created: Date.now(), admin: first, ...(await hashPassword(password)) };
    db.docs[uid] = { username, created: Date.now(), posts: {}, comments: {}, votes: { p: {}, c: {} }, boards: {} };
    newSession(res, uid, !!body.remember, req);
    changed();
    return send(res, 200, { ok: true, uid, username, admin: first });
  }

  if (p === '/api/login') {
    const username = String(body.username || '').trim(), password = String(body.password || '');
    const keys = ['ip:' + clientIp(req), 'user:' + username.toLowerCase()];
    if (keys.some(tooMany)) return send(res, 429, { code: 'too_many', error: 'too many tries' });
    const acct = findAccount(username);
    const ok = await checkPassword(password, acct || DUMMY);   // same work either way, so timing doesn't reveal usernames
    if (!acct || !ok) { keys.forEach(fail); return send(res, 401, { code: 'bad_login', error: 'wrong username or password' }); }
    keys.forEach(k => failures.delete(k));
    newSession(res, acct.uid, !!body.remember, req);
    return send(res, 200, { ok: true, uid: acct.uid, username: acct.username });
  }

  if (p === '/api/sessions/revoke-others') {
    if (!me) return send(res, 401, { code: 'not_signed_in', error: 'log in first' });
    const cur = sha(cookies(req).lb_session || ''); let n = 0;
    for (const [k, x] of Object.entries(db.sessions)) if (x.uid === me.uid && k !== cur) { delete db.sessions[k]; n++; }
    save();
    return send(res, 200, { ok: true, removed: n });
  }

  if (p === '/api/logout') { clearSession(req, res); return send(res, 200, { ok: true }); }

  if (p === '/api/presence') {
    const c = clients.get(String(body.clientId || ''));
    if (c) { c.board = String(body.b || '').slice(0, 21); c.uid = me ? me.uid : null; onlineSoon(); }
    return send(res, 200, { ok: true });
  }

  if (!me) return send(res, 401, { code: 'not_signed_in', error: 'log in first' });

  if (p === '/api/password') {
    const key = 'user:' + me.lower;
    if (tooMany(key)) return send(res, 429, { code: 'too_many', error: 'too many tries' });
    if (!(await checkPassword(String(body.current || ''), me))) { fail(key); return send(res, 401, { code: 'bad_login', error: 'wrong password' }); }
    const pw = String(body.password || '');
    if (pw.length < 8 || pw.length > 200) return fail400(res, 'bad_password', 'bad password');
    if (pw.toLowerCase() === me.lower) return fail400(res, 'same_as_username', 'password matches username');
    Object.assign(me, await hashPassword(pw));
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === me.uid) delete db.sessions[k];   // log out everywhere
    newSession(res, me.uid, true, req);
    save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/password') {
    if (!isAdmin(me)) return send(res, 403, { code: 'forbidden', error: 'admins only' });
    const acct = findAccount(body.username);
    if (!acct) return send(res, 404, { code: 'no_user', error: 'no such user' });
    const pw = String(body.password || '');
    if (pw.length < 8 || pw.length > 200) return fail400(res, 'bad_password', 'bad password');
    Object.assign(acct, await hashPassword(pw));
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === acct.uid) delete db.sessions[k];
    save();
    return send(res, 200, { ok: true, username: acct.username });
  }

  if (p === '/api/me') {
    let patch;
    try { patch = cleanKeys(body.patch); } catch (e) { return fail400(res, 'invalid_argument', 'bad change'); }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return fail400(res, 'invalid_argument', 'bad change');
    for (const k of Object.keys(patch)) if (!DOC_KEYS.has(k)) return fail400(res, 'invalid_argument', `can't change ${k}`);
    if (patch.boards) {
      if (typeof patch.boards !== 'object' || Array.isArray(patch.boards)) return fail400(res, 'invalid_argument', 'bad boards');
      for (const name of Object.keys(patch.boards)) {
        if (!/^[A-Za-z0-9_]{3,21}$/.test(name)) return fail400(res, 'invalid_argument', 'bad board name');
        const owner = boardOwner(name);
        if (owner && owner !== me.uid) return send(res, 409, { code: 'taken', error: 'that board already exists' });
      }
    }
    if (patch.joins !== undefined && !Array.isArray(patch.joins)) return fail400(res, 'invalid_argument', 'bad joins');
    const doc = db.docs[me.uid] || (db.docs[me.uid] = { username: me.username, created: me.created });
    // archived posts (over six months old) take no new votes or comments
    const ARCHIVE_MS = 180 * 24 * 3600e3, now = Date.now();
    const postTime = {}, commentPost = {};
    if (patch.votes || patch.comments) for (const d of Object.values(db.docs)) {
      for (const [id, pst] of Object.entries(d.posts || {})) if (pst) postTime[id] = +pst.time || 0;
      for (const [id, c] of Object.entries(d.comments || {})) if (c) commentPost[id] = c.pid;
    }
    const archived = pid => postTime[pid] !== undefined && now - postTime[pid] > ARCHIVE_MS;
    const changedVote = (kind, id, v) => ((doc.votes || {})[kind] || {})[id] !== v;
    for (const [id, v] of Object.entries((patch.votes || {}).p || {})) if (changedVote('p', id, v) && archived(id)) return send(res, 403, { code: 'archived', error: 'this post is archived' });
    for (const [id, v] of Object.entries((patch.votes || {}).c || {})) if (changedVote('c', id, v) && archived(commentPost[id])) return send(res, 403, { code: 'archived', error: 'this post is archived' });
    for (const [id, c] of Object.entries(patch.comments || {})) if (c && !(doc.comments || {})[id] && archived(c.pid)) return send(res, 403, { code: 'archived', error: 'this post is archived' });
    // restricted boards: only moderators and approved posters may submit
    for (const [id, pst] of Object.entries(patch.posts || {})) {
      if (!pst || (doc.posts || {})[id] || !pst.b) continue;
      const md = modDataFor(String(pst.b)); if (!md) continue;
      const pt = md.data.ptype, isSelf = pst.kind === 'self';
      if ((pt === 'link' && isSelf) || (pt === 'self' && !isSelf)) return send(res, 403, { code: 'wrong_kind', error: `b/${pst.b} takes ${pt === 'link' ? 'links' : 'text posts'} only.` });
      if (!md.data.restricted) continue;
      const ok = isAdmin(me) || md.owner === me.uid || lowerList(md.data.mods).includes(me.lower) || lowerList(md.data.approved).includes(me.lower);
      if (!ok) return send(res, 403, { code: 'restricted', error: `b/${pst.b} is restricted. only approved posters can submit there.` });
    }
    const fresh = (k) => patch[k] && typeof patch[k] === 'object' ? Object.keys(patch[k]).filter(id => !(doc[k] || {})[id]).length : 0;
    for (const [k, kind] of [['posts', 'post'], ['comments', 'comment'], ['boards', 'board']]) {
      const n = fresh(k); if (!n) continue;
      const wait = tooFast(me.uid, kind, n); if (wait) return slowDown(res, wait);
    }
    const next = merge(JSON.parse(JSON.stringify(doc)), patch);
    next.username = me.username; next.created = doc.created || me.created;
    if (size(next) > MAX_DOC) return send(res, 413, { code: 'quota_exceeded', error: 'your account is full' });
    db.docs[me.uid] = next;
    changed();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/message') {
    const rawTo = String(body.to || '').trim();
    const subj = String(body.subj || '').trim().slice(0, 100), txt = String(body.txt || '').trim().slice(0, 10000);
    // "b/name" goes to that board's moderators: its creator, or the site admins for the built-in boards
    let recipients = [], via = null;
    const bm = rawTo.match(/^\/?b\/([A-Za-z0-9_]{3,21})$/);
    if (bm) {
      const owner = boardOwner(bm[1]);
      if (!owner) return send(res, 404, { code: 'no_board', error: 'no such board' });
      recipients = owner === '*' ? Object.values(db.accounts).filter(isAdmin).map(a => a.uid) : [owner];
      recipients = recipients.filter(uid => db.accounts[uid]);
      if (!recipients.length) return send(res, 404, { code: 'no_board', error: 'that board has no moderators' });
      via = 'b/' + (BUILT_IN_BOARDS.find(b => b === bm[1].toLowerCase()) || Object.keys((db.docs[owner] || {}).boards || {}).find(k => k.toLowerCase() === bm[1].toLowerCase()) || bm[1]);
    } else {
      const to = findAccount(rawTo.replace(/^\/?u\//, ''));
      if (!to) return send(res, 404, { code: 'no_user', error: 'no such user' });
      recipients = [to.uid];
    }
    if (!subj || !txt) return fail400(res, 'invalid_argument', 'subject and message are required');
    const wait = tooFast(me.uid, 'message'); if (wait) return slowDown(res, wait);
    if ((db.messages || []).length >= 20000) db.messages.splice(0, 1000);   // keep the store bounded: drop the oldest
    const gid = 'g_' + crypto.randomBytes(6).toString('base64url');
    const blockedMe = uid => ((db.priv[uid] || {}).blocked || []).some(n => String(n).toLowerCase() === me.lower);
    for (const uid of recipients) if (!blockedMe(uid)) (db.messages || (db.messages = [])).push({ id: 'm_' + crypto.randomBytes(8).toString('base64url'), gid, from: me.uid, to: uid, via: via || undefined, subj, txt, t: Date.now(), read: uid === me.uid });
    changed();
    return send(res, 200, { ok: true, to: via || db.accounts[recipients[0]].username });
  }

  if (p === '/api/message/read' || p === '/api/message/delete') {
    const ids = new Set((Array.isArray(body.ids) ? body.ids : [body.id]).map(String).slice(0, 500));
    let n = 0;
    for (const m of db.messages || []) {
      if (!ids.has(m.id)) continue;
      if (p === '/api/message/read' && m.to === me.uid) { m.read = body.read !== false; n++; }
      if (p === '/api/message/delete') { if (m.to === me.uid) { m.delTo = true; n++; } if (m.from === me.uid) { m.delFrom = true; n++; } }
    }
    db.messages = (db.messages || []).filter(m => !(m.delTo && m.delFrom));
    if (n) save();
    return send(res, 200, { ok: true, changed: n });
  }

  if (p === '/api/upload/sign') {
    if (UPLOADS !== 'cloudinary') return send(res, 400, { code: 'uploads_off', error: 'uploads are not set up on this site' });
    const wait = tooFast(me.uid, 'upload'); if (wait) return slowDown(res, wait);
    const timestamp = Math.floor(Date.now() / 1000), folder = 'linkboard';
    const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${CLOUDINARY.secret}`).digest('hex');
    return send(res, 200, { cloud: CLOUDINARY.cloud, apiKey: CLOUDINARY.key, timestamp, folder, signature });
  }

  if (p.startsWith('/api/chat/')) {
    const chats = db.chats || (db.chats = {});
    if (p === '/api/chat/start') {
      const names = (Array.isArray(body.to) ? body.to : String(body.to || '').split(/[\s,]+/)).map(n => String(n).trim().replace(/^\/?u\//, '')).filter(Boolean);
      const accts = [];
      for (const n of names) {
        const a = findAccount(n);
        if (!a) return send(res, 404, { code: 'no_user', error: `there is no user named ${n.slice(0, 30)}` });
        if (a.uid !== me.uid && !accts.includes(a)) accts.push(a);
      }
      if (!accts.length) return fail400(res, 'invalid_argument', 'add at least one other person');
      if (accts.length + 1 > CHAT_MAX_MEMBERS) return fail400(res, 'invalid_argument', `a chat can have up to ${CHAT_MAX_MEMBERS} people`);
      const name = String(body.name || '').trim().slice(0, 60);
      const group = accts.length > 1 || !!name;
      if (!group) {
        const other = accts[0].uid;
        const existing = Object.values(chats).find(c => !c.group && c.members.length === 2 && c.members.includes(me.uid) && c.members.includes(other));
        if (existing) return send(res, 200, { ok: true, id: existing.id });
      }
      const wait = tooFast(me.uid, 'chatstart'); if (wait) return slowDown(res, wait);
      const id = 'ch_' + crypto.randomBytes(9).toString('base64url');
      const pending = {};
      for (const a of accts) if (!friendOf(a.uid, me.uid)) pending[a.uid] = true;
      const c = chats[id] = { id, name, group, creator: me.uid, created: Date.now(), members: [me.uid, ...accts.map(a => a.uid)], pair: group ? undefined : [me.uid, accts[0].uid], pending, read: { [me.uid]: Date.now() }, msgs: [] };
      if (group) chatSys(c, `${me.username} started the chat`);
      chatChanged(c);
      return send(res, 200, { ok: true, id });
    }
    const c = chats[String(body.id || '')];
    if (!c || !c.members.includes(me.uid)) return send(res, 404, { code: 'no_chat', error: 'no such chat' });
    c.pending = c.pending || {}; c.read = c.read || {};
    if (p === '/api/chat/send') {
      const txt = String(body.txt || '').trim().slice(0, 2000);
      if (!txt) return fail400(res, 'invalid_argument', 'write a message first');
      const wait = tooFast(me.uid, 'chat'); if (wait) return slowDown(res, wait);
      delete c.pending[me.uid];   // replying accepts a request
      c.msgs.push({ id: 'cm_' + crypto.randomBytes(8).toString('base64url'), from: me.uid, txt, t: Date.now() });
      if (c.msgs.length > CHAT_MAX_MSGS) c.msgs.splice(0, c.msgs.length - CHAT_MAX_MSGS);
      c.read[me.uid] = Date.now();
      chatChanged(c);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/chat/read') { c.read[me.uid] = Date.now(); chatChanged(c); return send(res, 200, { ok: true }); }
    if (p === '/api/chat/accept') { delete c.pending[me.uid]; c.read[me.uid] = Date.now(); chatChanged(c); return send(res, 200, { ok: true }); }
    if (p === '/api/chat/leave') {
      const wasPending = !!c.pending[me.uid];
      c.members = c.members.filter(u => u !== me.uid); delete c.pending[me.uid]; delete c.read[me.uid];
      if (!c.members.length) { delete chats[c.id]; sendTo([...c.members, me.uid], 'chat', { id: c.id }); save(); }
      else { if (c.group && !wasPending) chatSys(c, `${me.username} left the chat`); chatChanged(c, [me.uid]); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/chat/add' || p === '/api/chat/rename') {
      if (!c.group) return fail400(res, 'invalid_argument', 'only group chats can do that');
      if (c.pending[me.uid]) return send(res, 403, { code: 'forbidden', error: 'accept the chat first' });
      if (p === '/api/chat/rename') {
        c.name = String(body.name || '').trim().slice(0, 60);
        chatSys(c, c.name ? `${me.username} named the chat "${c.name}"` : `${me.username} removed the chat's name`);
        chatChanged(c); return send(res, 200, { ok: true });
      }
      const a = findAccount(String(body.user || '').trim().replace(/^\/?u\//, ''));
      if (!a) return send(res, 404, { code: 'no_user', error: 'no such user' });
      if (c.members.includes(a.uid)) return fail400(res, 'invalid_argument', `${a.username} is already in this chat`);
      if (c.members.length >= CHAT_MAX_MEMBERS) return fail400(res, 'invalid_argument', `a chat can have up to ${CHAT_MAX_MEMBERS} people`);
      c.members.push(a.uid); if (!friendOf(a.uid, me.uid)) c.pending[a.uid] = true;
      chatSys(c, `${me.username} added ${a.username}`);
      chatChanged(c); return send(res, 200, { ok: true });
    }
    return send(res, 404, { code: 'not_found', error: 'not found' });
  }

  if (p === '/api/account/delete') {
    if (!(await checkPassword(String(body.password || ''), me))) return send(res, 401, { code: 'bad_login', error: 'wrong password' });
    const uid = me.uid, d = db.docs[uid] || {};
    // Like the classic site: posts and comments stay up with the author shown as [deleted];
    // the account, its votes, settings and messages are removed and the username is freed.
    db.docs[uid] = { username: '[deleted]', deletedAccount: true, created: d.created, posts: d.posts || {}, comments: d.comments || {}, votes: { p: {}, c: {} }, boards: d.boards || {} };
    delete db.priv[uid];
    db.messages = (db.messages || []).filter(m => m.from !== uid && m.to !== uid);
    for (const [cid, c] of Object.entries(db.chats || {})) {
      if (!c.members.includes(uid)) continue;
      c.members = c.members.filter(u => u !== uid); delete (c.pending || {})[uid]; delete (c.read || {})[uid];
      c.msgs = c.msgs.filter(m => m.from !== uid);
      if (!c.members.length) delete db.chats[cid]; else sendTo(c.members, 'chat', { id: cid });
    }
    for (const [k, sess] of Object.entries(db.sessions)) if (sess.uid === uid) delete db.sessions[k];
    delete db.accounts[uid];
    clearSession(req, res);
    changed();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/priv') {
    let data;
    try { data = cleanKeys(body.data); } catch (e) { return fail400(res, 'invalid_argument', 'bad settings'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail400(res, 'invalid_argument', 'bad settings');
    if (size(data) > MAX_PRIV) return send(res, 413, { code: 'quota_exceeded', error: 'settings too large' });
    db.priv[me.uid] = data; save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/boardmod') {
    // Moderation settings for a board someone created. Its creator and the moderators they added may change them;
    // only the creator (or a site admin) may change who the moderators are.
    const name = String(body.board || '');
    const owner = /^[A-Za-z0-9_]{3,21}$/.test(name) ? boardOwner(name) : null;
    if (!owner) return send(res, 404, { code: 'no_board', error: 'no such board' });
    if (owner === '*') return send(res, 400, { code: 'invalid_argument', error: 'built-in boards are moderated by admins' });
    let data;
    try { data = cleanKeys(body.data); } catch (e) { return fail400(res, 'invalid_argument', 'bad settings'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail400(res, 'invalid_argument', 'bad settings');
    const lower = name.toLowerCase();
    const ownerDoc = db.docs[owner] || {};
    const legacy = (Object.entries(ownerDoc.boards || {}).find(([k]) => k.toLowerCase() === lower) || [])[1];
    const current = (db.boardmod || {})[lower] || (legacy && legacy.mod) || {};
    const curMods = (Array.isArray(current.mods) ? current.mods : []).map(m => String(m).toLowerCase());
    const isOwner = me.uid === owner, admin = isAdmin(me);
    if (!isOwner && !admin && !curMods.includes(me.lower)) return send(res, 403, { code: 'forbidden', error: 'only this board\'s moderators can do that' });
    let mods = Array.isArray(data.mods) ? data.mods : [];
    mods = [...new Set(mods.map(m => String(m).trim().replace(/^\/?u\//, '')).filter(m => findAccount(m) && findAccount(m).uid !== owner).map(m => findAccount(m).username))].slice(0, 10);
    if (!isOwner && !admin) {
      const same = mods.length === curMods.length && mods.every(m => curMods.includes(m.toLowerCase()));
      if (!same) return send(res, 403, { code: 'forbidden', error: 'only the board\'s creator can change its moderators' });
    }
    data.mods = mods;
    if (size(data) > MAX_SITE) return send(res, 413, { code: 'quota_exceeded', error: 'too large' });
    (db.boardmod || (db.boardmod = {}))[lower] = data;
    changed();
    return send(res, 200, { ok: true, mods });
  }

  if (p === '/api/site') {
    if (!isAdmin(me)) return send(res, 403, { code: 'forbidden', error: 'admins only' });
    let data;
    try { data = cleanKeys(body.data); } catch (e) { return fail400(res, 'invalid_argument', 'bad settings'); }
    if (!data || typeof data.boards !== 'object' || Array.isArray(data.boards)) return fail400(res, 'invalid_argument', 'bad settings');
    if (size(data) > MAX_SITE) return send(res, 413, { code: 'quota_exceeded', error: 'too large' });
    const ann = data.announce && typeof data.announce === 'object' && String(data.announce.text || '').trim() ? { text: String(data.announce.text).trim().slice(0, 300), t: +data.announce.t || Date.now(), by: me.username } : null;
    db.site = { boards: data.boards, announce: ann };
    changed();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { code: 'not_found', error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { code: 'unavailable', error: 'server error' });
    else res.end();
  });
});
if (require.main === module) {
  ready.then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Linkboard is running at http://localhost:${PORT}`);
      console.log(USE_REDIS ? 'Data is saved in your Upstash database.' : `Data is saved in ${DB_FILE}`);
      console.log({ cloudinary: 'Uploads go to your Cloudinary account.', local: `Uploads are saved in ${MEDIA_DIR}`, off: USE_REDIS ? 'Uploads are off: add CLOUDINARY_URL to turn them on.' : 'Uploads are off.' }[UPLOADS]);
      if (!Object.keys(db.accounts).length) console.log('The first account you create becomes the site admin.');
    });
  }).catch(e => { console.error('Could not load the saved data:', e.message); process.exit(1); });
}
module.exports = { server, getDb: () => db, ready, hashPassword, saveNow, findAccount };
