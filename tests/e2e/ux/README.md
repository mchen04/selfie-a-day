# Mobile UX evidence

The implementer builds the app and runs these browser checks each round. The suite uses synthetic account, photo, and reminder data. It does not verify API behavior, push delivery, or service-worker behavior.

## Before and after

Run the first command before changing app markup or styles. Keep its evidence directory. Run the second command after the fixes.

```sh
npx vite build
UX_EVIDENCE_DIR=test-results/ux-before npx playwright test -c playwright.ux.config.ts --workers=3 --reporter=line,./tests/e2e/ux/reporter.ts
```

```sh
npx vite build
UX_EVIDENCE_DIR=test-results/ux-after npx playwright test -c playwright.ux.config.ts --workers=3 --reporter=line,./tests/e2e/ux/reporter.ts
```

Set `E2E_BASE_URL` to use an existing preview. Without it, the runner starts a preview of the existing build. It does not build or start a Worker.

UX files use the `.ux.ts` suffix. Only this config collects them. The main suite keeps its existing test list.

## Outputs

| File | Content |
| --- | --- |
| `ux.json` | Every audit result, test failure, screenshot path, viewport, and stated limit |
| `taps.json` | Measured user clicks, paths, native confirmation actions, and target results |
| `<project>/<state>.png` | One viewport screenshot for each state |
| `<project>/<state>-insets.png` | The same state with simulated insets |

The reporter rewrites both JSON files after each test. Use a separate evidence directory for each run. Screenshots show the visible viewport. Long lists receive an end-of-scroll screenshot. Settings opens at its end, so its second screenshot scrolls Log out into view. The audit inspects all reachable content, including content below the visible scroll area.

Timeline screenshots wait until every cell inside the timeline's scroller shows a decoded thumbnail. The scroller is the reference because it clips the cells under the top bar. The test also measures the 400 px preload: the cells up to 400 px below the scroller get a 2 s grace period and must then be loaded. A 300 px swipe from the top must show no grey cell at its first frame. These counts are stored with the state in `ux.json` as `thumbnails` and `swipe`. Fixture photos end yesterday in UTC, so their month rows shift when a run crosses UTC midnight.

## Coverage

WebKit runs at 320×568, 375×667, 390×844, and 430×932 with mobile and touch enabled. Chromium runs at 1280×800. These projects cover account creation, sign-in, account errors, capture, a blocked camera (getUserMedia rejects with `NotAllowedError`), ghosts, upload status, offline status, the retake shutter once today is saved, timeline, photos, the photo Undo bar, Trash, both armed deletion controls, five reminder states (no photos, so Download is disabled), Settings with photos (Download enabled), album sheets, album rename, playback, options, custom dates, video export, ZIP progress, and logout confirmation.

Chromium also runs the live countdown, flash, and tap paths at all four phone sizes. It uses Chromium's generated fake camera. WebKit uses the real app's camera-roll fallback. File selection supplies a synthetic portrait. No native camera-picker tap count is claimed.

The audit checks overlapping notices, horizontal scroll, clipped content, 44×44 CSS pixel targets, one-line `.btn` labels (a wrapped or spilled label fails), full labels for shortened text, 16 px form text, single-line header titles, and primary action placement. A toast, upload status, Undo bar, or update banner may sit over the preview and its whole-frame shutter, but not over another control or another notice. Camera overlay content (icon, copy, buttons) must not run into the timer and flash buttons or sit under a notice; an open dialog skips this. The lower 45% requirement applies to the shutter, account submit button, first reminder switch, empty-timeline button, photo Trash button, and Undo button on phone sizes; states captured with `primary: null` skip it because they show a scrolled or secondary view. Clipping understands `column-reverse` scrollers, whose `scrollTop` runs from the negative end up to 0.

WebKit's offline emulation also fails reads of the picked file, so the WebKit offline state goes offline through failed API requests only.

The calibration test injects known failures into each check. It also verifies the click counter against two user clicks and one scripted click. It must pass before app results count as evidence.

## Safe-area simulation

Each phone state runs again after a stylesheet sets `--safe-top` and `--safe-bottom` to portrait insets for the size: 20/0 px at 320 and 375, 47/34 px at 390, and 59/34 px at 430. Top bars and the account screen must keep their content below the top inset; bottom bars must keep it above the bottom inset. Bar content must also stay inside the bar's own side padding, so a button too wide for its share fails. A scroller that reaches the bottom edge must end its content above the bottom inset when scrolled to its end. The end position is measured from the current position plus the scroll distance left, with sticky and fixed content excluded. A list that was scrolled to its end is scrolled back there after the insets apply, because on a device the insets are present from the start. The screenshot is taken before the audit because WebKit applies the injected properties at the next rendering update, and a paused `page.clock` can stop `requestAnimationFrame`. The stylesheet is removed afterwards. This tests the app's CSS contract. It does not test device `env()` values, Safari chrome, or an installed PWA.

## Tap measurement

The page counts trusted `click` events on controls. A touch generates one click. Scripted file-input and download-anchor clicks do not count. New-account measurements include the two field-focus taps; typing does not count. Keyboard submission receives a separate check. Returning capture, reminder, timer, album switch, Trash with Undo, ZIP download, and logout each receive an independent path. Each counted tap also records its `y` position; `taps.json` reports how many landed in the lower 45% of a phone viewport, and the Trash with Undo path requires all of them there.

The browser emits native confirmation events outside the DOM. The logout test records that event and dismisses it to verify cancellation. Its PNG shows the page after dismissal. The pending-photo logout path counts confirmation acceptance as a separate native action. Native dialog appearance is not captured.

## Not verified

Physical iPhone appearance, native keyboard and camera-picker appearance, real safe-area values, and installed-PWA behavior need a device check. Unsupported video export is reported as unavailable; no progress screen is fabricated.
