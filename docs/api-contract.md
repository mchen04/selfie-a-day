# Client and Worker contract

The API uses the same origin as the app; Vercel rewrites `/api` to the Worker.
`src/api/client.ts` owns all client network calls; push code and the service worker use it.
Worker routes share authentication, CSRF checks and response headers (`worker/src/index.ts`).

## Requests and responses

| Client operation | Request | Success response | Expected errors |
|---|---|---|---|
| Signup | `POST /api/auth/signup` `{username,password}` | 201 `{user:{id,username}}`, session and hint cookies | 400 `invalid_username`, `invalid_password`; 409 `username_taken`; 429 `too_many_attempts` |
| Login | `POST /api/auth/login` `{username,password}` | 200 `{user}`, session and hint cookies | 401 `invalid_credentials`; 429 `too_many_attempts` |
| Account check | `GET /api/auth/me` | 200 `{user}` | 401 `unauthenticated` |
| Logout | `POST /api/auth/logout` | 204, both cookies cleared | 204 without a session |
| Sync | `GET /api/sync[?since=<cursor>]` | 200 `{albums,photos,removed,cursor}` | 400 `invalid_cursor` |
| Save album | `PUT /api/albums/:id` `{name,timeZone}` | 200 `{album}` | 400 `invalid_album`, `invalid_name`, `invalid_time_zone`; 404 another owner's ID; 409 `album_name_taken` |
| Upload | `PUT /api/photos/:id`, multipart `meta`, `master`, `thumb` | 201 `{photo,replaced}`; 200 `{photo,replaced:[]}` on retry | 400 `invalid_photo`, `invalid_multipart`, `invalid_meta`, `invalid_image`; 404 `not_found`; 413 `quota_exceeded`, `payload_too_large`; 503 `upload_in_progress` |
| Image | `GET /api/photos/:id/master` or `/thumb` | 200 image bytes; 304 for a matching ETag | 404 `not_found` |
| Trash or restore | `PATCH /api/photos/:id` `{deletedAt:number\|null}` | 200 `{photo}` | 400 `invalid_deleted_at`; 404 `not_found`; 409 `day_taken` |
| Permanent deletion | `DELETE /api/photos/:id` | 204 | 404 `not_found` |
| Empty Trash | `POST /api/trash/empty` | 200 `{deleted:number}` | Shared errors |
| Push key | `GET /api/push/config` | 200 `{publicKey}` | Shared errors |
| Register device | `PUT /api/push/subscription` `{endpoint,keys:{p256dh,auth},timeZone}` | 204 | 400 `invalid_json`, `invalid_endpoint`, `invalid_keys`, `invalid_time_zone` |
| Remove device | `DELETE /api/push/subscription` `{endpoint}` | 204, own rows only | 400 `invalid_json`, `invalid_endpoint` |
| Reminder settings | `GET /api/push/prefs` | 200 `{prefs:[{albumId,enabled,time}]}` | Shared errors |
| Save reminder | `PUT /api/push/prefs/:albumId` `{enabled,time}` | 200 `{pref}` | 400 `invalid_json`, `invalid_enabled`, `invalid_time`; 404 `not_found` |

Shared errors: 401 `unauthenticated`, 403 `forbidden`, 405 `method_not_allowed`, 404 `not_found` for unknown paths, 409 `user_mismatch`, 413 `payload_too_large` for JSON over 16 KiB, 500 `internal_error`.
Errors use `{error:string}`.
The client shows specific messages for common errors and a fallback for other codes.

## Session, CSRF and account guard

| Item | Rule |
|---|---|
| Session cookie | `__Host-sad_session` (`sad_session` on local HTTP): HttpOnly, SameSite=Strict, Secure, 90 days. D1 stores only the SHA-256 of the token. |
| Renewal | A signed-in request writes nothing until under 45 days remain; then it extends the row and resends both cookies. |
| Hint cookie | `__Host-sad_hint=1` (`sad_hint` locally): readable, not HttpOnly, same attributes and lifetime. It carries no identity. On a cold start without a cached account, the app waits for `/api/auth/me` instead of flashing the account form when the hint is exactly `1`. |
| Clearing | Logout and every 401 from a request without a valid session expire both cookies. A failed password attempt keeps an existing valid session. |
| CSRF | Every non-GET needs an allowed `Origin` and `X-Selfie-CSRF: 1`; otherwise 403 `forbidden`. OPTIONS gets 405 and no CORS headers. |
| Account guard | Every non-GET outside `/api/auth/` sends `X-Selfie-User: <user id>`. If the cookie now belongs to another account (another tab signed in), the Worker answers 409 `user_mismatch` before any write. The client then signs out and keeps the queued photos with their owner. |
| Login limits | Per username: 10 per 15 min and 30 per day. Per IP: 50 per 15 min. Counters are reserved atomically before password verification. Success clears the 15-minute username counter and returns its daily and IP reservations. |
| Signup limit | 10 per hour per IP. |
| Rate responses | 429 `too_many_attempts` with `Retry-After` in seconds. 503 `upload_in_progress` sends `Retry-After: 1`. The client shows the wait and uses it for upload retries. |

Direct `workers.dev` callers can spoof `X-Forwarded-For`; the username limits and PBKDF2 still apply.

## Headers and caching

Requests use `credentials: 'same-origin'`.
JSON mutations use `Content-Type: application/json`; multipart uploads leave the boundary to the browser.
JSON responses use `Cache-Control: no-store`.
Images use `Cache-Control: private, max-age=31536000, immutable`, `Vary: Cookie` and an ETag.
All responses include `X-Content-Type-Options: nosniff`.
The service worker never caches API responses and excludes them from its app-shell fallback.

## Data fields

| Record | Fields |
|---|---|
| User | `id, username` |
| Album | `id, name, timeZone, deletedAt` |
| Photo | `id, albumId, dayKey, capturedAt, width, height, mime, mirrored, timerSeconds, deletedAt` |
| Upload metadata | Photo fields except `id, deletedAt` |
| Reminder | `albumId, enabled, time` |
| Push payload | `title, body, albumId, tag, url` |

Times use epoch milliseconds; reminder time uses `HH:MM`.
`timeZone` is an IANA name or null (follow the device); offsets such as `+01:00` are refused.
`timerSeconds` is 0, 3, 5 or 10; capture records it, and upload and sync preserve it.
Reminders carry no zone: the scheduler uses the album's fixed zone, else the zone of the user's most recently updated device subscription.
`deletedAt` on albums is always null today; no route deletes albums.

Full sync includes active and trashed photos, and creates the Selfies album on an account's first sync.
Delta sync returns rows changed after the cursor, plus `removed` IDs of purged photos.
Revision cursors distinguish writes in the same millisecond.
A 400 `invalid_cursor` makes the client drop its cursor and try one full sync.

## Regression map

Each row is a behavior that was once broken, with the tests that now guard it.

| Behavior | Test (file) |
|---|---|
| Hint cookie is set with the session, renewed with it, and cleared on logout, 401 and a stale failed login | `sets the readable constant hint beside the signup cookie`, `renews both cookies only when the session needs renewal`, `clears both cookies for a %s session on protected routes`, `clears a stale hint when a password attempt fails without a valid session` (`worker/test/core/session-security.test.ts`) |
| Startup reads the hint exactly | `waits for a cookie-only session with %s without showing the account form`, `ignores a cookie without the exact hint: %s` (`tests/unit/cloud/startup.test.ts`); `a cookie-only session reaches capture without showing the account form` (`tests/e2e/cloud/accounts.spec.ts`) |
| A proxy keeps both `Set-Cookie` headers | The `getSetCookie()` join in `tests/e2e/push.spec.ts` |
| Signed-in reads write nothing until renewal | `writes nothing on signed-in requests until renewal is due` (`session-security.test.ts`) |
| Writes for another account stop with 409 | `rejects another user before writes with %s session days remaining` (`worker/test/core/upload-user.test.ts`); `signs out after an upload finds another account and resumes only for the original owner` (`tests/unit/cloud/session.test.ts`) |
| Session expiry keeps queued captures | `keeps queued photos and caches on 401 and resumes uploads for the same user`, `isolates retained photos when another user signs in and clears only an explicit logout` (`session.test.ts`) |
| Retry cannot re-queue a photo whose upload just finished | `does not re-queue a photo whose upload finishes while Retry clears the backoff` (`sync.test.ts`) |
| An upload is not held behind a running refresh | `uploads before an in-flight refresh returns its sync response`, `uploads before a refresh queued during a ghost download starts another cycle` (`tests/unit/cloud/sync.test.ts`) |
| A refresh during a ghost download still sees a newer retake | `pulls a newer untimed retake when refresh arrives during a ghost download` (`sync.test.ts`) |
| Restore shows only after acceptance and persistence | `keeps a restored photo in Trash until the server accepts it and reload can read it` (`sync.test.ts`); `tests/e2e/trash.spec.ts` |
| Invalid cursor recovers once | `replaces an invalid cursor with one full snapshot and keeps pending captures`, `does not loop when the full snapshot also rejects its cursor` (`sync.test.ts`) |
| Offline reopen needs the full precache | `tests/unit/offline.test.ts`; `cached account and metadata open offline without caching API responses in the service worker` (`tests/e2e/offline-and-privacy.spec.ts`) |
| Settings shows an album that syncs in after it opened | `shows an album that syncs in after Settings opened and saves only real edits` (`tests/unit/push/app.test.ts`) |
| The subscription is re-sent only when it changed or is a day old | `re-sends an unchanged subscription only after a day, or for another user, endpoint or time zone` (`tests/unit/push/client.test.ts`) |
| Reminders store no zone | `returns only the current user preferences and requires album ownership` (`worker/test/push/push.test.ts`); PUT bodies in `tests/unit/push/reminders.test.ts` |
| Reminder zone follows the album, else the newest device | `uses a changed album zone for reminder time and today`, `follows the most recently synced device zone on a DST day`, `uses the effective zone date to suppress photos across midnight` (`push.test.ts`) |
| Notification log keeps only days a zone can still be on | `drops notification log days no zone can still be on` (`push.test.ts`) |
| Albums refuse offset zones | Album validation loop in `worker/test/core/photos.test.ts` |
| Parallel login guesses cannot exceed limits | `reserves concurrent guesses before password verification` (`session-security.test.ts`) |
| Trash retention starts at server time | `starts trash retention at server time despite an old client clock` (`session-security.test.ts`) |
| Expired sessions and counters are purged in bounded batches | `purges expired authentication rows in bounded cron batches using scheduled time`, `expires counters only when their own login, daily or signup window ends` (`session-security.test.ts`) |
| Push bodies are capped at 16 KiB | `caps %s %s bodies at 16 KiB` (`worker/test/core/push.test.ts`) |
| Permanent actions need two taps | `requires two taps for empty-trash and resets confirmation on blur` and the delete-forever pair (`tests/unit/trash.test.ts`) |
| Push routes and cron reach the real handlers | `worker/test/core/push.test.ts`, `worker/test/core/scheduled.test.ts`, `tests/e2e/push.spec.ts` |
| Workerd push delivery uses `redirect: 'manual'`; failures are counted and redacted | `worker/test/push/runtime.test.ts`; the failed-send cases in `push.test.ts` |
| Timer survives capture, upload and sync | `tests/unit/camera/capture.test.ts`, `tests/unit/cloud/api.test.ts`, `worker/test/core/photos.test.ts`, `tests/e2e/camera-controls.spec.ts` |
| Flash exposes a full-viewport white layer before capture | `flash toggles in one tap and exposes a full-viewport white layer before capture` (`camera-controls.spec.ts`) |
| Sign-in opens the camera, and the ZIP is named for the local day | `opens the camera after logging out from Settings and signing back in` (`session.test.ts`); `names the ZIP for today on this device, not the UTC date (an evening export in Los Angeles)` (`tests/unit/cloud/download.test.ts`); days 7 and 9 of `npm run sim` |

## Verification boundary

The default Worker tests use real Miniflare and a local HTTP push receiver; the socket-free mode checks the same push rules with SQLite.
`tests/e2e/push.spec.ts` checks the full browser path with a decrypting receiver and stubbed notifications.
Physical iPhone delivery of installed-PWA push is not verified.
