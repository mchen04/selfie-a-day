# Code-quality loop log

Four dimensions per cycle, reviewed **independently and in parallel** by agents that share no context: architecture boundaries, refactoring and slop, performance, storage design. Every finding then faces a separate skeptic whose instruction is to *refute* it, defaulting to refuted when uncertain — because a plausible-sounding review finding is cheap, and churn in working code is not free.

Refactors must be behaviour-preserving: `npm run verify` exit 0 and the full end-to-end suite green before and after.

---

## Cycle 1 — CHANGES_REQUESTED on all four dimensions

36 raw findings. 3 survived refutation as stated; a further 9 were fixed by me *during* the review and were therefore refuted as "already fixed" rather than as wrong. The rest were genuinely refuted, several with measured counter-evidence.

### Confirmed and fixed

| Severity | Dimension | Finding | Resolution |
|---|---|---|---|
| **critical** | architecture, refactoring, storage — **found independently by three reviewers** | `updateSettings` computed the value it persisted *inside* a React `setState` updater. React only runs an updater synchronously on the eager-state path, so any call arriving while an update was queued ran later and wrote the variable's initialiser — `DEFAULT_SETTINGS` — to IndexedDB. | One reviewer reproduced it: clicking through onboarding at full speed wrote `onboardingCompleteAt: null` in **2 of 3 fresh profiles**, and the reload landed back on onboarding. Now merged against a ref; the updater is pure. Regression test confirmed red against the old code on both viewports. |
| major | architecture | `FRAME_ASPECT` had a second, uncoupled definition as `--frame-aspect: 3 / 4` in CSS. The box the user aligns in and the canvas that gets saved were coupled only by hand. | The stylesheet value is written from the TypeScript constant at boot; CSS carries a fallback only. Guarded by a test that compares the computed property to the constant. |
| major | storage | `importBackup` left a failed batch in place, so one quota failure part-way through a restore re-attempted an ever-growing batch. | Batches clear either way and the failure is counted and reported. |
| major | storage | A browser-closed IndexedDB connection wedged every subsequent write for the session. | The cached handle is dropped and reopened once, in `beginTransaction`. |
| major | refactoring | `putPhoto` and `putPhotos` carried two verbatim copies of the one-photo-per-day replacement loop — the most correctness-critical logic in storage. | Extracted to `writeInto`. |
| minor | architecture | "Delete all photos" swallowed its failure and still reported success. | Failure is surfaced; the reload happens in `finally`. |
| minor | storage | A partially-successful restore left the timeline and ghost stale. | Reload moved to `finally`. |
| minor | refactoring | A truncated ZIP escaped as a raw `RangeError`. | Wrapped as a readable `ZipError`. |
| minor | architecture, refactoring | Unreachable storage-error advisory branch, propped up by a unit test; four dead exports; `persistenceAskedAt` declared but never written; `INDEX_DAY` bypassed by raw string literals; four CSS rules declared twice at equal specificity with conflicting values; `Playback` shadowing the global `window`; the frame-space assertion running *after* the encode it guards. | All removed or corrected. Tests that existed only to exercise dead code now assert through the path the app actually uses. |

### Found by cycle 1, fixed after it, and worth calling out separately

The architecture reviewer noted that the stored-space-vs-display-space rule lives in one component and every other renderer paints stored bytes untransformed. The refuter rejected the *proposed fix* — normalising at display time would make the viewer disagree with the file the user exports — and was right to.

But the underlying risk was real: a live capture stored mirrored pixels while a photo picked through the iOS file fallback stored un-mirrored ones, so a library containing both **plays back flipping left to right**. That is the "head jumping around" failure the product exists to prevent, and the exact complaint quoted in `docs/research.md`.

Fixed at capture time instead: the file path now writes in the space the library is already in. New test confirmed red against the previous behaviour.

### Refuted, with the reasoning worth keeping

The refutation pass did real work rather than rubber-stamping. Highlights:

- **"Ghost-opacity slider commits a write and a full re-render per step, janking the camera."** Refuted on measurement: one load-bearing claim was factually false and the other measured ~1000× smaller than presented. No camera jank at ten years of photos on a 6× throttled CPU.
- **"Playback's prune sweep is unreachable when cancelled, so the window is unbounded."** The mechanism is real — a throttled scrub peaked at 56 live URLs against a documented cap of 7 — but the refuter built a simulation showing the proposed fix *introduces* the failure it claims to prevent. Left alone deliberately; the bound is a soft one and steady playback holds flat at 7.
- **"The timeline retains every thumbnail it has ever scrolled past."** Refuted with an instrumented 1000-photo run using genuine thumbnail output.
- **"`makeThumbnail` re-decodes the master it just encoded."** The redundancy is real and was measured; the cost did not justify the change.
- **"`listMeta()` blocks the first paint."** Refuted — first contentful paint measured at 36 ms and flat from 0 to 1000 photos.

### Independent performance measurements from the review

Confirmed by an agent that did not write the code: cold boot to a live camera frame **70–190 ms**, IndexedDB open 10 ms, `getUserMedia` at 21 ms, first frame at 70 ms, **no degradation from 0 to 1000 photos**. Timeline decodes 12 of 1000 thumbnails on open, first render 48 ms. Bundle 254 KB / 80 KB gzipped, no runtime dependency beyond React. No object-URL leak on any path exercised, including error and cancellation paths.

### Process failure in cycle 1, recorded rather than hidden

I kept editing the repository while cycle 1 was running. Two consequences, both mine:

1. **The refutation pass is partly contaminated.** Nine findings were refuted as "already fixed" because I had fixed them mid-review. Those verdicts say nothing about whether the findings were right — they were, which is why I had fixed them. Cycle 2 runs against a frozen tree.
2. **I misdiagnosed my own test suite.** The reviewers were starting and killing `vite preview` on the same ports my end-to-end runs used, which produced cascading failures that looked like flaky tests. I spent several rounds "fixing" flakiness that was external interference. Two of those changes were real improvements and were kept (a boot-state race in `completeOnboarding`, and a service-worker handover race); the rest of the hunt was wasted. The lesson is in the check-the-check rule the brief already states, and I did eventually apply it — the giveaway was that failures moved between unrelated tests and always cascaded from one point onward.

After the reviewers stopped, three consecutive full runs: **86 passed, 0 failed**.

---

## Cycle 2 — CHANGES_REQUESTED on all four dimensions

39 raw findings, **3 survived refutation**, all major, all fixed. The tree was frozen for the whole cycle and the reviewers were told which ports were in use, so neither problem from cycle 1 recurred.

### Confirmed and fixed

| Severity | Finding | Resolution |
|---|---|---|
| **major** | **Export materialised the entire photo library in the JS heap** — twice, per the storage reviewer. Measured on the old code: a 296 MB library took the heap from 49 MB to 301 MB with a 619 ms frozen main thread; a 617 MB library took it to 624 MB and froze for 1282 ms. Heap tracked library size 1:1, so it becomes fatal somewhere around 2000–3000 photos — *inside* the ten-year horizon the app is designed for. | Each master is now checksummed as it is read and handed to a `Blob`, which lives in the browser's blob store rather than the JS heap, so peak heap is one photo. **Measured after the fix on a 78 MB library: heap 23 MB before, 23 MB peak, 23 MB after — zero growth, 340 ms.** The new writer's output was re-validated with the *system* `unzip`, not only our own reader. |
| major | **A successful export was reported as a failure, and the file was delivered twice.** The `lastExportAt` write sat on the export's success path: a throw inside the share branch was caught as a *share* failure and fell through to the download, handing the user the same file twice; a throw in the download branch surfaced "the backup could not be created" after the file had already been saved. | Recording an export is bookkeeping and now sits off the result path entirely. |
| major | **A failed settings write left the screen showing a value that was not on disk.** Every call site fires `updateSettings` without awaiting, so the rejection went nowhere. | The optimistic update now reverts on failure. The control visibly snapping back is the honest signal. |

### Slop removed

`useCamera.frameSize` (state, two setters and a live event-listener effect, zero consumers anywhere), a dead icon export, a dead CSS rule, a doubled `reload()` + `refreshStorage()` in the import handler, a `useCallback` wrapping an already-stable module function, and the blank-line craters left by earlier deletions. `coerceSettings`' grid allow-list is now derived from the type it validates instead of two casts.

### Two comments added where a tidy-up would reintroduce a bug

Both were flagged as *missing* rather than wrong, which is the more useful half of a slop review:

- `REPROMPT_WINDOW_MS = 50_000` sat directly under a comment stating WebKit's limit is **60** seconds, with nothing marking the 10-second gap as deliberate. "Correcting" it to `60_000` looks like a fix and puts every camera resume exactly on the boundary the constant exists to avoid.
- The two `scaleX(-1)` rules in `capture.css` are the runtime half of the mirroring contract and are deliberately **not** on the shared `.frame` container. Hoisting them there is the obvious tidy-up, and it would flip the ghost together with the preview.

### A refutation that stopped me making things worse

The architecture reviewer reported that **import admits photos that are not in frame space**, breaking the alignment invariant. I read the code, confirmed no `isFrameSpace` check exists on that path, and was ready to add one.

The refuter was right and I was wrong. The declared `width`/`height` are **inert**: the only read of `meta.width` anywhere is a cosmetic subtitle string, and every render path builds an object URL from raw bytes and lets `object-fit: cover` fit them into the 3:4 box. The invariant is a property of the *capture loop*, not of stored dimensions — and `captureFromFile` already accepts arbitrary foreign aspect ratios by design and normalises them with the same centre cover-crop. Rejecting non-frame-space imports would have banned data the app handles correctly and contradicted the shipped fallback path.

Recorded because "the reviewer found something and I fixed it" is only half the value of an adversarial pass; the other half is being stopped from a plausible, wrong change.

### Independent measurements from cycle 2

At **6× CPU throttle with 1000 photos stored**: document start 28 ms, IndexedDB open 48 ms, `getUserMedia` call 109 ms, first live video frame 208 ms, six React commits total. `listMeta` over 1000 rows costs 5 ms. Playback's rolling window held at exactly **7** outstanding object URLs through a 12 fps playback of a 1000-photo timeline, peaking at 13 during a hard scrubber drag. **No blob URL leak was found on any path**, including cancellation and error paths.

### Known and accepted

- The 200-photo persistence test's thresholds are far looser than the values they guard and it never scrolls. It still fails correctly when the feature breaks (verified in cycle 1), so it is a weak test rather than a wrong one. Left as-is and recorded here rather than silently tightened.
- Import has the same peak-memory shape as export did. It is bounded by `batchSize` rather than by the library, so it degrades far later; not fixed this cycle.

---

## Cycle 3 — CHANGES_REQUESTED on all four dimensions

35 raw findings, **3 survived refutation**. One was critical, and it was the most valuable finding of the whole loop.

### The critical one: a restore destroyed newer photos and reported success

Restoring a backup onto a day that already had a photo **deleted the photo on the device**, wrote the older backup copy in its place, and returned `{imported: 1, skipped: 0, problems: []}` — a green toast for data loss. As the reviewer put it: deleting a single photo asks for a two-tap confirm, but a restore could destroy an unbounded number behind one tap.

Worse, and this is the part worth dwelling on: **an existing test was named `merges into an existing library without destroying newer photos` while only exercising a *different* day.** It asserted a property the code did not have. A test that gives false assurance is worse than no test, because it stops anyone looking.

Reproduced red first (the newer 20:00 photo was replaced by the backup's 09:00 copy), then fixed: a restore now keeps whichever photo is newer, and says which ones it kept. The misleading test was renamed to what it actually checks, and the real case is covered in both directions.

### The other two

| Severity | Finding | Resolution |
|---|---|---|
| major | `importBackup`'s `problems[]` was computed and discarded. A quota-truncated restore read as "could not be read" — sending the user to re-download a backup that was fine, while the restore was already partly applied. | The list is shown in Settings. Manifest entries the validator rejects are counted too, instead of vanishing before any counter saw them. |
| minor | `withTransaction` resolved with `undefined` when the callback outlived the transaction — an `await` on anything that is not an IndexedDB request lets the transaction auto-commit. In `readwrite` mode that is a green "Saved" for a transaction that wrote nothing: **the exact failure its own doc comment claims to prevent**. | It now rejects with a plain-language error, driven by a test that awaits a timer inside the callback. |

### Independent measurements from cycle 3

`getUserMedia` is called ~15–17 ms after navigation start and the first video frame lands at ~66–85 ms, unchanged by 1000 stored photos. Shutter to "Saved" is 87 ms with 1000 photos stored, with zero long tasks. Playback's rolling window was stressed at 400 photos of 1.1 MB masters, 12 fps, 6× CPU throttle: object URLs pinned at exactly **7** for the entire run, 0 long tasks, 11.9 fps sustained — the reviewer's own hypothesis that the prune loop could be skipped did not reproduce.

---

## Cycle 4 — CHANGES_REQUESTED on all four dimensions

33 raw findings, **2 survived refutation** — both the same defect seen from two dimensions.

### The mirror split, raised in every single cycle

Toggling the Mirror setting mid-project left the library in **two mirroring spaces**, so a timelapse flipped left-to-right at the boundary. That is the failure the product exists to prevent, and the complaint quoted verbatim from a real review in `docs/research.md`.

This was raised independently in **all four cycles**. I fixed the file-fallback half of it after cycle 1 and left this half, which was a mistake — four separate reviewers pointing at the same place is about as loud as a signal gets, and I under-weighted it three times because each cycle's *proposed fix* (normalise at display time) was correctly refuted. The finding was right even though the remedy offered with it was wrong.

The fix is neither display normalisation nor a warning: **new photos follow the library's space rather than the view setting**. Mirroring the preview is a viewing preference, and alignment is untouched because the ghost is always rendered into whatever space the preview is in. Confirmed red against the old behaviour — *"library split across 2 mirroring spaces"*.

### Restore, the asymmetric twin

Restore read the whole archive into one `ArrayBuffer` and CRC'd it in a single uninterruptible task: roughly twice the backup's size resident, measured at **252 MB peak heap and a 277 ms long task for a 163 MB backup**, scaling to ~750 MB and several seconds on a phone. Precisely the failure `exportBackup` was rewritten to avoid two cycles earlier — left in place on the way back in, on the one file the app actively nags people to create.

`parseBackupFile` now reads the archive's tail to catalogue it and pulls one photo at a time.

---

## Convergence: productive, but it did not reach two consecutive APPROVE

| Cycle | Raw findings | Survived refutation | Worst survivor | Verdict |
|---|---|---|---|---|
| 1 | 36 | 3 | major | CHANGES_REQUESTED ×4 |
| 2 | 39 | 3 | major | CHANGES_REQUESTED ×4 |
| 3 | 35 | 3 | **critical** (data loss) | CHANGES_REQUESTED ×4 |
| 4 | 33 | 2 | major | CHANGES_REQUESTED ×4 |

**Stated plainly: the target of two consecutive APPROVE cycles was not met, and I do not believe it is reachable with this instrument.** Four independent adversarial reviewers, each instructed to find problems in a 4,300-line codebase, return CHANGES_REQUESTED while any nit remains. Every cycle ended with a verdict of CHANGES_REQUESTED on all four dimensions.

The brief's stop rule — *flat findings across 3 cycles* — was met at cycle 3, and it also says to audit the check before calling it stuck. That audit:

- **Does the check measure reality?** Yes. Cycle 3 surfaced a critical data-loss bug that I reproduced with a failing test before fixing. Cycle 4 surfaced a defect four separate reviewers had been pointing at.
- **Has it ever gone red?** Constantly, and discriminatingly: 31–36 findings per cycle are *refuted*, twice stopping me from making a plausible but wrong change. It is not a rubber stamp in either direction.
- **Are the findings the same each cycle?** No. Different defects each time, and severity peaked in the middle rather than trailing off — which is why I ran a fourth cycle rather than halting at the flat-findings signal.

So the honest characterisation is **productive but non-converging**, not stuck. The loop was stopped after cycle 4 as a judgement call: survivors declined (3, 3, 3, 2), the last cycle's two survivors were one defect seen twice, and the remaining unfixed findings are all nits or accepted trade-offs recorded below. `npm run verify` exits 0 and the full end-to-end suite is green after the final fixes.

### Known and accepted after cycle 4

Recorded rather than silently dropped:

- **Playback's prune sweep can be starved by hard scrubbing** — a reviewer measured 274 live object URLs against a design cap of 7. Refuted in cycles 1 and 3 (steady playback holds flat at exactly 7, verified twice), confirmed only under adversarial scrubbing. Not fixed: an earlier reviewer demonstrated that the obvious fix introduces the failure it claims to prevent.
- **The timeline retains every thumbnail scrolled past** — measured by me at 12 → 59 across five scroll positions in a 3650-photo library, and by a reviewer at 1000 live URLs / 15.2 MB when the whole thing is scrolled. This is the deliberate sticky-loading trade: unloading makes flicking back up flash grey placeholders, which reads as data loss in an app whose promise is that nothing is lost.
- **The 200-photo end-to-end test never scrolls and its thresholds sit far above measured reality.** It still fails correctly when the feature breaks (verified in cycle 1), so it is a weak test rather than a wrong one.
- **Ghost-slider bounds are duplicated** between the capture screen, Settings and the clamp in `coerceSettings`; grid-style labels have drifted ("No grid" vs "Off").
- **A `DB_VERSION` bump will wedge other open tabs** with a raw `VersionError`, and a downgrade lands on a screen that blames private browsing. Latent until the schema is first bumped.
