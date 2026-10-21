# Client and Worker contract map

The API uses the same origin as the app.
`src/api/client.ts` owns all client network calls.
Push code and the service worker use that module.
Worker routes share authentication, CSRF checks and response headers.

## Requests and responses

| Client operation | Request | Success response | Expected errors |
|---|---|---|---|
| Signup | `POST /api/auth/signup` `{username,password}` | 201 `{user:{id,username}}`, session cookie | 400 `invalid_username`, `invalid_password`; 409 `username_taken`; 429 `too_many_attempts` |
| Login | `POST /api/auth/login` `{username,password}` | 200 `{user}`, session cookie | 401 `invalid_credentials`; 429 `too_many_attempts` |
| Account check | `GET /api/auth/me` | 200 `{user}` | 401 `unauthenticated` |
| Logout | `POST /api/auth/logout` | 204, expired cookie | 204 without a session |
| Sync | `GET /api/sync?since=<cursor>` | 200 `{albums,photos,removed,cursor,serverTime}` | 400 `invalid_cursor` |
| Save album | `PUT /api/albums/:id` `{name,timeZone,createdAt}` | 200 `{album}` | 400 invalid metadata; 409 `album_name_taken` |
| Upload | `PUT /api/photos/:id`, multipart `meta`, `master`, `thumb` | 201 `{photo,replaced}`; 200 on retry | 400 invalid metadata/image; 404 `not_found`; 413 `quota_exceeded`, `payload_too_large`; 503 `upload_in_progress` |
| Image | `GET /api/photos/:id/master` or `/thumb` | 200 image bytes; 304 for matching ETag | 404 `not_found` |
| Trash or restore | `PATCH /api/photos/:id` `{deletedAt:number\|null}` | 200 `{photo}` | 400 `invalid_deleted_at`; 404 `not_found`; 409 `day_taken` |
| Permanent deletion | `DELETE /api/photos/:id` | 204 | 404 `not_found` |
| Empty Trash | `POST /api/trash/empty` | 200 `{deleted:number}` | Shared errors |
| Push key | `GET /api/push/config` | 200 `{publicKey}` | Shared errors |
| Register device | `PUT /api/push/subscription` `{endpoint,keys:{p256dh,auth},timeZone}` | 204 | 400 `invalid_json`, `invalid_endpoint`, `invalid_keys`, `invalid_time_zone` |
| Remove device | `DELETE /api/push/subscription` `{endpoint}` | 204, own rows only | 400 `invalid_json`, `invalid_endpoint` |
| Reminder settings | `GET /api/push/prefs` | 200 `{prefs:[{albumId,enabled,time,timeZone}]}` | Shared errors |
| Save reminder | `PUT /api/push/prefs/:albumId` `{enabled,time,timeZone}` | 200 `{pref}` | 400 `invalid_json`, `invalid_enabled`, `invalid_time`, `invalid_time_zone`; 404 `not_found` |

Protected operations return 401 `unauthenticated` without a valid session.
Every mutation needs an allowed `Origin` and `X-Selfie-CSRF: 1`.
The browser supplies Origin; the API module sets the CSRF header.
Missing or rejected CSRF checks return 403 `forbidden`.
Unsupported methods return 405 `method_not_allowed`; OPTIONS has no CORS response.
Unknown paths return 404 `not_found`.
Errors use `{error:string,message?:string}`.
The client shows specific messages for common errors and a fallback for other codes.
Protected 401 responses open sign-in; login failures stay inline.
Rate limits include `Retry-After`, which the client displays and uses for upload retries.

Requests use `credentials: 'same-origin'`.
JSON mutations use `Content-Type: application/json`.
Multipart uploads leave the boundary header to the browser.
JSON responses use `Cache-Control: no-store`.
Images use `Cache-Control: private, max-age=31536000, immutable`, `Vary: Cookie` and ETag.
All responses include `X-Content-Type-Options: nosniff`.
The service worker excludes API requests from its app-shell fallback.

## Data fields

| Record | Fields |
|---|---|
| User | `id, username` |
| Album | `id, name, timeZone, createdAt, updatedAt, deletedAt` |
| Photo | `id, albumId, dayKey, capturedAt, timeZone, tzOffsetMinutes, width, height, mime, mirrored, source, timerSeconds, masterBytes, thumbBytes, deletedAt` |
| Upload metadata | Photo fields except `id, masterBytes, thumbBytes, deletedAt` |
| Push payload | `title, body, albumId, tag, url` |

Times use epoch milliseconds; reminder time uses `HH:MM`.
`timerSeconds` is required in photo metadata and defaults to 0 at capture.
Its allowed values are 0, 3, 5 and 10.
The capture result records it before entering the upload queue.
Upload, Worker storage, full sync and delta sync preserve it.
Client-only `schema` stays out of upload DTOs.
The camera reads its album's latest active photo from the shared store.
Synced photos from another device can replace an older local timer choice.
An untimed latest photo supplies Off.

Full sync includes active and trashed photos.
Delta sync merges changed rows and removes purged IDs.
Revision cursors distinguish writes in the same millisecond.
The server creates Selfies on first sync.
The client retains metadata and account-scoped pending captures between sessions.
It uses local ghost bytes first and API images for cloud photos.

## Resolved integration gaps

| Gap | Product behavior | Regression coverage |
|---|---|---|
| Push routes and cron reached no-ops | Routes reach push handlers; cron reaches the real scheduler with `scheduledTime` | `worker/test/core/push.test.ts`, `worker/test/core/scheduled.test.ts`, `tests/e2e/push.spec.ts` |
| Local public key had no matching private key | Local starters generate one pair and load both values from one private file | `worker/test/core/local-api.test.ts`, `tests/e2e/push.spec.ts` |
| Local photo metadata allowed a missing timer | Required timer travels through capture, upload and sync without a structural compatibility bridge | `tests/unit/camera/capture.test.ts`, `tests/unit/cloud/api.test.ts`, `worker/test/core/photos.test.ts`, `tests/e2e/camera-controls.spec.ts` |
| Restore hid the row before acceptance or persistence | Mutation visibility follows server acceptance and device persistence | `tests/unit/cloud/sync.test.ts`, `tests/e2e/trash.spec.ts` |
| Camera checks read a removed photo store or mocked cloud | Shared account helper signs in; photo reads merge API metadata with pending uploads | `tests/e2e/camera-controls.spec.ts` |
| Separate push configs bypassed shared checks | One Worker type, lint and test path covers core and push | Worker configs and `npm run verify` |

## Reported regression checks

- `tests/unit/camera/controls.test.ts`: the shared app mock includes sign-in, logout and retry actions.
  It also includes the current account and sync state fields.
- `tests/e2e/camera-controls.spec.ts`: “one shutter tap counts down visibly and saves one timed photo at zero”.
  This reads server photos and pending captures on mobile and desktop.
- `tests/e2e/camera-controls.spec.ts`: “flash toggles in one tap and exposes a full-viewport white layer before capture”.
  This uses the same cloud-aware photo reader on mobile and desktop.
- `tests/e2e/trash.spec.ts`: “trash, undo, restore, and permanently delete a server photo”.
  Restore persists accepted metadata before showing empty Trash on mobile and desktop.
  The added delayed-restore check keeps the request pending before a full photo-page navigation.

The restore regression fails before the fix in `tests/unit/cloud/sync.test.ts`.
It also checks that a fresh reader sees the restored metadata when the UI changes.
The router and cron regressions fail when the push seam returns no-ops.

## Remaining verification boundary

No other endpoint, method, header, status, error-code or DTO mismatch appears in the client/Worker comparison.
The default Worker tests retain real Miniflare and local HTTP delivery.
The socket-free mode checks the same push rules with SQLite and an in-memory receiver.
Browser and Miniflare checks remain separate acceptance requirements.

## Security and retention regressions

Each finding below fails before its fix.
The listed checks cover the changed behavior with synthetic data.

| Finding | Current behavior | Failing regression name and file |
|---|---|---|
| 1. Parallel login guesses bypass limits | Atomic counter reservations precede password verification. Rejected reservations are returned. Success clears the short username counter and returns daily/IP reservations. | `reserves concurrent guesses before password verification` — `worker/test/core/session-security.test.ts` |
| 2. Session expiry deletes queued captures | A protected 401 clears the current account pointer and UI. User-scoped photos, snapshots and ghosts remain for later sign-in. Explicit logout still clears its user's data after the existing warning. | `keeps queued photos and caches on 401 and resumes uploads for the same user`; `isolates retained photos when another user signs in and clears only an explicit logout` — `tests/unit/cloud/session.test.ts` |
| 3. Reminder zone becomes stale | Cron uses the album zone when set. Otherwise it uses the subscription with the latest server `updated_at`. This zone controls both time and dayKey. | `uses a changed album zone for reminder time and today`; `follows the most recently synced device zone on a DST day`; `uses the effective zone date to suppress photos across midnight` — `worker/test/push/push.test.ts` |
| 4. Permanent actions need confirmation | Empty changes to Confirm. Delete changes to Delete forever?. The second tap acts; blur cancels confirmation. No modal opens. | `requires two taps for empty-trash and resets confirmation on blur`; `requires two taps for trash-delete-permanently and resets confirmation on blur` — `tests/unit/trash.test.ts` |
| 5. Client clocks shorten Trash retention | PATCH validates the deletion marker but stores server `now` for trash. Restore stores null. The response and sync supply the saved timestamp. | `starts trash retention at server time despite an old client clock` — `worker/test/core/session-security.test.ts` |
| 6. Invalid cursors prevent recovery | A 400 `invalid_cursor` clears the persisted cursor and tries one full snapshot. A rejected full snapshot stops that refresh. Pending captures remain. | `replaces an invalid cursor with one full snapshot and keeps pending captures`; `does not loop when the full snapshot also rejects its cursor` — `tests/unit/cloud/sync.test.ts` |
| 7. Push writes accept unbounded JSON | Subscription PUT/DELETE and preference PUT use the shared 16 KiB reader. Oversized bodies return 413 `payload_too_large`. | `caps subscription PUT bodies at 16 KiB`; `caps subscription DELETE bodies at 16 KiB`; `caps prefs/selfies PUT bodies at 16 KiB` — `worker/test/core/push.test.ts` |
| 8. Each image request writes session activity | Activity updates at most once per hour. The UPDATE also checks the stored timestamp to cover concurrent requests. Renewal still writes when due. | `writes session activity at most once an hour while renewal still writes when due` — `worker/test/core/session-security.test.ts` |
| 9. Authentication rows never expire | An independent cron job removes at most 100 expired sessions and 100 expired counters per invocation. Counter expiry respects its 15-minute, hourly or daily window. It uses scheduledTime. | `purges expired authentication rows in bounded cron batches using scheduled time`; `expires counters only when their own login, daily or signup window ends` — `worker/test/core/session-security.test.ts` |

The concurrency check admits ten password checks from twenty simultaneous wrong logins.
Ten responses are 401; ten are 429.
The daily reservation permits the thirtieth check and blocks the thirty-first.
A successful check returns its daily and IP reservation without erasing earlier failures.
The activity check measures zero writes for ten requests within an hour.
Ten concurrent requests at the hour boundary make one activity write.

The scheduler checks spring-forward and fall-back DST behavior with the same effective zone rule.
The cleanup check deliberately sets wall-clock time beyond scheduledTime to detect the wrong clock source.
The default push test mode still uses Miniflare and a real local receiver.
The socket-free mode uses SQLite and the same scheduler code.

Additional browser checks cover retained uploads after cookie loss and the inline Empty confirmation.
The existing Trash browser flow now confirms permanent deletion with its second tap.
Workerd coverage also sends twenty concurrent wrong logins through the real Worker entry point.
These browser and workerd checks require the mini.

Album IDs remain globally unique.
PUT with another owner's album ID returns 404 without creating an album.

## Export and browser harness regressions

The repository scan works in a Git archive without `.git` metadata or the Git CLI.
It walks regular source files and includes untracked Worker code.
It skips generated output, local secret files, ignored paths and symlinks.
It honors the repository's ignore exceptions and nested cache directories.
`tests/unit/repository.test.ts` checks a plain export with synthetic credential shapes.
The original architecture check also runs with Git metadata deliberately unavailable.

The push browser test migrates and starts its isolated Worker with the same persistence root.
`getPlatformProxy` takes the Miniflare versioned root directly.
`unstable_startWorker` appends `v3` to its persistence directory.
Passing the same unversioned directory to both APIs created two separate D1 stores.
The migration proxy had tables; signup in the started Worker reached an empty store and returned 500.
The proxy now receives the Worker's versioned root.
This fixes the path mismatch without adding a test endpoint to the product Worker.

A socket-free SQLite check applies every migration through `unstable_splitSqlQuery`.
Album revisions advance from 1 to 2 after an update, which confirms trigger bodies remain intact.
The browser check now asserts signup returns 201 before waiting for capture.
It retains the two-tap, decrypted reminder, duplicate-cron and photo-suppression assertions.
`tests/e2e/push.spec.ts` still needs execution on the mini to confirm the complete browser path.
