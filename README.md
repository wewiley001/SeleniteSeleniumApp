# Selenite — No-Code QA Runner

A Chrome extension for building and running QA test scripts directly in your browser — no code required. Selenite lets you build a queue of browser automation steps via a side panel UI, save and reload scripts, and watch execution logs in real time.

## Features

- Side panel UI — build and run test queues without leaving the page
- Visual step builder — add, reorder, and remove automation steps
- Element picker — click any element on the page to capture its CSS selector
- Metrics section — define the metric values that fire in the browser output (often prefixed `[PJS]` or `[cro]`) and assert them during runs with the **Track Metric** step
- Save and load named scripts (stored in Chrome sync storage)
- Universal delay override — set a single delay across all steps
- Two execution modes: **close after run** or **loop continuously**
- Tab targeting: run on the **active tab** or open a **new tab**
- Console log with live output and INFO / WARN / ERR filtering, plus a live browser-console mirror with a CRO (`[PJS]`/`[cro]`) filter
- Visual Regression — full-page screenshot baselines per URL with pixel diffing, ignore regions, and a mismatch threshold (Functional Testing tab)
- **Test Agent** tab — run WCAG, Cross-Variant Accessibility, or Performance one at a time, batch any of them together with A/B and Funnel Crawl via **Also Run**, and get a single combined report with an optional AI-written summary
- **A/B** tab — load each experiment variant once and diff page state, metric fires, and tagged console output against control, with an optional per-variant interaction heatmap and an AI-powered full-page visual diff
- WCAG / Accessibility mode — full WCAG 2.2 audit (heuristics + axe-core) with region scoping, check presets, click-to-highlight findings, JSON export, and per-URL run history
- Cross-Variant Accessibility mode — run the WCAG audit against every experiment variant and diff findings vs control (introduced / resolved / pre-existing)
- Performance/Load mode — median page-load metrics (TTFB, FCP, LCP, CLS, long tasks, resources) over N runs, checked against Core Web Vitals budgets, with per-URL history
- Funnel Crawl — an AI agent clicks through Start → Middle waypoint(s) → End to verify a funnel actually connects
- Agentic Testing (Sonnet) and Agentic Analysis (Opus) — optional AI-powered vision judgment and result summaries via Anthropic's API
- Stop execution at any time

## Installation

1. Clone or download this repo.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select the `extension/` folder.
5. Click the Selenite icon in the toolbar to open the side panel.

## Usage

### Building a Queue

1. Open the Selenite side panel by clicking the extension icon.
2. In the **Target** section:
   - Choose an execution mode: **Close after run** or **Loop continuously**.
   - Choose a tab target: **Active tab** or **New tab**.
3. Every queue starts with a locked **Open URL** step — enter the URL to open (leave blank to use the active tab), plus any URL parameters and the QA Mode toggle (`cro_mode=qa`).
4. Click **+ Add Step** to add automation steps to the queue.
5. For each step:
   - Select a function from the dropdown.
   - Fill in any required arguments (use the picker button `🎯` to capture selectors from the page).
   - Optionally set a per-step delay (seconds).
   - Use the checkbox to enable/disable individual steps.
6. Click **Execute** to run the queue.

### Tracking Metrics

1. Open the **Metrics** section at the top of the Functional Testing tab and click **+ Add Metric** for each console value you want to track (e.g. `Tagging: hero_cta_click`). Metrics persist across sessions.
2. Add a **Track Metric** step to the queue and pick a metric from the dropdown.
3. When the step runs, it checks the `[PJS]`/`[cro]`-tagged console output captured during the current run for that value (case-insensitive substring match). A hit logs how many times it fired; a miss logs an error without stopping the queue.

### Saving and Loading Scripts

- Enter a name in the **Script name** field and click **Save** to store the queue.
- Open the **Load Script** accordion to load or delete a saved script.
- Scripts are saved to Chrome sync storage and persist across sessions.

### Visual Regression

Lives in the **Functional Testing** tab, alongside the function queue. Catches unintended visual changes on a page over time: capture full-page screenshots as a named baseline, then diff later runs against it — layout shifts, broken styling, missing elements.

1. Add the page URL(s) to test (Single or Multi scope). Each page row carries its own QA Mode toggle and URL params; a shared **Settle** delay waits for experiment scripts and lazy content.
2. Optionally add **Ignore Regions** (CSS selectors, pickable with `🎯`) — matched regions are masked out of the comparison, for carousels, timestamps, ads, and other legitimately dynamic content.
3. Click **Set Baseline** to capture and store the reference screenshots (kept per URL in IndexedDB; replace any page's baseline with its ✕ reset control).
4. Click **Run Comparison** to capture fresh screenshots and diff pixel-by-pixel against the baseline. A page fails when its mismatch percentage exceeds the editable **Threshold** (default 0.1%). Results show pass/fail, mismatch %, and baseline/current/diff images (click to open full size), with changed pixels highlighted in red.
5. If the window width differs from the baseline's, the page is flagged with a viewport warning and the pixel diff is skipped — dimension-mismatched diffs are noise. Height changes are diffed over the shared region and the delta counts toward the mismatch.

Screenshots are captured over CDP (`Page.captureScreenshot` with `captureBeyondViewport`) — no scrolling and stitching, no new permissions. **Export** downloads the run's verdicts as JSON (images stay in the panel).

### Test Agent

The **Test Agent** tab runs one testing mode at a time: pick it from the **Test Mode** dropdown, configure its settings, and click **Execute Test**. Every automated mode (everything except Funnel Crawl) can also be batched together via **Also Run** — check any additional modes and they run in sequence after the primary one, each skipped automatically if it isn't configured. Once at least one mode has run, Selenite compiles a single report (opened in a new tab) covering every mode that ran, optionally with an AI-written plain-English summary.

A/B Variant Comparison is configured and run from its own **A/B** tab rather than here — selecting it in the **Test Mode** dropdown shows a pointer back to that tab instead of its settings, but it still runs and reports exactly like any other mode when batched via **Also Run**.

- **Agentic Testing** (Sonnet) — lets a mode capture a screenshot per page/variant and asks Claude to judge whether a visual difference looks like an intended change or a likely bug. Off by default.
- **Agentic Analysis** (Opus) — summarizes the full set of results in the report. On by default.
- Both require an **Anthropic API key** (saved locally in Chrome sync storage; calls go directly from the extension to `api.anthropic.com`). Funnel Crawl forces both on, since the agent's navigation *is* the test.

#### WCAG / Accessibility Mode

Runs a WCAG 2.2 accessibility audit (19 heuristic check suites plus axe-core as the authoritative engine) against the active tab. Pick the criteria to check and click **Run Audit**; rows marked **Manual** include a hand-check list of what to verify yourself.

- **Scoping** — enter a CSS selector (or pick one with `🎯`) to audit only that region of the page. Both the heuristic checks and the axe-core run are constrained to the subtree, so you can audit only the DOM an experiment variant touches. Leave empty for the full page.
- **Presets** — save named check configurations (enabled checks + scope) to Chrome sync storage. Two built-ins are always available: **Full audit** (all 19) and **Automated only** (excludes the manual checks).
- **Highlighting** — clicking an issue row that references a page element scrolls to and flashes that element in the audited tab.
- **Export** — the **Export** button in the results header downloads the run as a JSON file (per check: label, WCAG SCs, status, issues).
- **Run history** — the last 5 runs per page URL are kept in local storage; pick one under **Recent Runs** and click **View** to re-view its results.

#### Cross-Variant Accessibility Mode

Answers the question the standalone WCAG audit can't: **did an experiment variant introduce (or fix) accessibility issues relative to control?** It reuses the WCAG mode's audit engine and the A/B tab's variant-loading machinery.

1. Configure variant targets exactly like the A/B tab (base URL, per-variant label + override query string, QA Mode, settle, keep-tabs-open). The first target is the baseline, typically Control. Target sets save/load by name (namespaced separately from the A/B tab's sets).
2. Pick the automated checks to run (all on by default). Manual checks produce identical guidance on every variant, so they sit behind an **Include manual checks** toggle (off by default) and render once, not per variant.
3. Optionally **scope** the audit to the region the experiment modifies (CSS selector or `🎯`) — the expected usage, since it cuts shared-page noise dramatically.
4. Click **Run Cross-Variant Audit**. Each variant loads sequentially and gets the same audit; findings are diffed against the baseline per check:
   - **Introduced** — issues in a variant but not in baseline: the headline signal, expanded and styled as errors.
   - **Resolved** — issues in baseline but absent in a variant: shown positively.
   - **Pre-existing** — issues identical in both: collapsed and greyed, visible on expand.
5. With keep-tabs-open enabled, clicking an issue highlights its element in that variant's tab. **Export** downloads per-variant, per-check, per-bucket JSON.

Issue matching is exact (normalized whitespace) within each check — axe node-target strings can differ across runs for the same underlying issue, a known v1 limitation.

#### Performance/Load Mode

Measures page-load performance so experiment work that "visually passes" doesn't silently tank speed or stability. Each configured page is loaded fresh N times (default 3, sequential — never parallel) and the **median** per metric is reported; individual runs are viewable on expand.

- **Metrics per run**: TTFB, DOMContentLoaded, load event, First Contentful Paint, LCP, CLS, long-task count/time (a rough main-thread-blocking signal), request count and transfer size by type (script/css/img/font/other), resources arriving *after* the load event (experiment scripts often inject late), and JS errors during the load window.
- **Budgets**: editable thresholds with Core Web Vitals defaults (LCP ≤ 2.5 s, CLS ≤ 0.1, plus TTFB and load). Over-budget medians render red, under-budget green. Budgets persist in sync storage.
- **Disable cache** (default on) gives a fair "first visit" measurement via CDP `Network.setCacheDisabled` — no new permissions.
- **Run history**: the last 10 measurement summaries per URL (medians and verdicts) are kept in local storage under **Recent Runs**.
- Because pages are just URLs, compare experiment variants by adding the same page twice with different override params.

Numbers come from a real browser on your machine and network — useful for relative comparison (page vs page, run vs run, before vs after), not lab-grade absolutes.

#### Funnel Crawl

An AI agent (Sonnet) clicks through the live page to verify a funnel actually connects, end to end — Start → each Middle waypoint (in order) → End.

1. Enter the **Start** and **End** waypoint URLs (both required); optionally add **Middle** waypoints in between, in order.
2. Optionally add **Supplemental Instructions** — free-text notes for the agent (test credentials, paths to avoid, form field mappings, etc.).
3. Click **Execute Test**. Agentic Testing and Analysis are forced on for this mode and require an Anthropic API key.
4. Results show each segment (Start→Middle, Middle→Middle, Middle→End) as reached or not, with step counts and any error. Funnel Crawl always runs alone — it isn't batchable via Also Run.

### A/B Variant Comparison

The **A/B** tab QAs an A/B experiment (Optimizely, Convert, or similar) by loading the same page once per variant and diffing the captures — no interaction steps, just load and compare. Differences are shown neutrally (a variant is *supposed* to differ from control); only JS errors and load failures are styled as errors. It can also be batched from the **Test Agent** tab via **Also Run** — see above.

1. Set the **Base URL** the variants share (each target can override it with its own URL).
2. Define at least two **Variant Targets**. The first is the baseline (typically Control). Each target has a label and an **Override** — the query string that forces the variant, e.g. Optimizely's `optimizely_x=<variationId>`.
3. Optionally add **Watched Selectors** (use `🎯` to pick them from the page) — each is compared across variants for existence, visibility, text, and key computed styles.
4. Optional settings: **QA Mode** appends `cro_mode=qa` to every variant URL; **Settle** waits after load so experiment scripts can apply changes (default 3s); **Keep tabs open** leaves each variant tab open for manual inspection; **Agentic Testing (Sonnet)** takes a viewport screenshot per variant and asks Claude to judge whether a visual difference looks intended or like a bug (also available from Test Agent's own toggle when batched from there); **Visual Diff (AI)** does a full-page, region-level AI visual comparison against Control, requires an active reviewed ticket context.
5. Click **Run Comparison**. Each variant loads sequentially in its own tab; captures include page title/URL, `[PJS]`/`[cro]`-tagged console lines, Metrics fires (from the Functional Testing tab's Metrics list), JS errors, and watched-selector state.
6. Results are grouped diffs vs the baseline — identical facts are greyed and collapsed, deltas are highlighted, and errors are always flagged red.

Variant target sets can be saved by name (stored in Chrome sync storage) and re-run in one click. The comparison never touches the Functional Testing tab's queue.

**Optional: interaction heatmap** — with **Keep tabs open** checked, also check **Record interaction heatmap**. After the comparison, each variant's kept-open tab gets a small recorder control: click **Record walk**, interact with that tab the way a real visitor would, then **Stop Recording**; **Show heatmap overlay** draws click-density dots, a mouse-trail line, and a scroll-depth gutter onto that tab. Only one variant can record at a time, and recordings are kept in memory only for the current run (nothing is saved to disk, and nothing ever leaves the browser — keystrokes and typed values are never captured). Off by default; a normal A/B run is unaffected.

## Available Functions

| Function | Description |
|---|---|
| `open_url` | Navigates to a URL and waits for the page to load (always the first step) |
| `click` | Clicks an element (CSS selector, ID, name, XPath, or link text) |
| `fill` | Clears and types into an input field (CSS selector, ID, name, or XPath) |
| `submit` | Submits the form containing the matched element |
| `select_by_name` | Selects a dropdown option by element name and option value |
| `send_keys_action` | Sends keystrokes to the currently focused element |
| `wait_seconds` | Pauses for an exact number of seconds |
| `back` | Navigates back in browser history |
| `forward` | Navigates forward in browser history |
| `refresh` | Reloads the current page |
| `switch_to` | Switches context to a frame, parent frame, main page, or window |
| `alert` | Accepts, dismisses, or reads a browser alert dialog |
| `track_metric` | Checks the run's console output for a metric defined in the Metrics section |

## Project Structure

```
extension/
├── manifest.json       # Chrome extension manifest (MV3)
├── sidepanel.html      # Side panel UI
├── popup.html          # Popup UI (same layout as the side panel)
├── popup.js            # Queue builder, Metrics section, UI logic (shared by both UIs)
├── background.js       # Service worker (queue execution, console capture, metrics)
├── picker.js           # In-page element picker (injected on demand)
├── selector.js         # Shared CSS-selector builder (used by picker.js and recorder.js)
├── recorder.js         # Interaction recorder for A/B's heatmap (clicks/scroll/movement, injected on demand)
├── console-capture.js  # MAIN-world console patch (relays [PJS]/[cro] tagged output)
├── console-bridge.js   # ISOLATED-world bridge to the service worker
├── axe.min.js          # axe-core, used by the WCAG audit suite
└── icons/              # Extension icons (16, 48, 128px)
```

## Script Format

Scripts are stored as JSON arrays in Chrome sync storage:

```json
[
  {
    "func": "click",
    "enabled": true,
    "delay": "1",
    "inputs": {
      "selector": "#submit-btn"
    }
  }
]
```
