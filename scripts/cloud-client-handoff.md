# Cloud client handoff

The client is ready for Worker integration. No commit or staging operation runs in this checkout.

## Checks

- Frontend TypeScript: `npx tsc --noEmit -p tsconfig.app.json` passes.
- Tooling and browser-spec TypeScript: `npx tsc --noEmit -p tsconfig.node.json` passes.
- Lint: `npx eslint src tests *.config.ts eslint.config.js scripts/start-e2e-api.mjs` passes with zero errors and warnings.
- Selected unit tests: 64 pass, zero fail, across 12 files. The final storage lookup change also passes its 25 covering tests across five files.
- Command: `npx vitest run tests/unit/cloud tests/unit/migration.test.ts tests/unit/albums.test.ts tests/unit/architecture.test.ts tests/unit/settings.test.ts tests/unit/transaction.test.ts tests/unit/advice.test.ts tests/unit/timelapse.test.ts tests/unit/zip.test.ts`.
- Browser collection: `npx playwright test --list` lists 60 cases across 14 files. No browsers start.
- `git diff --check` passes.
- The fetch guard rejects a `globalThis.fetch` call outside the API module. The same input passes inside that module.

The test selector reports configuration files as unknown and package.json as a full-suite trigger. The selected unit tests above cover the changed storage, API, sync, download, and settings code. The browser specs below cover the remaining app and tooling changes. Full unit tests, Worker checks, builds, and browser runs remain for the mini, per the lane limits.

## Product changes

- Account creation and sign-in share one screen. The ghost explanation appears there.
- Captures compress through the existing camera encoder, queue locally, and upload with the same id on retries.
- The client checks the session owner before syncing or uploading. Another account cannot receive a cached user's outbox.
- IndexedDB v3 contains only kv, outbox, and ghosts. Upgrades discard old photo stores without import.
- Pending captures have a limit of 20. Each album keeps at most its newest ghost master.
- Image reads use direct keys. Ghost reconciliation reads keys without loading every album’s pixels.
- Metadata opens from a user-scoped snapshot. Sync applies cursor deltas, replacements, and removed ids.
- Trash changes update the screen immediately and roll back on failure.
- Server photo views use API image URLs. Pending images use temporary object URLs.
- Download my photos produces a ZIP with progress and cancel. Video export also supports cancel.
- Logout removes the device push subscription, logs out, and clears user data. Pending captures trigger one confirmation.
- Albums use the server endpoint. The default album comes from sync.
- The service worker excludes API navigations and has no photo cache. A later lane can add its push-handler import.

## First-run taps

Before: 3 taps — onboarding start, camera permission, shutter.
After: 5 taps — username field, password field, Create account, camera permission, shutter.
This count excludes typing. Keyboard Next can replace the password-field tap. A returning signed-in user needs one shutter tap.
The separate onboarding step is removed.

## Removed files

- src/app/screens/OnboardingScreen.tsx
- src/storage/albums.ts
- src/storage/backup.ts
- src/storage/persistence.ts
- src/storage/photos.ts
- tests/unit/backup.test.ts
- tests/unit/storage.test.ts

Removed features: backup import and restore, storage persistence prompts and status, device usage totals, local delete-everything, local-only privacy copy, and backup/install warnings.
The small Advice exports remain as a camera import bridge. They emit no obsolete warnings. The camera interface stays compatible.

## Browser specs awaiting the mini

All 14 files below collect successfully. None runs here.

- tests/e2e/cloud/accounts.spec.ts
- tests/e2e/cloud/layout.spec.ts
- tests/e2e/cloud/legacy.spec.ts
- tests/e2e/cloud/sync.spec.ts
- tests/e2e/albums.spec.ts
- tests/e2e/alignment.spec.ts
- tests/e2e/core-flow.spec.ts
- tests/e2e/ergonomics.spec.ts
- tests/e2e/fallback-and-ugly-states.spec.ts
- tests/e2e/offline-and-privacy.spec.ts
- tests/e2e/persistence.spec.ts
- tests/e2e/production.spec.ts
- tests/e2e/timelapse.spec.ts
- tests/e2e/trash.spec.ts

The local production run has 56 Chromium cases and four WebKit iPhone cases. The production-only spec skips without an HTTPS deployment.
The Worker starts with migrations and fresh temporary local state. The preview starts after generating fake-camera fixtures and building the app.
Synthetic API signups use unique test IP headers to avoid exhausting local signup limits.

## Reproduced and fixed

- An older ghost download overwrites a newer offline capture. A failing test reproduces this race before the fix.
- A slow sync delays a local capture save. Captures now commit independently of network work.
- A changed session cookie could send cached captures to another account. Identity checks prevent those uploads.
- Closing an account can reject a queued refresh. Cancellation now completes without an unhandled rejection.

## Integration

Run the Worker typecheck, Worker lint, Worker tests, full unit tests, build, and Playwright suite on the mini.
The Vercel rewrite retains the required WORKERS_SUBDOMAIN placeholder for release.
The timer value is read structurally from CaptureResult and defaults to zero. PhotoMeta keeps it optional until camera integration.
No dependency is added. No Worker file or camera-owned file changes.
Do not restore the deleted local repositories or backup UI. Keep the camera compatibility fields and hooks.

## Changed files

- .gitignore
- eslint.config.js
- index.html
- package.json
- playwright.config.ts
- scripts/cloud-client-handoff.md
- scripts/start-e2e-api.mjs
- src/api/client.ts
- src/app/App.tsx
- src/app/StoreProvider.tsx
- src/app/account/AccountScreen.tsx
- src/app/advice.ts
- src/app/components/Advice.tsx
- src/app/components/Playback.tsx
- src/app/components/cloud/CloudStatus.tsx
- src/app/screens/OnboardingScreen.tsx
- src/app/screens/PhotoScreen.tsx
- src/app/screens/SettingsScreen.tsx
- src/app/screens/TimelineScreen.tsx
- src/app/screens/TrashScreen.tsx
- src/app/store-context.ts
- src/app/timelapse-export.ts
- src/app/useStoredImage.ts
- src/core/types.ts
- src/pwa/useServiceWorker.ts
- src/storage/albums.ts
- src/storage/backup.ts
- src/storage/db.ts
- src/storage/download.ts
- src/storage/images.ts
- src/storage/local.ts
- src/storage/persistence.ts
- src/storage/photos.ts
- src/storage/settings.ts
- src/styles/global.css
- src/sw.ts
- src/sync/engine.ts
- tests/e2e-support/api.ts
- tests/e2e-support/helpers.ts
- tests/e2e/albums.spec.ts
- tests/e2e/alignment.spec.ts
- tests/e2e/cloud/accounts.spec.ts
- tests/e2e/cloud/layout.spec.ts
- tests/e2e/cloud/legacy.spec.ts
- tests/e2e/cloud/sync.spec.ts
- tests/e2e/core-flow.spec.ts
- tests/e2e/ergonomics.spec.ts
- tests/e2e/fallback-and-ugly-states.spec.ts
- tests/e2e/offline-and-privacy.spec.ts
- tests/e2e/persistence.spec.ts
- tests/e2e/production.spec.ts
- tests/e2e/timelapse.spec.ts
- tests/e2e/trash.spec.ts
- tests/unit/advice.test.ts
- tests/unit/albums.test.ts
- tests/unit/architecture.test.ts
- tests/unit/backup.test.ts
- tests/unit/cloud/api.test.ts
- tests/unit/cloud/download.test.ts
- tests/unit/cloud/fixtures.ts
- tests/unit/cloud/local.test.ts
- tests/unit/cloud/sync.test.ts
- tests/unit/migration.test.ts
- tests/unit/settings.test.ts
- tests/unit/storage.test.ts
- vercel.json
- vite.config.ts
