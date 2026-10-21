# Selfie a Day

Take one aligned photo each day, with a separate history for each album.
Your private account keeps photos in sync across devices.

**Live: https://selfie-a-day.vercel.app**

## Daily use

Choose an album and align against its latest photo.
The ghost, preview and saved image use the same crop and mirror rules.
Timer and flash controls sit inside the viewfinder.
The timer cycles Off → 3s → 5s → 10s → Off.
Each album inherits the timer from its latest photo, including photos from another device.
A newer local timer choice takes priority.

Retaking a photo moves the previous photo for that album and day to Trash.
Trash retains photos for 30 days.
The server clock starts that period.
Empty and permanent deletion each require two taps on the same inline button.
Restore fails if that day already has an active photo.
Albums can follow the device timezone or use a fixed IANA timezone.
The timeline includes timelapse playback, date filters and video export.

Settings includes one reminder row per album.
Reminders require browser permission and an installed PWA on iPhone.
The scheduler skips reminders once today's photo exists.
It supports one evening nudge and milestone messages.
Reminders follow the album's fixed zone, or the most recently synced device zone.

## Storage and privacy

Cloudflare D1 holds accounts, sessions, photo metadata and reminder settings.
Private R2 storage holds photo images.
Each API request checks account ownership.
The browser sends account requests through the same origin.

The device keeps a metadata snapshot, pending uploads and one ghost image per album.
Offline captures wait in an account-scoped upload queue.
They upload when the connection returns.
Signing out clears local account data and removes this device's push subscription.
One confirmation warns if pending captures will be lost.
An expired session opens sign-in and keeps that user's captures and caches.
Signing back in resumes uploads; another account cannot see or upload them.
Old local photo stores are discarded during the database upgrade.

Use **Download my photos** in Settings for a ZIP of dated images and metadata.
The app does not import backups.

## Local development

```sh
npm install
npm run dev:api
```

The API starter applies local D1 migrations and serves the Worker on port 8787.
It creates a throwaway VAPID key pair in git-ignored `worker/.dev.vars` when needed.
It derives the public key from the same private key on each start.
Keep that file private.
Delete it with local state to start again with fresh keys.
Production uses a public variable and a private Worker secret, set during release.

Start the frontend in another terminal:

```sh
npm run dev
```

Vite serves the app on port 5173 and forwards `/api` to the local Worker.
The preview server uses port 4319 with the same forwarding rule.
Camera access requires a secure context, such as localhost or HTTPS.

## Verification

```sh
npm run verify
npx playwright test
```

`verify` runs type checks, lint, client tests, Worker tests and the production build.
The Worker command covers both account/photo code and push code.
Cron removes expired sessions and stale login counters in bounded batches.
Its push tests use real Miniflare D1 and a local HTTP receiver by default.
They generate throwaway keys and decrypt delivered messages.
When a sandbox blocks sockets, run only the socket-free checks:

```sh
SELFIE_PUSH_TEST_MODE=sqlite npx vitest run --config worker/vitest.config.ts worker/test/push/push.test.ts worker/test/core/push.test.ts worker/test/core/local-api.test.ts worker/test/core/scheduled.test.ts worker/test/core/security.test.ts worker/test/core/password.test.ts
```

This checks SQL, encryption and scheduling with SQLite and an in-memory receiver.
It does not replace Miniflare or browser verification.
Test caches stay in the git-ignored repository path `worker/test/support/.vite`.

Playwright starts an isolated local Worker and the production preview.
Each fresh test state gets its own VAPID pair and D1/R2 data.
It removes that state when the API stops.
The suite generates its camera fixtures before building.
Timelapse export checks need `ffprobe` from FFmpeg.
Browser tests do not prove physical iPhone push delivery or camera torch behavior.

## Code map

| Path | Purpose |
|---|---|
| `src/core` | Geometry, dates, IDs and data types |
| `src/camera` | Camera lifecycle, capture, timer and flash |
| `src/api` | Account, sync, photo and push requests |
| `src/sync` | Metadata sync and pending uploads |
| `src/storage` | Device state, ghost cache and ZIP export |
| `src/app` | Screens, state and navigation |
| `src/push`, `src/sw.ts` | Push subscriptions, notifications and app shell |
| `worker/src/core` | Authentication, albums, photos and sync |
| `worker/src/push` | Push validation, encryption and scheduling |
| `worker/migrations` | Local and production D1 schema |
| `docs/api-contract.md` | Client/Worker contract map and regression coverage |

Earlier design research and verification notes remain in `docs/` as historical records.
This README and the API contract map describe the account-based product.
