# Performance harness v1

Measure frozen production builds on the Mac mini. The harness never builds or changes the app.
All reports identify harness version `v1`. Keep the harness unchanged during a comparison.

## Prerequisites

- Use one Mac mini, one checkout, one Node version, and one installed Chromium version.
- Use the existing project dependencies. Lighthouse is an external executable.
- Generate the repository camera fixture with `npm run fixtures` before freezing the inputs.
- Keep each production `dist/` in a separate folder. Build both inputs with the same mode and toolchain.
- Keep output folders outside all build folders. Use a new output folder for each run.
- Stop other heavy work. Keep the power source, display state, and thermal conditions steady.
- Use the local Worker only. Never point the harness at a production API.

Set these paths on the mini:

```sh
cd /path/to/selfie-a-day
export PERF_ORIGINAL_DIST=/path/to/frozen-original/dist
export PERF_CANDIDATE_DIST=/path/to/frozen-candidate/dist
export PERF_ORIGINAL_ASSET="$PERF_ORIGINAL_DIST/assets/index-C7aPkNJ7.js"
export LIGHTHOUSE_BIN=/absolute/path/to/lighthouse
export CHROME_PATH="$(node --input-type=module -e "import { chromium } from '@playwright/test'; process.stdout.write(chromium.executablePath())")"
```

`PERF_ORIGINAL_ASSET` must contain the original 286,778-byte main script.
`PERF_CAMERA_FIXTURE` can select another copy of `alignment-target.y4m`. Every compared run must use the same bytes.
`CHROME_PATH` is optional. The Lighthouse wrapper otherwise uses Playwright's Chromium path.
`LIGHTHOUSE_BIN` must name an existing executable. The harness does not install Lighthouse.

Start an isolated local Worker in another terminal:

```sh
node scripts/start-e2e-api.mjs
```

This existing launcher applies local migrations and uses temporary D1/R2 storage.
It removes that storage when the process exits. `npm run dev:api` also works, but keeps local state.
The local Worker must allow `http://127.0.0.1:4319` and use the insecure local session cookie.
No production account, key, image, or session is needed.

## One command per build

The original build needs no API, account, or sign-in screen:

Its first visit shows onboarding. Cold measures the interactive primary button without advancing it.
Warm, offline, and capture scenarios tap that button during untimed setup.

```sh
node scripts/perf/lab.mjs --target "original=$PERF_ORIGINAL_DIST" --encoding br-dynamic --runs 9 --out /tmp/selfie-perf-original
```

The cloud build uses synthetic accounts through the local API:

```sh
node scripts/perf/lab.mjs --target "candidate=$PERF_CANDIDATE_DIST,http://127.0.0.1:8787" --encoding br-dynamic --runs 9 --out /tmp/selfie-perf-candidate
```

Each command writes `lab.json`. These reports share the same settings and schema.
Separate commands show each build's behavior. A keep decision requires the interleaved command below.

## Readiness smoke on the mini

Start the local Worker, then run one sample of each relevant path against both frozen builds:

```sh
node scripts/perf/lab.mjs --target "original=$PERF_ORIGINAL_DIST" --target "candidate=$PERF_CANDIDATE_DIST,http://127.0.0.1:8787" --encoding br-dynamic --runs 1 --scenario cold --scenario cold-signed-in --scenario warm --scenario offline-warm --scenario capture --out /tmp/selfie-perf-readiness-smoke
node scripts/perf/summarize.mjs /tmp/selfie-perf-readiness-smoke
```

Original cold must report `evidence.firstScreen: "onboarding"`. Candidate cold must report `"account"`.
Warm and offline samples must report `"capture"`. Candidate signed-in cold must also report `"capture"`.
Original warm, offline, and capture evidence must show `completedOnboarding: true`.
Original signed-in cold skips because it has no account API. Every other sample must succeed.
This smoke checks readiness and capture completion. One sample does not establish a performance gain.

For capture, timeline, and snapshot changes, run only these paths:

```sh
node scripts/perf/lab.mjs --target "original=$PERF_ORIGINAL_DIST" --target "candidate=$PERF_CANDIDATE_DIST,http://127.0.0.1:8787" --encoding br-dynamic --runs 1 --scenario capture --scenario timeline-60 --scenario sync-60 --scenario sync-365 --out /tmp/selfie-perf-capture-timeline-smoke
node scripts/perf/summarize.mjs /tmp/selfie-perf-capture-timeline-smoke
```

Candidate capture must report nonzero `uploadRequestBytes`, `savedMs`, and `uploadedMs`.
Candidate timeline and both snapshot scenarios must run. The original skips API-only scenarios.

## Frozen A/B comparison

```sh
node scripts/perf/lab.mjs --target "original=$PERF_ORIGINAL_DIST" --target "candidate=$PERF_CANDIDATE_DIST,http://127.0.0.1:8787" --encoding br-dynamic --runs 9 --out /tmp/selfie-perf-ab
node scripts/perf/summarize.mjs /tmp/selfie-perf-ab
```

For each scenario, samples run A, B, A, B, until each target has nine samples.
All targets use the same loopback origin. The server switches the frozen file set between samples.
Account setup and photo uploads for seeding happen before timing. Every measured sample gets a fresh browser context.
Capture samples get separate empty accounts. Other scenarios reuse read-only synthetic accounts with 0, 60, or 365 photos.
The same generated JPEG bytes and fixed photo dates seed every target.
The original build skips account, API-seeded timeline, and API snapshot scenarios with explicit reasons.
A cloud build without an API argument skips signed-in scenarios. Cold still measures its account screen.

Reports include machine details, Node and browser versions, fixture and image hashes, settings, and every build file's SHA-256.
The harness checks that build files remain unchanged after the run.
It saves partial results after every sample. Any failed sample sets a nonzero exit code.
Skips remain visible and never become zero-valued measurements.
Invalid metrics become error samples with the metric name and value in the reason. Later samples still run.
If the first two samples of a target/scenario return the same error, remaining samples record that error without running.
Those rows have `evidence.executed: false` and identify the two failed rounds. Other targets and scenarios continue.
Every row records `os.loadavg()` before and after the sample, including untimed setup.
Load arrays contain the 1-, 5-, and 15-minute averages. High load never removes samples.

Optional lab flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--encoding` | `br11` | `br11`, `gzip9`, `identity`, or `br-dynamic` |
| `--runs` | `9` | Samples per target and scenario |
| `--port` | `4319` | Shared server port; API origin policy must allow it |
| `--scenario` | All | Repeat to select scenarios without changing their definitions |
| `--build-mode` | `production` | Recorded build mode; build the inputs before running |
| `--calibration-asset` | `PERF_ORIGINAL_ASSET` | Original script used for dynamic Brotli calibration |

Scenario names are `cold`, `cold-signed-in`, `warm`, `offline-warm`, `capture`, `timeline-60`, `sync-60`, and `sync-365`.

## Delivery sizes

```sh
node scripts/perf/sizes.mjs "$PERF_ORIGINAL_DIST" --json /tmp/selfie-perf-original-sizes.json
node scripts/perf/sizes.mjs "$PERF_CANDIDATE_DIST" --json /tmp/selfie-perf-candidate-sizes.json
node scripts/perf/sizes.mjs "$PERF_ORIGINAL_DIST" --served https://selfie-a-day.vercel.app --json /tmp/selfie-perf-live-delivery.json
```

The optional served check only sends anonymous GET requests for initial static assets.
It sends separate `Accept-Encoding: br` and `gzip` requests. Node's raw HTTP client counts compressed response bodies without automatic decompression.
Use a deployment that matches the measured file set. HTTP failures remain in the report and set a nonzero exit code.
The report records the actual response encoding, body length, content length, status, and `Vary` header.
Top-level `servedAssets` lists every asset/encoding response. Existing `files[].served` rows retain the same data.
Top-level `servedTotals` sums initial-asset body bytes separately for requested `br` and `gzip` delivery.
Totals also show response encoding counts, HTTP failures, and missing content lengths.
A missing content-length header stays null; measured body bytes still count.
Compare the main-script rows when checking the earlier 92,421-byte Brotli and 90,548-byte gzip measurements.

`sizes.mjs` reports every shipped file, including source maps and images.
Raw, gzip level 9, and Brotli quality 11 totals are separate theoretical body sizes.
The initial set starts at `index.html`, follows its script/link/image references, then follows static JavaScript imports and CSS URLs.
This includes modulepreloads. Dynamic imports do not join the initial set.
The HTML parser reads actual attributes. The installed Acorn parser follows import/export declarations and literal `new URL(..., import.meta.url)` assets.
JavaScript strings, comments, regular expressions, and dynamic imports cannot create false static references.
Lazy chunks are remaining JavaScript/CSS files, excluding service worker and Workbox files.
The precache set comes from built service worker URL/revision records.
These sets can overlap. Do not add their totals together.
Missing local references and precache entries are errors. External references are listed separately.

## Static server and Brotli

```sh
node scripts/perf/serve.mjs "$PERF_CANDIDATE_DIST" --port 4319 --encoding br-dynamic --api http://127.0.0.1:8787
```

The server reads this checkout's `vercel.json` headers and applies its SPA fallback behavior.
Assets get their configured cache headers. API paths never fall back to HTML.
An API argument enables a loopback-only proxy. Without it, API paths return JSON 404.
Static content uses the selected compression only when the client accepts it.
Images and fonts keep their original encoding. `HEAD` returns the same headers without a body.

`br11` and `gzip9` prepare static bytes before samples. `identity` sends raw bytes.
`br-dynamic` compresses each static response on demand.
It tries Brotli qualities 0–11 against the original script and chooses the closest size to 92,421 bytes.
Calibration must land within 2%. Otherwise the run stops.
Every compared target uses that one quality. Candidates never calibrate against their own main script.
The output records the selected quality, measured size, error, and all tried sizes.
This approximates Vercel compression size. It does not reproduce Vercel's server hardware, edge cache, or compression latency.

## Browser metrics

Chromium uses a 390×664 viewport, 390×844 screen, 3× pixel scale, touch, and mobile emulation.
Locale is `en-US`, timezone is UTC, and color scheme is dark.
CDP adds 150 ms latency, 1.6 Mbps download, 750 kbps upload, and 4× CPU slowdown.
Fake camera flags match the project configuration. Readiness requires a nonuniform live camera frame.
The browser blocks external HTTP traffic through an unused loopback proxy.

| Scenario | Start and finish | Data |
| --- | --- | --- |
| `cold` | New navigation to interactive onboarding, interactive account screen, or capture-ready | Empty context; service workers blocked |
| `cold-signed-in` | New navigation to capture-ready | Session cookie only; no local app storage; service workers blocked |
| `warm` | Second navigation to capture-ready | First visit completes onboarding and activates the service worker |
| `offline-warm` | New offline navigation to capture-ready | Online visits warm the app; HTTP cache disabled; SW stays active |
| `capture` | Shutter click to saved toast; separate time to completed upload | Empty account, or original storage after untimed onboarding |
| `timeline-60` | Timeline click to decoded thumbnails in the viewport | 60 fixed synthetic photos; service workers blocked |
| `sync-60`, `sync-365` | Full snapshot fetch to complete response body | 60 or 365 fixed photos; CDP throttle applies |

Navigation `readyMs` uses the browser navigation clock. Action timings use `performance.timeOrigin + performance.now()` at both endpoints.
The harness arms a click listener directly on the measured button before clicking it.
If the click mark is missing, it uses the browser timestamp from immediately before the click command.
Timing evidence names that fallback. It includes Playwright's action checks and command delay, so inspect it before comparing samples.
`savedMs` ends when the saved toast first appears. A browser mutation observer records that point independently of upload completion.
`uploadedMs` ends after Playwright confirms the upload response finished, before byte inspection or response parsing.
These endpoints run independently. The original local-only app reports only `savedMs` and retains its reason for missing upload metrics.
`uploadRequestBytes` uses Content-Length or complete CDP post data, including multipart framing and metadata.
Incomplete multipart data never becomes a zero-byte upload. Missing byte counts become error samples.
`uploadResponseBytes` counts the encoded response body. `uploadMasterBytes` and `uploadThumbBytes` record file sizes when visible.
The upload response's photo DTO confirms those part sizes. Evidence records each byte count's source.
Timeline waits for all 60 cells and decodes only thumbnails that intersect the viewport.
Snapshot time includes network transfer; JSON parsing follows timing. Its decoded `bodyBytes` and compressed wire `transferBytes` differ.

FCP and LCP come from browser paint observations around readiness. LCP is the last observed candidate at that point.
`longTaskMs` adds task durations before readiness. `blockingMs` adds each task's portion beyond 50 ms before readiness.
This blocking measure resembles TBT but uses capture/account readiness as its endpoint.
`heapBytes` is JavaScript heap usage after readiness, without forced garbage collection.
`transferBytes` sums CDP encoded transfer lengths for page requests observed in the measured window.
Completed requests include response headers. In-flight requests contribute their observed encoded body bytes.
Cached and service worker responses count as zero network bytes.
`requestCount` counts page HTTP requests, including cache hits. Evidence also lists network-only request counts.
Background service worker maintenance requests are outside the page CDP target and are not included.
Offline checks allow expected API failures but reject failed document, script, or stylesheet requests.

## Lighthouse and PWA checks

Keep the static server above running:

```sh
node scripts/perf/lighthouse.mjs --url http://127.0.0.1:4319 --name candidate --runs 5 --out /tmp/selfie-perf-lighthouse
node scripts/perf/pwa.mjs --url http://127.0.0.1:4319 --api http://127.0.0.1:8787 --out /tmp/selfie-perf-pwa
node scripts/perf/summarize.mjs /tmp/selfie-perf-lighthouse
```

For the original server, omit `--api` from both the server and PWA command.
These commands only accept loopback URLs. PWA account setup uses synthetic local accounts.
Lighthouse uses its default mobile preset with simulated throttling. Its numbers differ from lab's measured CDP throttle.
It writes each raw report, plus scores, timings, byte weights, medians, spreads, and sample counts in `lighthouse.json`.
The report includes Lighthouse version and each run's configuration. Lighthouse failures remain visible.

Lighthouse 13 has no PWA category. `pwa.json` gives pass/fail results with evidence for:

- Manifest fields, start URL, scope, display mode, and theme colors.
- Decoded 192px and 512px icons, a maskable icon, and an apple-touch-icon.
- Chromium installability errors from CDP.
- An active service worker that controls the page.
- A new offline document that renders the shell and live signed-in capture screen, with HTTP cache disabled.
- Online API bypass, absence of API entries in Cache Storage, rejected offline API fetches, and no API navigation fallback.
- iOS capability, title, status bar, theme, and safe-area meta tags.

## Summary and keep decisions

```sh
node scripts/perf/summarize.mjs /tmp/selfie-perf-ab
node scripts/perf/summarize.mjs /tmp/selfie-perf-original /tmp/selfie-perf-candidate --out /tmp/selfie-perf-separate-summary
```

The command writes `summary.md` and `summary.json` with one table per scenario and metric.
Each target gets n, median, p25–p75, and min–max. Quartiles use linear interpolation.
Spread means p75 minus p25. Noise threshold means `max(baseline spread, smallest useful gain)`.
Version 1 fixes useful gains before measurement: 50 ms, 1,024 bytes, 1 request, 1 score point, or 0.01 ratio units.
Delta means candidate minus baseline. Lower time, size, count, and CLS values improve the result; higher scores improve it.
Paired runs use the median of per-round deltas. Separate runs use the difference of medians and cannot earn a keep decision.
The baseline is the first target in the input order. Each pair gets its own baseline spread and threshold.
Only interleaved gains strictly above that threshold earn `keep: true`.
The command rejects mixed lab settings, machines, versions, fixtures, or build modes.
It also rejects one target name that refers to different builds.
Read skips and failures alongside the tables. A missing feature supplies no comparison metric.
Cold onboarding, account, and capture screens perform different work; inspect the recorded first-screen mode before comparing them.
Summary JSON includes each row's `loadAverages`. Markdown prints a per-sample load table and marks rows that did not execute.

## Light checks on a development Mac

```sh
for script in scripts/perf/*.mjs; do node --check "$script" || exit 1; done
npx eslint scripts/perf
node scripts/perf/lab.mjs --self-check
```

The self-check validates arguments, rejects bad inputs, checks sample schema, and exercises noise decisions without launching browsers.
It also checks minified references, delivery totals, readiness modes, onboarding clicks, repeated-error limits, and load reporting.
Timing fixtures include a missing timeline action mark, invalid metric values, and independent save/upload endpoints.
Upload fixtures cover multipart byte counts, partial CDP data, header event order, and visible file-part sizes.
Run builds, browser scenarios, Lighthouse, and actual measurements only on the mini.
