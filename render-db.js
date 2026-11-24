import pg from 'pg';

const { Pool } = pg;
let pool = null;
let ready = false;

export function renderPostgresReady() {
  return ready;
}

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 8,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      application_name: 'warworld-api'
    });
    pool.on('error', error => {
      ready = false;
      console.error('Erreur de connexion Render PostgreSQL :', error.message);
    });
  }
  return pool;
}

export async function initRenderPostgres() {
  const db = getPool();
  if (!db) {
    console.log('Render PostgreSQL non configurée : fonctions d’historique désactivées.');
    return false;
  }
  await db.query('SELECT 1');
  await db.query(`
    CREATE TABLE IF NOT EXISTS ww_match_history (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      mode VARCHAR(24) NOT NULL,
      score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
      wave INTEGER NOT NULL DEFAULT 0 CHECK (wave >= 0),
      kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
      duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
      trust_level VARCHAR(24) NOT NULL DEFAULT 'client-reported',
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS ww_match_history_user_played_idx
    ON ww_match_history (user_id, played_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS ww_match_history_played_idx
    ON ww_match_history (played_at DESC)
  `);
  ready = true;
  console.log('Render PostgreSQL prête : historique des parties activé.');
  return true;
}

export async function recordMatch(userId, match) {
  const db = getPool();
  if (!db || !ready) throw new Error('Render PostgreSQL indisponible.');
  const { rows } = await db.query(
    `INSERT INTO ww_match_history
      (user_id, mode, score, wave, kills, duration_seconds, trust_level)
     VALUES ($1,$2,$3,$4,$5,$6,'client-reported')
     RETURNING id, mode, score, wave, kills, duration_seconds, played_at, trust_level`,
    [userId, match.mode, match.score, match.wave, match.kills, match.durationSeconds]
  );
  return rows[0];
}

export async function getMatchHistory(userId, limit = 20) {
  const db = getPool();
  if (!db || !ready) throw new Error('Render PostgreSQL indisponible.');
  const { rows } = await db.query(
    `SELECT id, mode, score, wave, kills, duration_seconds, played_at, trust_level
     FROM ww_match_history
     WHERE user_id = $1
     ORDER BY played_at DESC
     LIMIT $2`,
    [userId, Math.max(1, Math.min(50, Number(limit) || 20))]
  );
  return rows;
}

export async function getLeaderboard(period = 'week', limit = 20) {
  const db = getPool();
  if (!db || !ready) throw new Error('Render PostgreSQL indisponible.');
  const validPeriod = ['week', 'month', 'all'].includes(period) ? period : 'week';
  const since = validPeriod === 'all'
    ? null
    : new Date(Date.now() - (validPeriod === 'month' ? 30 : 7) * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await db.query(
    `SELECT user_id,
            COALESCE(SUM(score), 0)::int AS total_score,
            COALESCE(SUM(kills), 0)::int AS total_kills,
            COUNT(*)::int AS matches
     FROM ww_match_history
     WHERE ($2::timestamptz IS NULL OR played_at >= $2)
     GROUP BY user_id
     ORDER BY total_score DESC, total_kills DESC, matches DESC
     LIMIT $1`,
    [Math.max(1, Math.min(50, Number(limit) || 20)), since]
  );
  return rows;
}

export async function getMatchMetrics() {
  const db = getPool();
  if (!db || !ready) throw new Error('Render PostgreSQL indisponible.');
  const [total, recent, modes] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS total_matches FROM ww_match_history'),
    db.query('SELECT COUNT(*)::int AS matches_last_24h FROM ww_match_history WHERE played_at >= NOW() - INTERVAL \'24 hours\''),
    db.query('SELECT mode, COUNT(*)::int AS matches FROM ww_match_history GROUP BY mode ORDER BY matches DESC LIMIT 10')
  ]);
  return {
    ready: true,
    totalMatches: total.rows[0]?.total_matches ?? 0,
    matchesLast24h: recent.rows[0]?.matches_last_24h ?? 0,
    modes: modes.rows
  };
}
