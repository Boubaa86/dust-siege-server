import express from 'express';
import { supabase } from './supabase.js';

const app = express();
app.use(express.json());

// Pour servir aussi votre jeu (votre index.html) si besoin
app.use(express.static('.'));

// Exemple de route protégée avec Supabase
app.get('/api/profil', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Aucun token fourni.' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Token invalide ou expiré.' });
    }

    res.json({ 
      message: 'Accès autorisé !',
      userId: user.id,
      email: user.email 
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur en écoute sur le port ${PORT}`);
});