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

Use **Download my photos** in Settings for a ZIP of dated images and metadata.
The app does not import backups.

[docs/data-flow.md](docs/data-flow.md) lists every stored item, why it exists and how it is deleted.

## Local development

```sh
npm install
npm run dev:api
```

The API starter applies local D1 migrations and serves the Worker on port 8787.
It keeps state in `worker/.wrangler/state`.
Migrations 0001 and 0002 were edited in place before the first release.
Delete `worker/.wrangler/state` if it was created before that.
The starter creates a throwaway VAPID key pair in git-ignored `worker/.dev.vars` when needed.
Keep that file private; delete it with local state to start again with fresh keys.

Start the frontend in another terminal:

```sh
npm run dev
```

Vite serves the app on port 5173 and forwards `/api` to the local Worker.
The preview server uses port 4319 with the same forwarding rule.
Camera access requires a secure context, such as localhost or HTTPS.

## Tests

| Command | What it runs |
|---|---|
| `npm run verify` | Type checks, lint, client unit tests, Worker tests and the production build |
| `npm run test:e2e` | Playwright against an isolated local Worker and the production preview |
| `npm run test:ux` | Mobile UX audit of an existing build; see [tests/e2e/ux/README.md](tests/e2e/ux/README.md) |
| `npm run sim` | Ten simulated days on two devices with a fake clock, cron and push receiver |

The Worker tests use real Miniflare D1 and a local HTTP push receiver.
They generate throwaway keys and decrypt delivered messages.
When a sandbox blocks sockets, run the socket-free subset:

```sh
SELFIE_PUSH_TEST_MODE=sqlite npx vitest run --config worker/vitest.config.ts worker/test/push/push.test.ts worker/test/push/runtime.test.ts worker/test/core/push.test.ts worker/test/core/local-api.test.ts worker/test/core/scheduled.test.ts worker/test/core/security.test.ts worker/test/core/password.test.ts
```

That subset checks SQL, encryption and scheduling with SQLite and an in-memory receiver.
It does not replace Miniflare or browser verification.

`test:e2e` and `sim` build the app first and start their own Worker with fresh D1/R2 state and VAPID keys.
Timelapse export checks need `ffprobe` from FFmpeg.
`production.spec.ts` checks headers and CSP against a deploy; it skips without an HTTPS `E2E_BASE_URL`.
`vite preview` sends no CSP; only `vercel.json` does.

The sim writes `SIM_EVIDENCE_DIR` (default `test-results/sim`): per day `checks`, `requests`, `storage`, `push` and `console` JSON, screenshots and `summary.md`.
Run one sim at a time, and do not edit `worker/src` while it runs: `wrangler dev` reloads the Worker mid-run.

Data-flow audits read that evidence:

```sh
node scripts/audit/requests.mjs test-results/sim [--compare <other sim dir>]
node scripts/audit/queries.mjs
```

The first counts requests, bytes and device/server storage per endpoint, flow and day.
The second maps every D1 statement to its columns and index; `worker/test/core/data-audit.test.ts` fails on a new unexplained finding.
Performance measurement uses a separate harness: [scripts/perf/README.md](scripts/perf/README.md).

## Deploy

The Worker (`worker/wrangler.jsonc`, name `selfie-a-day-api`) serves `/api`; Vercel serves the app and rewrites `/api` to it.

1. Apply migrations: `npx wrangler d1 migrations apply DB --remote --config worker/wrangler.jsonc`.
2. Set `VAPID_PUBLIC_KEY` in `worker/wrangler.jsonc` and the matching private key with `npx wrangler secret put VAPID_PRIVATE_KEY --config worker/wrangler.jsonc`.
   The key format is the one `ensureLocalVapid` in `worker/scripts/local-api.mjs` writes: base64url P-256 public point and 32-byte private scalar.
3. Deploy the Worker: `npx wrangler deploy --config worker/wrangler.jsonc`.
4. Replace `WORKERS_SUBDOMAIN` in `vercel.json` with the account's workers.dev subdomain, then deploy the app with Vercel.
5. Create an account in the app, or provision one: `node worker/scripts/provision-user.mjs <username>` reads a password from stdin and prints the SQL for `wrangler d1 execute`.

Sessions use the `__Host-` cookie prefix, so production must be HTTPS on one origin.

## Platform limits

- iOS allows `getUserMedia` in home-screen PWAs since iOS 13.4.
  Camera permission does not persist across standalone cold starts (WebKit bug 280394), so iOS may ask again.
- Back from under 50 s in the background, the camera restarts by itself; after longer, the app asks for a tap.
  50 s stays under WebKit's 60 s window, after which an automatic restart would prompt again.
- Without `getUserMedia` or a secure context, the shutter opens the file picker (`capture="user"`).
- New photos follow the library's mirror space, not the current Mirror setting, so a timelapse never flips midway.
- Browser tests use Chromium and WebKit with fake cameras and stubbed notifications.
  Physical iPhone standalone behavior, the torch, real safe-area values and installed-PWA push delivery are not verified.

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
| `tests/sim` | Ten-day simulation |
| `scripts/audit`, `scripts/perf` | Data-flow audits and the performance harness |
| `docs/api-contract.md` | Client/Worker contract and regression map |
| `docs/data-flow.md` | Stored data, retention and measured request flows |
