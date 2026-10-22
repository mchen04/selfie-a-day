# Data flow

What the app stores and sends, why, and how each item is deleted.
The numbers come from the ten-day simulation (`npm run sim`) read by `scripts/audit/requests.mjs`, and from `scripts/audit/queries.mjs`.
`worker/test/core/data-audit.test.ts` fails if a column nothing reads, an index serving no statement, or a response field the client never reads comes back without a recorded reason.

## Inventory

### Server: Cloudflare D1

| Table | Columns | Why | Retention and deletion |
|---|---|---|---|
| `users` | `id, username, password_hash` | Sign-in; PBKDF2-SHA256, 100,000 rounds | Kept with the account. There is no self-service account deletion. |
| `sessions` | `id` (SHA-256 of the token), `user_id, expires_at` | Session lookup | 90 days, renewed under 45 days left. Logout deletes the row; cron deletes expired rows, 100 per run. |
| `auth_attempts` | `key, window_start, count` | Login and signup rate limits | Cron deletes a counter after its own 15-minute, hourly or daily window, 100 per run. A successful login deletes the 15-minute username counter. |
| `sync_clock` | `user_id, revision` | Delta-sync cursor; triggers advance it on album and photo writes | One row per user. |
| `albums` | `user_id, id, name, name_key, time_zone, updated_at, deleted_at, revision` | Album list and fixed zones. `name_key` enforces case-insensitive unique names; writing `updated_at` fires the revision trigger | Kept with the account. `deleted_at` is always null: no route deletes albums. |
| `photos` | `user_id, id, album_id, day_key, captured_at, width, height, mime, mirrored, timer_seconds, master_bytes, thumb_bytes, deleted_at, purged_at, updated_at, revision` | Metadata for sync, timeline and ZIP. `master_bytes`/`thumb_bytes` feed the 5,000-photo / 2 GiB quota and are not sent to clients | Trash sets `deleted_at` (server time). Permanent delete, Empty Trash and the 30-day cron purge delete both R2 objects and keep the row as a tombstone (`purged_at`) so delta sync can report `removed`. Tombstones are never deleted. |
| `photo_uploads` | `user_id, id, token, started_at` | Upload lock, so two devices cannot write one photo | Deleted when the upload ends. A lock left by a crashed upload is taken over after 10 minutes. |
| `push_subscriptions` | `endpoint, user_id, p256dh, auth, time_zone, created_at, updated_at` | Web Push delivery and the device zone | Logout deletes the device's row. A new subscription drops the user's oldest beyond 10. A 404 or 410 from the push service deletes the row. |
| `push_prefs` | `user_id, album_id, enabled, time` | Reminder time per album | Overwritten on save. Kept with the album. |
| `notification_log` | `user_id, album_id, event, day_key, sent_at` | Sends each reminder, nudge or milestone at most once per day | Each cron run deletes rows older than UTC's day before yesterday, 500 per run. |

Cron runs every 5 minutes (`*/5 * * * *`).

### Server: R2 and the push service

| Item | Content | Why | Deletion |
|---|---|---|---|
| R2 `u/<userId>/<photoId>/master` | JPEG or WebP, at most 4 MiB | The photo | Purge (permanent delete, Empty Trash, 30-day cron) |
| R2 `u/<userId>/<photoId>/thumb` | At most 256 KiB | Timeline and Trash grids | Same as master |
| Browser push service (Apple, Google, Mozilla) | The endpoint; aes128gcm-encrypted `{title, body, albumId, tag, url}`; TTL 4 h | Reminders | The service drops undelivered messages after the TTL. Unsubscribing at logout ends the endpoint. |

Images are served only through the Worker after an ownership check.

### Device

| Item | Content | Why | Deletion |
|---|---|---|---|
| Cookie `__Host-sad_session` | HttpOnly session token | Authentication | Logout or any 401 expires it |
| Cookie `__Host-sad_hint` | The constant `1`, readable by the app | Lets a cold start without a cached account wait for `/api/auth/me` instead of showing the account form | Same as the session cookie |
| IndexedDB `selfie-a-day` v3, `kv` | `user` (id and username); `user:<id>:snapshot` (albums, photo metadata, cursor); `user:<id>:settings` | Opens offline and shows the timeline before the network answers | Logout deletes the user's keys. A 401 keeps them for the same user's next sign-in. |
| IndexedDB `outbox` | Pending captures: metadata, master and thumbnail | Offline capture and retry | Deleted after the server accepts the upload. Logout deletes them after one warning. A 401 keeps them for the same user. |
| IndexedDB `ghosts` | One image per album: the newest active photo | Alignment overlay, offline thumbnails | Replaced when a newer photo arrives; logout deletes them |
| localStorage | `sad.camera.timer.<albumId>`, `sad.camera.flash`, `sad.push.sent` (last subscription sent: user, endpoint, zone, time) | Camera choices; skips unchanged subscription re-sends | Logout removes every `sad.camera.` and `sad.push.` key |
| Cache Storage | Workbox precache: 11 entries (HTML, one script, one stylesheet, workbox-window, icons, manifest), no API responses | Offline app shell | Replaced on each deploy |
| HTTP cache | Thumbnails and masters (`private, immutable`, `Vary: Cookie`) | Avoids re-downloading images | Browser-managed. `Vary: Cookie` keeps another account's session from matching them. |

## Measured flows

Ten simulated days, two devices plus a third account, measured before this audit (Stage 2 end, cd27131) and after it (9a26bab).
Bytes are network headers plus bodies as Playwright reports them; it cannot see multipart upload bodies.

| Flow | Requests before → after | Bytes before → after |
|---|---:|---:|
| second-device sync | 62 → 38 | 192.4 → 125.6 kB |
| trash, restore, delete | 118 → 96 | 306.8 → 282.3 kB |
| offline and reconnect | 51 → 33 | 45.7 → 34.6 kB |
| reopen (cold start) | 53 → 40 | 94.5 → 84.6 kB |
| albums | 22 → 15 | 30.5 → 17.2 kB |
| capture and upload | 61 → 55 | 114.1 → 88.8 kB |
| account isolation | 25 → 23 | 135.5 → 133.0 kB |
| sign-in and sign-up | 97 → 96 | 470.1 → 531.5 kB |
| timelapse | 71 → 71 | 392.5 → 392.5 kB |
| Download my photos (ZIP) | 63 → 63 | 312.9 → 312.8 kB |
| reminders | 16 → 16 | 14.8 → 14.3 kB |
| logout | 25 → 25 | 13.6 → 13.3 kB |
| All | 665 → 573 | 2,130 → 2,044 kB |

Sign-in grows because faster syncs let ghost downloads finish inside the sign-in step: 16 → 27 master downloads there, 23 → 15 in second-device sync.
That split also moves from run to run: 7 requests and 49 kB between the 9a26bab and 4752155 runs, whose endpoint counts are identical.
Master downloads total 207 in both runs. Each is a ghost, a timelapse frame or a ZIP entry; repeat views come from the HTTP cache.

| Endpoint | Requests before → after | Bytes before → after |
|---|---:|---:|
| `GET /api/sync` (delta) | 124 → 80 | 140.4 → 89.7 kB |
| `GET /api/sync` (full) | 14 → 14 | 22.1 → 20.3 kB |
| `GET /api/auth/me` | 75 → 46 | 75.1 → 45.7 kB |
| `PUT /api/push/subscription` | 32 → 13 | — |
| `GET /api/push/prefs` | 29 → 29 | 30.0 → 29.3 kB |
| `PUT /api/push/prefs/:albumId` | 6 → 6 | 7.6 → 7.2 kB |
| `GET /api/photos/:id/master` | 207 → 207 | 1,214.5 → 1,214.5 kB |
| `GET /api/photos/:id/thumb` | 48 → 48 (105 more from the HTTP cache) | 84.3 → 84.3 kB |

On day 10, the phone's IndexedDB `kv` holds 6,537 B (10,771 B before) and three ghosts of 18.5 kB.
Server D1 holds 37 photo rows (one tombstone), 5 albums, 5 sessions, 2 reminder rows and 2 notification-log rows (11 before); R2 holds 72 objects, 150.7 kB.

## D1 statements

45 statements in `worker/src` and 9 trigger statements, from `node scripts/audit/queries.mjs`.
Every per-user lookup uses a primary key or index. Two cron statements read a whole index: reminder candidates walk every reminder row, and the log purge walks the notification log.

| Request | Statements | Tables | Index |
|---|---|---|---|
| Any signed-in request | 1 read; 1 write only when renewal is due | `sessions`, `users` | primary keys |
| `POST /api/auth/signup` | Counter upsert, user insert, session insert | `auth_attempts`, `users`, `sessions` | primary keys |
| `POST /api/auth/login` | 3 counter upserts, user lookup, refund or clear, session insert | `auth_attempts`, `users`, `sessions` | primary keys, `users.username` |
| `POST /api/auth/logout` | 1 delete | `sessions` | primary key |
| `GET /api/sync` | Default-album insert on a full sync only; one batch of 4 reads | `sync_clock`, `albums`, `photos` | `albums_sync`, `photos_sync` (revision after the cursor) |
| `PUT /api/albums/:id` | 1 upsert with RETURNING | `albums` | primary key, `albums_active_name_key` |
| `PUT /api/photos/:id` | Retry check, album check, quota sum, lock, retake + insert batch, unlock | `photos`, `albums`, `photo_uploads` | `photos_active_day`, `photos_sync`, primary keys |
| `GET /api/photos/:id/*`, `PATCH /api/photos/:id` | Ownership read; PATCH updates 1 row | `photos` | primary key |
| `DELETE /api/photos/:id`, `POST /api/trash/empty` | Read, then purge batches of 96 | `photos` | primary key, `photos_sync` |
| `/api/push/*` | Prefs read; subscription upsert and trim to 10; pref upsert | `push_prefs`, `push_subscriptions`, `albums` | primary keys, `push_subscriptions_user` |
| Cron (every 5 min) | Auth purge, trash purge, log purge, reminder candidates, today's photo, log claim and mark | all except `sync_clock` | `sessions_expiry`, `auth_attempts_window`, `photos_trash`, `photos_active_day`, primary keys |
| Triggers | Revision bump on album and photo writes; quota check on photo insert | `sync_clock`, `albums`, `photos` | primary keys, `photos_sync` |

Kept on purpose:
- The two writes on read requests: session renewal and the first sync's default album.
- `albums.name_key`, which enforces unique names.
- `albums.updated_at` and `photos.updated_at`, which fire the revision triggers.
- The full-index reads in cron: the reminder query must see every enabled reminder, and the log holds at most three days of rows.

## Removals in this audit

| Removed | Before → after | Guarded by |
|---|---|---|
| Subscription re-sent on every start, reconnect and focus; now sent when the user, endpoint or zone changes, or after 24 h | `PUT /api/push/subscription` 32 → 13 | `tests/unit/push/client.test.ts` |
| `/api/auth/me` before trash, restore, delete, Empty Trash and album saves; those writes carry `X-Selfie-User` | `GET /api/auth/me` 75 → 46 | `trashes, empties Trash and saves an album with one named write each and no session check first` (`sync.test.ts`), `worker/test/core/upload-user.test.ts` |
| Second delta sync after a refresh that uploaded nothing | Delta syncs 124 → 80 | `refreshes with one session check and one delta sync when nothing uploads…` (`sync.test.ts`) |
| Hourly `sessions.last_seen_at` write, and the column | Signed-in reads write 0 rows until renewal | `writes nothing on signed-in requests until renewal is due` |
| Default-album insert on every sync | Runs on 14 full syncs, not all 94 | `creates the default album on the first full sync, never from a delta sync` (`worker/test/core/photos.test.ts`) |
| Unread fields: photo `timeZone`, `tzOffsetMinutes`, `source`; photo `masterBytes`/`thumbBytes` in the API and on the device; album `createdAt`/`updatedAt`; sync `serverTime`; client schema stamps; `users.created_at`, `sessions.created_at`, `push_prefs.updated_at` | Full sync 22.1 → 20.3 kB for the same 14 requests; day-10 device `kv` 10,771 → 6,537 B | `data-audit.test.ts` |
| Reminder `time_zone`: stored and returned, but the scheduler uses the album or device zone | `GET /api/push/prefs` 30.0 → 29.3 kB, PUT 7,562 → 7,215 B | `returns only the current user preferences…` (`push.test.ts`), `tests/unit/push/reminders.test.ts` |
| Indexes that served no statement: `photos_updated`, `sessions_user`, `albums_active_name` | 3 fewer index writes per affected insert or update | `keeps only indexes that serve a statement or enforce uniqueness` |
| A second upload when Retry is tapped as an upload finishes (Retry wrote the finished entry back) | 1 → 0 extra photo PUTs in the race | `does not re-queue a photo whose upload finishes while Retry clears the backoff` (`tests/unit/cloud/sync.test.ts`) |
| Notification-log rows for days no zone can still be on | 11 → 2 rows on day 10 | `drops notification log days no zone can still be on` |
| Dead client code, styles and the `__APP_VERSION__` define | Entry JS 294,880 → 294,400 B (gzip 92,319 → 92,172); CSS 26,823 → 24,385 B (gzip 6,299 → 5,815) | Build, typecheck, lint |

Migrations 0001 and 0002 were edited in place; production D1 has no migrations applied yet.

## Open notes

- Purged photo tombstones (`purged_at`) are never deleted. They are small and let delta sync report removals to a device that was offline.
- `albums.deleted_at` and the album `deletedAt` field are always null because no route deletes albums. Removing them would touch most album code to save about 17 bytes per album per full sync.
- There is no self-service account deletion. Removing an account means deleting its D1 rows and its `u/<userId>/` R2 prefix by hand.
