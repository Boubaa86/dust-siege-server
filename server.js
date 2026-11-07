import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Variables Render manquantes : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function authenticatedUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Connexion requise.' });
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Session invalide ou expirée.' });
    req.user = user;
    next();
  } catch (e) {
    console.error('Erreur authentification :', e);
    res.status(500).json({ error: 'Erreur interne.' });
  }
}

app.get('/api/profil', authenticatedUser, (req, res) => {
  res.json({ userId: req.user.id, email: req.user.email });
});

app.get('/api/save', authenticatedUser, async (req, res) => {
  const { data, error } = await admin.from('game_saves')
    .select('data, updated_at').eq('user_id', req.user.id).maybeSingle();
  if (error) {
    console.error('Lecture sauvegarde :', error);
    return res.status(500).json({ error: 'Impossible de charger la sauvegarde.' });
  }
  res.json({ data: data?.data || null, updated_at: data?.updated_at || null });
});

app.post('/api/save', authenticatedUser, async (req, res) => {
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Données de sauvegarde invalides.' });
  }
  const { error } = await admin.from('game_saves').upsert({
    user_id: req.user.id,
    data,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) {
    console.error('Écriture sauvegarde :', error);
    return res.status(500).json({ error: 'Impossible d’enregistrer la sauvegarde.' });
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dust Siege écoute sur le port ${PORT}`));
