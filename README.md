# Selfie a Day

One selfie a day, lined up with a faint ghost of your last photo, so months later
the timeline plays back without your head jumping around.

**Live: https://selfie-a-day.vercel.app**

Everything stays on your device. No account, no upload, no cloud — the app makes
no network requests at all once it has loaded.

---

## The idea

Open the app. The camera is already live, with faint guides and a ghost of your
last photo over it. Line your eyes up with the ghost, tap once, done. Under five
seconds, no menus.

The failure this exists to avoid is an alignment aid that is decorative: a ghost
too faint to use, buried behind a menu, or — the one real users complain about
most — showing a *mirror image* of the photo that actually gets saved, so
nothing you line up against is real.

## How the alignment is guaranteed

The product rests on one invariant:

> what the user aligned against **=** what got saved **=** what becomes the ghost

It is held by construction rather than by care:

1. `computeCoverCrop()` in `src/core/geometry.ts` is the only definition of the
   crop. The preview box and the capture canvas both use it, and it depends only
   on the source dimensions and the frame's *aspect* — never on pixel sizes,
   which is why a 390px phone preview and a 1080px capture agree.
2. Stored photos are already in frame space (3:4), so drawing one back into the
   frame is the identity mapping. The ghost has no second transform that could
   disagree.
3. Each photo records the mirroring its pixels are in. The ghost flips only when
   that disagrees with the current preview, so changing the mirror setting can
   never corrupt older photos' alignment.

This is verified against a **known camera target**, not by eye: the test suite
feeds a synthetic camera three coloured markers at known positions, computes
where each must land after cropping and mirroring, then reads the stored pixels
and the on-screen composite and checks. A wrong crop offset, a missing mirror,
or a mirror applied twice all move a marker somewhere the test does not expect.

## Storage and getting your photos out

Photos live in IndexedDB, split across three stores by read cost — metadata,
thumbnails, and full-size images — so a timeline with hundreds of photos never
reads a full-size image it is not showing.

Browsers can evict website storage. The app asks for persistent storage, reports
honestly what the browser actually granted, and treats **export as the protection
that works everywhere**. A backup is a plain `.zip` of ordinary dated image files
plus a small manifest: openable in Finder or Explorer, useful with or without
this app, forever. That is deliberate — the loudest complaint in this whole app
category is years of photos stranded inside software that stopped working.

## Running it

```bash
npm install
npm run fixtures     # generate the synthetic camera target used by tests
npm run dev          # http://localhost:5173
```

`getUserMedia` needs a secure context, so `localhost` and the deployed URL are
the only origins where the camera works.

## Verifying it

```bash
npm run verify       # typecheck + lint + test + build
npx playwright test  # 90 local end-to-end tests, mobile + desktop viewports
npm run verify:full  # both
```

End-to-end tests run against a real production build served by `vite preview`,
because the service worker, the precache and offline behaviour only exist there.

Playwright starts and stops that server itself. If you run the suite repeatedly
back to back, start the server yourself first — otherwise a second run can adopt
the first run's server while it is still shutting down, and every test after
that point fails on a dead connection:

```bash
npm run build && npm run preview &   # then run the suite as often as you like
```

To check the live deployment:

```bash
E2E_BASE_URL=https://selfie-a-day.vercel.app npx playwright test tests/e2e/production.spec.ts
```

## Documentation

| File | What it holds |
|---|---|
| `docs/progress.md` | Gate-by-gate status with the evidence that closed each one, measured performance, secret containment, and what the tests deliberately do **not** prove |
| `docs/research.md` | Both research tracks with dated primary sources, a build/cut decision for every feature in the category, and the twelve findings that changed the design |
| `docs/ux-loop.log.md` | Three UX cycles, the six defects cycle 1 found, and the two clean cycles that closed it |
| `docs/code-quality-loop.log.md` | Four review cycles, every finding that survived adversarial refutation, and an honest convergence verdict |

## Layout

```
src/core      pure domain — geometry, day keys, ids, types. No DOM, no React.
src/storage   IndexedDB, schema ladder, backup format, minimal ZIP.
src/camera    MediaStream lifecycle, capture pipeline, encoding, support probes.
src/app       React screens, components, router, hooks.
src/pwa       service-worker registration.
src/sw.ts     the worker — app shell only; it cannot read photos.
docs/         research, progress, and both loop logs.
```

The layer boundaries are enforced by a test (`tests/unit/architecture.test.ts`),
which also asserts that no application code contains a network primitive and that
no credential-shaped string appears anywhere in the source.

## What it deliberately does not do

No accounts, no cloud storage, no sync, no push notifications, no face detection
or ML auto-alignment, no filters, no social features. `docs/research.md` gives
every feature in the category an explicit build-or-cut decision with a reason —
including the most-requested missing feature in competing apps (nudging a photo
after capture), which is cut because it is a symptom fix for the alignment bug
this design removes at the source.
