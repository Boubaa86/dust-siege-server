// Dust Siege - serveur multijoueur (aucune dépendance). Lancer : node server.js
const http = require('http'), crypto = require('crypto'), fs = require('fs');
const PORT = process.env.PORT || 8080;
const DATA = process.env.DATA_FILE || './data.json';
const MAX_ROOM = 8, GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {}
if (!db.users) db.users = {};
let dirty = false;
const save = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) {} };
setInterval(save, 20000); process.on('SIGTERM', () => { save(); process.exit(0); });

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const out = (res, code, obj) => { res.writeHead(code, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => { let b = ''; req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ok({}); } }); });
const clean = s => String(s || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Joueur';
const okId = s => typeof s === 'string' && /^[a-z0-9]{8,40}$/.test(s);
const codeOf = id => 'AMI-' + crypto.createHash('sha1').update(id).digest('hex').slice(0, 6).toUpperCase();
const findByCode = c => Object.keys(db.users).find(id => codeOf(id) === c);

// limitation de débit HTTP par IP
const hits = new Map();
setInterval(() => hits.clear(), 60000);
const limited = req => { const ip = req.socket.remoteAddress; const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 120; };

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (limited(req)) return out(res, 429, { err: 'trop de requetes' });
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/' || u.pathname === '/health') return out(res, 200, { ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((a, r) => a + r.size, 0) });
    if (u.pathname === '/top') {
      const top = Object.values(db.users).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 20).map(x => ({ n: x.n, s: x.s, w: x.w || 0 }));
      return out(res, 200, top);
    }
    if (u.pathname === '/claim') {
      const id = u.searchParams.get('id'); if (!okId(id) || !db.users[id]) return out(res, 200, { pending: 0 });
      const p = db.users[id].pending || 0; db.users[id].pending = 0; dirty = true; return out(res, 200, { pending: p });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!okId(b.id)) return out(res, 400, { err: 'id invalide' });
      const me = db.users[b.id] || (db.users[b.id] = { n: 'Joueur', s: 0, w: 0, pending: 0 }); dirty = true;
      if (u.pathname === '/reg') { if (b.name) me.n = clean(b.name); return out(res, 200, { code: codeOf(b.id) }); }
      if (u.pathname === '/score') {
        const s = Math.floor(+b.score), w = Math.floor(+b.wave) || 0;
        if (!(s >= 0 && s < 5e6)) return out(res, 400, { err: 'score invalide' });
        if (b.name) me.n = clean(b.name); if (s > me.s) { me.s = s; me.w = w; }
        return out(res, 200, { ok: true, best: me.s });
      }
      if (u.pathname === '/ref') {
        if (me.refBy) return out(res, 200, { ok: false, err: 'Tu as deja utilise un code ami.' });
        const code = String(b.code || '').toUpperCase().trim(); const ownerId = findByCode(code);
        if (!ownerId) return out(res, 200, { ok: false, err: 'Code ami inconnu.' });
        if (ownerId === b.id) return out(res, 200, { ok: false, err: 'Tu ne peux pas utiliser ton propre code.' });
        me.refBy = ownerId; db.users[ownerId].pending = (db.users[ownerId].pending || 0) + 1000;
        return out(res, 200, { ok: true, bonus: 1000 });
      }
    }
    out(res, 404, { err: 'introuvable' });
  } catch (e) { out(res, 500, { err: 'erreur' }); }
});

// ---- WebSocket minimal (RFC 6455), sans dependance ----
const rooms = new Map(); // nom -> Map(id -> client)
const rid = () => crypto.randomBytes(5).toString('hex');
function frame(str, op = 1) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else return null;
  return Buffer.concat([h, p]);
}
const wsend = (c, obj) => { if (c.sock.destroyed) return; const f = frame(JSON.stringify(obj)); if (f) c.sock.write(f); };
function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const op = b[0] & 15, masked = (b[1] & 128) !== 0; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) return c.sock.destroy();
    if (!masked || len > 8192) return c.sock.destroy();
    if (b.length < off + 4 + len) return;
    const mask = b.slice(off, off + 4), data = Buffer.from(b.slice(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.slice(off + 4 + len);
    if (op === 8) return c.sock.end();
    if (op === 9) { const f = frame(data.toString(), 10); if (f) c.sock.write(f); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1) onMsg(c, data.toString());
    else if (op !== 0) return c.sock.destroy();
  }
}
function leave(c) {
  if (!c.room) return; const r = rooms.get(c.room); c.room = null; if (!r) return;
  r.delete(c.id); if (!r.size) { rooms.delete(c.rname); return; }
  for (const o of r.values()) wsend(o, { t: 'peer-', id: c.id });
  if (r.hostId === c.id) { r.hostId = r.keys().next().value; for (const o of r.values()) wsend(o, { t: 'host', id: r.hostId }); }
}
const RELAY = new Set(['p', 'en', 'hit', 'kill', 'dmg', 'msg']);
function onMsg(c, text) {
  const now = Date.now(); if (now - c.t0 > 1000) { c.t0 = now; c.n = 0; } if (++c.n > 60) return; // 60 msg/s max
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (m.t === 'join') {
    if (c.room) return;
    const name = String(m.room || 'salon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'salon';
    let r = rooms.get(name); if (!r) { r = new Map(); r.hostId = null; rooms.set(name, r); }
    if (r.size >= MAX_ROOM) return wsend(c, { t: 'full' });
    c.room = name; c.rname = name; c.name = clean(m.name);
    if (!r.hostId) r.hostId = c.id;
    r.set(c.id, c);
    wsend(c, { t: 'welcome', id: c.id, host: r.hostId, peers: [...r.values()].filter(o => o !== c).map(o => ({ id: o.id, n: o.name })) });
    for (const o of r.values()) if (o !== c) wsend(o, { t: 'peer+', id: c.id, n: c.name });
    return;
  }
  if (!c.room || !RELAY.has(m.t)) return;
  const r = rooms.get(c.room); if (!r) return;
  if (m.t === 'en' && r.hostId !== c.id) return; // seul l'hote envoie les ennemis
  m.from = c.id;
  if (m.t === 'hit') { const h = r.get(r.hostId); if (h && h !== c) wsend(h, m); return; }
  if (m.to) { const o = r.get(String(m.to)); if (o) wsend(o, m); return; }
  for (const o of r.values()) if (o !== c) wsend(o, m);
}
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  const c = { sock, id: rid(), room: null, buf: Buffer.alloc(0), t0: 0, n: 0, alive: true, name: 'Joueur' };
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 20000) return sock.destroy(); parse(c); });
  sock.on('close', () => leave(c)); sock.on('error', () => { try { sock.destroy(); } catch (e) {} });
});
setInterval(() => { for (const r of rooms.values()) for (const c of r.values()) { if (!c.alive) { c.sock.destroy(); continue; } c.alive = false; const f = frame('', 9); if (f) c.sock.write(f); } }, 25000);
server.listen(PORT, () => console.log('Dust Siege server sur le port ' + PORT));
