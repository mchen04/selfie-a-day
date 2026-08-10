# Research — Selfie a Day

**Date:** 2026-08-09
**Method:** Six parallel research agents. Four gathering (iOS camera, iOS storage, iOS PWA shell + camera UX, product teardown), two adversarial — each given one load-bearing claim and told to refute it, defaulting to "refuted" without dated primary evidence.
**Evidence rule used throughout:** a claim counts only with a URL that was actually fetched plus the source's date. Primary sources (webkit.org, bugs.webkit.org, WebKit trunk source, developer.apple.com, MDN, W3C) outrank blog posts. Where sources contradict, both are reported with dates rather than averaged.

Both adversarial checks came back **refuted** — each on a split verdict where the comfortable half was true and the load-bearing half was not. Those two results changed the design more than anything else here.

---

## Part 1 — Technical: iOS Safari, PWA, camera, storage

### 1.1 getUserMedia inside an installed home-screen web app

| Question | Answer | Source |
|---|---|---|
| Is WebKit bug 185448 ("getUserMedia not working in apps added to home screen that run in standalone mode") still open? | **No — RESOLVED / FIXED.** Filed 2018-05-08, resolved 2020-02-06. | [bugs.webkit.org/show_bug.cgi?id=185448](https://bugs.webkit.org/show_bug.cgi?id=185448) |
| Which iOS fixed it? | **iOS 13.4.** An earlier fix in an iOS 13.0 beta was rolled back. Eric Carlson, 2019-06-19: *"we had to disable the feature because we found a serious bug."* Thomas Steiner, 2020-02-06: *"this works fine (again) as of iOS 13.4 beta 1."* | same bug thread |
| Corroboration | caniuse "Stream API" carries the iOS note *"getUserMedia working again in PWA on iOS 13.4"*. | [caniuse.com/stream](https://caniuse.com/stream) |

So the 2018-era blanket failure is genuinely gone. **The adversarial pass refuted the comfortable conclusion anyway**, and it was right to:

- **Camera permission does not persist across cold starts of a standalone PWA.** Bug 280394 "Persist permissions for getUserMedia" is **NEW, unresolved**, filed 2024-09-25, last touched 2026-07-08. On 2026-02-03 WebKit engineer *youennf* told a reporter that persistent permission for PWAs is a separate request that has not been filed yet — Apple, six months ago, confirming the capability does not exist. ([bug 215884](https://bugs.webkit.org/show_bug.cgi?id=215884))
- **This is by design, not an oversight.** Brent Fulgham, 2022-02-01: *"The current behavior (on Apple platforms) is by design. Home Screen apps are created as isolated entities without shared state with the browser."* ([bug 181849](https://bugs.webkit.org/show_bug.cgi?id=181849), still NEW)
- **It has broken again twice since 185448 closed.** iOS 18.0 broke camera in home-screen PWAs entirely (fixed 18.1.1). Bug 275527 "REGRESSION (again in iOS 17.5.1): Camera freezes in installed PWA" is still NEW, reproduced on 18.1.1. A further iOS 26 report of 90°-rotated getUserMedia video *in standalone only* has no WebKit bug and no confirmed fix — **UNVERIFIED, treat as possibly live.**

Two findings came from reading WebKit trunk directly, and both changed code:

**(a) The re-prompt window.** `UserMediaPermissionRequestManagerProxy::hasGrantedRequest` contains:

```cpp
if (!isUserGesturePriviledged && inactiveMediaCaptureStreamDuration().minutes()
      > ...inactiveMediaCaptureStreamRepromptWithoutUserGestureIntervalInMinutes())
    return false;
```

with `inactiveMediaCaptureStreamRepromptIntervalForiOS = 1` (versus 10 on desktop) in `WebPreferencesDefaultValues.cpp`. **Calling `getUserMedia()` without a user gesture, more than a minute after capture went inactive, re-prompts. Calling it inside a gesture does not.**

**(b) Interruption is `muted`, not `ended`.** `RealtimeMediaSource::setInterruptedForTesting` calls `notifyMutedChange(interrupted)`, and `setMuted` recovers via *"Let's uninterrupt by doing a stop/start cycle."* `readyState` stays `"live"` throughout.

Also relevant: WebKit PR #24971 (merged 2024-02-23) — before iOS 17.4, a same-document `pushState` that changed the URL *path* destroyed the media environment and the system **paused** the capture session. Fixed in 17.4. Hash-only navigation had the related permission-reset problem in bug 215884, so hash routing is not a safer alternative.

### 1.2 Storage durability — will a 200-day streak survive?

The claim under test: *"home-screen web apps are exempt from the 7-day script-writable storage cap, so an installed PWA's IndexedDB is durable."*

**Premise TRUE. Conclusion FALSE.** This is the single most consequential finding in the document.

The exemption is real and still live:

- The 7-day cap was announced in *Full Third-Party Cookie Blocking and More*, John Wilander, **2020-03-24**, covering IndexedDB, LocalStorage, Cache API and service worker registrations. The countdown is **seven days of Safari use** without interaction, not seven calendar days. ([webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/))
- Home-screen web apps *"are not part of Safari"*, keep their own days-of-use counter, and were made an explicit hard skip in ITP's data-removal algorithm in **2020-11-12**. ([webkit.org/blog/11338](https://webkit.org/blog/11338/cname-cloaking-and-bounce-tracking-defense/))
- Confirmed in WebKit trunk today: `ResourceLoadStatisticsStore.cpp` has `shouldExemptFromWebsiteDataDeletion()` commented *"Domains permanently configured to be exempt. This can be home screen web applications…"*. No narrowing found in any iOS version.

**But the exemption covers exactly one deletion path.** WebKit documents three, and the other two still apply. From *Updates to Storage Policy*, **2023-08-10**: *"By default, all origins use a best-effort mode, which means their persistence is not guaranteed and their data can be evicted."* Trunk confirms it — `NetworkStorageManager::performQuotaBasedEviction()` skips an origin only `if (record.isActive || valueOrDefault(record.isPersisted))`; **it never consults the ITP exempt list.**

So: *installed* is not the same as *durable*. Durability needs `navigator.storage.persist()` to have actually succeeded.

Supporting facts:

- `persist()` / `persisted()` shipped in **Safari 15.2**; `estimate()` only in **Safari 17**. (MDN browser-compat-data, fetched 2026-08-09) — so `estimate()` must be feature-detected.
- Safari **does** grant persistence silently, with no prompt, and the documented heuristic explicitly includes *"whether the website is opened as a Home Screen Web App"*. ([webkit.org/blog/14403](https://webkit.org/blog/14403/updates-to-storage-policy/))
- Current per-origin quota is **up to ~60% of total disk** since iOS 17; the old 1 GB-and-prompt regime is gone and Safari never prompts. The reported quota is fuzzed for anti-fingerprinting and is an upper bound, not a guarantee.
- **Contradiction reported, not resolved:** web.dev's *Storage for the web* (last updated 2024-09-23) still describes the obsolete ~1 GB / 200 MB-prompt regime. The WebKit blog and MDN (2026-01-05) agree against it. We follow the primary sources and treat quota as generous but unguaranteed.
- **Service-worker updates cannot touch photo data.** The spec's Unregister/Update algorithms touch only the registration and its workers. The risk is entirely self-inflicted: an `activate` handler that clears storage broadly would destroy IndexedDB, Cache and localStorage together, since they share one origin-level bucket.
- **Do not re-write a Blob read back out of IndexedDB.** Bugs [235687](https://bugs.webkit.org/show_bug.cgi?id=235687) and [240216](https://bugs.webkit.org/show_bug.cgi?id=240216) are still open in 2026 and are triggered by exactly get-then-put of the same Blob, producing a Blob with a correct `.size` that nothing can read. Blobs *do* survive a reload — the bug reports depend on the read succeeding — so the hazard is the re-save, not the round trip.

**Unverified, and stated as such:** what `persist()` actually returns on a real iOS device; whether storing `ArrayBuffer` instead of `Blob` genuinely avoids those two bugs (no WebKit engineer has commented on either); the numeric threshold for "storage pressure"; whether ITP's 7-day sweep is itself bypassed by persistent mode; whether clearing Safari website data also clears an installed web app's isolated container.

### 1.3 PWA shell and mobile camera UX

- **No `beforeinstallprompt` on Safari.** A hand-built "Share → Add to Home Screen" coach mark is the only install surface on iOS.
- **iOS ignores manifest `background_color`, `orientation` and `display_override`.** `theme_color` is honoured on iOS 15+. `apple-touch-icon` **overrides** manifest icons — MDN's compat data states manifest icons are used on iOS only when no `apple-touch-icon` is present.
- **`viewport-fit=cover` is mandatory** or `env(safe-area-inset-*)` stays 0 and the preview cannot go edge to edge.
- **`user-scalable=no` / `maximum-scale=1` are ignored since iOS 10.** `touch-action: manipulation` is the correct way to kill double-tap zoom without disabling pinch zoom.
- **Tap targets:** Apple's floor is 44×44 pt. There is **no** published Apple or Google number for shutter diameter — the widely-quoted figures are unsourced. Apple's camera HIG says only to keep common controls toward the middle and give people *"a large preview image with as few visual distractions as possible."*
- **Mirroring:** `getUserMedia` never mirrors and CSS never touches the stream, so `drawImage` of the raw video yields an **un-mirrored** file. iOS, Pixel and Samsung all default to saving un-mirrored. The decision must be explicit and applied consistently across the whole archive, because flipping it mid-series breaks the timelapse.
- **Standalone has no back button**, and the system edge-swipe cannot be disabled — so avoid horizontal edge-anchored gestures for app functions.
- **Apple removes unused service-worker registrations and caches after a few weeks**, so no user data may live only in Cache Storage.

---

## Part 2 — Product: what the category actually ships

21 apps checked live on 2026-08-09 via the iTunes Lookup API and Play Store pages, with version and last-updated dates.

**The category is entirely native. No shipping web or PWA competitor was found** after four separate searches. That is the strategic reason this is a PWA at all: nothing else in the category is one.

**The market is a graveyard with new entrants.** *Everyday* — the app most people mean by "selfie a day", and the one with the best alignment UI — is **abandoned**: still sold at $2.99, last updated **2019-01-12**. *TimeShutter* last updated 2018-10-03. *PhotoChron* 2018-05-29. *Day Pic* 2023. Meanwhile *1 Second Everyday* (v6.5.6), *Facelapse* (50k+ installs, updated 2026-08-04), *Close-up*, and four 2025–2026 entrants are active, and the new ones all lead with automatic face alignment.

### Feature frequency across the 21

| Feature | Apps | Build / Cut | Reason |
|---|---|---|---|
| Ghost / translucent overlay of previous photo | 10 | **BUILD** | The product. |
| Grid / alignment guide lines | 7 | **BUILD** | Thirds + an eye line. Eyes are what faces align by. |
| Timelapse playback | 16 | **BUILD** | Named in the north star: *"the timeline plays back without his head jumping around."* Includes scrubbing, speed, looping, ranges, dates, and export after the 2026-08-10 follow-up below. |
| Local-only storage as a privacy promise | 7 | **BUILD** | Already the hard constraint. |
| Save-to-camera-roll / export as the real backup | 7 | **BUILD** | Shipped as a plain `.zip` of dated image files. |
| Calendar / month-grouped browsing | 5 | **BUILD** | Month headers in the timeline; nearly free. |
| Streaks / milestone counters | 4 | **BUILD** | One line in the header. Counts a streak ending *yesterday*, because today is not over. |
| Resolution / quality options | 4 | **BUILD** | Three presets with honest per-day byte costs. |
| Automatic face alignment (eye-based) | 6 | **CUT** | Explicitly cut by the brief; also unavailable — `FaceDetector` is Chrome-only behind a flag, absent on iOS. Would need a bundled ML model, breaking the "loads instantly, works offline" property. **This is the main axis of competition among 2025–26 entrants and the clearest reason a v2 would revisit it.** |
| Daily reminder notification | **15** | **CUT** | Cut by the brief. Independently supported: reminders are the *second-largest* complaint category — fire at the wrong time, fire endlessly, cannot be turned off. iOS web push also requires Home Screen install and permission from a direct tap. |
| Video file export (MP4/GIF) | 16 / 4 | **BUILD (2026-08-10)** | Free local MP4/WebM export. The app feature-detects the container rather than promising one codec everywhere. |
| Import from camera roll | 11 | **PARTIAL** | The file-input fallback imports one photo as today's. Bulk import is cut: it is where these apps most reliably crash and silently corrupt ordering. |
| Multiple projects / timelines | 10 | **BUILD (2026-08-10)** | Albums make "one a day" independent per journey, which is necessary for face and physique tracking on the same day. |
| Cloud backup to Dropbox/Drive | 4 | **CUT** | Photos never leave the device. |
| Post-capture repositioning | 3 | **CUT** | See below — this is a considered cut, not an omission. |
| Passcode / biometric lock | 3 | **CUT** | Device lock already covers this; a web app cannot do it credibly. |
| Filters / colour treatment | 3 | **CUT** | Cut by the brief. |
| Front + rear camera | 3 | **CUT** | It is a selfie app; a second facing doubles the mirroring state space. |
| Notes / journal text per photo | 2 | **CUT** | Not the north star. |
| Watermark on free exports | 2 | **CUT** | Nothing is paid. |
| Date/timestamp overlay on export | 3 | **BUILD, OPTIONAL (2026-08-10)** | Dates are drawn only during playback/export. Stored masters remain untouched, so the old irreversibility objection no longer applies. |
| Multiple photos per day | 5 | **CUT** | One per day; a retake replaces. The schema keeps the door open (non-unique day index). |

### Follow-up: albums, timelapse controls, timezone, and recovery (2026-08-10)

The review request reopened the three earlier cuts above. A focused pass found a
consistent minimum useful timelapse rather than a reason to copy a full video editor:

- **Independent projects are a real use case, not a contradiction.** Dayli describes
  separate photo journals/collections, renaming, and video export/share; its reviews
  explicitly mention multiple categories and three export speeds. Face and physique
  are two daily journeys, so the invariant becomes one photo per album per day.
  ([Dayli App Store listing](https://apps.apple.com/us/app/dayli-everyday-photo-journal/id717858939),
  [reviews](https://apps.apple.com/us/app/dayli-everyday-photo-journal/id717858939?platform=iphone&see-all=reviews))
- **Range, speed, duration, and share/export are the useful core.** 1 Second Everyday
  exposes month/year/custom/date-range selection and shows the resulting duration as
  speed changes. Dayli also saves and shares the finished timelapse. Those findings
  produced All/30 days/year/custom, 3/6/12 fps, an exact duration label, and local
  export/share. ([1SE date selection](https://help.1se.co/en/articles/3703781-how-to-choose-the-dates-to-mash),
  [1SE speed](https://help.1se.co/en/articles/8200716-how-to-speed-up-your-mash))
- **Music, morphing, filters, and arbitrary reordering remain cut.** They turn a
  progress viewer into an editor, add rights/encoding complexity, or hide the honest
  hard cuts that expose alignment quality. Looping and optional dates are lightweight
  playback aids; dates never alter source photos.
- **The browser can encode locally without a new dependency.** Canvas `captureStream()`
  provides a video track, `MediaRecorder` accepts canvas-generated tracks, and
  `MediaRecorder.isTypeSupported()` lets the app choose MP4/H.264 or WebM at runtime.
  Unsupported browsers keep playback and disable only export.
  ([MDN canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream),
  [WebKit MediaRecorder](https://webkit.org/blog/11353/mediarecorder-api/),
  [MDN format detection](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static))
- **Day boundaries follow the album, not UTC.** `Intl.DateTimeFormat().resolvedOptions()`
  exposes the runtime's IANA timezone, so automatic mode follows the device. A manual
  per-album override makes travel or a fixed project location deterministic. The
  override affects future captures only; rebucketing history would rewrite what day
  the user actually saved. ([MDN resolved options](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/resolvedOptions))
- **Deletion is reversible for 30 days.** This matches the recovery model users already
  know from Apple Photos: restore during the retention window, or permanently delete
  early. The app also offers immediate Undo and empties expired items locally.
  ([Apple Photos recovery](https://support.apple.com/en-nz/124460))

### What users actually complain about

22 complaint clusters were collected with verbatim quotes. Three matter enough to quote:

> **"Main problem: the mirroring effect. You take one picture but it spits out a mirrored image (different picture). The option that allows you to match your face up to an outline of your own face is so unthought through. You're matching your face to a mirrored image."**
> — *Everyday*, 3 stars

This is precisely the failure the brief names, observed in the wild, in the best-regarded app in the category.

> **"It worked for me for years but apparently abandoned by the developer. The grid lines keep getting messed up and my multi year long time lapse is all crooked now."** — *Everyday*, 1 star
> **"I liked this program until I lost six years of photos."** — *Selfie A Day*, 2 stars
> **"I've used this app since 2011… the camera is broken now so the app functionally doesn't work."** — *Everyday*, 1 star

Alignment breaking after an OS upgrade, and archives stranded inside dead apps, are the two ways people lose years of work here.

**The single most-requested missing feature is post-capture nudging** — "let me line it up after I take it", asked for across at least three apps. **Cut, deliberately.** It is a symptom fix for an alignment bug we removed by construction: users need to nudge because the ghost they aimed at was not the frame that got saved. Fixing the cause is the operating rule. If real use shows drift, this is the first thing to revisit.

---

## Part 3 — What the research changed

Everything in this section is a design or code change that would not exist without a specific finding above.

1. **Resuming the camera now waits for a tap past a ~50 s window** (`REPROMPT_WINDOW_MS` in `src/camera/useCamera.ts`). Straight from `inactiveMediaCaptureStreamRepromptIntervalForiOS = 1`. The obvious implementation — auto-restart on `visibilitychange` — would have burned a permission prompt every time the user came back to the app.

2. **Stream health is `readyState === 'live' && !track.muted`, and `mute`/`unmute` are handled** (`isUsable()` in the same file). The `readyState`-only check every tutorial shows would have left a frozen picture on iOS that still claimed to be running.

3. **The file-input fallback is load-bearing, not a legacy nicety.** Two open regressions (275527, and the unverified iOS 26 rotation report) mean the live camera can fail on current iOS. The fallback is auto-selected when `getUserMedia` is absent *and* reachable from every camera error state.

4. **A prompt on every cold start is treated as normal, not as an error.** Home-screen apps are isolated from Safari by design, so onboarding never promises "you'll only be asked once".

5. **Photos are stored as `ArrayBuffer` + a separate `mime` field, and records are write-once.** Directly from bugs 235687/240216. The stored image is never read-then-rewritten; a replacement is a fresh encode under a new id. *(The claim that ArrayBuffer avoids the bug is unverified — this avoids the documented failure path rather than proving immunity.)*

6. **Storage state is reported honestly, and "installed" is never conflated with "safe".** Because the ITP exemption does not cover quota or pressure eviction, Settings reports what `persisted()` actually returned and says a backup is the protection that works everywhere.

7. **A warning that iOS gives an installed web app its own storage container** (`src/app/advice.ts`). This is the finding I would most have missed: build a streak in Safari, install to the Home Screen, and the new app opens empty. The app now detects iOS-in-browser with photos present and tells the user to export first.

8. **The service worker cannot reach photo data by construction**, and its cleanup is scoped to its own precache buckets. Backed by an e2e test that purges all Cache Storage and forces a genuine worker update, then asserts the photos are still there.

9. **Timelapse playback was promoted from "stretch" to core**, because it appears in 16 of 21 apps *and* in the north-star sentence. Frames decode in a rolling window of 6 — a direct answer to *"once I added around 900 photos, the animate preview doesn't work and it only shows a blank screen."*

10. **Mirroring: stored pixels are in preview space by default,** with a per-photo `mirrored` flag, and the ghost flips only when the stored space disagrees with the current preview.

    This *contradicts* the research's own recommendation, which was to save un-mirrored to match platform defaults. The trade-off: saving un-mirrored matches iOS/Pixel/Samsung and produces exported stills with readable text; saving in preview space makes the ghost path transform-free, so the invariant holds by construction with no code that can be wrong. Given the complaint driving this whole design is a *mismatch* between what you aim at and what you get — not mirroring itself — the transform-free path wins. The per-photo flag means a user who flips the setting does not corrupt older photos, and it means the decision is reversible later without a migration.

11. **Tap-anywhere-to-capture plus Space/Enter.** Users of the native apps repeatedly ask for a volume-button shutter for one-handed selfies; the web cannot have one. The largest possible target is the honest substitute.

12. **iOS shell hardening from the checklist:** `viewport-fit=cover`, `apple-touch-icon` at 180×180 alongside manifest icons, `apple-mobile-web-app-capable` retained (Apple's own reference says `status-bar-style` has no effect without it), `touch-action: manipulation` instead of `user-scalable=no`, `overscroll-behavior: none` on both `html` and `body`, and `-webkit-touch-callout`/`user-select` suppressed on controls but re-enabled on prose.

13. **The single timeline became independent albums after the 2026-08-10 review.**
    The migration places every existing photo in `Selfies`; captures, the daily slot,
    the ghost, timeline, and timelapse are all scoped by album. Selection persists,
    and albums can be created and renamed without moving existing photos.

14. **Day identity now records an IANA timezone.** Automatic mode is read from
    `Intl.DateTimeFormat().resolvedOptions().timeZone`; each album can pin a manual
    override. A live visibility/midnight watcher updates an open capture screen, while
    stored day keys never change retroactively. The capture timestamp is taken at the
    shutter press or file selection, before encoding, so work that crosses midnight
    cannot silently move to the following day.

15. **Timelapse export was promoted from stretch to shipped.** The player filters by
    inclusive date ranges, reports frame count and duration, loops optionally, and can
    stamp dates without modifying masters. Export uses a rolling decode pipeline,
    canvas capture, codec feature detection, and `MediaRecorder`; mobile file sharing
    is preferred when available and desktop falls back to download. Playback and export
    share capture-time ordering, and the generated container duration is checked against
    the duration shown in the UI.

16. **Deletion is now a reversible state transition.** Pixels remain in IndexedDB for
    30 days, immediate Undo and a central Trash screen both restore them, and a restore
    refuses to overwrite a newer active photo in the same album/day. Empty Trash and
    expiry are the only bulk permanent-delete paths. Same-day retakes and backup
    replacements also move the displaced photo to Trash instead of destroying it.

### Findings that produced no change, recorded so the reasoning is auditable

- **`display_override`, `orientation`, `background_color` in the manifest** — ignored by iOS. Left in place; they cost nothing and are honoured elsewhere.
- **`pushState` pausing capture before iOS 17.4.** Real, but fixed in March 2024, and the alternative (hash routing) had a *worse* related bug. Kept `pushState`; noted as a residual risk for iOS < 17.4.
- **Storage Buckets API** for prioritising the master images over thumbnails — unimplemented in Safari. Thumbnails are instead kept small and are regenerable from masters on import.

---

## Sources

Primary: [bugs.webkit.org 185448](https://bugs.webkit.org/show_bug.cgi?id=185448) · [181849](https://bugs.webkit.org/show_bug.cgi?id=181849) · [215884](https://bugs.webkit.org/show_bug.cgi?id=215884) · [235687](https://bugs.webkit.org/show_bug.cgi?id=235687) · [240216](https://bugs.webkit.org/show_bug.cgi?id=240216) · [275527](https://bugs.webkit.org/show_bug.cgi?id=275527) · [280394](https://bugs.webkit.org/show_bug.cgi?id=280394) · WebKit trunk `WebPreferencesDefaultValues.cpp`, `UserMediaPermissionRequestManagerProxy.cpp`, `RealtimeMediaSource.cpp`, `ResourceLoadStatisticsStore.cpp`, `NetworkStorageManager` · [WebKit PR 24971](https://github.com/WebKit/WebKit/pull/24971) · [webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) · [11338](https://webkit.org/blog/11338/cname-cloaking-and-bounce-tracking-defense/) · [14205](https://webkit.org/blog/14205/news-from-wwdc23-webkit-features-in-safari-17-beta/) · [14403](https://webkit.org/blog/14403/updates-to-storage-policy/) · [webkit.org/tracking-prevention](https://webkit.org/tracking-prevention/) · Apple HIG (camera, layout) · MDN browser-compat-data.

Secondary / cross-checked: MDN storage quotas (2026-01-05) · caniuse Stream API · web.dev *Storage for the web* (2024-09-23, **contradicted** on quota) · iTunes Lookup API and Google Play listings for 21 apps (queried 2026-08-09) · App Store and Play review text.

2026-08-10 follow-up: [Dayli App Store listing](https://apps.apple.com/us/app/dayli-everyday-photo-journal/id717858939) · [1SE date selection](https://help.1se.co/en/articles/3703781-how-to-choose-the-dates-to-mash) · [1SE speed and duration](https://help.1se.co/en/articles/8200716-how-to-speed-up-your-mash) · [Apple Photos 30-day recovery](https://support.apple.com/en-nz/124460) · [MDN resolved timezone](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/resolvedOptions) · [MDN canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream) · [WebKit MediaRecorder](https://webkit.org/blog/11353/mediarecorder-api/) · [MDN codec/container detection](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).
