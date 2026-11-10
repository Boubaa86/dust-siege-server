// Routes sociales Dust Siege — à enregistrer à la racine du serveur.
// Appel : registerSocialRoutes(app, supabase, authenticatedUser)
export function registerSocialRoutes(app, supabase, authenticatedUser) {
  const fail = (res, e, label) => { console.error(label, e?.message || e); return res.status(500).json({ error: label }); };
  const clean = v => String(v || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20);
  const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
  const user = async (req, res) => authenticatedUser(req, res);

  app.post('/api/social/profile', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const nickname = clean(req.body?.nickname);
      if (nickname.length < 3) return res.status(400).json({ error: 'Pseudo : 3 caractères minimum.' });
      const { error } = await supabase.from('ds_profiles').upsert({ user_id: u.id, nickname, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) return fail(res, error, 'Impossible d’enregistrer le profil.');
      res.json({ ok: true, nickname });
    } catch (e) { fail(res, e, 'Erreur profil.'); }
  });

  app.get('/api/social/search', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const q = clean(req.query.q);
      if (q.length < 2) return res.json({ players: [] });
      const { data, error } = await supabase.from('ds_profiles').select('user_id,nickname').ilike('nickname', `%${q}%`).neq('user_id', u.id).limit(12);
      if (error) throw error;
      res.json({ players: data || [] });
    } catch (e) { fail(res, e, 'Recherche impossible.'); }
  });

  app.get('/api/social', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const [fr, teamRows, invites, myProfile] = await Promise.all([
        supabase.from('ds_friend_requests').select('id,requester_id,addressee_id,status,created_at').or(`requester_id.eq.${u.id},addressee_id.eq.${u.id}`).order('created_at', { ascending: false }),
        supabase.from('ds_team_members').select('team_id,role,ds_teams(id,name,owner_id)').eq('user_id', u.id),
        supabase.from('ds_team_invites').select('id,team_id,inviter_id,invitee_id,status,ds_teams(name)').eq('invitee_id', u.id).eq('status', 'pending'),
        supabase.from('ds_profiles').select('nickname').eq('user_id', u.id).maybeSingle()
      ]);
      for (const x of [fr, teamRows, invites, myProfile]) if (x.error) throw x.error;
      const rows = fr.data || [], ids = [...new Set(rows.filter(x => x.status === 'accepted').map(x => x.requester_id === u.id ? x.addressee_id : x.requester_id).concat(rows.filter(x => x.status === 'pending' && x.addressee_id === u.id).map(x => x.requester_id)))];
      let profiles = [];
      if (ids.length) { const p = await supabase.from('ds_profiles').select('user_id,nickname').in('user_id', ids); if (p.error) throw p.error; profiles = p.data || []; }
      const byId = Object.fromEntries(profiles.map(p => [p.user_id, p.nickname]));
      const friends = rows.filter(x => x.status === 'accepted').map(x => { const id = x.requester_id === u.id ? x.addressee_id : x.requester_id; return { id, nickname: byId[id] || 'Joueur' }; });
      const incoming = rows.filter(x => x.status === 'pending' && x.addressee_id === u.id).map(x => ({ id: x.id, userId: x.requester_id, nickname: byId[x.requester_id] || 'Joueur' }));
      const outgoing = rows.filter(x => x.status === 'pending' && x.requester_id === u.id).map(x => ({ id: x.id, userId: x.addressee_id, nickname: 'En attente' }));
      const team = teamRows.data?.[0]?.ds_teams || null;
      let members = [];
      if (team?.id) { const m = await supabase.from('ds_team_members').select('user_id,role').eq('team_id', team.id); if (m.error) throw m.error; const mids = (m.data || []).map(x => x.user_id); if (mids.length) { const p = await supabase.from('ds_profiles').select('user_id,nickname').in('user_id', mids); if (p.error) throw p.error; const names = Object.fromEntries((p.data || []).map(x => [x.user_id, x.nickname])); members = (m.data || []).map(x => ({ userId: x.user_id, nickname: names[x.user_id] || 'Joueur', role: x.role })); } }
      res.json({ nickname: myProfile.data?.nickname || '', friends, incoming, outgoing, team, members, invites: (invites.data || []).map(x => ({ id: x.id, teamId: x.team_id, teamName: x.ds_teams?.name || 'Équipe' })) });
    } catch (e) { fail(res, e, 'Impossible de charger les amis et équipes.'); }
  });

  app.post('/api/social/friends/request', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const target = String(req.body?.targetUserId || '');
      if (!isUuid(target) || target === u.id) return res.status(400).json({ error: 'Joueur invalide.' });
      const { data: existing, error: findErr } = await supabase.from('ds_friend_requests').select('id,requester_id,addressee_id,status').or(`and(requester_id.eq.${u.id},addressee_id.eq.${target}),and(requester_id.eq.${target},addressee_id.eq.${u.id})`).limit(1).maybeSingle();
      if (findErr) throw findErr;
      if (existing?.status === 'accepted') return res.status(409).json({ error: 'Vous êtes déjà amis.' });
      if (existing?.status === 'pending') return res.status(409).json({ error: 'Une demande existe déjà.' });
      const { error } = await supabase.from('ds_friend_requests').insert({ requester_id: u.id, addressee_id: target, status: 'pending' });
      if (error) throw error;
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Impossible d’envoyer la demande.'); }
  });

  app.post('/api/social/friends/respond', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const id = String(req.body?.requestId || ''), accept = !!req.body?.accept;
      if (!isUuid(id)) return res.status(400).json({ error: 'Demande invalide.' });
      const { data, error } = await supabase.from('ds_friend_requests').update({ status: accept ? 'accepted' : 'declined', updated_at: new Date().toISOString() }).eq('id', id).eq('addressee_id', u.id).eq('status', 'pending').select('id').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Demande introuvable.' });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Impossible de répondre à la demande.'); }
  });

  app.post('/api/social/team/create', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const name = clean(req.body?.name);
      if (name.length < 3) return res.status(400).json({ error: 'Nom : 3 caractères minimum.' });
      const { data: existing, error: check } = await supabase.from('ds_team_members').select('team_id').eq('user_id', u.id).maybeSingle();
      if (check) throw check; if (existing) return res.status(409).json({ error: 'Tu es déjà dans une équipe.' });
      const { data: team, error } = await supabase.from('ds_teams').insert({ name, owner_id: u.id }).select('id,name,owner_id').single();
      if (error) throw error;
      const m = await supabase.from('ds_team_members').insert({ team_id: team.id, user_id: u.id, role: 'owner' });
      if (m.error) { await supabase.from('ds_teams').delete().eq('id', team.id); throw m.error; }
      res.json({ ok: true, team });
    } catch (e) { fail(res, e, 'Impossible de créer l’équipe.'); }
  });

  app.post('/api/social/team/invite', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const target = String(req.body?.targetUserId || '');
      const { data: mine, error: meErr } = await supabase.from('ds_team_members').select('team_id,role').eq('user_id', u.id).maybeSingle();
      if (meErr) throw meErr; if (!mine) return res.status(400).json({ error: 'Crée ou rejoins une équipe avant d’inviter.' });
      if (!isUuid(target) || target === u.id) return res.status(400).json({ error: 'Joueur invalide.' });
      const { count, error: countErr } = await supabase.from('ds_team_members').select('user_id', { count: 'exact', head: true }).eq('team_id', mine.team_id);
      if (countErr) throw countErr; if ((count || 0) >= 4) return res.status(409).json({ error: 'Équipe complète (4 joueurs maximum).'});
      const { data: member, error: memberErr } = await supabase.from('ds_team_members').select('user_id').eq('user_id', target).maybeSingle();
      if (memberErr) throw memberErr; if (member) return res.status(409).json({ error: 'Ce joueur est déjà dans une équipe.' });
      const { data: pending, error: pErr } = await supabase.from('ds_team_invites').select('id').eq('team_id', mine.team_id).eq('invitee_id', target).eq('status', 'pending').maybeSingle();
      if (pErr) throw pErr; if (pending) return res.status(409).json({ error: 'Invitation déjà envoyée.' });
      const { error } = await supabase.from('ds_team_invites').insert({ team_id: mine.team_id, inviter_id: u.id, invitee_id: target, status: 'pending' });
      if (error) throw error; res.json({ ok: true });
    } catch (e) { fail(res, e, 'Impossible d’inviter ce joueur.'); }
  });

  app.post('/api/social/team/respond', async (req, res) => {
    try {
      const u = await user(req, res); if (!u) return;
      const id = String(req.body?.inviteId || ''), accept = !!req.body?.accept;
      if (!isUuid(id)) return res.status(400).json({ error: 'Invitation invalide.' });
      const { data: invite, error } = await supabase.from('ds_team_invites').select('id,team_id').eq('id', id).eq('invitee_id', u.id).eq('status', 'pending').maybeSingle();
      if (error) throw error; if (!invite) return res.status(404).json({ error: 'Invitation introuvable.' });
      if (accept) {
        const { data: mine, error: mErr } = await supabase.from('ds_team_members').select('team_id').eq('user_id', u.id).maybeSingle();
        if (mErr) throw mErr; if (mine) return res.status(409).json({ error: 'Tu es déjà dans une équipe.' });
        const { count, error: cErr } = await supabase.from('ds_team_members').select('user_id', { count: 'exact', head: true }).eq('team_id', invite.team_id);
        if (cErr) throw cErr; if ((count || 0) >= 4) return res.status(409).json({ error: 'Cette équipe est complète.' });
        const { error: addErr } = await supabase.from('ds_team_members').insert({ team_id: invite.team_id, user_id: u.id, role: 'member' });
        if (addErr) throw addErr;
      }
      const { error: updateErr } = await supabase.from('ds_team_invites').update({ status: accept ? 'accepted' : 'declined', updated_at: new Date().toISOString() }).eq('id', id).eq('invitee_id', u.id);
      if (updateErr) throw updateErr; res.json({ ok: true });
    } catch (e) { fail(res, e, 'Impossible de répondre à l’invitation.'); }
  });
}
