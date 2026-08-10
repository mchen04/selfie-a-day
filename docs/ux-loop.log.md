# UX loop log

**Converged: 2 consecutive clean cycles (cycles 2 and 3).**
Hard cap was 8 cycles. Used 3.

Axes judged each cycle, per the brief: **feature completeness**, **one-handed ease**, **Safari/PWA standalone behaviour** (safe areas, cold start, no-back-button navigation).

Method: drive the real production build (`vite preview`, not the dev server) with Playwright at mobile (390×664, iPhone 14 UA, touch) and desktop (1280×900) viewports, plus 320/375/412-wide sweeps for layout checks. Findings are measured where a number exists — element geometry, clipped-text detection, overlap detection — and judged by screenshot only where taste is genuinely the oracle. Every finding fixed at the root became a committed test in `tests/e2e/ergonomics.spec.ts`, so a later cycle cannot re-pass by luck.

---

## Cycle 1 — 6 findings, all fixed

| # | Axis | Finding | Evidence | Resolution |
|---|---|---|---|---|
| 1.1 | One-handed ease | **The live camera preview got only 27–29% of a phone screen.** The advisory banner alone was 139px tall, plus 154px of controls and a 64px top bar on a 664px screen. The frame is the reason the app exists and it was a minority of the display. | Measured at 375×667, 390×664, 412×732 | Advisory copy cut to a single short sentence, banner padding reduced, control gaps tightened. Frame now **45–54%**. Locked by a test asserting >40% at three phone sizes. |
| 1.2 | One-handed ease | **Four controls were below Apple's 44×44 pt minimum hit region** — ghost toggle and grid toggle at 36px tall, two banner actions at 32px. | Programmatic sweep of every visible interactive element | Chips and banner actions raised to 44px. |
| 1.3 | One-handed ease | **The mirror switch was 52×32** — visually correct but under the tap floor. | Same sweep, settings screen | Control is 44px tall; the visible 52×32 track is drawn with `::before`, so the design is unchanged and the hit region clears the floor. |
| 1.4 | Feature completeness | **The iOS storage warning truncated to "Installing starts a separate…"**, losing the actionable half. A warning the user cannot finish reading signals danger without saying what to do — worse than silence. | Screenshot at 390×664, then `scrollWidth > clientWidth` check | Copy rewritten to "Export before adding to your Home Screen" — complete and actionable. The full explanation moved to Settings → Backup, where there is room for a paragraph. |
| 1.5 | One-handed ease | **The "Saved" toast covered the ghost-opacity slider and the shutter.** It was anchored 116px from the bottom, landing directly on the controls the user had just reached for. | Screenshot; then a rect-intersection check | Toast moved to the top of the screen. The bottom belongs to the thumb. |
| 1.6 | Feature completeness | **Ghost hint read "Line your eyes up with today"** after a same-day retake, which is nonsense — you cannot line up with the photo you just took. | Screenshot | Hint now reads "Lined up with today's photo" when the ghost is today's own capture. |

**A false alarm worth recording:** cycle 1 initially reported the advisory banner overlapping the capture frame. Measurement disproved it — the banner is translucent and the frame's grid lines were showing *through* it, with 0px of actual overlap and the frame at a correct 0.748 ratio. Reading a compressed screenshot is not evidence; the geometry check was.

---

## Cycle 2 — clean

Full re-audit after the cycle 1 fixes, including three new committed checks written *because* of cycle 1 (`no visible text is clipped`, `the toast never covers the shutter or the ghost controls`, `the camera frame dominates the screen on a phone`).

Two issues surfaced while writing those checks and were fixed before the cycle closed, so they are recorded rather than hidden:

- The clipped-text check flagged `Ghost strength`, a `.visually-hidden` screen-reader label. That is intentional clipping — the check was wrong, not the app. Excluded screen-reader-only text.
- With a 2-line clamp the warning still clipped at **320px** width. Raised to 3 lines so the sentence completes on the narrowest phone still in use.

Result: **74 passed / 0 failed** across both viewport projects.

Screens reviewed by eye as well as by measurement: onboarding, capture (day one, after capture, retake), timeline, single photo, timelapse playback, settings (top and bottom), camera-roll fallback, permission denied, storage unavailable.

Judgement on the three axes:

- **Feature completeness** — the north-star loop is present and reachable without explanation: camera live on open, ghost and grid on by default, one tap to capture, timeline and playback two taps away. Ghost opacity and grid are on the capture screen itself, never behind a menu, which is the specific failure the brief names.
- **One-handed ease** — shutter is 76px, horizontally centred, in the bottom third. The whole frame is also a shutter, which is the honest substitute for the volume-button shutter that users of the native apps keep asking for and the web cannot provide. Every control clears 44px.
- **Safari/PWA standalone** — `viewport-fit=cover` with `env(safe-area-inset-*)` on every edge of chrome; no page scroll on the capture screen at any tested size; in-app back on every screen since standalone has no browser back button; cold start verified offline from the precached shell.

---

## Cycle 3 — clean (converged)

Identical audit re-run with no changes to the app between cycles 2 and 3. **74 passed / 0 failed**, same set.

Two consecutive clean cycles → converged.

---

## Deliberately not changed

- **Mirror-the-preview explanation is three lines of prose in Settings.** It is the one setting that can affect a whole archive's consistency, so it earns the words.
- **The desktop layout holds a phone-shaped column rather than filling the window.** Stretching a one-handed layout across 1400px would put every control out of reach of the thumb it was designed for. Judged intentional, not a defect.
- **The timelapse has no speed memory between sessions.** Noted, below the bar for this loop.

## Known limits of this loop

Chromium emulation is not WebKit. Everything here proves layout, geometry and behaviour under Chromium at iPhone dimensions; it does **not** prove Safari rendering, and it cannot prove standalone-mode behaviour on a real iPhone. That gap is recorded as an external blocker in `docs/progress.md`, not papered over.
