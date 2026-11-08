import express from 'express';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { supabase } from './supabase.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/' });
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static('.'));

const TABLE = 'dust_siege_players';
const safeId = value => String(value || '').trim().slice(0, 80);
const safeName = value => String(value || 'Joueur').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Joueur';
const num = (v, min = 0, max = 1e9) => Math.max(min, Math.min(max, Number.isFinite(+v) ? +v : 0));
const jsonError = (res, err, message) => {
  console.error(message, err?.message || err);
  return res.status(500).json({ error: message });
};

async function getPlayer(id) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('player_id', safeId(id)).maybeSingle();
  if (error) throw error;
  return data;
}
async function putPlayer(id, patch) {
  const player_id = safeId(id);
  if (!player_id) throw new Error('Identifiant joueur manquant');
  const current = await getPlayer(player_id);
  const row = { player_id, name: current?.name || 'Joueur', score: current?.score || 0, wave: current?.wave || 0,
    games: current?.games || 0, kills: current?.kills || 0, heads: current?.heads || 0,
    hits: current?.hits || 0, shots: current?.shots || 0, dmg: current?.dmg || 0,
    fav: current?.fav || '—', referral_code: current?.referral_code || null,
    pending_bonus: current?.pending_bonus || 0, referred_by: current?.referred_by || null,
    ...patch, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from(TABLE).upsert(row, { onConflict: 'player_id' }).select('*').single();
  if (error) throw error;
  return data;
}

// Profil et sauvegardes de compte : ces routes restent inchangées dans leur fonctionnement.
async function authenticatedUser(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) { res.status(401).json({ error: 'Aucun token fourni.' }); return null; }
  const { data, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !data?.user) { res.status(401).json({ error: 'Token invalide ou expiré.' }); return null; }
  return data.user;
}
app.get('/api/profil', async (req, res) => {
  try { const user = await authenticatedUser(req, res); if (!user) return;
    res.json({ message: 'Accès autorisé !', userId: user.id, email: user.email });
  } catch (e) { jsonError(res, e, 'Erreur interne du serveur.'); }
});
app.get('/api/sauvegarde', async (req, res) => {
  try { const user = await authenticatedUser(req, res); if (!user) return;
    const { data, error } = await supabase.from('game_saves').select('data, updated_at').eq('user_id', user.id).maybeSingle();
    if (error) throw error; res.json({ data: data?.data || {}, updated_at: data?.updated_at || null });
  } catch (e) { jsonError(res, e, 'Impossible de charger la sauvegarde.'); }
});
app.put('/api/sauvegarde', async (req, res) => {
  try { const user = await authenticatedUser(req, res); if (!user) return;
    const data = req.body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Données de sauvegarde invalides.' });
    const { error } = await supabase.from('game_saves').upsert({ user_id: user.id, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error; res.json({ ok: true });
  } catch (e) { jsonError(res, e, 'Impossible d’enregistrer la sauvegarde.'); }
});

// Classement et statistiques Dust Siege.
app.post('/score', async (req, res) => {
  try {
    const id = safeId(req.body?.id); if (!id) return res.status(400).json({ error: 'Identifiant joueur manquant.' });
    const old = await getPlayer(id);
    const score = Math.floor(num(req.body?.score));
    const wave = Math.floor(num(req.body?.wave, 0, 10000));
    const saved = await putPlayer(id, { name: safeName(req.body?.name), score: Math.max(old?.score || 0, score), wave: Math.max(old?.wave || 0, wave), games: (old?.games || 0) + 1 });
    res.json({ ok: true, score: saved.score, wave: saved.wave });
  } catch (e) { jsonError(res, e, 'Impossible d’enregistrer le score. Vérifie la table Dust Siege dans Supabase.'); }
});
app.get('/top', async (_req, res) => {
  try { const { data, error } = await supabase.from(TABLE).select('name, score, wave').order('score', { ascending: false }).limit(20);
    if (error) throw error; res.json((data || []).map(p => ({ n: p.name || 'Joueur', s: p.score || 0, w: p.wave || 0 })));
  } catch (e) { jsonError(res, e, 'Impossible de charger le classement.'); }
});
app.get('/tournoi', async (_req, res) => {
  try {
    const now = new Date(); const start = new Date(now); start.setUTCHours(0,0,0,0); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 7);
    const { data, error } = await supabase.from(TABLE).select('name, score, wave, updated_at').gte('updated_at', start.toISOString()).lt('updated_at', end.toISOString()).order('score', { ascending: false }).limit(20);
    if (error) throw error;
    res.json({ endsIn: Math.max(0, end.getTime() - now.getTime()), list: (data || []).map(p => ({ n: p.name || 'Joueur', s: p.score || 0, w: p.wave || 0 })) });
  } catch (e) { jsonError(res, e, 'Impossible de charger le tournoi.'); }
});
app.get('/stats', async (req, res) => {
  try {
    const p = await getPlayer(req.query.id);
    if (!p) return res.json({ games: 0, kills: 0, heads: 0, acc: 0, hits: 0, shots: 0, dmg: 0, best: 0, wave: 0, fav: '—', tier: 'Recrue', r: 0 });
    const r = Math.floor((p.score || 0) / 100); const tiers = ['Recrue','Soldat','Vétéran','Élite','Légende'];
    res.json({ games: p.games || 0, kills: p.kills || 0, heads: p.heads || 0, hits: p.hits || 0, shots: p.shots || 0,
      acc: p.shots ? Math.round((p.hits || 0) / p.shots * 100) : 0, dmg: p.dmg || 0, best: p.score || 0,
      wave: p.wave || 0, fav: p.fav || '—', tier: tiers[Math.min(tiers.length - 1, Math.floor(r / 100))], r });
  } catch (e) { jsonError(res, e, 'Impossible de charger les statistiques.'); }
});
app.get('/shop', (_req, res) => res.json({ offers: [] }));
app.get('/replay', (_req, res) => res.json({ frames: [] }));

// Parrainage : un code par joueur, un seul parrainage accepté par compte.
app.post('/reg', async (req, res) => {
  try {
    const id = safeId(req.body?.id); if (!id) return res.status(400).json({ error: 'Identifiant joueur manquant.' });
    let p = await getPlayer(id);
    if (!p?.referral_code) {
      const code = 'AMI-' + randomBytes(3).toString('hex').toUpperCase();
      p = await putPlayer(id, { name: safeName(req.body?.name), referral_code: code });
    }
    res.json({ code: p.referral_code });
  } catch (e) { jsonError(res, e, 'Impossible de créer le code de parrainage.'); }
});
app.post('/ref', async (req, res) => {
  try {
    const id = safeId(req.body?.id); const code = String(req.body?.code || '').trim().toUpperCase();
    if (!id || !code) return res.status(400).json({ ok: false, err: 'Code ou joueur manquant.' });
    const { data: ref, error } = await supabase.from(TABLE).select('player_id').eq('referral_code', code).maybeSingle();
    if (error) throw error;
    if (!ref) return res.json({ ok: false, err: 'Code invalide.' });
    if (ref.player_id === id) return res.json({ ok: false, err: 'Tu ne peux pas utiliser ton propre code.' });
    const me = await getPlayer(id); if (me?.referred_by) return res.json({ ok: false, err: 'Tu as déjà utilisé un code.' });
    await putPlayer(ref.player_id, { pending_bonus: (ref.pending_bonus || 0) + 1000 });
    await putPlayer(id, { referred_by: ref.player_id });
    res.json({ ok: true, bonus: 1000 });
  } catch (e) { jsonError(res, e, 'Impossible de valider le parrainage.'); }
});
app.get('/claim', async (req, res) => {
  try {
    const id = safeId(req.query.id); const p = await getPlayer(id);
    if (!p) return res.json({ pending: 0 });
    const pending = p.pending_bonus || 0;
    if (pending > 0) await putPlayer(id, { pending_bonus: 0 });
    res.json({ pending });
  } catch (e) { jsonError(res, e, 'Impossible de récupérer le bonus.'); }
});

// WebSocket : rooms communes pour la coop et l'arène.
const rooms = new Map();
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
const broadcast = (room, data, except = null) => { for (const p of room.players.values()) if (p.ws !== except) send(p.ws, data); };
function makeRoom(name, arena) {
  return { name, arena, players: new Map(), host: null, wave: 1, enemies: [], nextEnemy: 0, enemyId: 1, tick: null };
}
function spawnEnemy(room) {
  const angle = Math.random() * Math.PI * 2, radius = 18 + Math.random() * 8;
  const boss = room.wave % 5 === 0 && room.enemies.length === 0;
  room.enemies.push({ id: room.enemyId++, x: Math.cos(angle)*radius, z: Math.sin(angle)*radius, hp: boss ? 900 + room.wave*80 : 90 + room.wave*12, type: boss ? 'k' : '', boss, dead: false });
}
function arenaState(room) {
  const en = room.enemies.map(e => [e.id, e.x, e.z, 0, Math.round(e.hp), e.type, e.boss ? 1 : 0, e.dead ? 1 : 0]);
  const pl = [...room.players.values()].map(p => [p.id, p.x, p.z, p.ya, p.hp, 0, p.alive ? 1 : 0]);
  return { t: 'st', w: room.wave, en, pl };
}
function startArenaLoop(room) {
  if (room.tick) return;
  room.tick = setInterval(() => {
    if (!room.players.size) { clearInterval(room.tick); room.tick = null; rooms.delete(room.name); return; }
    const alive = [...room.players.values()].filter(p => p.alive);
    if (!room.enemies.some(e => !e.dead) && Date.now() > room.nextEnemy) {
      if (room.enemies.length) { room.wave++; room.enemies = []; }
      for (let i=0;i<Math.min(3 + room.wave, 12);i++) spawnEnemy(room);
      room.nextEnemy = Date.now() + 3000;
    }
    for (const e of room.enemies) {
      if (e.dead || !alive.length) continue;
      let target = alive.reduce((a,b) => Math.hypot(a.x-e.x,a.z-e.z) < Math.hypot(b.x-e.x,b.z-e.z) ? a : b);
      const dx=target.x-e.x, dz=target.z-e.z, d=Math.hypot(dx,dz)||1;
      if (d > 1.6) { e.x += dx/d*0.045; e.z += dz/d*0.045; }
      else { target.hp = Math.max(0, target.hp - 0.45); if (target.hp <= 0) target.alive = false; }
    }
    for (const p of room.players.values()) if (!p.alive && Date.now() > p.respawnAt) { p.alive=true; p.hp=60; p.x=0; p.z=0; send(p.ws,{t:'resp',x:0,z:0}); }
    broadcast(room, arenaState(room));
  }, 100);
}
wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'join') {
      const name = String(m.room || 'salon').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40) || 'salon';
      const arena = !!m.auth; const key = (arena ? 'arena:' : 'coop:') + name;
      let room = rooms.get(key); if (!room) { room=makeRoom(key,arena); rooms.set(key,room); }
      if (room.players.size >= 12) return send(ws,{t:'full'});
      const id = randomUUID().slice(0,8); const p={id,ws,name:safeName(m.name),x:0,z:0,ya:0,hp:100,alive:true,score:0,kills:0,shots:0,hits:0};
      room.players.set(id,p); ws.room=room; ws.player=p;
      send(ws,{t:'welcome',id,host:room.host || id,peers:[...room.players.values()].filter(x=>x.id!==id).map(x=>({id:x.id}))});
      if (!room.host) room.host=id;
      broadcast(room,{t:'peer+',id},ws);
      if (room.arena) startArenaLoop(room);
      return;
    }
    const room=ws.room, p=ws.player; if (!room || !p) return;
    if (m.t==='p') { p.x=num(m.x,-1000,1000); p.z=num(m.z,-1000,1000); p.ya=num(m.ya,-20,20); broadcast(room,{...m,t:'p',from:p.id},ws); }
    else if (m.t==='en' && !room.arena && p.id===room.host) broadcast(room,m,ws);
    else if (m.t==='hit' && !room.arena) broadcast(room,{...m,from:p.id},ws);
    else if (m.t==='kill' && !room.arena) broadcast(room,{...m,from:p.id},ws);
    else if (m.t==='dmg' && !room.arena) { const target=[...room.players.values()].find(x=>x.id===m.to); if(target) send(target.ws,{...m,from:p.id}); }
    else if (m.t==='in' && room.arena) { p.x=num(m.x,-1000,1000); p.z=num(m.z,-1000,1000); p.ya=num(m.ya,-20,20); p.pt=num(m.pt,-2,2); p.weapon=num(m.w,0,20); }
    else if (m.t==='finish' && room.arena && !p.saved) {
      p.saved = true;
      getPlayer(p.id).then(old => putPlayer(p.id, { name:p.name, score:Math.max(old?.score||0,Math.floor(num(m.score))), wave:Math.max(old?.wave||0,Math.floor(num(m.wave))), games:(old?.games||0)+1, kills:(old?.kills||0)+p.kills, hits:(old?.hits||0)+p.hits, shots:(old?.shots||0)+p.shots })).catch(e=>console.error('Fin partie arène:',e.message));
    }
    else if (m.t==='shot' && room.arena && p.alive) {
      p.shots++;
      const dx=num(m.dx,-1,1), dz=num(m.dz,-1,1); let best=null, bestD=3.0;
      for (const e of room.enemies) { if(e.dead) continue; const ex=e.x-p.x, ez=e.z-p.z, along=ex*dx+ez*dz; if(along<0||along>65) continue; const side=Math.abs(ex*dz-ez*dx); if(side<bestD && side<1.7) { best=e; bestD=side; } }
      if (best) { p.hits++; best.hp-=([35,55,90,120,150][p.weapon]||45); if(best.hp<=0){best.dead=true;p.kills++;p.score+=best.boss?500:100;send(p.ws,{t:'kill',hd:0,bs:best.boss?1:0});} }
    }
  });
  ws.on('close', () => {
    const room=ws.room, p=ws.player; if(!room||!p)return;
    room.players.delete(p.id); broadcast(room,{t:'peer-',id:p.id});
    if(room.host===p.id){room.host=room.players.keys().next().value||null;if(room.host)broadcast(room,{t:'host',id:room.host});}
    if(room.arena && !p.saved && p.kills>0) getPlayer(p.id).then(old=>putPlayer(p.id,{name:p.name,score:Math.max(old?.score||0,p.score),wave:Math.max(old?.wave||0,room.wave),games:(old?.games||0)+1,kills:(old?.kills||0)+p.kills,hits:(old?.hits||0)+p.hits,shots:(old?.shots||0)+p.shots})).catch(e=>console.error('Stats arène:',e.message));
    if(!room.players.size){if(room.tick)clearInterval(room.tick);rooms.delete(room.name);}
  });
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30000);
wss.on('close',()=>clearInterval(heartbeat));
app.get('/health', (_req,res)=>res.json({ok:true, websocket:true}));
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Dust Siege API + WebSocket en écoute sur ${PORT}`));
