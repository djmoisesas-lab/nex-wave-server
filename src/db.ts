import { Pool } from 'pg';
import path from 'path';

const DATABASE_URL = process.env.DATABASE_URL;

let pool: Pool;

function getPool(): Pool {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({ connectionString: DATABASE_URL, parseInt8: true });
    initSchema();
  }
  return pool;
}

function prepare(sql: string, params: any[]): { text: string; values: any[] } {
  let i = 0;
  const text = sql
    .replace(/\?/g, () => `$${++i}`)
    .replace(/datetime\('now',\s*'([^']+)'\)/g, (_, interval) => {
      const neg = interval.startsWith('-');
      return `NOW() ${neg ? '-' : '+'} INTERVAL '${interval.replace(/^[+-]/, '')}'`;
    })
    .replace(/datetime\('now'\)/g, 'NOW()')
    .replace(/INSERT OR IGNORE\s+INTO\s+(\S+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/g, 'INSERT INTO $1 ($2) VALUES ($3) ON CONFLICT DO NOTHING');
  return { text, values: params };
}

export function getDb() {
  const pool = getPool();
  return {
    query(sql: string) {
      return {
        get: async (...params: any[]) => {
          const { text, values } = prepare(sql, params);
          const result = await pool.query(text, values);
          return result.rows[0] || null;
        },
        all: async (...params: any[]) => {
          const { text, values } = prepare(sql, params);
          const result = await pool.query(text, values);
          return result.rows;
        },
        run: async (...params: any[]) => {
          const { text, values } = prepare(sql, params);
          const result = await pool.query(text, values);
          return { changes: result.rowCount ?? 0 };
        },
      };
    },
  };
}

function initSchema() {
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT,
      bio TEXT DEFAULT '',
      avatar_url TEXT,
      banner_url TEXT,
      social_instagram TEXT,
      social_soundcloud TEXT,
      social_mixcloud TEXT,
      social_tiktok TEXT DEFAULT '',
      social_facebook TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      is_public INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      genre TEXT DEFAULT '',
      bpm REAL,
      musical_key TEXT DEFAULT '',
      description TEXT DEFAULT '',
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      duration REAL DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      waveform_data TEXT,
      cover_url TEXT,
      plays INTEGER DEFAULT 0,
      downloads INTEGER DEFAULT 0,
      is_public INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_url TEXT,
      is_public INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (playlist_id, track_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, track_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_id TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
    );

    ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id TEXT;

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      notify_on_upload INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_user_id ON tracks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_is_public ON tracks(is_public);
    CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
    CREATE INDEX IF NOT EXISTS idx_likes_track_id ON likes(track_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      track_id TEXT,
      actor_id TEXT NOT NULL,
      read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);

    CREATE TABLE IF NOT EXISTS track_plays (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      user_id TEXT,
      ip TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_track_plays_track_id ON track_plays(track_id);
    CREATE INDEX IF NOT EXISTS idx_track_plays_user_id ON track_plays(user_id);
    CREATE INDEX IF NOT EXISTS idx_track_plays_ip ON track_plays(ip);

    CREATE TABLE IF NOT EXISTS comment_likes (
      user_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, comment_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id);

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);

    CREATE TABLE IF NOT EXISTS play_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_track ON play_history(track_id);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      user_id TEXT,
      reason TEXT NOT NULL,
      description TEXT DEFAULT '',
      resolved INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reports_track ON reports(track_id);
  `).catch((err) => {
    console.error('Schema initialization error:', err);
  });
}
