-- GameShow — esquema SQLite (spec §10.5)
-- Diseñado para que cada juego (gameId) aísle su propio estado, rondas, preguntas y sesiones.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  date        TEXT,
  status      TEXT NOT NULL DEFAULT 'draft',     -- draft | published | archived
  note        TEXT,
  theme       TEXT,                              -- JSON con config visual
  access_code TEXT,                              -- 4-6 dígitos para que los jugadores entren
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                     -- multirespuesta | pulsador | precio | imagen | cancion | boom | ruleta | imagen_fija
  sort_order  INTEGER NOT NULL DEFAULT 0,
  config      TEXT                                -- JSON: { time, basePoints, bonusMax, penalty, background, logo }
);

CREATE INDEX IF NOT EXISTS idx_rounds_game ON rounds(game_id, sort_order);

CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  round_id    TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  content     TEXT NOT NULL,                     -- JSON específico por tipo (spec §10.6)
  media_url   TEXT,
  config      TEXT                                -- JSON con overrides
);

CREATE INDEX IF NOT EXISTS idx_questions_round ON questions(round_id, sort_order);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  state       TEXT                                -- JSON con estado completo (snapshot para reanudar)
);

CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  photo_url   TEXT,
  device_id   TEXT,                               -- para reconexión persistente (cookie/localStorage del iPad)
  score       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_teams_session ON teams(session_id);
CREATE INDEX IF NOT EXISTS idx_teams_device  ON teams(device_id);
