-- Warworld / Dust Siege — Render PostgreSQL
-- Safe, additive migration. It does not alter or copy existing Supabase data.
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
);
CREATE INDEX IF NOT EXISTS ww_match_history_user_played_idx
  ON ww_match_history (user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS ww_match_history_played_idx
  ON ww_match_history (played_at DESC);
