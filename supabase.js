import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant sur Render');
}

// Client réservé aux opérations de données côté serveur. Il conserve la clé service_role.
export const supabase = createClient(url, key);

// Client distinct pour la connexion du développeur.
// Il ne persiste pas la session et ne peut donc pas remplacer la session du client de données.
export const authSupabase = createClient(url, key, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});
