PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_attempts (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE sync_clock (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  revision INTEGER NOT NULL
);
CREATE TABLE photo_uploads (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  token TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE albums (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT,
  time_zone TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX albums_active_name ON albums(user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX albums_active_name_key ON albums(user_id, name_key) WHERE deleted_at IS NULL AND name_key IS NOT NULL;
CREATE UNIQUE INDEX albums_owned_id ON albums(id) WHERE id <> 'selfies';
CREATE INDEX albums_sync ON albums(user_id, revision);
CREATE TABLE photos (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  time_zone TEXT,
  tz_offset_minutes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  mime TEXT NOT NULL,
  mirrored INTEGER NOT NULL,
  source TEXT NOT NULL,
  timer_seconds INTEGER NOT NULL DEFAULT 0,
  master_bytes INTEGER NOT NULL,
  thumb_bytes INTEGER NOT NULL,
  deleted_at INTEGER,
  purged_at INTEGER,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, album_id) REFERENCES albums(user_id, id)
);
CREATE INDEX photos_updated ON photos(user_id, updated_at);
CREATE INDEX photos_album_day ON photos(user_id, album_id, day_key);
CREATE INDEX photos_sync ON photos(user_id, revision);
CREATE INDEX photos_trash ON photos(deleted_at) WHERE purged_at IS NULL AND deleted_at IS NOT NULL;
CREATE UNIQUE INDEX photos_active_day ON photos(user_id, album_id, day_key) WHERE deleted_at IS NULL AND purged_at IS NULL;

CREATE TRIGGER albums_insert_revision AFTER INSERT ON albums BEGIN
  INSERT INTO sync_clock(user_id, revision) VALUES (NEW.user_id, 1)
    ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
  UPDATE albums SET revision = (SELECT revision FROM sync_clock WHERE user_id = NEW.user_id)
    WHERE user_id = NEW.user_id AND id = NEW.id;
END;
CREATE TRIGGER albums_update_revision AFTER UPDATE OF updated_at ON albums BEGIN
  INSERT INTO sync_clock(user_id, revision) VALUES (NEW.user_id, 1)
    ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
  UPDATE albums SET revision = (SELECT revision FROM sync_clock WHERE user_id = NEW.user_id)
    WHERE user_id = NEW.user_id AND id = NEW.id;
END;
CREATE TRIGGER photos_insert_revision AFTER INSERT ON photos BEGIN
  INSERT INTO sync_clock(user_id, revision) VALUES (NEW.user_id, 1)
    ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
  UPDATE photos SET revision = (SELECT revision FROM sync_clock WHERE user_id = NEW.user_id)
    WHERE user_id = NEW.user_id AND id = NEW.id;
END;
CREATE TRIGGER photos_update_revision AFTER UPDATE OF updated_at ON photos BEGIN
  INSERT INTO sync_clock(user_id, revision) VALUES (NEW.user_id, 1)
    ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1;
  UPDATE photos SET revision = (SELECT revision FROM sync_clock WHERE user_id = NEW.user_id)
    WHERE user_id = NEW.user_id AND id = NEW.id;
END;
CREATE TRIGGER photos_quota BEFORE INSERT ON photos WHEN NEW.purged_at IS NULL BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM photos WHERE user_id = NEW.user_id AND purged_at IS NULL) >= 5000
    OR (SELECT coalesce(sum(master_bytes + thumb_bytes), 0) FROM photos WHERE user_id = NEW.user_id AND purged_at IS NULL)
      + NEW.master_bytes + NEW.thumb_bytes > 2147483648
    THEN RAISE(ABORT, 'quota_exceeded') END;
END;
