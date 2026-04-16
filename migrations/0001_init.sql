-- FutbolFR — D1 Schema
-- Exécuter: wrangler d1 execute futbolfr --file migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  fcm_token   TEXT,
  notif_live  INTEGER DEFAULT 1,
  notif_goals INTEGER DEFAULT 1,
  notif_pre   INTEGER DEFAULT 0,  -- rappel 10 min avant
  lang_pref   TEXT DEFAULT 'fr',
  quality_pref TEXT DEFAULT 'auto',
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS favorites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_name   TEXT NOT NULL,
  team_id     TEXT,
  competition TEXT,
  UNIQUE(user_id, team_name)
);

CREATE TABLE IF NOT EXISTS watch_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  match_id    TEXT NOT NULL,
  home_team   TEXT NOT NULL,
  away_team   TEXT NOT NULL,
  competition TEXT,
  watched_at  INTEGER DEFAULT (unixepoch()),
  duration_s  INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_hist_user ON watch_history(user_id);
CREATE INDEX IF NOT EXISTS idx_hist_date ON watch_history(watched_at);
