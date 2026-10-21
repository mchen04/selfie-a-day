CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id, created_at);

CREATE TABLE push_prefs (
  user_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, album_id)
);

CREATE TABLE notification_log (
  user_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  event TEXT NOT NULL,
  day_key TEXT NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (user_id, album_id, event, day_key)
);
