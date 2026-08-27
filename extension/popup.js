// Selenite popup logic

let FN_META = {};     // { funcName: { label, args } }
let steps = [];       // [{ id, enabled, func, delay, inputs, groupId, groupName }]
let nextId = 1;
let nextGroupId = 1;  // groupId values are 'g' + this counter, scoped to the live session
let logData = [];
let filterLevel = null;
let bcLogData = [];
let bcFilterLevel = null;
let bcTagOnly = false;   // Browser Console "CRO" toggle: narrow the live mirror to [PjS]/[cro] tagged lines
let metrics = [];        // User-defined metric values (Build tab → Metrics), persisted in storage.local
let logOffset = 0;
let _wasRunning = false;

// The queue always starts with this function, which carries the target URL
// and its parameters. This first step cannot be removed or reassigned.
const OPEN_URL_FUNC = 'open_url';

// ── Per-window state isolation ──────────────────────────────────────────────
// The side panel is one instance per browser window, and each window's panel is
// its own document (so in-memory globals are already isolated). The one channel
// that leaks state across windows is chrome.storage. To make each window behave
// like its own Chrome DevTools instance, every chrome.storage.session key — all
// of it working/runtime state — is namespaced by this window's id via the
// sessionNS wrapper below (this applies within normal and within incognito
// alike — chrome.storage.session doesn't span the incognito boundary on its
// own regardless of the manifest's incognito mode). The manifest's
// "incognito": "spanning" is what lets storage.local's initContexts be saved
// in a normal window and read in an incognito one (see initInitializeTab).
// Saved libraries and settings live in storage.local / storage.sync and stay
// shared across windows on purpose (like
// DevTools snippets/settings), so those are left un-namespaced.
let WIN_ID = null;
const nsPrefix = () => (WIN_ID != null ? `w${WIN_ID}:` : '');
const nsKey    = (k) => nsPrefix() + k;
const stripNs  = (k) => (nsPrefix() && k.startsWith(nsPrefix()) ? k.slice(nsPrefix().length) : k);

// Namespaced facade over chrome.storage.session. Mirrors the get/set/remove
// surface the code uses (string key, array of keys, or object literal) and
// transparently prefixes keys, returning results under their bare names.
const sessionNS = {
  get(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    return chrome.storage.session.get(arr.map(nsKey)).then(res => {
      const out = {};
      for (const [k, v] of Object.entries(res)) out[stripNs(k)] = v;
      return out;
    });
  },
  set(obj) {
    const prefixed = {};
    for (const [k, v] of Object.entries(obj)) prefixed[nsKey(k)] = v;
    return chrome.storage.session.set(prefixed);
  },
  remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    return chrome.storage.session.remove(arr.map(nsKey));
  },
};

// Resolve the id of the window this side-panel instance belongs to. Prefer
// windows.getCurrent (the panel's own window); fall back to the active tab's
// window id. Must run before any sessionNS access.
async function resolveWinId() {
  try {
    const w = await chrome.windows.getCurrent();
    if (w && w.id != null) { WIN_ID = w.id; return; }
  } catch (_) {}
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t && t.windowId != null) WIN_ID = t.windowId;
  } catch (_) {}
}

// A long-lived port is how background.js knows this window's panel is open —
// its disconnect (panel closed, window closed, or the document torn down) is
// what releases that window's passive capture/debugger attachment. Reconnects
// after a drop (e.g. an MV3 service-worker restart); harmless if the document
// itself is gone, since nothing runs after unload.
let _panelPort = null;
function connectPanelPort() {
  _panelPort = chrome.runtime.connect({ name: 'selenite-panel' });
  _panelPort.postMessage({ action: 'hello', winId: WIN_ID });
  _panelPort.onDisconnect.addListener(() => {
    _panelPort = null;
    setTimeout(connectPanelPort, 500);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Resolve this panel's window id first — every session read/write below is
  // namespaced by it, and the background worker is told the id so it writes run
  // logs / status / capture state into this window's namespace too.
  await resolveWinId();
  connectPanelPort();

  // Load function metadata from background
  const res = await chrome.runtime.sendMessage({ action: 'getFunctions' });
  FN_META = res.functions;

  // Restore saved queue state. The first step is always the mandatory
  // "Open URL" step; seed it from the saved state if present, otherwise
  // create a fresh one.
  const { queueState } = await sessionNS.get('queueState');
  const rest = [...(queueState || [])];
  const firstData = (rest[0]?.func === OPEN_URL_FUNC) ? rest.shift() : null;
  ensureOpenUrlFirst(firstData);
  rest.forEach(s => addStep(s));
  // Restored steps may carry groupIds from a previous session — nest them
  // into their .step-group wrappers now that they're all in the DOM.
  renderGroups();
  // Group ids restored above are already session-scoped; keep new ones from
  // colliding with the highest one seen.
  for (const s of rest) {
    const n = parseInt(String(s.groupId || '').slice(1), 10);
    if (Number.isFinite(n) && n >= nextGroupId) nextGroupId = n + 1;
  }

  await refreshScripts();
  await syncLogs();
  await syncBcLogs();
  await syncBcStatus();
  await loadMetrics();

  // Poll for log updates and running state. Test Results and Browser Console
  // are polled independently so one panel's updates never block the other's.
  setInterval(syncLogs, 600);
  setInterval(syncBcLogs, 600);
  setInterval(syncBcStatus, 800);
  setInterval(syncRunState, 800);
  setInterval(syncCaptureStatus, 800);
  setInterval(mtSync, 600);          // Metric Tracker counts + recent-fires feed
  setInterval(mtSyncStatus, 800);    // Metric Tracker capture-health line + tracking dot
  setInterval(expSync, 1000);        // Experiment status card — poll + heartbeat, see its header comment

  await loadUniversalDelay();
  await loadQueueMetricsTracking();
  await loadBcTagFilter();
  await restoreCaptureState();
  initAccordions();

  // Tab clicks
  document.querySelectorAll('.tab[data-tab]').forEach(t => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
  });

  // WCAG / Accessibility mode
  document.getElementById('btn-run-wcag')?.addEventListener('click', runWcagAudit);
  initSuiteTooltips();
  await initWcagMode();
  // A/B Variant Comparison mode
  await initAbCompare();

  await initTestModePages();
  // Cross-Variant Accessibility / Performance (each is a no-op if its host
  // markup is absent).
  await initCvaMode();
  await initPerfMode();

  // Initialize tab (Jira ticket → Test Context). Isolated in its own
  // try/catch: a failure here (e.g. a storage hiccup) must never abort the
  // rest of this init chain — Test Agent, Metrics, Queue, Console tab
  // bindings below all depend on this handler continuing past this point.
  try {
    await initInitializeTab();
  } catch (e) {
    console.error('Selenite: Initialize tab failed to load —', e);
  }

  // Matrix Auditor tab. Isolated in its own try/catch for the same reason as
  // Initialize above — a failure here must not cascade into the Test Agent /
  // Console bindings still to come.
  try {
    await initMatrixAuditor();
  } catch (e) {
    console.error('Selenite: Matrix Auditor tab failed to load —', e);
  }

  // Metric Tracker tab. Isolated in its own try/catch for the same reason as
  // Matrix Auditor above. Must run after loadMetrics() (line 125-ish) so
  // `metrics` is hydrated before mtRenderRows() reads it.
  try {
    await initMetricTracker();
  } catch (e) {
    console.error('Selenite: Metric Tracker tab failed to load —', e);
  }

  // Credentials — both live in the settings overlay, not in any tab.
  // Guarded element lookups on purpose: this sits in the same unguarded await
  // chain as everything below, so a missing node would take out every
  // listener bound after this point rather than failing locally.
  const { anthropicApiKey, figmaPat } = await chrome.storage.sync.get(['anthropicApiKey', 'figmaPat']);
  const anthropicInput = document.getElementById('set-anthropic-key');
  if (anthropicInput && anthropicApiKey) anthropicInput.value = anthropicApiKey;
  const figmaPatInput = document.getElementById('set-figma-pat');
  if (figmaPatInput && figmaPat) figmaPatInput.value = figmaPat;
  const { funnelState: savedFunnel } = await sessionNS.get('funnelState');
  if (savedFunnel) funnelState = { start: '', middles: [], end: '', supplementalPrompt: '', ...savedFunnel };

  // Fill-target registry: binds every mode's "Fill from ticket" button and
  // the Initialize card's "Apply to all modes". Must come after every state
  // object it writes to is hydrated — abState/cvaState/tmModes (above),
  // mxState (172), steps (DOMContentLoaded start), funnelState (just above).
  // Isolated in its own try/catch so a registry fault can't take the Test
  // Agent bindings below with it.
  try {
    await initFillTargets();
  } catch (e) {
    console.error('Selenite: fill targets failed to initialize —', e);
  }

  // ── Settings overlay ─────────────────────────────────────────────────────
  // Credentials are not a workflow step, so they are not a tab — a tab would
  // give them the same visual rank as the modes and bury them behind whichever
  // one happened to own them. The gear is in the header, so this is reachable
  // from anywhere.
  const settingsOverlay = document.getElementById('settings-overlay');
  const openSettings = () => { if (settingsOverlay) settingsOverlay.hidden = false; };
  const closeSettings = () => { if (settingsOverlay) settingsOverlay.hidden = true; };
  document.getElementById('btn-settings')?.addEventListener('click', openSettings);
  document.getElementById('btn-settings-close')?.addEventListener('click', closeSettings);
  document.getElementById('settings-backdrop')?.addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOverlay && !settingsOverlay.hidden) closeSettings();
  });

  // Shared by both credential rows: same empty-clears-it contract, same
  // status line, so neither can drift into behaving differently from the
  // other.
  function bindCredential({ btnId, inputId, statusId, storageKey, verify }) {
    const status = document.getElementById(statusId);
    const setStatus = (msg, color) => { if (status) { status.textContent = msg; status.style.color = color; } };
    document.getElementById(btnId)?.addEventListener('click', async () => {
      const value = (document.getElementById(inputId)?.value || '').trim();
      if (!value) {
        await chrome.storage.sync.remove(storageKey);
        setStatus('Cleared.', 'var(--fg3)');
        return;
      }
      await chrome.storage.sync.set({ [storageKey]: value });
      if (!verify) { setStatus('Saved.', 'var(--ok)'); return; }
      setStatus('Saved — verifying…', 'var(--fg3)');
      const res = await verify().catch(e => ({ ok: false, error: e.message }));
      if (res?.ok) setStatus('Verified — ' + (res.handle || 'ok'), 'var(--ok)');
      else setStatus('Saved, but not verified: ' + (res?.error || 'unknown error'), 'var(--err)');
    });
  }

  // No verify for Anthropic: every endpoint that would prove the key works
  // also bills for it, and a save that silently costs money is worse than a
  // save that just says "Saved."
  bindCredential({
    btnId: 'btn-set-anthropic-save', inputId: 'set-anthropic-key',
    statusId: 'set-anthropic-status', storageKey: 'anthropicApiKey',
  });

  // Figma does have a free identity endpoint, so the round trip is worth it —
  // and because the call is made by the worker, a green line here also proves
  // the worker's Figma path is wired end to end. It does NOT prove any given
  // file is readable; that is what the A/B tab's Check button is for.
  bindCredential({
    btnId: 'btn-set-figma-save', inputId: 'set-figma-pat',
    statusId: 'set-figma-status', storageKey: 'figmaPat',
    verify: () => chrome.runtime.sendMessage({ action: 'figmaVerifyToken' }),
  });

  document.getElementById('ta-primary-select').addEventListener('change', taShowPrimary);
  document.getElementById('ta-multi-list').addEventListener('change', e => {
    const chk = e.target.closest('.ta-extra-chk');
    if (!chk) return;
    if (chk.checked) taQueuedExtra.add(chk.dataset.mode); else taQueuedExtra.delete(chk.dataset.mode);
  });
  document.getElementById('btn-ta-run').addEventListener('click', runTestAgent);
  document.getElementById('btn-ta-stop').addEventListener('click', stopTestAgent);

  // Queue buttons
  document.getElementById('btn-add-step').addEventListener('click', () => addStep());
  document.getElementById('btn-clear-steps')?.addEventListener('click', clearSteps);
  document.getElementById('btn-group-mode')?.addEventListener('click', enterGroupSelectMode);
  document.getElementById('btn-group-confirm')?.addEventListener('click', combineSelectedIntoGroup);
  document.getElementById('btn-group-cancel')?.addEventListener('click', exitGroupSelectMode);
  document.getElementById('btn-run').addEventListener('click', runQueue);
  document.getElementById('btn-stop').addEventListener('click', stopQueue);

  // Script buttons
  document.getElementById('btn-save-script').addEventListener('click', saveScript);
  document.getElementById('btn-append-script')?.addEventListener('click', appendScripts);
  document.getElementById('btn-load-script').addEventListener('click', loadScript);
  document.getElementById('btn-delete-script').addEventListener('click', deleteScript);

  // Universal delay toggle + input
  document.getElementById('udel-enabled').addEventListener('change', saveUniversalDelay);
  document.getElementById('udel-seconds').addEventListener('input', saveUniversalDelay);

  // Metrics Tracking toggle (Function Queue)
  document.getElementById('qmt-enabled').addEventListener('change', saveQueueMetricsTracking);

  // Console filter input
  document.getElementById('filter-input').addEventListener('input', renderLog);

  // Console filter buttons
  document.getElementById('fb-all').addEventListener('click',     function() { setFilter(null,      this); });
  document.getElementById('fb-info').addEventListener('click',    function() { setFilter('INFO',    this); });
  document.getElementById('fb-warn').addEventListener('click',    function() { setFilter('WARNING', this); });
  document.getElementById('fb-err').addEventListener('click',     function() { setFilter('ERROR',   this); });
  document.getElementById('fb-browser').addEventListener('click', function() { setFilter('BROWSER', this); });
  document.getElementById('btn-clear-log').addEventListener('click', clearLog);

  // Console subtabs
  document.querySelectorAll('.console-subtab').forEach(b => {
    b.addEventListener('click', () => showConsoleSubtab(b.dataset.subtab));
  });

  // Browser Console filter input/buttons
  document.getElementById('bc-filter-input')?.addEventListener('input', renderBcLog);
  document.getElementById('bcfb-all')?.addEventListener('click',  function() { setBcFilter(null,      this); });
  document.getElementById('bcfb-info')?.addEventListener('click', function() { setBcFilter('INFO',    this); });
  document.getElementById('bcfb-warn')?.addEventListener('click', function() { setBcFilter('WARNING', this); });
  document.getElementById('bcfb-err')?.addEventListener('click',  function() { setBcFilter('ERROR',   this); });
  document.getElementById('btn-clear-bc-log')?.addEventListener('click', clearBcLog);
  document.getElementById('btn-bc-reconnect')?.addEventListener('click', reconnectBcFeed);
  document.getElementById('bc-tag-filter-enabled')?.addEventListener('change', onBcTagFilterToggle);
  document.getElementById('bc-eval-input')?.addEventListener('keydown', onBcEvalKeydown);
  document.getElementById('bc-log-out')?.addEventListener('click', onBcLogClick);

  // Console capture pause/resume toggle — capture itself is automatic and
  // follows whatever tab is focused; this only pauses/resumes it.
  document.getElementById('capture-enabled').addEventListener('change', onCaptureToggle);
});

// ── Tabs ──────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab[data-tab]').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name)?.classList.add('active');

  // Test Agent borrows a mode's settings body from its permanent home
  // (#ta-mode-homes) while active, and parks it back there on the way out —
  // covers every navigation path, so a mode's settings are never stranded
  // mid-move.
  if (name === 'testagent') {
    taShowPrimary();
  } else if (_taActiveBody) {
    taMoveBodyHome(_taActiveBody);
    _taActiveBody = null;
  }

  // The Tracker's rows may have been edited from another window since the
  // last visit — re-render on entry.
  if (name === 'tracker') { mtRenderRows(); mtRenderCounts(); mtSyncStatus(); expRefreshCtx(); expSync(); }

  // A Visual Diff run that died mid-pass (panel closed, worker evicted)
  // should surface its resume banner on return, not just on panel load —
  // fire-and-forget since showTab itself is synchronous. Same reasoning for
  // the Summary of Changes auto-fill: a ticket committed in Initialize after
  // the A/B tab was already visited should still populate it on return.
  if (name === 'abtest') { checkForResumableVisualDiff(); autofillAbSummary(); syncAbDesignReference(); }
}

// ── Test Agent ───────────────────────────────────────────────────────────────
// Reuses each mode's own settings UI (permanently parked in #ta-mode-homes) by
// reparenting it, not copying — WCAG's checks share name="wcag-check" with no
// per-checkbox id, and wcagCheckboxes() queries the whole document, so a
// literal duplicate would silently merge two sets of checkboxes into one.
function taAgenticTestingEnabled() {
  return !!document.getElementById('ta-agentic-testing')?.checked;
}

const TA_MODES = {
  '2': {
    label: 'A/B Variant Comparison',
    // No bodyId/homeParentId — its settings card lives permanently in its
    // own tab (#panel-abtest) now, not parked here for reparenting. A DOM
    // node can't be in two places, so this renders a pointer instead of the
    // real settings — same shape Funnel Crawl has always used (it has never
    // had a parked body either). run/isConfigured/getData are unchanged, so
    // "Also Run" batching and the combined report still work exactly as before.
    renderSlot: (slot) => {
      slot.innerHTML = `
        <div class="card">
          <div class="card-title">A/B Variant Comparison</div>
          <div style="font-size:11px;color:var(--fg2);margin-bottom:8px">Settings and results live in the A/B tab now. Running from here uses whatever is configured there, and the findings still land in this combined report.</div>
          <button class="btn sm" data-ta-open-abtest type="button">Open the A/B tab</button>
        </div>`;
      slot.querySelector('[data-ta-open-abtest]').addEventListener('click', () => showTab('abtest'));
    },
    // fromTestAgent: true — runTestAgent() opens its own single combined
    // report once the whole queued sequence finishes (getData() below feeds
    // rptAbSection there); this run must not ALSO pop its own report tab, or
    // queuing A/B in Test Agent would open two tabs for one run.
    run: () => runAbComparison({ agenticTesting: taAgenticTestingEnabled(), fromTestAgent: true }),
    isConfigured: () => (abState ? abState.targets.map(t => abComposeUrl(t)).filter(Boolean) : []).length >= 2,
    getData: () => _abLastRun,
  },
  '4': {
    label: 'WCAG / Accessibility', bodyId: 'tm4-body', homeParentId: 'ta-mode-homes',
    run: () => runWcagAudit({ agenticTesting: taAgenticTestingEnabled() }),
    isConfigured: () => wcagCheckboxes().some(cb => cb.checked),
    getData: () => _wcagCurrentRun,
  },
  '5': {
    label: 'Cross-Variant Accessibility', bodyId: 'tm5-body', homeParentId: 'ta-mode-homes',
    run: () => runCvaAudit(),
    isConfigured: () => {
      if (!cvaState) return false;
      const targets = cvaState.targets.map(t => composeVariantUrl(t, cvaState.baseUrl, cvaState.qaMode)).filter(Boolean);
      const autoChecks = cvaState.checks.filter(k => WCAG_CHECKS.some(c => c.key === k && !c.manual));
      return targets.length >= 2 && autoChecks.length > 0;
    },
    getData: () => _cvaLastRun,
  },
  '6': {
    label: 'Performance / Load', bodyId: 'tm6-body', homeParentId: 'ta-mode-homes',
    run: () => runPerfMode({ agenticTesting: taAgenticTestingEnabled() }),
    isConfigured: () => tmPagesFor('6').length > 0,
    getData: () => _perfLastRun,
  },
  // Test-Agent-native — no bodyId/homeParentId (nothing is reparented for funnel).
  'funnel': {
    label: 'Funnel Crawl',
    run: () => runFunnelCrawl(),
    isConfigured: () => !!(funnelState.start.trim() && funnelState.end.trim()),
    getData: () => _funnelLastRun,
  },
};
let _taActiveBody = null;        // '2' | '4' | '6' | 'funnel' | null — which mode currently owns #ta-settings-slot
const taQueuedExtra = new Set(); // mode ids checked in the "Also Run" list, not persisted across popup reopen
let _taStopRequested = false;

// ── Funnel Crawl (Test Agent-native — no Test Modes submenu to reparent) ──────
let funnelState = { start: '', middles: [], end: '', supplementalPrompt: '' };  // waypoint URLs + optional supplemental prompt, persisted to sessionNS
let _funnelLastRun = null;
let _taCheckboxPrior = null;      // remembers agentic-checkbox state while funnel force-enables both

function persistFunnel() { sessionNS.set({ funnelState }); }

function funnelWaypoints() {
  return [funnelState.start, ...funnelState.middles, funnelState.end]
    .map(s => (s || '').trim()).filter(Boolean);
}

function syncFunnelRunEnabled() {
  if (document.getElementById('ta-primary-select').value !== 'funnel') return;
  document.getElementById('btn-ta-run').disabled = !(funnelState.start.trim() && funnelState.end.trim());
}

function taRenderFunnel() {
  const slot = document.getElementById('ta-settings-slot');
  const midRows = funnelState.middles.map((u, i) => `
    <div class="row" style="gap:6px;margin-bottom:4px">
      <input type="text" class="fn-mid" data-i="${i}" value="${esc(u)}" placeholder="Middle waypoint URL" style="flex:1">
      <button class="btn danger sm fn-rm-mid" data-i="${i}">✕</button>
    </div>`).join('');
  slot.innerHTML = `
    <div class="card">
      <div class="card-title">Funnel Waypoints</div>
      <div style="font-size:10px;color:var(--fg3);margin-bottom:8px">An AI agent (Sonnet) clicks through the live UI to navigate Start → each Middle (in order) → End, verifying the funnel actually connects. Requires an API key; Agentic Testing + Analysis are forced on for this mode.</div>
      <label class="cap">Start (required)</label>
      <input type="text" id="fn-start" value="${esc(funnelState.start)}" placeholder="https://example.com/landing" style="width:100%;margin-bottom:6px">
      <div class="row" style="gap:6px;margin-bottom:8px">
        <button class="btn sm" id="fn-fill-ticket" type="button" disabled title="Set Start to the control variant's full preview URL from the active ticket context (Initialize tab)">Fill from ticket</button>
        <span id="fn-fill-hint" style="font-size:10px;color:var(--fg3)">No active ticket context — use the Initialize tab</span>
      </div>
      <label class="cap">Middle waypoints (optional, in order)</label>
      <div id="fn-mid-list">${midRows}</div>
      <button class="btn sm" id="fn-add-mid" style="margin:2px 0 8px">+ Add Waypoint</button>
      <label class="cap">End (required)</label>
      <input type="text" id="fn-end" value="${esc(funnelState.end)}" placeholder="https://example.com/confirmation" style="width:100%;margin-bottom:8px">
      <label class="cap">Supplemental Instructions (optional)</label>
      <textarea id="fn-supplemental" placeholder="Add any special instructions or site-specific notes here (e.g., test credentials, specific paths to avoid, form field mappings)" style="width:100%;height:80px;font-family:monospace;font-size:11px;margin-bottom:8px">${esc(funnelState.supplementalPrompt)}</textarea>
      <div id="fn-results" style="margin-top:8px"></div>
    </div>`;

  slot.querySelector('#fn-start').addEventListener('input', e => { funnelState.start = e.target.value; persistFunnel(); syncFunnelRunEnabled(); });
  slot.querySelector('#fn-end').addEventListener('input', e => { funnelState.end = e.target.value; persistFunnel(); syncFunnelRunEnabled(); });
  slot.querySelector('#fn-supplemental').addEventListener('input', e => { funnelState.supplementalPrompt = e.target.value; persistFunnel(); });
  slot.querySelectorAll('.fn-mid').forEach(inp => inp.addEventListener('input', e => {
    funnelState.middles[+e.target.dataset.i] = e.target.value; persistFunnel();
  }));
  slot.querySelectorAll('.fn-rm-mid').forEach(btn => btn.addEventListener('click', () => {
    funnelState.middles.splice(+btn.dataset.i, 1); persistFunnel(); taRenderFunnel();
  }));
  slot.querySelector('#fn-add-mid').addEventListener('click', () => {
    funnelState.middles.push(''); persistFunnel(); taRenderFunnel();
  });
  slot.querySelector('#fn-fill-ticket').addEventListener('click', () => fillOneFromTicket('funnel'));
  // The form was just rebuilt with the button disabled; getActiveContext()
  // is async so this resolves a moment later — same fire-and-forget pattern
  // as every other refreshXFillButton() call, just triggered from a render
  // instead of from init.
  refreshAllFillButtons();
}

function renderFunnelResults(el, run) {
  if (run.error && !(run.segments || []).length) {
    el.innerHTML = `<div style="color:var(--err);font-size:12px;padding:6px 0">${esc(run.error)}</div>`;
    return;
  }
  const rows = (run.segments || []).map(s => `<div style="font-size:11px;padding:3px 0;border-bottom:1px solid var(--stroke)">
    ${s.reached ? '✅' : '❌'} ${esc(shortUrl(s.from))} → ${esc(shortUrl(s.to))} <span style="color:var(--fg3)">(${s.steps} step${s.steps === 1 ? '' : 's'}${s.error ? ' · ' + esc(s.error) : ''})</span></div>`).join('');
  el.innerHTML = `<div style="font-weight:600;font-size:12px;margin-bottom:4px">${run.reachedEnd ? 'Reached End ✅' : 'Did not reach End ❌'}</div>${rows}`;
}

async function runFunnelCrawl() {
  const resultsEl = document.getElementById('fn-results');
  if (resultsEl) resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;padding:6px 0">Crawling funnel…</div>';
  const res = await chrome.runtime.sendMessage({ action: 'runFunnelCrawl', payload: { waypoints: funnelWaypoints(), supplementalPrompt: funnelState.supplementalPrompt, winId: WIN_ID } });
  _funnelLastRun = res?.ok
    ? { ts: Date.now(), segments: res.segments || [], reachedEnd: !!res.reachedEnd, error: res.error || null }
    : { ts: Date.now(), segments: [], reachedEnd: false, error: res?.error || 'Funnel crawl failed' };
  if (resultsEl) renderFunnelResults(resultsEl, _funnelLastRun);
}

function taMoveBodyHome(n) {
  const mode = TA_MODES[n];
  if (!mode || !mode.bodyId) return;   // funnel is Test-Agent-native; nothing to move home
  const home = document.getElementById(mode.homeParentId);
  const body = document.getElementById(mode.bodyId);
  if (home && body) home.appendChild(body);
}

function taShowPrimary() {
  const val = document.getElementById('ta-primary-select').value;
  if (_taActiveBody && _taActiveBody !== val) taMoveBodyHome(_taActiveBody);  // no-op for funnel

  const slot = document.getElementById('ta-settings-slot');
  const runBtn = document.getElementById('btn-ta-run');
  const testChk = document.getElementById('ta-agentic-testing');
  const analysisChk = document.getElementById('ta-agentic-analysis');

  // Leaving funnel: restore the agentic checkboxes to the user's prior state.
  if (val !== 'funnel' && _taCheckboxPrior) {
    testChk.checked = _taCheckboxPrior.testing; testChk.disabled = false;
    analysisChk.checked = _taCheckboxPrior.analysis; analysisChk.disabled = false;
    _taCheckboxPrior = null;
  }

  if (val === 'funnel') {
    // Funnel's engine IS the AI loop — force both agentic capabilities on and lock them.
    if (!_taCheckboxPrior) _taCheckboxPrior = { testing: testChk.checked, analysis: analysisChk.checked };
    testChk.checked = true;  testChk.disabled = true;
    analysisChk.checked = true; analysisChk.disabled = true;
    _taActiveBody = 'funnel';
    taRenderFunnel();
    syncFunnelRunEnabled();
  } else if (TA_MODES[val]) {
    slot.innerHTML = '';
    const mode = TA_MODES[val];
    // bodyId modes (WCAG/CVA/Perf) reparent their settings in; A/B has no
    // bodyId anymore (see TA_MODES['2']'s own comment) and renders a
    // pointer instead via renderSlot.
    if (mode.bodyId) slot.appendChild(document.getElementById(mode.bodyId));
    else if (mode.renderSlot) mode.renderSlot(slot);
    _taActiveBody = val;
    runBtn.disabled = false;
  } else {
    _taActiveBody = null;
    slot.innerHTML = '';
    runBtn.disabled = true;
  }
  taRenderMultiList();
}

function taRenderMultiList() {
  const card = document.getElementById('ta-multi-card');
  const list = document.getElementById('ta-multi-list');
  // Funnel is a heavy standalone operation — no "Also Run" batching for it.
  if (_taActiveBody === 'funnel') { card.style.display = 'none'; list.innerHTML = ''; taQueuedExtra.clear(); return; }
  const others = Object.keys(TA_MODES).filter(n => n !== _taActiveBody && n !== 'funnel');

  for (const n of [...taQueuedExtra]) if (!others.includes(n)) taQueuedExtra.delete(n);

  if (!_taActiveBody || !others.length) { card.style.display = 'none'; list.innerHTML = ''; return; }
  card.style.display = '';
  list.innerHTML = others.map(n => `
    <label class="suite-check">
      <input type="checkbox" class="ta-extra-chk" data-mode="${n}"${taQueuedExtra.has(n) ? ' checked' : ''}>
      ${esc(TA_MODES[n].label)}
    </label>`).join('');
}

// Sequential batch execution: primary mode + whichever "Also Run" modes are
// checked, in order — skip-if-unconfigured, collect each mode's result, and
// (if anything ran) compile a report.
async function runTestAgent() {
  const primary = _taActiveBody;
  if (!primary) return;

  const sequence = [primary, ...[...taQueuedExtra].filter(n => n !== primary)];
  _taStopRequested = false;
  const runBtn = document.getElementById('btn-ta-run');
  const stopBtn = document.getElementById('btn-ta-stop');
  const status = document.getElementById('ta-status');
  runBtn.disabled = true;
  stopBtn.style.display = '';

  const modeResults = [];
  try {
    for (const n of sequence) {
      const m = TA_MODES[n];
      const modeKey = /^\d+$/.test(n) ? +n : n;   // 'funnel' stays a string; numeric modes become numbers
      if (_taStopRequested) {
        modeResults.push({ mode: modeKey, name: m.label, status: 'skipped', reason: 'Stopped before this mode started.' });
        continue;
      }
      if (!m.isConfigured()) {
        const reason = n === 'funnel' ? 'Funnel Crawl needs a Start and End waypoint.' : 'Not configured.';
        modeResults.push({ mode: modeKey, name: m.label, status: 'skipped', reason });
        continue;
      }
      status.textContent = `Running ${m.label}…`;
      await m.run();
      modeResults.push({ mode: modeKey, name: m.label, status: 'ran', data: m.getData() });
    }

    const anyRan = modeResults.some(r => r.status === 'ran');
    if (anyRan) {
      const analysisEnabled = !!document.getElementById('ta-agentic-analysis')?.checked;
      let aiSectionHtml;
      if (analysisEnabled) {
        status.textContent = 'Generating AI summary…';
        // Grounds the summary in what the experiment was actually testing —
        // reference-only fields (summary/goals), never anything that drives
        // pass/fail itself.
        const activeCtx = await getActiveContext().catch(() => null);
        const ticketContext = activeCtx?.reviewed ? {
          ticketKey: activeCtx.ticketKey, experimentId: activeCtx.experimentId,
          summary: activeCtx.summary, goals: activeCtx.goals,
        } : null;
        const summaryRes = await chrome.runtime.sendMessage({ action: 'summarizeTestAgentResults', payload: { modeResults, ticketContext } });
        aiSectionHtml = rptAiSummarySection(summaryRes?.ok ? summaryRes.summary : null, summaryRes?.ok ? null : summaryRes?.error);
      } else {
        aiSectionHtml = rptAiSummarySection(null, 'Agentic Analysis is off — enable it in Test Controls for an AI-written summary.');
      }
      status.textContent = 'Done — report opened in a new tab.';
      await openReportTab({ ts: Date.now(), pageUrls: [], modes: modeResults, extraHtml: aiSectionHtml });
    } else {
      status.textContent = 'Done — nothing configured to run.';
    }
  } finally {
    runBtn.disabled = false;
    stopBtn.style.display = 'none';
  }
}

function stopTestAgent() {
  _taStopRequested = true;
  _abVisualDiffStopRequested = true;   // runAbComparison also runs as a Test Agent mode
  chrome.runtime.sendMessage({ action: 'stop' });
}

// Each Test Mode submenu carries its own list of page areas — the same layout
// and controls as the mandatory "Open URL" first step of the Build queue, but
// held per mode. Scope drives the list shape: Single shows just "Start Page";
// Multi shows "Start Page" … "End Page" with user-added pages in between.
const tmModes = {};   // { modeNum: { scope, pages: [step-like objects] } }

function tmNewPage(saved) {
  return {
    func: OPEN_URL_FUNC,
    enabled: saved?.enabled ?? true,
    delay: saved?.delay ?? '0',
    inputs: { url: '', qa_mode: false, params: [], ...(saved?.inputs || {}) },
  };
}

async function initTestModePages() {
  const { tmPagesState } = await sessionNS.get('tmPagesState');
  document.querySelectorAll('.tm-pages').forEach(cont => {
    const n = cont.dataset.mode;
    const saved = tmPagesState?.[n] || {};
    const mode = {
      scope: saved.scope === 'multi' ? 'multi' : 'single',
      pages: (saved.pages || []).map(tmNewPage),
    };
    if (!mode.pages.length) mode.pages.push(tmNewPage());
    tmModes[n] = mode;

    document.querySelectorAll(`input[name="tm-scope-${n}"]`).forEach(r => {
      r.checked = r.value === mode.scope;
      r.addEventListener('change', () => {
        if (!r.checked) return;
        mode.scope = r.value;
        renderTmPages(n);
        persistTmPages();
      });
    });

    document.querySelector(`.tm-add-page[data-mode="${n}"]`)?.addEventListener('click', () => {
      mode.pages.splice(mode.pages.length - 1, 0, tmNewPage());   // insert before End Page
      renderTmPages(n);
      persistTmPages();
    });

    renderTmPages(n);
  });
  // "Fill from ticket" binding + refresh for these buttons now lives in the
  // fill-target registry (initFillTargets), which runs later in the init
  // chain after abState/cvaState/mxState/funnelState are all hydrated too.
}

function renderTmPages(n) {
  const mode   = tmModes[n];
  const cont   = document.querySelector(`.tm-pages[data-mode="${n}"]`);
  const addBtn = document.querySelector(`.tm-add-page[data-mode="${n}"]`);
  if (!mode || !cont) return;

  const multi = mode.scope === 'multi';
  if (multi && mode.pages.length < 2) mode.pages.push(tmNewPage());
  const shown = multi ? mode.pages : mode.pages.slice(0, 1);
  if (addBtn) addBtn.style.display = multi ? '' : 'none';

  cont.innerHTML = '';
  shown.forEach((page, i) => {
    const isEnd = multi && i === shown.length - 1;
    const label = i === 0 ? 'Start Page' : isEnd ? 'End Page' : `Page ${i + 1}`;
    const removable = multi && i > 0 && !isEnd;
    // Start and End pages always run — no enable checkbox, and any persisted
    // disabled state is overridden.
    const fixed = i === 0 || isEnd;
    if (fixed) page.enabled = true;

    const el = document.createElement('div');
    el.className = 'step step-locked';
    el.innerHTML = `
      ${fixed ? '' : `
      <div class="step-ctrl">
        <input type="checkbox" class="en-chk"${page.enabled ? ' checked' : ''}>
      </div>`}
      <div class="step-main">
        <div class="step-fn-row">
          <span class="fn-locked">🔒 ${label}</span>
          ${removable ? '<button class="btn-icon tm-rm-page" style="color:var(--err)" title="Remove page">✕</button>' : ''}
        </div>
        <div class="step-args"></div>
        <div class="delay-row">
          <span class="arg-lbl">Delay (s)</span>
          <input type="text" class="delay-in" value="${esc(page.delay || '0')}">
        </div>
      </div>`;
    el.querySelector('.step-args').innerHTML = buildOpenUrlArgsHTML(page);
    wireArgs(el, page);

    el.querySelector('.en-chk')?.addEventListener('change', e => { page.enabled = e.target.checked; });
    el.querySelector('.delay-in').addEventListener('input', e => { page.delay = e.target.value; });
    el.querySelector('.tm-rm-page')?.addEventListener('click', () => {
      mode.pages.splice(i, 1);
      renderTmPages(n);
      persistTmPages();
    });

    // wireArgs/wireOpenUrlArgs already keep page.inputs current; these
    // delegated listeners just persist after any edit in the area.
    el.addEventListener('input', persistTmPages);
    el.addEventListener('change', persistTmPages);
    el.addEventListener('click', e => {
      if (e.target.closest('.add-open-url-param, .rm-open-url-param')) persistTmPages();
    });

    cont.appendChild(el);
  });
}

function persistTmPages() {
  const state = {};
  for (const [n, m] of Object.entries(tmModes)) {
    state[n] = {
      scope: m.scope,
      pages: m.pages.map(p => ({ enabled: p.enabled, delay: p.delay, inputs: p.inputs })),
    };
  }
  sessionNS.set({ tmPagesState: state });
}

// ── Accordions ────────────────────────────────────────────────────────────
function toggleAccordion(id) {
  document.getElementById(id)?.classList.toggle('open');
}

function openAccordion(id) {
  document.getElementById(id)?.classList.add('open');
}

function initAccordions() {
  document.querySelectorAll('.acc-hdr[data-acc]').forEach(hdr => {
    hdr.addEventListener('click', () => toggleAccordion(hdr.dataset.acc));
  });
}

// ── Run state sync ────────────────────────────────────────────────────────
async function syncRunState() {
  const { running } = await sessionNS.get('running');
  document.getElementById('btn-run').disabled  = !!running;
  document.getElementById('btn-stop').disabled = !running;
  document.getElementById('run-indicator').style.display = running ? 'inline-block' : 'none';

  if (running && !_wasRunning) {
    // Test just started — reset log view (capture itself is automatic now,
    // background already points it at the run's tab).
    logData = [];
    document.getElementById('log-out').innerHTML = '';
  }
  _wasRunning = !!running;
}

// ── Log sync ──────────────────────────────────────────────────────────────
async function syncLogs() {
  const { logs = [] } = await sessionNS.get('logs');
  if (logs.length > logData.length) {
    logData = logs;
    renderLog();
  }
}

function renderLog() {
  const needle = (document.getElementById('filter-input')?.value || '').trim().toLowerCase();
  const out = document.getElementById('log-out');
  if (!out) return;
  const atBottom = out.scrollHeight - out.scrollTop <= out.clientHeight + 4;
  out.innerHTML = logData
    .filter(e => (!filterLevel || e.level === filterLevel) && (!needle || e.text.toLowerCase().includes(needle)))
    .map(e => `<div class="log-${e.level}">[${e.ts}] [${e.level}] ${esc(e.text)}</div>`)
    .join('');
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function esc(s) {
  // String(s ?? '') guards against non-string input (e.g. a migrated metric
  // entry's field going missing) — a throw here happens inside loadMetrics(),
  // which boots outside a try/catch, and would silently kill every listener
  // binding still to come in DOMContentLoaded.
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function setFilter(lv, btn) {
  filterLevel = lv;
  document.querySelectorAll('#filter-btns .btn-icon').forEach(b => {
    b.style.background = '';
    b.style.color = '';
  });
  btn.style.background = 'var(--brand)';
  btn.style.color = '#fff';
  renderLog();
}

// ── Browser Console (genuine live mirror, via chrome.debugger/CDP) ──────────
// Kept as a fully separate data stream/render cycle from the Test Results log
// above, so the two panels never clobber each other and update independently.
async function syncBcLogs() {
  const { browserConsoleLogs = [] } = await sessionNS.get('browserConsoleLogs');
  if (browserConsoleLogs.length !== bcLogData.length) {
    bcLogData = browserConsoleLogs;
    renderBcLog();
  }
}

function renderBcLog() {
  const needle = (document.getElementById('bc-filter-input')?.value || '').trim().toLowerCase();
  const out = document.getElementById('bc-log-out');
  if (!out) return;
  const atBottom = out.scrollHeight - out.scrollTop <= out.clientHeight + 4;
  out.innerHTML = bcLogData
    .filter(e => (!bcFilterLevel || e.level === bcFilterLevel)
              && (!needle || e.text.toLowerCase().includes(needle))
              && (!bcTagOnly || e.tagged))
    .map(e => {
      const badge  = e.level === 'CMD' ? '&gt;' : (e.source === 'eval-result' ? '&#8626;' : e.level);
      const toggle = e.expandable ? `<button class="bc-expand-toggle" data-object-id="${e.objectId}">&#9656;</button>` : '';
      const { tag, rest } = splitBcTag(e.text);
      const tagHtml = tag ? `<span class="bc-tag">${esc(tag)}</span>` : '';
      return `<div class="bc-entry bc-${e.level}">
        <span class="bc-ts">${e.ts}</span>
        <span class="bc-badge">${badge}</span>
        ${toggle}
        ${tagHtml}
        <span class="bc-text">${esc(rest)}</span>
      </div>`;
    })
    .join('');
  if (atBottom) out.scrollTop = out.scrollHeight;
}

// Pulls a leading "[tag] " prefix (e.g. "[javascript]", "[network]", "[PJS]",
// "[cro]") off a log line's text so it renders as its own label instead of
// being embedded in the message text.
function splitBcTag(text) {
  const m = /^\[([^\]]+)\]\s*(.*)$/s.exec(text);
  return m ? { tag: m[1], rest: m[2] } : { tag: null, rest: text };
}

// Lazily expands object/array values via Runtime.getProperties (bcExpand).
// Delegated on #bc-log-out so it survives re-renders without re-binding.
// Note: a full renderBcLog() re-render (triggered by a *new* log line arriving)
// rebuilds innerHTML from bcLogData and does not preserve expanded state.
async function onBcLogClick(e) {
  const btn = e.target.closest('.bc-expand-toggle');
  if (!btn) return;
  const objectId = btn.dataset.objectId;
  // Nested (tiered) toggles live inside .bc-child-row, not .bc-entry — match
  // either so drilling into a second/third level of nesting works the same
  // way as the top level.
  const entryRow = btn.closest('.bc-entry, .bc-child-row');
  if (!entryRow) return;
  const existing = entryRow.nextElementSibling;
  if (existing && existing.classList.contains('bc-children') && existing.dataset.parentFor === objectId) {
    const nowHidden = existing.style.display === 'none';
    existing.style.display = nowHidden ? '' : 'none';
    btn.classList.toggle('bc-expanded', nowHidden);
    return;
  }
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ action: 'bcExpand', objectId, winId: WIN_ID });
  btn.disabled = false;
  const container = document.createElement('div');
  container.className = 'bc-children';
  container.dataset.parentFor = objectId;
  if (!res?.ok) {
    container.innerHTML = `<div class="bc-child-row" style="color:var(--err)">${esc(res?.error || 'Could not expand')}</div>`;
  } else {
    btn.classList.add('bc-expanded');
    container.innerHTML = res.props.map(p => {
      const childToggle = p.expandable
        ? `<button class="bc-expand-toggle" data-object-id="${p.objectId}">&#9656;</button>`
        : '';
      return `<div class="bc-child-row">
        ${childToggle}
        <span class="bc-key">${esc(p.name)}:</span>
        <span class="bc-text">${esc(p.text)}</span>
      </div>`;
    }).join('') || '<div class="bc-child-row">(no own properties)</div>';
  }
  entryRow.insertAdjacentElement('afterend', container);
}

async function loadBcTagFilter() {
  const { bcTagFilterEnabled = false } = await chrome.storage.local.get('bcTagFilterEnabled');
  bcTagOnly = bcTagFilterEnabled;
  const chk = document.getElementById('bc-tag-filter-enabled');
  if (chk) chk.checked = bcTagOnly;
  renderBcLog();
}

async function onBcTagFilterToggle() {
  bcTagOnly = document.getElementById('bc-tag-filter-enabled').checked;
  await chrome.storage.local.set({ bcTagFilterEnabled: bcTagOnly });
  renderBcLog();
}

function setBcFilter(lv, btn) {
  bcFilterLevel = lv;
  document.querySelectorAll('#bc-filter-btns .btn-icon').forEach(b => {
    b.style.background = '';
    b.style.color = '';
  });
  btn.style.background = 'var(--brand)';
  btn.style.color = '#fff';
  renderBcLog();
}

async function clearBcLog() {
  bcLogData = [];
  await sessionNS.set({ browserConsoleLogs: [] });
  document.getElementById('bc-log-out').innerHTML = '';
}

// ── Metrics (Metric Tracker tab, read by Track Metric queue steps) ──────────
// User-entered metric values — the strings that fire in the browser output,
// typically prefixed [PJS] or [cro] (the same values the Console tab's CRO
// toggle surfaces). Stored in storage.local as `metricsList`. This array is
// consumed by two surfaces: the Metric Tracker tab (editing + live fire
// counting) and Track Metric queue steps (post-hoc assertion) — so every
// entry is now an object, not a bare string. See normalizeMetricsList in
// metric-match.js for the shape and the migration from the old string[] shape.
async function loadMetrics() {
  const { metricsList = [] } = await chrome.storage.local.get('metricsList');
  const normalized = normalizeMetricsList(metricsList);
  metrics = normalized;
  // One-time upgrade only — writing back unconditionally would have every
  // open panel ping-pong the write through storage.onChanged forever.
  if (JSON.stringify(metricsList) !== JSON.stringify(normalized)) persistMetrics();
  mtRenderRows();
  // The queue is restored before this runs — give any restored Track Metric
  // steps their dropdown options now that the list is in memory.
  refreshTrackMetricSteps();
}

// Deliberately fire-and-forget (no await on the storage.local.set) — that is
// what lets a synchronous caller (e.g. the Initialize fill target's apply(),
// which the registry contract requires to stay synchronous) call this and
// return without ever becoming async itself.
function persistMetrics() {
  chrome.storage.local.set({ metricsList: metrics });
}

// Every mutation to `metrics` must fan out to the Tracker tab's renderer plus
// the queue's Track Metric dropdowns, or one surface goes stale until reload.
// `skip` is 'mt' when the Tracker's own DOM was just interacted with directly
// (typing mid-keystroke), so its rebuild is skipped to avoid stealing focus.
function mtSyncAfterListChange(skip) {
  persistMetrics();
  refreshTrackMetricSteps();
  if (skip !== 'mt') mtRenderRows();
}

// Edited (or migrated) in another window — refresh the Tracker's rows and the
// queue dropdowns, but never write back from here. Mirrors the fill-target
// registry's invariant: a storage event may only update what's shown, never
// trigger a write of its own.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.metricsList) return;
  metrics = normalizeMetricsList(changes.metricsList.newValue || []);
  mtRenderRows();
  refreshTrackMetricSteps();
});

async function syncBcStatus() {
  const { debuggerStatus } = await sessionNS.get('debuggerStatus');
  const attached = !!debuggerStatus?.attached;
  const input = document.getElementById('bc-eval-input');
  if (input) {
    input.disabled = !attached;
    input.placeholder = attached ? '> Type a JS expression and press Enter…' : '> Not attached';
  }
  const el = document.getElementById('bc-status');
  const reconnectBtn = document.getElementById('btn-bc-reconnect');
  if (!el) return;
  if (attached) {
    el.textContent = '● Live — mirroring the captured tab';
    el.style.color = 'var(--brand)';
    if (reconnectBtn) reconnectBtn.style.display = 'none';
  } else if (debuggerStatus?.error) {
    el.textContent = `○ Not attached — ${debuggerStatus.error}`;
    el.style.color = 'var(--err)';
    if (reconnectBtn) reconnectBtn.style.display = '';
  } else {
    el.textContent = '○ Not attached — waiting for a capturable tab';
    el.style.color = 'var(--fg3)';
    if (reconnectBtn) reconnectBtn.style.display = 'none';
  }
}

// Manual retry when the CDP feed drops — background's onDetach handler
// deliberately doesn't auto-retry, so this is the only way back short of
// switching tabs away and back onto the captured one.
async function reconnectBcFeed() {
  const btn = document.getElementById('btn-bc-reconnect');
  if (btn) btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'reconnectCapture', winId: WIN_ID });
    await syncBcStatus();
    await syncCaptureStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Reflects background's passive follow-active-tab capture state (see
// followTab/doFollow in background.js) — read-only, since target selection is
// now automatic rather than a manual dropdown.
async function syncCaptureStatus() {
  const { captureStatus } = await sessionNS.get('captureStatus');
  const el = document.getElementById('capture-status-label');
  if (!el) return;
  if (!captureStatus) { el.textContent = 'Not capturing'; return; }
  const label = captureStatus.title || captureStatus.url || `tab ${captureStatus.tabId}`;
  el.textContent = captureStatus.capturable === false
    ? `Not capturable: ${label}`
    : `Capturing: ${label}`;
}

// ── Browser Console eval REPL (Runtime.evaluate over CDP) ───────────────────
let bcEvalHistory = [];
let bcEvalHistoryIdx = -1;

async function sendBcEval() {
  const input = document.getElementById('bc-eval-input');
  const expr = input.value.trim();
  if (!expr) return;
  bcEvalHistory.push(expr);
  bcEvalHistoryIdx = bcEvalHistory.length;
  input.value = '';
  await chrome.runtime.sendMessage({ action: 'bcEval', expression: expr, winId: WIN_ID });
  await syncBcLogs();
}

function onBcEvalKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendBcEval();
  } else if (e.key === 'ArrowUp' && bcEvalHistory.length) {
    e.preventDefault();
    bcEvalHistoryIdx = Math.max(0, bcEvalHistoryIdx - 1);
    e.target.value = bcEvalHistory[bcEvalHistoryIdx] || '';
  } else if (e.key === 'ArrowDown' && bcEvalHistory.length) {
    e.preventDefault();
    bcEvalHistoryIdx = Math.min(bcEvalHistory.length, bcEvalHistoryIdx + 1);
    e.target.value = bcEvalHistory[bcEvalHistoryIdx] || '';
  }
}

function showConsoleSubtab(name) {
  document.querySelectorAll('.console-subtab').forEach(b => {
    const active = b.dataset.subtab === name;
    b.style.background = active ? 'var(--brand)' : '';
    b.style.color = active ? '#fff' : '';
  });
  document.getElementById('subpanel-test-results')?.classList.toggle('active', name === 'test-results');
  document.getElementById('subpanel-browser-console')?.classList.toggle('active', name === 'browser-console');
}

// ── Console capture ───────────────────────────────────────────────────────
// Capture is passive — background follows whatever tab is focused in this
// window automatically. This toggle only pauses/resumes it; there's no target
// to pick, so failures (non-capturable page, DevTools already open, etc.) are
// reflected in the read-only status label/bc-status, not surfaced as alerts.
async function restoreCaptureState() {
  const { captureEnabled } = await sessionNS.get('captureEnabled');
  const chk = document.getElementById('capture-enabled');
  if (chk) chk.checked = captureEnabled !== false;
}

async function onCaptureToggle() {
  const enabled = document.getElementById('capture-enabled').checked;
  await chrome.runtime.sendMessage({ action: enabled ? 'startCapture' : 'stopCapture', winId: WIN_ID });
  await syncBcStatus();
  await syncCaptureStatus();
}

async function clearLog() {
  logData = [];
  logOffset = 0;
  await sessionNS.set({ logs: [] });
  document.getElementById('log-out').innerHTML = '';
}

// ── Universal Delay ───────────────────────────────────────────────────────
function setUniversalDelayUI(enabled) {
  const row = document.getElementById('udel-row');
  if (!row) return;
  row.style.opacity       = enabled ? '1'    : '.4';
  row.style.pointerEvents = enabled ? 'auto' : 'none';
}

async function loadUniversalDelay() {
  const { universalDelay = { enabled: false, seconds: '1' } } =
    await chrome.storage.local.get('universalDelay');
  const chk = document.getElementById('udel-enabled');
  const inp = document.getElementById('udel-seconds');
  if (!chk) return;
  chk.checked = universalDelay.enabled;
  inp.value   = universalDelay.seconds;
  setUniversalDelayUI(universalDelay.enabled);
}

async function saveUniversalDelay() {
  const chk     = document.getElementById('udel-enabled');
  const inp     = document.getElementById('udel-seconds');
  const enabled = chk.checked;
  setUniversalDelayUI(enabled);
  await chrome.storage.local.set({
    universalDelay: { enabled, seconds: inp.value || '1' }
  });
}

async function loadQueueMetricsTracking() {
  const { queueMetricsTracking = false } = await chrome.storage.local.get('queueMetricsTracking');
  const chk = document.getElementById('qmt-enabled');
  if (chk) chk.checked = queueMetricsTracking;
}

async function saveQueueMetricsTracking() {
  await chrome.storage.local.set({
    queueMetricsTracking: document.getElementById('qmt-enabled').checked
  });
}

// ── Target info (execution mode + tab target) ───────────────────────────────
// The target URL and its parameters now live on the mandatory leading
// "Open URL" queue step (see OPEN_URL_FUNC below) rather than here.
// Snapshot the current Target accordion so it can be persisted with a script.
function collectTarget() {
  return {
    mode:      document.querySelector('input[name=mode]:checked')?.value || 'close',
    tabTarget: document.querySelector('input[name=tabtarget]:checked')?.value || 'active',
  };
}

// Restore a saved target snapshot back into the Target accordion.
function applyTarget(target) {
  if (!target) return;
  if (target.mode) {
    const m = document.querySelector(`input[name=mode][value="${target.mode}"]`);
    if (m) m.checked = true;
  }
  if (target.tabTarget) {
    const t = document.querySelector(`input[name=tabtarget][value="${target.tabTarget}"]`);
    if (t) t.checked = true;
  }
}

// Saved scripts are stored either as a bare step array (legacy format) or as
// { steps, target } (current format). These normalize access across both.
function scriptSteps(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.steps)) return data.steps;
  return [];
}
function scriptTarget(data) {
  return (data && !Array.isArray(data) && data.target) ? data.target : null;
}

// ── Run / Stop ────────────────────────────────────────────────────────────
async function runQueue() {
  const mode       = document.querySelector('input[name=mode]:checked').value;
  const tabTarget  = document.querySelector('input[name=tabtarget]:checked').value;

  // Get the active tab id if needed
  let targetTabId = null;
  if (tabTarget === 'active') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tab?.id || null;
  }

  const queue = steps.map(s => ({
    func: s.func, enabled: s.enabled, delay: s.delay, inputs: { ...s.inputs }
  }));

  const { universalDelay = { enabled: false, seconds: '1' } } =
    await chrome.storage.local.get('universalDelay');
  const { queueMetricsTracking = false } =
    await chrome.storage.local.get('queueMetricsTracking');

  await chrome.runtime.sendMessage({
    action: 'run',
    payload: { queue, mode, targetTabId, universalDelay, winId: WIN_ID, trackMetricsForRun: queueMetricsTracking }
  });

  showTab('console');
  syncRunState();
}

async function stopQueue() {
  await chrome.runtime.sendMessage({ action: 'stop' });
}

// ── Scripts ───────────────────────────────────────────────────────────────
async function refreshScripts() {
  const { scripts = {} } = await chrome.storage.local.get('scripts');
  const names = Object.keys(scripts).sort();
  const sel = document.getElementById('script-select');
  sel.innerHTML = names.length
    ? names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : '<option disabled>&lt;no scripts&gt;</option>';
}

// The single script name currently selected in the list, or '' if none.
function getSelectedScriptName() {
  const sel = document.getElementById('script-select');
  return sel.value || '';
}

async function saveScript() {
  const name = document.getElementById('save-name').value.trim();
  if (!name) { alert('Enter a script name.'); return; }
  const { scripts = {} } = await chrome.storage.local.get('scripts');
  scripts[name] = {
    steps: steps.map(s => ({
      func: s.func, enabled: s.enabled, delay: s.delay, inputs: { ...s.inputs },
      groupId: s.groupId || null, groupName: s.groupName || null,
    })),
    target: collectTarget(),
  };
  await chrome.storage.local.set({ scripts });
  await refreshScripts();
  document.getElementById('save-name').value = '';
  alert(`"${name}" saved.`);
}

// Append the selected script to the end of the current queue.
async function appendScripts() {
  const name = getSelectedScriptName();
  if (!name) { alert('Select a saved script first.'); return; }
  const { scripts = {} } = await chrome.storage.local.get('scripts');
  // Remap group ids so the appended script's groups never collide with (and
  // silently merge into) a group already present in the current queue.
  const stepArr = remapGroupIds(scriptSteps(scripts[name]));
  if (!stepArr.length) { alert('The selected script had no steps.'); return; }
  stepArr.forEach(s => addStep(s));
  renderGroups();
  openAccordion('acc-queue');
}

// Replace the current queue with the selected script.
async function loadScript() {
  const name = getSelectedScriptName();
  if (!name) { alert('Select a saved script first.'); return; }
  const { scripts = {} } = await chrome.storage.local.get('scripts');
  document.getElementById('step-list').innerHTML =
    '<div id="empty-msg">No steps yet — click + Add Step to begin</div>';
  steps = [];
  nextId = 1;
  nextGroupId = 1; // full replace — no prior groups to collide with
  const rest = [...scriptSteps(scripts[name])];
  const firstData = (rest[0]?.func === OPEN_URL_FUNC) ? rest.shift() : null;
  ensureOpenUrlFirst(firstData);
  rest.forEach(s => addStep(s));
  // Restore Target info saved with the script, if any.
  applyTarget(scriptTarget(scripts[name]));
  renderGroups();
  persistQueue();
  openAccordion('acc-queue');
}

async function deleteScript() {
  const name = getSelectedScriptName();
  if (!name) return;
  if (!confirm(`Delete "${name}"?`)) return;
  const { scripts = {} } = await chrome.storage.local.get('scripts');
  delete scripts[name];
  await chrome.storage.local.set({ scripts });
  await refreshScripts();
}

// ── Queue steps ───────────────────────────────────────────────────────────
// opts.locked marks the mandatory leading "Open URL" step — it cannot be
// removed, reassigned to another function, or moved out of position 0.
function addStep(data, opts = {}) {
  const locked = !!opts.locked;
  const fnNames = Object.keys(FN_META).sort((a, b) =>
    (FN_META[a].label || a).localeCompare(FN_META[b].label || b)
  );
  const id   = nextId++;
  const func = locked ? OPEN_URL_FUNC : (data?.func || fnNames[0]);
  const step = {
    id,
    enabled: data?.enabled ?? true,
    func,
    delay:  data?.delay ?? '0',
    inputs: { ...(data?.inputs || {}) },
    locked,
    groupId:   data?.groupId   ?? null,
    groupName: data?.groupName ?? null,
  };
  steps.push(step);

  const el = document.createElement('div');
  el.className = 'step' + (locked ? ' step-locked' : '');
  el.id = 'step-' + id;
  el.innerHTML = buildStepHTML(step, fnNames);
  document.getElementById('step-list').appendChild(el);

  // Wire events
  if (!locked) {
    el.querySelector('.fn-select').addEventListener('change', e => {
      step.func = e.target.value;
      step.inputs = {};
      el.querySelector('.step-args').innerHTML = buildArgsHTML(step);
      el.querySelector('.step-tooltip-slot').innerHTML = buildTooltipHTML(step.func);
      wireArgs(el, step);
      persistQueue();
    });
    el.querySelector('.rm-btn').addEventListener('click', () => removeStep(id));
    el.querySelector('.up-btn').addEventListener('click', () => moveStep(id, -1));
    el.querySelector('.dn-btn').addEventListener('click', () => moveStep(id, 1));
    el.querySelector('.dup-btn').addEventListener('click', () => duplicateStep(id));
    el.querySelector('.grp-chk').addEventListener('change', updateGroupSelectionUI);
  }
  el.querySelector('.en-chk').addEventListener('change', e => {
    step.enabled = e.target.checked;
    persistQueue();
  });
  el.querySelector('.delay-in').addEventListener('input', e => {
    step.delay = e.target.value;
    persistQueue();
  });
  wireArgs(el, step);

  updateCount();
  persistQueue();
  return step;
}

// Guarantee the queue's first step is the locked "Open URL" step, seeding it
// with previously-saved data (if any). Must be called before any other
// addStep() calls populate the (currently empty) queue.
function ensureOpenUrlFirst(data) {
  return addStep(data, { locked: true });
}

function buildTooltipHTML(func) {
  const doc = FN_META[func]?.doc || '';
  if (!doc) return '';
  return `<span class="tooltip-wrap">
    <span class="tooltip-icon">ⓘ</span>
    <span class="tooltip-box">${esc(doc)}</span>
  </span>`;
}

function buildStepHTML(step, fnNames) {
  const locked = !!step.locked;

  const fnControl = locked
    ? `<span class="fn-locked" title="This step always runs first and can't be removed">🔒 ${esc(FN_META[step.func]?.label || step.func)}</span>`
    : `<select class="fn-select">${fnNames
        .map(n => `<option value="${n}"${n === step.func ? ' selected' : ''}>${FN_META[n]?.label || n}</option>`)
        .join('')}</select>`;

  const moveButtons = locked ? '' : `
      <button class="btn-icon up-btn" title="Move up">↑</button>
      <button class="btn-icon dn-btn" title="Move down">↓</button>`;

  const dupButton = locked ? '' : `<button class="btn-icon dup-btn" title="Duplicate">⧉</button>`;
  const rmButton  = locked ? '' : `<button class="btn-icon rm-btn" style="color:var(--err)" title="Remove">✕</button>`;
  const grpChk    = locked ? '' : `<input type="checkbox" class="grp-chk" title="Select for grouping">`;

  return `
    <div class="step-ctrl">
      <input type="checkbox" class="en-chk"${step.enabled ? ' checked' : ''}>${moveButtons}${grpChk}
    </div>
    <div class="step-main">
      <div class="step-fn-row">
        ${fnControl}
        <span class="step-tooltip-slot">${buildTooltipHTML(step.func)}</span>
        ${dupButton}
        ${rmButton}
      </div>
      <div class="step-args">${buildArgsHTML(step)}</div>
      <div class="delay-row">
        <span class="arg-lbl">Delay (s)</span>
        <input type="text" class="delay-in" value="${step.delay || 0}">
      </div>
    </div>`;
}

// Args that benefit from the element picker
const PICKER_ARGS = new Set(['css', 'element_id', 'css_selector', 'xpath']);

// Method options for consolidated click/fill functions
const CLICK_METHODS = [
  { value: 'css',       label: 'CSS Selector', doc: 'Finds the element using a CSS selector string, e.g. `.btn-primary` or `#submit-btn`. Use the 🎯 picker to generate one automatically.' },
  { value: 'id',        label: 'ID',           doc: 'Finds the element by its `id` attribute — the fastest and most reliable method when an id is present.' },
  { value: 'name',      label: 'Name',         doc: 'Finds the element by its `name` attribute — commonly used on form inputs and buttons.' },
  { value: 'xpath',     label: 'XPath',        doc: 'Finds the element using an XPath expression — powerful and flexible, but more verbose than CSS.' },
  { value: 'link_text', label: 'Link Text',    doc: 'Finds an <a> link whose visible text exactly matches the value you enter.' },
];

const FILL_METHODS = [
  { value: 'css',   label: 'CSS Selector', doc: 'Finds the input using a CSS selector string, e.g. `input[name="email"]`. Use the 🎯 picker to generate one automatically.' },
  { value: 'id',    label: 'ID',           doc: 'Finds the input by its `id` attribute — the fastest and most reliable method when an id is present.' },
  { value: 'name',  label: 'Name',         doc: 'Finds the input by its `name` attribute — the most common way to target form fields.' },
  { value: 'xpath', label: 'XPath',        doc: 'Finds the input using an XPath expression — useful when no id or name is available.' },
];

const SUBMIT_METHODS = [
  { value: 'css',   label: 'CSS Selector', doc: 'Finds any element inside the form using a CSS selector, then submits that form.' },
  { value: 'id',    label: 'ID',           doc: 'Finds an element by its `id` inside the target form, then submits that form.' },
  { value: 'xpath', label: 'XPath',        doc: 'Finds an element using XPath inside the target form, then submits that form.' },
];

const SWITCH_TARGETS = [
  { value: 'frame',  label: 'Frame (by Name)',  hasValue: true,  doc: 'Switches the scripting context into an iframe identified by its name or id attribute.' },
  { value: 'main',   label: 'Main Page',         hasValue: false, doc: 'Returns to the top-level page context, exiting any active iframe.' },
  { value: 'parent', label: 'Parent Frame',      hasValue: false, doc: 'Moves up one level from a nested iframe to its parent frame.' },
  { value: 'window', label: 'Window (by Title)', hasValue: true,  doc: 'Switches focus to a different browser tab or window whose title matches the value.' },
];

const ALERT_ACTIONS = [
  { value: 'accept',   label: 'Accept (OK)',      doc: 'Clicks the OK button on a JavaScript alert, confirm, or prompt dialog.' },
  { value: 'dismiss',  label: 'Dismiss (Cancel)', doc: 'Clicks the Cancel button on a JavaScript confirm or prompt dialog.' },
  { value: 'get_text', label: 'Get Text',         doc: 'Logs the message text from the current alert dialog to the console.' },
];

// Build a tooltip for a sub-option select based on the currently selected value
function buildSubTooltipHTML(options, currentValue) {
  const opt = options.find(o => o.value === currentValue) || options[0];
  if (!opt?.doc) return '';
  return `<span class="tooltip-wrap">
    <span class="tooltip-icon">ⓘ</span>
    <span class="tooltip-box">${esc(opt.doc)}</span>
  </span>`;
}

function buildMethodArgsHTML(step, methods, hasText) {
  const method   = step.inputs.method   || methods[0].value;
  const selector = step.inputs.selector || '';
  const methodOpts = methods.map(m =>
    `<option value="${m.value}"${m.value === method ? ' selected' : ''}>${m.label}</option>`
  ).join('');
  const textRow = hasText ? `
    <div class="arg-row">
      <span class="arg-lbl">Text</span>
      <input type="text" data-arg="text" value="${esc(step.inputs.text || '')}">
    </div>` : '';
  return `
    <div class="arg-row">
      <span class="arg-lbl">Method</span>
      <select data-arg="method" class="method-select">${methodOpts}</select>
      <span class="sub-tooltip-slot">${buildSubTooltipHTML(methods, method)}</span>
    </div>
    <div class="arg-row">
      <span class="arg-lbl">Value</span>
      <input type="text" data-arg="selector" value="${esc(selector)}">
      <button class="btn-pick" data-pick-arg="selector" title="Pick element from page">&#x1F3AF;</button>
    </div>${textRow}`;
}

function buildSwitchArgsHTML(step) {
  const target     = step.inputs.target || 'frame';
  const value      = step.inputs.value  || '';
  const targetInfo = SWITCH_TARGETS.find(t => t.value === target) || SWITCH_TARGETS[0];
  const targetOpts = SWITCH_TARGETS.map(t =>
    `<option value="${t.value}"${t.value === target ? ' selected' : ''}>${t.label}</option>`
  ).join('');
  return `
    <div class="arg-row">
      <span class="arg-lbl">Target</span>
      <select data-arg="target" class="method-select">${targetOpts}</select>
      <span class="sub-tooltip-slot">${buildSubTooltipHTML(SWITCH_TARGETS, target)}</span>
    </div>
    <div class="arg-row switch-value-row" style="display:${targetInfo.hasValue ? 'flex' : 'none'}">
      <span class="arg-lbl">Name / Title</span>
      <input type="text" data-arg="value" value="${esc(value)}">
    </div>`;
}

function buildAlertArgsHTML(step) {
  const action     = step.inputs.action || 'accept';
  const actionOpts = ALERT_ACTIONS.map(a =>
    `<option value="${a.value}"${a.value === action ? ' selected' : ''}>${a.label}</option>`
  ).join('');
  return `
    <div class="arg-row">
      <span class="arg-lbl">Action</span>
      <select data-arg="action" class="method-select">${actionOpts}</select>
      <span class="sub-tooltip-slot">${buildSubTooltipHTML(ALERT_ACTIONS, action)}</span>
    </div>`;
}

// The mandatory leading step: URL to open first + its URL parameters.
// These previously lived in the Target accordion; they now travel with the
// queue (and with saved scripts) as this step's inputs.
function buildOpenUrlArgsHTML(step) {
  if (!Array.isArray(step.inputs.params)) {
    step.inputs.params = step.inputs.params ? [step.inputs.params] : [];
  }
  const params = step.inputs.params.length ? step.inputs.params : [''];
  const rows = params.map((v, i) => `
    <div class="arg-row open-url-param-row">
      <span class="arg-lbl">${i === 0 ? 'Params' : ''}</span>
      <input type="text" class="open-url-param-input" data-idx="${i}" placeholder="key=value" value="${esc(v)}">
      <button class="btn-icon rm-open-url-param" data-idx="${i}" title="Remove" style="color:var(--err)">✕</button>
    </div>`).join('');
  return `
    <div class="arg-row">
      <span class="arg-lbl">URL</span>
      <input type="text" data-arg="url" value="${esc(step.inputs.url || '')}" placeholder="https://example.com (optional — leave blank to use active tab)">
    </div>
    <div class="arg-row">
      <span class="arg-lbl">QA Mode</span>
      <label class="toggle-wrap" title="Append cro_mode=qa as a parameter on the executed URL">
        <input type="checkbox" class="qa-mode-chk"${step.inputs.qa_mode ? ' checked' : ''}>
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    </div>
    <div class="open-url-params">${rows}</div>
    <button class="btn ghost sm add-open-url-param" type="button" style="align-self:flex-start;margin:4px 0 0;padding:3px 8px;font-size:12px">+ Add parameter</button>`;
}

// Dropdown of the user-defined metric values from the Tracker tab. A value
// saved on the step but since removed from the list is kept selectable so the
// step still shows (and runs with) what it was configured to track.
function buildTrackMetricArgsHTML(step) {
  // Goal-derived entries nobody has reviewed are NOT offered here — the
  // Metric Tracker still counts them (observation is safe), but asserting on
  // one is a claim only a human confirming it as a real console signal
  // should be able to make.
  const usable = metrics.filter(m =>
    m.enabled !== false &&
    (m.pattern || '').trim() &&
    !(m.source === 'goal' && m.reviewed === false));
  const pendingGoals = metrics.filter(m =>
    m.source === 'goal' && m.reviewed === false && (m.pattern || '').trim()).length;

  // Silent upgrade: a step saved before the Tracker carries only the legacy
  // `metric` string. Resolve it to an id once, here, on first render.
  const raw = (step.inputs.metric || '').trim();
  if (!step.inputs.metricId && raw) {
    const hit = metrics.find(m => (m.pattern || '').trim() === raw);
    if (hit) step.inputs.metricId = hit.id;
  }

  // An id (or raw string) no longer in the list stays selectable, so the
  // step still shows — and still runs — what it was configured to track.
  const orphan = step.inputs.metricId && !usable.some(m => m.id === step.inputs.metricId);

  if (!usable.length && !orphan && !raw) {
    return '<div class="no-args">No metrics defined — add one in the Tracker tab first</div>'
      + (pendingGoals ? `<div class="no-args">${pendingGoals} goal-derived metric(s) are awaiting review.</div>` : '');
  }
  if (!step.inputs.metricId && usable.length) {
    step.inputs.metricId = usable[0].id;
    step.inputs.metric   = usable[0].pattern;
  }

  const opts = [
    ...((orphan || (raw && !step.inputs.metricId))
      ? [`<option value="${esc(step.inputs.metricId || '')}" selected>${esc(raw || '(removed metric)')} — not in the list</option>`]
      : []),
    ...usable.map(m => {
      const name = esc(m.label || m.pattern).replace(/"/g, '&quot;');
      return `<option value="${esc(m.id)}"${m.id === step.inputs.metricId ? ' selected' : ''}>${name} · ${m.mode}</option>`;
    }),
  ].join('');

  return `
    <div class="arg-row">
      <span class="arg-lbl">Metric</span>
      <select data-arg="metricId" class="method-select">${opts}</select>
    </div>`
    + (pendingGoals ? `<div class="no-args">${pendingGoals} goal-derived metric(s) hidden until reviewed — confirm them in the Tracker tab.</div>` : '');
}

// Rebuild every Track Metric step's dropdown so it reflects the current
// Metrics list — called whenever that list changes.
function refreshTrackMetricSteps() {
  for (const step of steps) {
    if (step.func !== 'track_metric') continue;
    const el = document.getElementById('step-' + step.id);
    if (el) rerenderStepArgs(el, step);
  }
}

function buildArgsHTML(step) {
  if (step.func === 'click')          return buildMethodArgsHTML(step, CLICK_METHODS,  false);
  if (step.func === 'fill')           return buildMethodArgsHTML(step, FILL_METHODS,   true);
  if (step.func === 'submit')         return buildMethodArgsHTML(step, SUBMIT_METHODS, false);
  if (step.func === 'switch_to')      return buildSwitchArgsHTML(step);
  if (step.func === 'alert')          return buildAlertArgsHTML(step);
  if (step.func === 'track_metric')   return buildTrackMetricArgsHTML(step);
  if (step.func === OPEN_URL_FUNC)    return buildOpenUrlArgsHTML(step);

  const args = FN_META[step.func]?.args || [];
  if (!args.length) return '<div class="no-args">No arguments</div>';
  return args.map(a => {
    const pickBtn = PICKER_ARGS.has(a)
      ? `<button class="btn-pick" data-pick-arg="${a}" title="Pick element from page">&#x1F3AF;</button>`
      : '';
    return `
    <div class="arg-row">
      <span class="arg-lbl">${a}</span>
      <input type="text" data-arg="${a}" value="${esc(step.inputs[a] || '')}">
      ${pickBtn}
    </div>`;
  }).join('');
}

function wireArgs(el, step) {
  // Map each sub-select arg to its options list for tooltip updates
  const SUB_OPTION_MAP = {
    click:     { method:  CLICK_METHODS   },
    fill:      { method:  FILL_METHODS    },
    submit:    { method:  SUBMIT_METHODS  },
    switch_to: { target:  SWITCH_TARGETS  },
    alert:     { action:  ALERT_ACTIONS   },
  };

  el.querySelectorAll('[data-arg]').forEach(inp => {
    const isSelect = inp.tagName === 'SELECT';
    inp.addEventListener(isSelect ? 'change' : 'input', e => {
      step.inputs[inp.dataset.arg] = e.target.value;

      // Keep the legacy `metric` string in step alongside the id, so a
      // script saved by this build still runs on a build that predates
      // metricId — and so a step whose metric is later deleted still knows
      // what it was pointed at.
      if (step.func === 'track_metric' && inp.dataset.arg === 'metricId') {
        const ent = metrics.find(m => m.id === e.target.value);
        step.inputs.metric = ent ? ent.pattern : (step.inputs.metric || '');
      }

      // Update sub-tooltip when a method/target/action select changes
      const subOpts = SUB_OPTION_MAP[step.func]?.[inp.dataset.arg];
      if (subOpts) {
        const slot = inp.closest('.arg-row')?.querySelector('.sub-tooltip-slot');
        if (slot) slot.innerHTML = buildSubTooltipHTML(subOpts, e.target.value);
      }

      // For switch_to: show/hide value row based on target selection
      if (step.func === 'switch_to' && inp.dataset.arg === 'target') {
        const info = SWITCH_TARGETS.find(t => t.value === e.target.value);
        const row  = el.querySelector('.switch-value-row');
        if (row) row.style.display = info?.hasValue ? 'flex' : 'none';
      }

      persistQueue();
    });
  });

  el.querySelectorAll('.btn-pick').forEach(btn => {
    const argName = btn.dataset.pickArg;
    const onResult = ['click', 'fill', 'submit'].includes(step.func) ? applyPickerToMethod : null;
    btn.addEventListener('click', () => startPicker(el, step, argName, onResult));
  });

  if (step.func === OPEN_URL_FUNC) wireOpenUrlArgs(el, step);
}

// Rebuild and rewire a step's argument area in place — used whenever the
// number of inputs changes (e.g. adding/removing a URL parameter row).
function rerenderStepArgs(el, step) {
  el.querySelector('.step-args').innerHTML = buildArgsHTML(step);
  wireArgs(el, step);
  persistQueue();
}

function wireOpenUrlArgs(el, step) {
  el.querySelector('.qa-mode-chk')?.addEventListener('change', e => {
    step.inputs.qa_mode = e.target.checked;
    persistQueue();
  });
  el.querySelectorAll('.open-url-param-input').forEach(inp => {
    inp.addEventListener('input', e => {
      step.inputs.params[Number(inp.dataset.idx)] = e.target.value;
      persistQueue();
    });
  });
  el.querySelectorAll('.rm-open-url-param').forEach(btn => {
    btn.addEventListener('click', () => {
      step.inputs.params.splice(Number(btn.dataset.idx), 1);
      rerenderStepArgs(el, step);
    });
  });
  el.querySelector('.add-open-url-param')?.addEventListener('click', () => {
    step.inputs.params.push('');
    rerenderStepArgs(el, step);
  });
}

// ── Element picker ────────────────────────────────────────────────────────────
let _pickerPoller = null;

async function startPicker(stepEl, step, argName, onResult) {
  await sessionNS.remove('pickerResult');

  const btn = stepEl.querySelector(`.btn-pick[data-pick-arg="${argName}"]`);
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  const res = await chrome.runtime.sendMessage({ action: 'startPicker', winId: WIN_ID });
  if (!res?.ok) {
    if (btn) { btn.textContent = '🎯'; btn.disabled = false; }
    alert('Could not inject picker. Make sure you are on a regular webpage (not a chrome:// page).');
    return;
  }

  _pickerPoller = setInterval(async () => {
    const { pickerResult } = await sessionNS.get('pickerResult');
    if (!pickerResult) return;

    clearInterval(_pickerPoller);
    _pickerPoller = null;
    await sessionNS.remove('pickerResult');

    if (btn) { btn.textContent = '🎯'; btn.disabled = false; }
    if (pickerResult.cancelled) return;

    if (onResult) {
      onResult(pickerResult.selector, stepEl, step);
    } else {
      const { selector } = pickerResult;
      const value = (argName === 'element_id' && selector.idValue)
        ? selector.idValue
        : selector.css;
      const inp = stepEl.querySelector(`[data-arg="${argName}"]`);
      if (inp) { inp.value = value; step.inputs[argName] = value; persistQueue(); }
    }
  }, 300);
}

function applyPickerToMethod(selector, stepEl, step) {
  const method = selector.idValue ? 'id' : 'css';
  const value  = selector.idValue || selector.css;
  step.inputs.method   = method;
  step.inputs.selector = value;
  const methodEl = stepEl.querySelector('[data-arg="method"]');
  const valueEl  = stepEl.querySelector('[data-arg="selector"]');
  if (methodEl) methodEl.value = method;
  if (valueEl)  valueEl.value  = value;
  persistQueue();
}

function removeStep(id) {
  const i = steps.findIndex(s => s.id === id);
  if (i < 0 || steps[i].locked) return;
  steps.splice(i, 1);
  renderGroups(); // also dissolves the step's group wrapper if it just emptied out
  persistQueue();
}

function clearSteps() {
  const removable = steps.filter(s => !s.locked);
  if (!removable.length) return;
  if (!confirm(`Remove all ${removable.length} step${removable.length !== 1 ? 's' : ''} from the queue?`)) return;
  steps = steps.filter(s => s.locked);
  renderGroups();
  persistQueue();
}

function duplicateStep(id) {
  const i = steps.findIndex(s => s.id === id);
  if (i < 0) return;
  const src = steps[i];

  // Create the copy (deep-clone inputs so nested arrays/objects aren't shared).
  // Carries the source's group along, so duplicating a step inside a group
  // keeps the copy in that same group.
  const copy = addStep({
    func:      src.func,
    enabled:   src.enabled,
    delay:     src.delay,
    inputs:    structuredClone(src.inputs),
    groupId:   src.groupId,
    groupName: src.groupName,
  });

  // addStep() appends to the end; move the copy to sit right after its source.
  steps.splice(steps.length - 1, 1);
  steps.splice(i + 1, 0, copy);
  renderGroups();
  persistQueue();
}

// A step can reorder freely within its own group, but ↑/↓ can't carry it past
// a group boundary — crossing one would silently either join or abandon a
// group depending on direction, which is confusing without an explicit action.
function moveStep(id, dir) {
  const i = steps.findIndex(s => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= steps.length) return;
  if (steps[i].locked || steps[j].locked) return;
  if (steps[i].groupId !== steps[j].groupId) return;
  [steps[i], steps[j]] = [steps[j], steps[i]];
  renderGroups();
  persistQueue();
}

// ── Step groups ──────────────────────────────────────────────────────────
// A group is a purely organizational overlay on the flat `steps` array: any
// run of steps sharing the same non-null groupId renders inside one wrapper
// and can be duplicated/ungrouped as a unit. background.js's run loop only
// ever sees the flat, ordered {func,enabled,delay,inputs} list — groupId/
// groupName travel along for persistence (persistQueue/saveScript) but the
// executor ignores them entirely.
let groupSelecting = false;

function buildGroupWrapper(groupId, groupName) {
  const wrapper = document.createElement('div');
  wrapper.className = 'step-group';
  wrapper.dataset.groupId = groupId;
  wrapper.innerHTML = `
    <div class="step-group-hdr">
      <input type="text" class="step-group-name" placeholder="Group name" value="${esc(groupName || '').replace(/"/g, '&quot;')}">
      <button class="btn-icon step-group-dup" title="Duplicate group">⧉</button>
      <button class="btn ghost btn-icon step-group-ungroup" title="Ungroup — steps stay, just no longer combined">Ungroup</button>
    </div>
    <div class="step-group-body"></div>`;
  wrapper.querySelector('.step-group-name').addEventListener('input', e => renameGroup(groupId, e.target.value));
  wrapper.querySelector('.step-group-dup').addEventListener('click', () => duplicateGroup(groupId));
  wrapper.querySelector('.step-group-ungroup').addEventListener('click', () => ungroupSteps(groupId));
  return wrapper;
}

// Rebuilds #step-list so contiguous same-groupId steps nest inside a
// .step-group wrapper — moves existing step elements rather than recreating
// them, so their listeners/inputs/focus survive. The single place group
// nesting is reconciled with the `steps` array after any structural change
// (add/remove/move/duplicate/group/ungroup).
function renderGroups() {
  const list = document.getElementById('step-list');
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < steps.length) {
    const s  = steps[i];
    const el = document.getElementById('step-' + s.id);
    if (!el) { i++; continue; }
    if (!s.groupId) { frag.appendChild(el); i++; continue; }
    const gid = s.groupId;
    const wrapper = buildGroupWrapper(gid, s.groupName);
    const body = wrapper.querySelector('.step-group-body');
    while (i < steps.length && steps[i].groupId === gid) {
      const memberEl = document.getElementById('step-' + steps[i].id);
      if (memberEl) body.appendChild(memberEl);
      i++;
    }
    frag.appendChild(wrapper);
  }
  list.innerHTML = '<div id="empty-msg">No steps yet — click + Add Step to begin</div>';
  list.appendChild(frag);
  updateCount();
}

function renameGroup(groupId, name) {
  steps.forEach(s => { if (s.groupId === groupId) s.groupName = name; });
  persistQueue();
}

function ungroupSteps(groupId) {
  steps.forEach(s => { if (s.groupId === groupId) { s.groupId = null; s.groupName = null; } });
  renderGroups();
  persistQueue();
}

// Clones every step in the group (deep-cloning inputs, same as duplicateStep)
// into a new group with the same name, inserted right after the source group.
function duplicateGroup(groupId) {
  const memberIdxs = [];
  steps.forEach((s, idx) => { if (s.groupId === groupId) memberIdxs.push(idx); });
  if (!memberIdxs.length) return;
  const members   = memberIdxs.map(idx => steps[idx]);
  const lastIdx   = memberIdxs[memberIdxs.length - 1];
  const groupName = members[0].groupName;
  const newGroupId = 'g' + (nextGroupId++);

  members.forEach(src => addStep({
    func:      src.func,
    enabled:   src.enabled,
    delay:     src.delay,
    inputs:    structuredClone(src.inputs),
    groupId:   newGroupId,
    groupName,
  }));

  // Each addStep() call above appended one copy to the very end, in source
  // order — pull that trailing block out and reinsert it after the source.
  const copies = steps.splice(steps.length - members.length, members.length);
  steps.splice(lastIdx + 1, 0, ...copies);

  renderGroups();
  persistQueue();
}

function updateGroupSelectionUI() {
  const n = document.querySelectorAll('.grp-chk:checked').length;
  const btn = document.getElementById('btn-group-confirm');
  if (!btn) return;
  btn.textContent = `Combine (${n})`;
  btn.disabled = n < 2;
}

function enterGroupSelectMode() {
  groupSelecting = true;
  document.getElementById('step-list').classList.add('selecting');
  document.getElementById('btn-group-mode').style.display = 'none';
  document.getElementById('btn-group-confirm').style.display = '';
  document.getElementById('btn-group-cancel').style.display = '';
  updateGroupSelectionUI();
}

function exitGroupSelectMode() {
  groupSelecting = false;
  document.querySelectorAll('.grp-chk').forEach(c => { c.checked = false; });
  document.getElementById('step-list').classList.remove('selecting');
  document.getElementById('btn-group-mode').style.display = '';
  document.getElementById('btn-group-confirm').style.display = 'none';
  document.getElementById('btn-group-cancel').style.display = 'none';
}

// Combines the checked steps into a new group, moving them to sit
// contiguously at the position of the first selected step.
function combineSelectedIntoGroup() {
  const ids = new Set(
    [...document.querySelectorAll('.grp-chk:checked')]
      .map(c => Number(c.closest('.step')?.id.replace('step-', '')))
  );
  const selected = steps.filter(s => ids.has(s.id));
  if (selected.length < 2) return;

  const name = prompt('Group name:', `Group ${nextGroupId}`);
  if (name == null) return; // cancelled

  const groupId = 'g' + (nextGroupId++);
  selected.forEach(s => { s.groupId = groupId; s.groupName = name; });

  // Reinsert the selected steps as a contiguous block right where the first
  // selected step used to sit, relative to the untouched (unselected) steps.
  const firstIdx = steps.findIndex(s => ids.has(s.id));
  const insertAt = steps.slice(0, firstIdx).filter(s => !ids.has(s.id)).length;
  const rest = steps.filter(s => !ids.has(s.id));
  rest.splice(insertAt, 0, ...selected);
  steps = rest;

  exitGroupSelectMode();
  renderGroups();
  persistQueue();
}

// Loading/appending a saved script must never let its stored groupIds collide
// with (and silently merge into) a group that already exists in the live
// queue — remap each distinct incoming groupId to a fresh session-scoped id,
// preserving which steps share one (the grouping structure), not its label.
function remapGroupIds(stepDataArr) {
  const map = new Map();
  return stepDataArr.map(s => {
    if (!s.groupId) return s;
    if (!map.has(s.groupId)) map.set(s.groupId, 'g' + (nextGroupId++));
    return { ...s, groupId: map.get(s.groupId) };
  });
}

function updateCount() {
  const n = steps.length;
  document.getElementById('step-count').textContent = n + ' step' + (n !== 1 ? 's' : '');
  const empty = document.getElementById('empty-msg');
  if (empty) empty.style.display = n ? 'none' : 'block';
}

function persistQueue() {
  sessionNS.set({
    queueState: steps.map(s => ({
      func: s.func, enabled: s.enabled, delay: s.delay, inputs: { ...s.inputs },
      groupId: s.groupId || null, groupName: s.groupName || null,
    }))
  });
}

// ── WCAG results renderer ─────────────────────────────────────────────────────
// Try to derive a CSS selector from an issue string so clicking the row can
// highlight the element on the audited page. axe issues carry a real selector
// after " — "; heuristic issues embed brief()'s '#id' / '[name="…"]' /
// 'tag.class' shorthand. Returns null when nothing usable is found.
const _LOC_TAGS = 'a|button|input|select|textarea|div|span|img|video|audio|ul|ol|li|p|h[1-6]|form|nav|header|footer|section|article|dialog|td|th|tr|table|label|iframe|svg|main|aside|marquee';
function extractIssueTarget(text) {
  const axeM = /^axe · .*? — (.+)$/.exec(text);
  if (axeM) return axeM[1].trim();
  const m = new RegExp(`(^|[\\s:])(#[A-Za-z][\\w-]*|\\[name="[^"]+"\\]|(?:${_LOC_TAGS})(?:\\.[A-Za-z0-9_-]+)+)`).exec(text);
  return m ? m[2] : null;
}

function renderSuiteResults(containerId, results, order) {
  const el = document.getElementById(containerId);
  if (!el) return;

  let passed = 0, withIssues = 0, manual = 0, totalIssues = 0;

  const issueHtml = (text) => {
    const target = extractIssueTarget(text);
    return target
      ? `<div class="a11y-issue a11y-issue-loc" data-loc="${esc(target).replace(/"/g, '&quot;')}" title="Click to highlight this element on the page">${esc(text)}</div>`
      : `<div class="a11y-issue">${esc(text)}</div>`;
  };

  const rows = order
    .filter(k => results[k])
    .map(k => {
      const { label, issues, infoOnly } = results[k];
      const count = issues.length;
      const guide = infoOnly ? (WCAG_MANUAL_GUIDE[k] || []) : [];

      let dotCls, countLabel;
      if (infoOnly) {
        manual++;
        dotCls = 'a11y-info-dot';
        countLabel = 'Manual';
      } else {
        totalIssues += count;
        if (count === 0) passed++; else withIssues++;
        dotCls = count === 0 ? 'a11y-pass-dot' : 'a11y-fail-dot';
        countLabel = count === 0 ? 'Pass' : count + ' issue' + (count !== 1 ? 's' : '');
      }
      const hasBody = count > 0 || guide.length > 0;
      const isOpen = !infoOnly && count > 0;

      const body = hasBody ? `
        ${issues.map(issueHtml).join('')}
        ${guide.length ? `
          <div class="a11y-guide-title">Verify by hand:</div>
          ${guide.map(g => `<div class="a11y-guide-item">${esc(g)}</div>`).join('')}` : ''}` : '';

      return `
        <div class="a11y-row${isOpen ? ' open' : ''}" data-suite-row>
          <div class="a11y-row-hdr">
            <span class="a11y-dot ${dotCls}"></span>
            <span class="a11y-row-label">${esc(label)}</span>
            <span class="a11y-count">${countLabel}</span>
            ${hasBody ? '<span class="a11y-chevron">›</span>' : ''}
          </div>
          ${hasBody ? `<div class="a11y-body">${body}</div>` : ''}
        </div>`;
    });

  const summaryColor = withIssues === 0 ? 'var(--ok)' : 'var(--err)';
  const summaryText = withIssues === 0
    ? 'No automated issues'
    : `${totalIssues} issue${totalIssues !== 1 ? 's' : ''}`;

  el.innerHTML = `
    <div class="a11y-summary-bar">
      <span>${passed} passed · ${withIssues} with issues · ${manual} manual review</span>
      <div class="row" style="gap:8px">
        <span class="a11y-summary-total" style="color:${summaryColor}">${summaryText}</span>
        <button class="btn ghost btn-icon" data-export-results title="Download results as JSON">Export</button>
        <button class="btn ghost btn-icon" data-clear-results title="Clear results">Clear</button>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px">${rows.join('')}</div>`;

  el.querySelectorAll('[data-suite-row] .a11y-row-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => hdr.closest('[data-suite-row]').classList.toggle('open'));
  });
  el.querySelector('[data-clear-results]')?.addEventListener('click', () => { el.innerHTML = ''; });
  el.querySelector('[data-export-results]')?.addEventListener('click', exportWcagResults);
  el.querySelectorAll('.a11y-issue-loc').forEach(row => {
    row.addEventListener('click', () => wcagHighlight(row.dataset.loc, row));
  });
}

// Highlight an issue's element in the audited tab (or the active tab as a
// fallback for history views). On failure, notes it inline on the row.
async function wcagHighlight(selector, rowEl) {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      action: 'highlightElement',
      tabId: _wcagCurrentRun?.tabId || null,
      selector,
    });
  } catch (_) {}
  if ((!res?.ok || !res.found) && rowEl && !rowEl.querySelector('.a11y-loc-miss')) {
    const note = document.createElement('span');
    note.className = 'a11y-loc-miss';
    note.textContent = ' — not found on the current page';
    note.style.color = 'var(--fg3)';
    rowEl.appendChild(note);
    setTimeout(() => note.remove(), 2500);
  }
}

// ── WCAG mode: per-criterion explanations (shown as hover tooltips) ───────────
const WCAG_INFO = {
  titles: 'Every page needs a unique, descriptive <title>. It is the first thing a screen reader announces and how users tell browser tabs and history entries apart. (WCAG 2.4.2)',
  navconsistency: 'Navigation, header, footer, and help links should stay in the same place with the same labels on every page, so users can rely on a consistent mental model. (WCAG 3.2.3, 3.2.4, 3.2.6)',
  multipleways: 'Offer at least two ways to reach content — e.g. a navigation menu plus site search or a sitemap — so users are not forced through a single path. (WCAG 2.4.5)',
  skiplink: 'A "skip to main content" link lets keyboard and screen-reader users jump past repeated navigation straight to the page’s main region. (WCAG 2.4.1)',
  keyboardpath: 'All functionality must be operable with the keyboard alone, and the tab/focus order must follow a logical sequence. Positive tabindex values break that order. (WCAG 2.1.1, 2.4.3)',
  modalescape: 'Users must never get trapped in a component. A modal or dialog should always be closable with a standard method such as the Escape key. (WCAG 2.1.2)',
  formerror: 'When a submission fails, the error must be clearly identified, described in text with a suggested fix, and announced to assistive technology. (WCAG 3.3.1, 3.3.3, 4.1.3)',
  sessiontiming: 'If a session can expire, warn the user before it does and let them extend it without losing any data they have entered. (WCAG 2.2.1, 2.2.6)',
  destructive: 'Actions with real consequences — delete, cancel, payment — should require explicit confirmation or be reversible, to prevent costly mistakes. (WCAG 3.3.4, 3.3.6)',
  linkpurpose: 'Link text should make sense on its own. Generic phrases like "click here" or "read more" are meaningless to someone scanning links out of context. (WCAG 2.4.4, 2.4.9)',
  formlabels: 'Every field needs a real, persistent label that is programmatically associated with it. Placeholder text disappears on input and does not count as a label. (WCAG 3.3.2, 1.3.1)',
  redundant: 'In a multi-step flow, do not make users re-enter information they already provided — auto-populate it or let them reuse it. (WCAG 3.3.7)',
  focusvis: 'A visible focus indicator must appear when an element is focused by keyboard, and must not be removed by CSS or hidden behind sticky headers or overlays. (WCAG 2.4.7, 2.4.11)',
  ariastate: 'Custom widgets (accordions, tabs, dropdowns, toggles) must expose and update their state — e.g. aria-expanded or aria-selected — so assistive tech knows what happened. (WCAG 4.1.2)',
  contrast: 'Text and meaningful UI elements need enough contrast against their background: 4.5:1 for normal text, 3:1 for large text and non-text elements. (WCAG 1.4.3, 1.4.11)',
  reflow: 'Content must reflow into a single column and stay usable at 400% zoom or a 320px-wide viewport, without forcing two-dimensional scrolling. (WCAG 1.4.10, 1.4.4)',
  motion: 'Nothing should flash more than three times per second, and any auto-playing motion must be pausable, stoppable, or hideable. (WCAG 2.2.2, 2.3.1)',
  screenreader: 'Assistive tech must be able to announce each element’s name, role, and state, plus dynamic status updates — via alt text, accessible names, and live regions. (WCAG 1.1.1, 4.1.2, 4.1.3)',
  realworld: 'A holistic check: using only a keyboard or a screen reader, can someone actually complete the key tasks (sign up, checkout, find content) without excessive friction? (cross-cutting)'
};

// Attach an info tooltip to every WCAG audit criterion. Sourced from one map so
// the popup and side panel stay in sync. Flips up/down to avoid clipping in the
// scrollable panel.
function initSuiteTooltips() {
  const scroller = document.getElementById('panels');
  document.querySelectorAll('input[name="wcag-check"]').forEach(cb => {
    const label = cb.closest('.suite-check');
    const text = WCAG_INFO[cb.value];
    if (!label || !text || label.querySelector('.tooltip-wrap')) return;

    const wrap = document.createElement('span');
    wrap.className = 'tooltip-wrap';
    wrap.style.marginLeft = 'auto';

    const icon = document.createElement('span');
    icon.className = 'tooltip-icon';
    icon.textContent = 'ⓘ';
    icon.setAttribute('aria-label', 'What this checks');

    const box = document.createElement('span');
    box.className = 'tooltip-box';
    box.textContent = text;

    wrap.appendChild(icon);
    wrap.appendChild(box);
    label.appendChild(wrap);

    // Clicking the icon shouldn't toggle the checkbox it lives inside.
    wrap.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });

    // Open downward when there isn't room above within the scroll container.
    wrap.addEventListener('mouseenter', () => {
      const top = (scroller || document.documentElement).getBoundingClientRect().top;
      box.classList.toggle('tt-down', wrap.getBoundingClientRect().top - top < 140);
    });
  });
}

// ── Test Agent mode: WCAG / Accessibility (#tm4-body) ─────────────────────────
// The audit engine (heuristics + axe-core merge) lives in background.js and is
// unchanged; this side owns scoping, presets, run history, export, and the
// results view. Fully independent of the Build tab queue.

// Manual-check guidance — one actionable checklist per infoOnly check, kept
// alongside WCAG_INFO so all criterion copy lives in one place.
const WCAG_MANUAL_GUIDE = {
  modalescape: [
    'Open each modal/dialog on the page.',
    'Press Escape — the dialog should close.',
    'Tab forward and backward inside the open dialog — focus must stay within it until it closes.',
    'When it closes, focus should return to the control that opened it.',
  ],
  sessiontiming: [
    'Stay idle until near session expiry — a warning should appear before you are logged out.',
    'The warning offers a way to extend the session without losing your place (2.2.1).',
    'After extending or re-authenticating, previously entered form data is still intact (2.2.6).',
  ],
  destructive: [
    'Trigger each destructive or consequential action found above.',
    'Confirm it only finalizes after an explicit confirmation step, or can be undone (3.3.4).',
    'For legal/financial submissions, confirm the user can review and correct data before the final submit (3.3.6).',
  ],
  redundant: [
    'Walk any multi-step flow (checkout, signup, booking) end to end.',
    'Information entered in an earlier step (name, email, address) should be auto-populated or selectable later, not re-typed (3.3.7).',
    'Re-entry is acceptable only when essential or for security (e.g. password confirmation).',
  ],
  realworld: [
    'Using only the keyboard, complete each key task end to end (sign up, checkout, find content).',
    'Repeat the same tasks with a screen reader (VoiceOver, NVDA, or JAWS).',
    'Confirm there are no dead ends, focus traps, or silent state changes that block completion.',
  ],
};

// The manual/infoOnly checks — used by the built-in "Automated only" preset.
const WCAG_MANUAL_KEYS = Object.keys(WCAG_MANUAL_GUIDE);

let _wcagCurrentRun = null;   // whatever run is currently rendered (fresh or from history)

function wcagCheckboxes() {
  return [...document.querySelectorAll('input[name="wcag-check"]')];
}

async function runWcagAudit(opts = {}) {
  const btn = document.getElementById('btn-run-wcag');
  const resultsEl = document.getElementById('wcag-results');
  const checks = wcagCheckboxes().filter(cb => cb.checked).map(cb => cb.value);
  if (!checks.length) {
    resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Select at least one check.</div>';
    return;
  }
  const scope = (document.getElementById('wcag-scope')?.value || '').trim();

  btn.disabled = true;
  btn.textContent = 'Running…';
  resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Auditing page…</div>';

  try {
    const res = await chrome.runtime.sendMessage({ action: 'runWcagAudit', checks, scope, agenticTesting: !!opts.agenticTesting });
    if (!res?.ok) throw new Error(res?.error || 'Audit failed');
    _wcagCurrentRun = {
      url: res.url || '', ts: Date.now(), tabId: res.tabId || null,
      checks, scope, results: res.results,
      axeError: res.axeError || null, scopeError: res.scopeError || null,
      agenticNote: res.agenticNote || null,
    };
    renderWcagRun(_wcagCurrentRun);
    await saveWcagHistory(_wcagCurrentRun);
    await renderWcagHistoryList();
  } catch (e) {
    resultsEl.innerHTML = '<div style="color:var(--err);font-size:12px;padding:6px 0">Error: ' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Audit';
  }
}

function renderWcagRun(run) {
  renderSuiteResults('wcag-results', run.results, run.checks);
  const resultsEl = document.getElementById('wcag-results');
  const notes = [];
  if (run.scopeError) notes.push(run.scopeError);
  else if (run.scope)  notes.push('Scoped to: ' + run.scope);
  if (run.axeError)    notes.push('axe-core could not run on this page (' + run.axeError + '). Heuristic checks were used instead.');
  if (run.url)         notes.push('Audited ' + run.url + ' at ' + new Date(run.ts).toLocaleString());
  if (notes.length) {
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--fg3);font-size:11px;padding:6px 2px 0';
    note.textContent = notes.join(' · ');
    resultsEl.prepend(note);
  }
}

// ── Check presets (chrome.storage.sync, like saved scripts) ───────────────────
// Two built-ins are always present; user presets also store the scope selector.
const WCAG_BUILTIN_PRESETS = {
  '__full': 'Full audit (all checks)',
  '__auto': 'Automated only (no manual checks)',
};

async function refreshWcagPresets() {
  const { wcagPresets = {} } = await chrome.storage.sync.get('wcagPresets');
  const names = Object.keys(wcagPresets).sort();
  const sel = document.getElementById('wcag-preset-select');
  if (!sel) return;
  sel.innerHTML =
    Object.entries(WCAG_BUILTIN_PRESETS).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('') +
    names.map(n => `<option value="u:${esc(n)}">${esc(n)}</option>`).join('');
}

async function loadWcagPreset() {
  const sel = document.getElementById('wcag-preset-select');
  const v = sel?.value || '';
  let checks = null, scope = '';
  if (v === '__full') {
    checks = wcagCheckboxes().map(cb => cb.value);
  } else if (v === '__auto') {
    checks = wcagCheckboxes().map(cb => cb.value).filter(k => !WCAG_MANUAL_KEYS.includes(k));
  } else if (v.startsWith('u:')) {
    const { wcagPresets = {} } = await chrome.storage.sync.get('wcagPresets');
    const p = wcagPresets[v.slice(2)];
    if (!p) return;
    checks = p.checks || [];
    scope = p.scope || '';
  } else return;
  wcagCheckboxes().forEach(cb => { cb.checked = checks.includes(cb.value); });
  const scopeInput = document.getElementById('wcag-scope');
  if (scopeInput) scopeInput.value = scope;
}

async function saveWcagPreset() {
  const name = document.getElementById('wcag-preset-name').value.trim();
  if (!name) { alert('Enter a preset name.'); return; }
  const { wcagPresets = {} } = await chrome.storage.sync.get('wcagPresets');
  wcagPresets[name] = {
    checks: wcagCheckboxes().filter(cb => cb.checked).map(cb => cb.value),
    scope: (document.getElementById('wcag-scope')?.value || '').trim(),
  };
  await chrome.storage.sync.set({ wcagPresets });
  await refreshWcagPresets();
  document.getElementById('wcag-preset-select').value = 'u:' + name;
  document.getElementById('wcag-preset-name').value = '';
  alert(`"${name}" saved.`);
}

async function deleteWcagPreset() {
  const v = document.getElementById('wcag-preset-select')?.value || '';
  if (!v.startsWith('u:')) { alert('Built-in presets can\'t be deleted.'); return; }
  const name = v.slice(2);
  if (!confirm(`Delete "${name}"?`)) return;
  const { wcagPresets = {} } = await chrome.storage.sync.get('wcagPresets');
  delete wcagPresets[name];
  await chrome.storage.sync.set({ wcagPresets });
  await refreshWcagPresets();
}

// ── Run history (chrome.storage.local — results can be large) ─────────────────
const WCAG_HISTORY_PER_URL = 5;
const WCAG_HISTORY_URLS = 15;

async function saveWcagHistory(run) {
  if (!run.url) return;
  const { wcagHistory = {} } = await chrome.storage.local.get('wcagHistory');
  const arr = wcagHistory[run.url] || [];
  arr.unshift({ ts: run.ts, checks: run.checks, scope: run.scope, results: run.results, axeError: run.axeError, scopeError: run.scopeError });
  wcagHistory[run.url] = arr.slice(0, WCAG_HISTORY_PER_URL);
  const urls = Object.keys(wcagHistory);
  if (urls.length > WCAG_HISTORY_URLS) {
    urls.sort((a, b) => (wcagHistory[b][0]?.ts || 0) - (wcagHistory[a][0]?.ts || 0));
    for (const u of urls.slice(WCAG_HISTORY_URLS)) delete wcagHistory[u];
  }
  await chrome.storage.local.set({ wcagHistory });
}

async function renderWcagHistoryList() {
  const sel = document.getElementById('wcag-history-select');
  if (!sel) return;
  const { wcagHistory = {} } = await chrome.storage.local.get('wcagHistory');
  const opts = [];
  for (const [url, runs] of Object.entries(wcagHistory)) {
    runs.forEach((r, i) => opts.push({ url, i, ts: r.ts, scope: r.scope }));
  }
  opts.sort((a, b) => b.ts - a.ts);
  sel.innerHTML = opts.length
    ? opts.map(o => {
        let short = o.url;
        try { const u = new URL(o.url); short = u.host + u.pathname; } catch (_) {}
        return `<option value="${encodeURIComponent(o.url)}|${o.i}">${new Date(o.ts).toLocaleString()} — ${esc(short)}${o.scope ? ' (scoped)' : ''}</option>`;
      }).join('')
    : '<option disabled>&lt;no past runs&gt;</option>';
}

async function viewWcagHistoryRun() {
  const v = document.getElementById('wcag-history-select')?.value || '';
  const bar = v.lastIndexOf('|');
  if (bar < 0) return;
  const url = decodeURIComponent(v.slice(0, bar));
  const idx = +v.slice(bar + 1);
  const { wcagHistory = {} } = await chrome.storage.local.get('wcagHistory');
  const run = wcagHistory[url]?.[idx];
  if (!run) return;
  // tabId is intentionally null — highlighting falls back to the active tab.
  _wcagCurrentRun = { url, ts: run.ts, tabId: null, checks: run.checks, scope: run.scope, results: run.results, axeError: run.axeError, scopeError: run.scopeError };
  renderWcagRun(_wcagCurrentRun);
}

// ── Export (plain JSON file download) ─────────────────────────────────────────
function exportWcagResults() {
  const r = _wcagCurrentRun;
  if (!r) { alert('Run an audit first.'); return; }
  const data = {
    url: r.url || null,
    timestamp: new Date(r.ts).toISOString(),
    scope: r.scope || null,
    axeError: r.axeError || null,
    checks: r.checks.filter(k => r.results[k]).map(k => {
      const c = r.results[k];
      return {
        key: k,
        label: c.label,
        wcag: c.wcag || '',
        status: c.infoOnly ? 'manual review' : (c.issues.length ? 'issues' : 'pass'),
        issues: c.issues,
      };
    }),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = 'wcag-audit-' + new Date(r.ts).toISOString().replace(/[:.]/g, '-') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

// One-time wiring for the accessibility subpage's controls.
async function initWcagMode() {
  if (!document.getElementById('btn-run-wcag')) return;
  document.getElementById('btn-wcag-scope-pick')?.addEventListener('click', () => {
    const row = document.getElementById('wcag-scope-row');
    startPicker(row, null, 'wcag-scope', (selector) => {
      document.getElementById('wcag-scope').value =
        selector.css || (selector.idValue ? '#' + selector.idValue : '');
    });
  });
  document.getElementById('btn-wcag-load-preset')?.addEventListener('click', loadWcagPreset);
  document.getElementById('btn-wcag-save-preset')?.addEventListener('click', saveWcagPreset);
  document.getElementById('btn-wcag-delete-preset')?.addEventListener('click', deleteWcagPreset);
  document.getElementById('btn-wcag-view-history')?.addEventListener('click', viewWcagHistoryRun);
  await refreshWcagPresets();
  await renderWcagHistoryList();
}

// ── A/B Variant Comparison (its own tab, #ab-body — also batchable from Test
// Agent via TA_MODES['2'], which has no bodyId of its own; see renderSlot) ──
// Static load-and-compare mode: opens each variant target once (background owns
// the tab lifecycle and capture), then diffs every variant against the first
// target — the baseline, typically Control. Differences are surfaced neutrally:
// a variant is *supposed* to differ from control, so only JS errors and load
// failures are styled as errors. This mode never reads or executes the Build
// tab queue.

let abState = null;   // { baseUrl, qaMode, settleSec, keepTabs, recordHeatmap, visualDiff, visualDiffCrops, targets: [{label,url,override}], selectors: [] }
let _abLastRun = null;   // last comparison, for the Run All & Generate Report mode

// Visual Diff: Stop is shared with the Test Agent mode's own Stop button
// (stopTestAgent), since runAbComparison also runs as a Test Agent mode —
// unlike deterministic capture, whose stop flag lives in background.js
// (_abStopRequested) and is never exposed here, this pass is driven entirely
// from popup.js one variant at a time, so it needs its own client-side flag.
let _abVisualDiffStopRequested = false;

// Resolves a URL to its ticket variant ({id, isControl, rawDescription}) via
// the ticket's forced-variant-id convention — not by trusting a target's
// display label, which only equals the ticket's v0/v1 id when it came from
// "Fill from ticket" (ctxVariantTargets). expExtractForcedVarId/expLabelFor
// already do this URL -> ticket-variant resolution for the experiment-
// results matching feature; reused here with no results row, since a row is
// only needed for that feature's ordinal fallback. labelMap comes from
// expBuildLabelMap(ctx), built once by the caller and reused across every URL.
function resolveTicketVariantForUrl(ctx, labelMap, url) {
  const forced = expExtractForcedVarId(url);
  if (!forced || !forced.varId) return null;
  const resolved = expLabelFor(forced.varId, null, ctx, labelMap);
  return resolved ? (ctx.variants || []).find(v => v.id === resolved.label) || null : null;
}

// Resolves which of a set of {label,url} items (targets, before capture, or
// captures, after) is the baseline — AND how it was decided. Shared by
// runAbComparison (resolved BEFORE capture, so the deterministic sections'
// baseline agrees with Visual Diff's) and runVisualDiffPipeline (resolved
// again, post-capture, since capture can fail/skip a target).
//
// Ticket resolution (via the forced-variant-id convention) wins when it can.
// When it can't — a plain, unforced Control URL is a normal way to express
// "Control," not an edge case, since nothing requires a ticket's Control
// preview link to carry its own optimizely_x/_conv_eforce param — fall back
// to the FIRST item, matching what the deterministic sections
// (diffAbCaptures/renderAbResults) already hardcode as index 0. Returns null
// only for an empty list. `notes` carries expBuildLabelMap's own diagnostics
// (e.g. a preview link forcing the wrong experiment id) — previously built
// and silently discarded at both call sites.
function resolveAbBaseline(ctx, items) {
  if (!items.length) return null;
  const { map: labelMap = {}, notes = [] } = ctx ? expBuildLabelMap(ctx) : {};
  if (ctx) {
    const idx = items.findIndex(i => resolveTicketVariantForUrl(ctx, labelMap, i.url)?.isControl);
    if (idx > -1) return { index: idx, label: items[idx].label, source: 'ticket', notes, labelMap };
  }
  return { index: 0, label: items[0].label, source: 'first-target', notes, labelMap };
}

// ── Visual Diff checkpointing (chrome.storage.local) ────────────────────────
// Root lifecycle (create/finalize/clear) lives here; background.js only ever
// patches an existing entry (see its own patchVisualDiffCheckpoint), guarded
// by runId so a straggling write from a superseded/aborted run can never
// resurrect a stale entry. "Resume" can only mean skipping the Claude
// re-call for variants already checkpointed done — every target still needs
// a fresh capture (closing the side panel kills this very loop's state
// regardless of where the pixel work happens, and the full-page screenshots
// a resume would need are gone from the worker within ~30s of idle either
// way) — real value is saved API cost/time for whatever finished before the
// run died, not seamless continuation.
const VD_CHECKPOINT_KEY = 'visualDiffCheckpoints';

function computeVisualDiffRunSignature(ctx, targets) {
  return `${ctx?.ticketKey || ''}::${targets.map(t => t.url).slice().sort().join('|')}`;
}

async function getVisualDiffCheckpoint(winId) {
  const { [VD_CHECKPOINT_KEY]: all = {} } = await chrome.storage.local.get(VD_CHECKPOINT_KEY);
  return all[winId] || null;
}
// Writes go through background.js rather than chrome.storage directly:
// background.js patches the same blob per batch, and two contexts each doing
// an unlocked get -> mutate -> set silently lose whichever write read first.
// Everything that mutates VD_CHECKPOINT_KEY is serialized there
// (vdCheckpointTx); reads stay local, since a stale read is harmless. All
// three swallow send failures: checkpointing is a best-effort convenience,
// and a worker that restarted mid-message must not take down the rendered
// A/B results with it (runAbComparison's catch replaces the whole panel).
function setVisualDiffCheckpointRoot(winId, root) {
  return chrome.runtime.sendMessage({ action: 'vdCheckpointRoot', payload: { winId, root } }).catch(() => {});
}
// status 'completed' only for a run that reached its natural end — a run the
// user stopped finalizes as 'stopped' so the resume banner still offers it.
function finalizeVisualDiffCheckpoint(winId, runId, status = 'completed') {
  return chrome.runtime.sendMessage({ action: 'vdCheckpointFinalize', payload: { winId, runId, status } }).catch(() => {});
}
function clearVisualDiffCheckpoint(winId) {
  return chrome.runtime.sendMessage({ action: 'vdCheckpointClear', payload: { winId } }).catch(() => {});
}

// Optional per-variant interaction heatmap (opt-in, requires keepTabs) — reuses
// the Session Replay recording/overlay engine (sessionRecordStart/Stop,
// sessionShowOverlay/HideOverlay) against each kept-open variant tab. Sessions
// are kept in memory only, keyed by tabId, and reset on every new run.
let _abHeatmapSessions = {};       // { [tabId]: recordedSession }
let _abHeatmapRecordingTabId = null;

function abDefaultState() {
  return {
    baseUrl: '', qaMode: false, settleSec: '3', keepTabs: false, recordHeatmap: false,
    // Visual Diff and Agentic Testing are always on and no longer have
    // checkboxes; recordHeatmap stays in the state (and the code behind it
    // still works) but has no UI and is never switched on.
    visualDiff: true, visualDiffCrops: true, agenticTesting: true, summaryOfChanges: '',
    figmaUrl: '',
    // Off by default, deliberately. This writes the text every finding is
    // graded against, and it writes it by reading an image — so it is opt-in
    // rather than something that happens to a run you did not ask for.
    figmaAutofill: false,
    targets: [
      { label: 'v0', url: '', override: '' },
      { label: 'v1', url: '', override: '' },
    ],
    selectors: [],
  };
}

async function initAbCompare() {
  if (!document.getElementById('ab-target-list')) return;
  const { abCompareState } = await sessionNS.get('abCompareState');
  abState = { ...abDefaultState(), ...(abCompareState || {}) };
  // These three are no longer user-controllable, so the persisted value must
  // not win: a session saved before the checkboxes were removed carries
  // visualDiff:false / agenticTesting:false, and with no control left to flip
  // them the feature would appear permanently broken for that user.
  abState.visualDiff = true;
  abState.agenticTesting = true;
  abState.recordHeatmap = false;
  if (!Array.isArray(abState.targets) || !abState.targets.length) abState.targets = abDefaultState().targets;
  if (!Array.isArray(abState.selectors)) abState.selectors = [];

  applyAbStateToInputs();

  document.getElementById('ab-base-url').addEventListener('input',   e => { abState.baseUrl  = e.target.value;   persistAbState(); });
  document.getElementById('ab-qa-mode').addEventListener('change',   e => { abState.qaMode   = e.target.checked; persistAbState(); });
  document.getElementById('ab-settle').addEventListener('input',     e => { abState.settleSec = e.target.value;  persistAbState(); });
  document.getElementById('ab-keep-tabs').addEventListener('change', e => {
    abState.keepTabs = e.target.checked;
    persistAbState();
  });
  document.getElementById('ab-visual-diff-crops').addEventListener('change', e => {
    abState.visualDiffCrops = e.target.checked;
    persistAbState();
  });
  document.getElementById('ab-summary-of-changes').addEventListener('input', e => {
    abState.summaryOfChanges = e.target.value;
    // Which source wrote the spec is invisible once the text is in the box,
    // and the whole report is graded against it — so record it.
    abState.summarySource = e.target.value.trim() ? 'manual' : null;
    persistAbState();
  });
  document.getElementById('ab-figma-url')?.addEventListener('input', e => {
    abState.figmaUrl = e.target.value;
    persistAbState();
  });
  document.getElementById('ab-figma-autofill')?.addEventListener('change', e => {
    abState.figmaAutofill = e.target.checked;
    persistAbState();
    if (e.target.checked) autofillAbSummary();
  });

  // Board-access check. Whether view/comment access reaches the node tree is
  // the question that decides what the design reference can be built from,
  // and it is per-FILE — the token check in Settings only proves the token
  // itself is live, so it cannot answer this.
  document.getElementById('btn-ab-figma-check')?.addEventListener('click', abFigmaCheck);

  document.getElementById('btn-ab-add-target').addEventListener('click', () => {
    // Default labels continue the v0/v1/v2/… sequence used by the ticket
    // convention elsewhere (Initialize's own "+ Add Variant", isControl:
    // id==='v0'). Length-based, not a scan of existing labels — same
    // simplicity as before, just the ticket-id convention instead of letters.
    abState.targets.push({ label: 'v' + abState.targets.length, url: '', override: '' });
    renderAbTargets();
    persistAbState();
  });
  document.getElementById('btn-ab-add-selector').addEventListener('click', () => {
    abState.selectors.push('');
    renderAbSelectors();
    persistAbState();
    const inputs = document.querySelectorAll('#ab-selector-list [data-ab-sel-input]');
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById('btn-ab-save-set').addEventListener('click', saveAbSet);
  document.getElementById('btn-ab-load-set').addEventListener('click', loadAbSet);
  document.getElementById('btn-ab-delete-set').addEventListener('click', deleteAbSet);
  // "Fill from ticket" binding + refresh now lives in the fill-target
  // registry (initFillTargets), which runs later in the init chain.
  // Not a bare `runAbComparison` reference — that would hand the click
  // Event straight into opts (harmless only because every field this
  // function reads off opts happens to be absent on an Event; a trap for
  // the next option added to it).
  document.getElementById('btn-run-abcompare').addEventListener('click', () => runAbComparison());
  document.getElementById('btn-stop-abcompare').addEventListener('click', () => {
    _abVisualDiffStopRequested = true;
    // Stage 1's band calls for one page run in parallel (Promise.all) — Stop
    // can only land before/after that whole set of calls finishes, not
    // mid-band. Says so up front rather than leaving whatever mid-stage
    // status text ("Scraping…"/"Analyzing…") was last shown, unexplained,
    // until the run actually unwinds.
    setAbStatus('Stopping — this takes effect after the current page finishes its scrape/report calls…');
    chrome.runtime.sendMessage({ action: 'stop' });
  });

  initVisualDiffResumeBanner();
  checkForResumableVisualDiff();
  autofillAbSummary();
  syncAbDesignReference();

  renderAbTargets();
  renderAbSelectors();
  await refreshAbSets();
}

function applyAbStateToInputs() {
  document.getElementById('ab-base-url').value    = abState.baseUrl || '';
  document.getElementById('ab-qa-mode').checked   = !!abState.qaMode;
  document.getElementById('ab-settle').value      = abState.settleSec || '3';
  document.getElementById('ab-keep-tabs').checked = !!abState.keepTabs;
  document.getElementById('ab-visual-diff-crops').checked = abState.visualDiffCrops !== false;
  document.getElementById('ab-summary-of-changes').value = abState.summaryOfChanges || '';
  const abFigmaEl = document.getElementById('ab-figma-url');
  if (abFigmaEl) abFigmaEl.value = abState.figmaUrl || '';
  const abFigmaChk = document.getElementById('ab-figma-autofill');
  if (abFigmaChk) abFigmaChk.checked = !!abState.figmaAutofill;
}

function persistAbState() {
  sessionNS.set({ abCompareState: abState });
}

function renderAbTargets() {
  const list = document.getElementById('ab-target-list');
  const q = s => esc(s || '').replace(/"/g, '&quot;');
  list.innerHTML = abState.targets.map((t, i) => `
    <div class="ab-target" data-ab-target="${i}">
      <div class="arg-row">
        <span class="arg-lbl">Label</span>
        <input type="text" data-ab-field="label" value="${q(t.label)}" placeholder="e.g. v1">
        <button class="btn-icon" data-ab-rm-target title="Remove variant" style="color:var(--err)">✕</button>
      </div>
      <div class="arg-row">
        <span class="arg-lbl">URL</span>
        <input type="text" data-ab-field="url" value="${q(t.url)}" placeholder="(uses base URL)">
      </div>
      <div class="arg-row">
        <span class="arg-lbl">Override</span>
        <input type="text" data-ab-field="override" value="${q(t.override)}" placeholder="e.g. optimizely_x=123456">
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-ab-target]').forEach(block => {
    const i = +block.dataset.abTarget;
    block.querySelectorAll('[data-ab-field]').forEach(inp => {
      inp.addEventListener('input', () => {
        abState.targets[i][inp.dataset.abField] = inp.value;
        persistAbState();
      });
    });
    block.querySelector('[data-ab-rm-target]').addEventListener('click', () => {
      abState.targets.splice(i, 1);
      renderAbTargets();
      persistAbState();
    });
  });
}

function renderAbSelectors() {
  const list = document.getElementById('ab-selector-list');
  const q = s => esc(s || '').replace(/"/g, '&quot;');
  if (!abState.selectors.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--fg3)">None — the automatic captures (title, console, metrics) still compare.</div>';
    return;
  }
  list.innerHTML = abState.selectors.map((s, i) => `
    <div class="ab-sel-row" data-ab-sel="${i}">
      <input type="text" data-ab-sel-input value="${q(s)}" placeholder=".hero .cta, #banner …">
      <button class="btn-pick" data-pick-arg="ab-sel" title="Pick element from page">&#x1F3AF;</button>
      <button class="btn-icon" data-ab-rm-sel title="Remove" style="color:var(--err)">✕</button>
    </div>`).join('');

  list.querySelectorAll('[data-ab-sel]').forEach(row => {
    const i = +row.dataset.abSel;
    row.querySelector('[data-ab-sel-input]').addEventListener('input', e => {
      abState.selectors[i] = e.target.value;
      persistAbState();
    });
    // Same picker flow as the Build tab; the callback routes the result into
    // this row instead of a queue step.
    row.querySelector('.btn-pick').addEventListener('click', () => {
      startPicker(row, null, 'ab-sel', (selector) => {
        const val = selector.css || (selector.idValue ? '#' + selector.idValue : '');
        abState.selectors[i] = val;
        row.querySelector('[data-ab-sel-input]').value = val;
        persistAbState();
      });
    });
    row.querySelector('[data-ab-rm-sel]').addEventListener('click', () => {
      abState.selectors.splice(i, 1);
      renderAbSelectors();
      persistAbState();
    });
  });
}

// ── Saved variant target sets (chrome.storage.sync, like saved scripts) ──────
async function refreshAbSets() {
  const { abVariantSets = {} } = await chrome.storage.sync.get('abVariantSets');
  const names = Object.keys(abVariantSets).sort();
  const sel = document.getElementById('ab-set-select');
  sel.innerHTML = names.length
    ? names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : '<option disabled>&lt;no saved sets&gt;</option>';
}

async function saveAbSet() {
  const name = document.getElementById('ab-set-name').value.trim();
  if (!name) { alert('Enter a set name.'); return; }
  const { abVariantSets = {} } = await chrome.storage.sync.get('abVariantSets');
  abVariantSets[name] = JSON.parse(JSON.stringify(abState));
  await chrome.storage.sync.set({ abVariantSets });
  await refreshAbSets();
  document.getElementById('ab-set-select').value = name;
  document.getElementById('ab-set-name').value = '';
  alert(`"${name}" saved.`);
}

async function loadAbSet() {
  const name = document.getElementById('ab-set-select').value || '';
  if (!name) { alert('Select a saved set first.'); return; }
  const { abVariantSets = {} } = await chrome.storage.sync.get('abVariantSets');
  if (!abVariantSets[name]) return;
  abState = { ...abDefaultState(), ...abVariantSets[name] };
  applyAbStateToInputs();
  renderAbTargets();
  renderAbSelectors();
  persistAbState();
}

async function deleteAbSet() {
  const name = document.getElementById('ab-set-select').value || '';
  if (!name) return;
  if (!confirm(`Delete "${name}"?`)) return;
  const { abVariantSets = {} } = await chrome.storage.sync.get('abVariantSets');
  delete abVariantSets[name];
  await chrome.storage.sync.set({ abVariantSets });
  await refreshAbSets();
}

// ── Run orchestration ─────────────────────────────────────────────────────────
// Compose the final URL for one target: per-target URL (or the shared base),
// plus the override query string, plus cro_mode=qa last — mirroring the Build
// tab's Open URL behavior. Shared with the Cross-Variant Accessibility mode.
function composeVariantUrl(target, baseUrl, qaMode) {
  let url = (target.url || baseUrl || '').trim();
  if (!url) return '';
  let params = [];
  const override = (target.override || '').trim().replace(/^[?&]/, '');
  if (override) params.push(override);
  if (qaMode) {
    params = params.filter(p => !p.toLowerCase().startsWith('cro_mode='));
    params.push('cro_mode=qa');
  }
  if (params.length) url += (url.includes('?') ? '&' : '?') + params.join('&');
  return url;
}

function abComposeUrl(target) {
  return composeVariantUrl(target, abState.baseUrl, abState.qaMode);
}

let _abProgressPoller = null;

// Resume banner is built here rather than in popup.html/sidepanel.html —
// this file is loaded by both, and the two host files are hand-synced
// duplicates that must be edited together for any markup change; a purely
// JS-constructed, idempotent insertion avoids that risk for a small, opt-in
// piece of UI. Inserted once, as a sibling immediately before #ab-results.
function initVisualDiffResumeBanner() {
  if (document.getElementById('ab-visual-diff-resume-banner')) return;
  const resultsEl = document.getElementById('ab-results');
  if (!resultsEl) return;
  resultsEl.insertAdjacentHTML('beforebegin', `
    <div id="ab-visual-diff-resume-banner" class="a11y-summary-bar" style="display:none;margin-bottom:8px">
      <span data-vd-resume-text style="font-size:11px"></span>
      <div class="row" style="gap:6px">
        <button class="btn primary sm" data-vd-resume>Resume</button>
        <button class="btn ghost sm" data-vd-discard>Discard</button>
      </div>
    </div>`);
  const banner = document.getElementById('ab-visual-diff-resume-banner');
  banner.querySelector('[data-vd-resume]').addEventListener('click', () => {
    const cp = JSON.parse(banner.dataset.checkpoint || 'null');
    if (cp) runAbComparison({ resumeCheckpoint: cp });
  });
  banner.querySelector('[data-vd-discard]').addEventListener('click', async () => {
    await clearVisualDiffCheckpoint(WIN_ID);
    hideVisualDiffResumeBanner();
  });
}

function hideVisualDiffResumeBanner() {
  const banner = document.getElementById('ab-visual-diff-resume-banner');
  if (banner) banner.style.display = 'none';
}

// Concatenates every ticket variant's already-extracted description (from
// the ticket's Test Specifications section, see extractTestContext) into
// one readable block — the auto-fill source for the standalone Summary of
// Changes box. No new ticket parsing: this is the same per-variant text
// Visual Diff used to resolve individually before it became one shared
// summary for every variant.
function buildSummaryFromTicketVariants(ctx) {
  return (ctx.variants || [])
    .filter(v => (v.rawDescription || '').trim())
    .map(v => `${v.id}${v.isControl ? ' (Control)' : ''}: ${v.rawDescription.trim()}`)
    .join('\n\n');
}

// Auto-fills the Summary of Changes box from the active ticket, but ONLY
// when the box is currently empty — a user's own manual edits are never
// silently overwritten. Called alongside checkForResumableVisualDiff (same
// two call sites: showTab('abtest') and initAbCompare's panel-load), so a
// ticket committed in Initialize after the A/B tab was already visited
// still fills the box the next time the user switches back to this tab.
// Reads the Variation labels off the board, when a link and a token are both
// available. Returns [] rather than throwing on any failure — a summary that
// falls back to the image alone is a degraded result, not a broken run.
async function figmaFetchVariationLabels(url) {
  if (!url || !figmaParseUrl(url)) return [];
  const res = await chrome.runtime.sendMessage({ action: 'figmaFetchNodes', url, depth: 4 })
    .catch(() => null);
  if (!res?.ok) return [];
  return figmaClassifyChildren(res.node?.children || []).labels || [];
}

// Same shape buildSummaryFromTicketVariants produces, so the report prompt
// sees one format regardless of which source filled the box.
function buildSummaryFromFigmaVariants(variants) {
  return (variants || [])
    .filter(v => (v.changes || '').trim())
    .map(v => {
      const isControl = String(v.id || '').toLowerCase() === 'v0';
      const name = (v.name || '').trim();
      return `${v.id}${isControl ? ' (Control)' : ''}: ${name ? name + ' — ' : ''}${v.changes.trim()}`;
    })
    .join('\n\n');
}

// Fills Summary of Changes from the design comp, but ONLY when the box is
// still empty after the ticket has had its turn. Ticket text keeps precedence
// deliberately: it quotes the ticket verbatim, whereas this puts a model's
// reading of an image into the box that decides expected vs unexpected for
// every finding in the report. That is a real trade, so it runs second, it
// never overwrites, and it records itself as the source in the debug log.
//
// Two sources, and the cheaper one is not the fallback:
//   * Variation labels from the node tree are EXACT strings, so when they are
//     available they anchor the read rather than leaving the model to work
//     the variant ids out of the pixels.
//   * The comp image carries the detail. Labels alone give a name per variant
//     and no description of what changed, which is thin but still better than
//     an empty box — an empty box makes every finding "unclear" by
//     construction.
async function autofillAbSummaryFromFigma() {
  if (!abState || !abState.figmaAutofill) return;
  if ((abState.summaryOfChanges || '').trim()) return;

  const ctx = await getActiveContext().catch(() => null);
  const url = (abState.figmaUrl || '').trim() || (ctx?.reviewed ? ctx.figmaUrl : null);
  const compDataUrl = ctx?.reviewed ? await getCompImage(ctx) : null;
  if (!url && !compDataUrl) return;

  // Board renders are the preferred input, not an optimisation. The four-up
  // attachment cannot carry legible fine print — see figmaRenderBoards in
  // background.js for the arithmetic — and the comp is only the fallback for
  // when there is no token.
  let labels = [], boards = [];
  if (url) {
    const res = await chrome.runtime.sendMessage({ action: 'figmaFetchNodes', url, depth: 4 }).catch(() => null);
    if (res?.ok) {
      const c = figmaClassifyChildren(res.node?.children || []);
      labels = c.labels || [];
      const ids = [...new Set([...c.boards.map(b => b.variantId), ...labels.map(l => l.variantId)].filter(Boolean))].sort();
      const picks = ids
        .map(id => ({ id, sel: figmaSelectDesktopBoard(c.boards, id), label: labels.find(l => l.variantId === id) }))
        .filter(p => p.sel.board);
      if (picks.length) {
        const rendered = await chrome.runtime.sendMessage({
          action: 'figmaRenderBoards', url, nodeIds: picks.map(p => p.sel.board.nodeId),
        }).catch(e => ({ ok: false, error: e.message }));
        if (rendered?.ok) {
          boards = picks
            .map(p => ({ variantId: p.id, name: p.label?.changeName || p.sel.board.name, dataUrl: rendered.images[p.sel.board.nodeId] }))
            .filter(b => b.dataUrl);
          (rendered.failures || []).forEach(f => console.warn('[Selenite] Board render failed:', f));
        } else {
          console.warn('[Selenite] Board render failed —', rendered?.error);
        }
      }
    }
  }

  if (!boards.length && !compDataUrl && !labels.length) return;

  let summary = '', source = null;

  if (boards.length || compDataUrl) {
    const res = await chrome.runtime.sendMessage({
      action: 'figmaSummarizeComp',
      payload: { boards, compDataUrl, labels, ticketKey: ctx?.ticketKey || null },
    }).catch(e => ({ ok: false, error: e.message }));

    if (res?.ok) {
      summary = buildSummaryFromFigmaVariants(res.variants);
      // The source string records HOW the spec was read, not just that it was
      // — the report prompt keys "absence means unclear" off the figma- prefix,
      // and the whole-sheet path is materially less trustworthy than per-board.
      source = res.perBoard ? 'figma-boards' : (res.usedFileLabels ? 'figma-comp+labels' : 'figma-comp');
      (res.flags || []).forEach(f => console.warn('[Selenite] Design read flag:', f));
    } else {
      console.warn('[Selenite] Design summary failed —', res?.error || 'no response');
    }
  }

  // Labels-only path: no images, or the vision call failed. No model at all
  // here — these are the designer's own strings.
  if (!summary && labels.length) {
    summary = labels
      .filter(l => l.variantId)
      .map(l => `${l.variantId}${l.variantId === 'v0' ? ' (Control)' : ''}: ${l.changeName || '(unnamed board)'}`)
      .join('\n\n');
    source = summary ? 'figma-labels' : null;
  }

  if (!summary) return;
  // Re-check: the render + vision round trip takes seconds, and the user may
  // have typed into the box meanwhile. Never clobber that.
  if ((abState.summaryOfChanges || '').trim()) return;

  abState.summaryOfChanges = summary;
  abState.summarySource = source;
  persistAbState();
  const el = document.getElementById('ab-summary-of-changes');
  if (el) el.value = summary;
  const note = document.getElementById('ab-figma-out');
  if (note) {
    const weak = source !== 'figma-boards' && source !== 'figma-labels';
    note.innerHTML = `<div style="color:var(--warn)">Summary of Changes was written from the design (${esc(source)}) — read it before running, it decides how every finding is graded.`
      + (weak ? ' It was read from the multi-board comp image, where small text may be illegible, so it is likely incomplete.' : '')
      + '</div>';
  }
}

// Ticket first, comp second — both only fill an empty box, so the order IS
// the precedence. Awaited in sequence rather than fired in parallel: run
// concurrently they would both see an empty box and race to write it.
async function autofillAbSummary() {
  await autofillAbSummaryFromTicket();
  await autofillAbSummaryFromFigma();
}

// ── Design reference (A/B tab) ──────────────────────────────────────────────
// The Figma board URL and the comp attachment both come off the ticket during
// Initialize and both describe the ticket as a whole, not a single variant —
// one comp covers every board on it.
//
// The URL is editable and persisted here rather than in the Initialize review
// step, because this is where it gets used and where a wrong board is noticed.
// Same only-when-empty contract as the Summary of Changes autofill: an
// extracted value fills an empty box and never overwrites a manual edit.
//
// The comp is deliberately READ-ONLY here. Re-fetching a different attachment
// needs the Jira session cookie, and by the time a comparison runs the context
// is incognito with no session — so a picker in this tab could offer choices
// it cannot actually retrieve. Ambiguity is surfaced instead, and resolved by
// re-extracting in Initialize.
async function syncAbDesignReference() {
  const urlEl = document.getElementById('ab-figma-url');
  const compEl = document.getElementById('ab-figma-comp');
  if (!urlEl && !compEl) return;

  const ctx = await getActiveContext().catch(() => null);

  if (urlEl && !(abState.figmaUrl || '').trim() && ctx?.reviewed && ctx.figmaUrl) {
    abState.figmaUrl = ctx.figmaUrl;
    urlEl.value = ctx.figmaUrl;
    persistAbState();
  }

  if (!compEl) return;
  const line = (t, color) => `<div style="color:${color || 'var(--fg3)'}">${esc(t)}</div>`;

  if (!ctx?.reviewed) { compEl.innerHTML = line('No active ticket context — extract one in Initialize to pick up the comp automatically.'); return; }

  if (ctx.compAttachment) {
    const c = ctx.compAttachment;
    const img = await getCompImage(ctx);
    compEl.innerHTML = line(`Comp: ${c.filename} — ${c.w}×${c.h}${c.srcW ? ` (from ${c.srcW}×${c.srcH})` : ''}`, 'var(--ok)')
      + (img ? `<img src="${esc(img)}" alt="Comp preview" style="max-width:100%;max-height:120px;border:1px solid var(--stroke);border-radius:4px;margin-top:4px">` : line('Stored image could not be read back.', 'var(--warn)'));
    return;
  }

  const n = (ctx.compCandidates || []).length;
  compEl.innerHTML = n
    ? line(`No attachment matched ${ctx.ticketKey}_comp. ${n} other image(s) are attached — rename the comp on the ticket and re-extract to pick it up.`, 'var(--warn)')
    : line('No image attachments on this ticket — the Figma link is the only design reference.');
}

// Reads the board and reports what it found, inline. Runs against whatever is
// currently in the box, not the saved context, so a pasted board can be
// checked before it is committed to anything.
async function abFigmaCheck() {
  const out = document.getElementById('ab-figma-out');
  const url = (document.getElementById('ab-figma-url')?.value || '').trim();
  if (!out) return;
  const line = (t, color) => `<div style="color:${color || 'var(--fg3)'}">${esc(t)}</div>`;

  if (!url) { out.innerHTML = line('Paste a Figma board link first.', 'var(--warn)'); return; }
  if (!figmaParseUrl(url)) { out.innerHTML = line('That is not a Figma design link — expected figma.com/design/… or /file/….', 'var(--err)'); return; }

  out.innerHTML = line('Checking…');
  const res = await chrome.runtime.sendMessage({ action: 'figmaFetchNodes', url, depth: 4 })
    .catch(e => ({ ok: false, error: e.message }));
  if (!res?.ok) { out.innerHTML = line(res?.error || 'No response from the background worker.', 'var(--err)'); return; }

  const node = res.node || {};
  const c = figmaClassifyChildren(node.children || []);
  const rows = [line(`Read "${res.fileName || '(unnamed file)'}" — access role: ${res.role || 'unknown'}`, 'var(--ok)')];
  rows.push(line(`Node "${node.name || node.id}" (${node.type}) — ${(node.children || []).length} children`));

  if (!c.boards.length) {
    // The actionable case. A comp whose boards don't follow the v{n}
    // convention looks identical to a comp with no boards unless the rejects
    // are shown, and that distinction is the whole fix.
    rows.push(line('No boards matched the v{n} naming convention.', 'var(--warn)'));
    (c.rejected || []).slice(0, 8).forEach(r => rows.push(line(`  · ${r.name} (${r.type}) — ${r.reason}`)));
  } else {
    c.boards.forEach(b => rows.push(line(
      `  · ${b.name} → ${b.variantId}/${b.breakpoint || 'no breakpoint'}, measured ${b.measuredWidth}px`
        + (b.widthDisagrees ? `  ⚠ name says ${b.nominalWidth}px` : ''),
      b.widthDisagrees ? 'var(--warn)' : 'var(--fg2)')));
  }

  if (c.labels.length) c.labels.forEach(l => rows.push(line(`  · label "${l.text}" → ${l.variantId || 'unmapped'}`, 'var(--fg2)')));
  else rows.push(line('No Variation label blocks found — board→variant mapping falls back to board names.', 'var(--warn)'));

  out.innerHTML = rows.join('');
}

async function autofillAbSummaryFromTicket() {
  if (!abState || (abState.summaryOfChanges || '').trim()) return;
  const ctx = await getActiveContext().catch(() => null);
  if (!ctx?.reviewed) return;
  const summary = buildSummaryFromTicketVariants(ctx);
  if (!summary) return;
  abState.summaryOfChanges = summary;
  abState.summarySource = 'ticket';
  persistAbState();
  const el = document.getElementById('ab-summary-of-changes');
  if (el) el.value = summary;
}

// Checked on panel load. A checkpoint whose signature doesn't match the
// CURRENT ticket context + targets is ignored outright — never silently
// resume a run against a different page or ticket.
async function checkForResumableVisualDiff() {
  const banner = document.getElementById('ab-visual-diff-resume-banner');
  if (!banner) return;
  const cp = await getVisualDiffCheckpoint(WIN_ID);
  if (!cp || cp.status === 'completed') { banner.style.display = 'none'; return; }

  const ctx = await getActiveContext().catch(() => null);
  const targets = abState.targets
    .map(t => ({ label: (t.label || '').trim() || 'Variant', url: abComposeUrl(t) }))
    .filter(t => t.url);
  if (cp.signature !== computeVisualDiffRunSignature(ctx, targets)) { banner.style.display = 'none'; return; }

  const perVariant = cp.perVariant || {};
  const doneCount = Object.values(perVariant).filter(v => v.status === 'done').length;
  const totalCount = Object.keys(perVariant).length;
  banner.dataset.checkpoint = JSON.stringify(cp);
  banner.querySelector('[data-vd-resume-text]').textContent =
    `A previous Visual Diff run didn't finish (${new Date(cp.updatedAt).toLocaleString()}). ${doneCount} of ${totalCount || '?'} variant${totalCount !== 1 ? 's' : ''} were analyzed.`;
  banner.style.display = '';
}

// Sets the single status line #ab-results shows for the whole run — matching
// Test Agent's own one-line-status + report-tab pattern (runTestAgent's
// `status.textContent = ...`) rather than the incremental live result
// rendering this replaced. #ab-heatmap-block stays a permanent sibling so
// renderAbHeatmapBlock (a genuinely live tool tied to open tabs — recording a
// walk only makes sense while the variant tabs are still around, unlike a
// static report) keeps working exactly as before.
function setAbStatus(text, { error = false } = {}) {
  const resultsEl = document.getElementById('ab-results');
  if (!resultsEl) return;
  if (!resultsEl.querySelector('#ab-status')) {
    resultsEl.innerHTML = `<div id="ab-status" style="font-size:12px;text-align:center;padding:10px 0"></div><div id="ab-heatmap-block"></div>`;
  }
  const statusEl = resultsEl.querySelector('#ab-status');
  statusEl.style.color = error ? 'var(--err)' : 'var(--fg3)';
  statusEl.textContent = text;
}

async function runAbComparison(opts = {}) {
  const btn       = document.getElementById('btn-run-abcompare');
  const stopBtn   = document.getElementById('btn-stop-abcompare');

  const targets = abState.targets
    .map(t => ({ label: (t.label || '').trim() || 'Variant', url: abComposeUrl(t) }))
    .filter(t => t.url);
  if (targets.length < 2) {
    setAbStatus('Define at least two variant targets with a URL (or set a base URL).');
    return;
  }

  const metricsList = metrics.filter(m => m.enabled !== false && (m.pattern || '').trim());
  const selectors   = abState.selectors.map(s => s.trim()).filter(Boolean);

  // A new run invalidates any in-memory heatmap recordings from the last one
  // (their variant tabs are about to be replaced or closed).
  _abHeatmapSessions = {};
  _abHeatmapRecordingTabId = null;
  _abVisualDiffStopRequested = false;
  hideVisualDiffResumeBanner();

  // Resolved up front, before capture, purely so the deterministic sections'
  // baseline (captures[0] after the reorder below) and Visual Diff's own
  // baseline can never disagree (see resolveAbBaseline's own comment for why
  // URL, not label, is the source of truth, and for the first-target
  // fallback). Passed through to runVisualDiffPipeline below too, so it
  // isn't re-resolved.
  let ctx = null, controlLabel = null;
  const resumeCheckpoint = opts.resumeCheckpoint || null;
  if (abState.visualDiff) {
    ctx = await getActiveContext().catch(() => null);
    controlLabel = resolveAbBaseline(ctx, targets)?.label ?? null;
  }

  // Test Agent passes this explicitly, from its own shared checkbox — a
  // standalone run from the A/B tab falls back to that tab's own toggle.
  const agenticTesting = opts.agenticTesting !== undefined ? !!opts.agenticTesting : !!abState.agenticTesting;
  // TA_MODES['2'].run sets this true: runTestAgent() opens its OWN single
  // combined report at the end of the whole queued sequence (getData() below
  // feeds rptAbSection there, same as always) — this run must not ALSO pop
  // its own separate report tab, or queuing A/B in Test Agent would open two
  // tabs for one run.
  const fromTestAgent = !!opts.fromTestAgent;

  btn.disabled = true;
  btn.textContent = 'Running…';
  if (stopBtn) stopBtn.style.display = '';
  setAbStatus('Loading variants…');

  _abProgressPoller = setInterval(async () => {
    const { abProgress } = await sessionNS.get('abProgress');
    if (abProgress?.running) {
      btn.textContent = `Running ${abProgress.index + 1}/${abProgress.total}…`;
      setAbStatus(`Loading ${abProgress.label} (${abProgress.index + 1} of ${abProgress.total})…`);
    }
  }, 400);

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'runVariantComparison',
      payload: {
        targets, settleSeconds: abState.settleSec, keepTabs: abState.keepTabs, selectors, winId: WIN_ID,
        agenticTesting, visualDiff: !!abState.visualDiff,
      },
    });
    if (!res?.ok) throw new Error(res?.error || 'Comparison failed');

    // Two independent notions of "which target is Control" otherwise coexist
    // in one report: the deterministic section below always treats index 0
    // as the baseline, while Visual Diff resolves Control from the ticket's
    // forced-variant-id convention. Nothing sorts Control to index 0 ("Fill
    // from ticket" populates targets in ctx.previewLinks order), so
    // "Baseline: X" and "Visual Diff vs Y" could name different targets.
    // Reordering here makes the ticket-resolved Control govern both. Only
    // applies when Visual Diff is on — that's the only time controlLabel is
    // resolved, and with it off there's no second mechanism to disagree with.
    let captures = res.results;
    if (controlLabel) {
      const ci = captures.findIndex(c => c.label === controlLabel);
      if (ci > 0) captures = [captures[ci], ...captures.filter((_, i) => i !== ci)];
    }

    _abLastRun = { captures, metricsList, selectors, ts: Date.now(), agenticNote: res.agenticNote || null };
    if (abState.keepTabs && abState.recordHeatmap) renderAbHeatmapBlock();

    if (abState.visualDiff) setAbStatus('Comparing visuals…');
    const visualDiffResult = await runVisualDiffPipeline(captures, {
      ctx, resumeCheckpoint, onStatus: (text) => setAbStatus(text),
    });
    // Metadata-only mirror on _abLastRun (no crops) — this is what
    // getData()/rptAbSection see via the Test-Agent-queued path, and what
    // the AI summarize-results prompt reads; a crop's base64 data URL has no
    // business in a text-summarization prompt or that combined report.
    if (visualDiffResult) {
      _abLastRun.visualDiff = visualDiffResult.skipped
        ? { skipped: true, reason: visualDiffResult.reason }
        : {
            skipped: false, baselineLabel: visualDiffResult.baselineLabel,
            baselineWarning: visualDiffResult.baselineWarning,
            sharedFindingCount: (visualDiffResult.sharedFindings || []).length,
            perVariant: (visualDiffResult.perVariant || []).map(v => ({
              label: v.label, skipped: v.skipped, reason: v.reason, error: v.error,
              controlDuplicate: v.controlDuplicate,
              overallSummary: v.overallSummary, structuralStats: v.structuralStats,
              truncatedFindingCount: v.truncatedFindingCount, noVerdictCount: v.noVerdictCount,
              duplicateIndexCount: v.duplicateIndexCount, truncated: v.truncated, pixelDiff: v.pixelDiff,
              fullPageTruncated: v.fullPageTruncated, resumed: v.resumed, noSpecText: v.noSpecText,
              // Diff diagnostics ride along on this mirror too. It exists to
              // keep crops out of the text-summarization prompt, and these are
              // small text-only counters — without them a Test-Agent-queued
              // run (which only ever sees this mirror, never visualDiffFull)
              // would export a debug log with no diff diagnostics at all,
              // which is the run most likely to need them.
              aggregate: v.aggregate, diffMode: v.diffMode, matchedFraction: v.matchedFraction,
              matchTierCounts: v.matchTierCounts, diffDebug: v.diffDebug,
              findingCount: v.findings ? v.findings.length : 0,
              // noSpecText variants carry no expected/unexpected verdicts at all — every
              // finding for them lands in unclearCount instead, so a no-spec run's real
              // finding count isn't silently reported as zero.
              unexpectedCount: v.findings ? v.findings.filter(f => f.classification === 'unexpected').length : 0,
              unclearCount: v.findings ? v.findings.filter(f => f.classification === 'unclear').length : 0,
            })),
          };
    }

    if (fromTestAgent) {
      setAbStatus('Done — included in the Test Agent report.');
    } else {
      // Built fresh here, NOT from _abLastRun/getData(): visualDiffFull is
      // the LIVE runVisualDiffPipeline result, crops included, and is only
      // ever read by rptAbVisualDiffSection on this standalone path.
      setAbStatus('Building report…');
      const { figmaPat: _figmaPat } = await chrome.storage.sync.get('figmaPat');
      await openReportTab({
        ts: Date.now(), pageUrls: [],
        modes: [{
          mode: 2, name: 'A/B Variant Comparison', status: 'ran',
          data: { captures, metricsList, selectors, agenticNote: res.agenticNote || null, visualDiffFull: visualDiffResult },
        }],
        designReference: buildDesignReferenceDebug(ctx, abState, _figmaPat),
        extraHtml: '',
      });
      setAbStatus('Done — report opened in a new tab.');
    }
  } catch (e) {
    setAbStatus('Error: ' + e.message, { error: true });
  } finally {
    clearInterval(_abProgressPoller);
    _abProgressPoller = null;
    btn.disabled = false;
    btn.textContent = 'Run Comparison';
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

// ── Diffing ───────────────────────────────────────────────────────────────────
// All comparison logic lives here; captures[0] is the baseline. Returns a
// structure the renderer walks — no DOM concerns in this function.
function diffAbCaptures(captures, metricsList, selectors) {
  // Defensive: an in-memory _abLastRun captured before this build's migration
  // (report replay, popup.js:4393) may still hold the old string[] shape.
  const metricEntries = normalizeMetricsList(metricsList);
  const texts = c => (c.console || []).map(l => l.text);
  const stripUrl = (u) => {
    try { const p = new URL(u); return p.origin + p.pathname; } catch (_) { return u || ''; }
  };
  const base = captures[0];

  // Page basics — override params make full URLs differ by design, so URL
  // mismatch means origin+path, not query string.
  const basics = captures.map((c, i) => ({
    label: c.label, title: c.title || '', finalUrl: c.finalUrl || '', loadError: c.loadError || null,
    titleDiff: i > 0 && !c.loadError && c.title !== base.title,
    urlDiff:   i > 0 && !c.loadError && stripUrl(c.finalUrl) !== stripUrl(base.finalUrl),
  }));

  // Watched selectors — per selector, one flattened fact row per variant, with
  // the list of fact keys that differ from the baseline row.
  const FACT_KEYS = ['exists', 'visible', 'text', 'display', 'visibility', 'color', 'background-color'];
  const flat = f => f && {
    exists: f.exists, visible: f.visible, text: f.text || '',
    display: f.styles?.display ?? '', visibility: f.styles?.visibility ?? '',
    color: f.styles?.color ?? '', 'background-color': f.styles?.['background-color'] ?? '',
  };
  const selectorRows = selectors.map((sel, si) => {
    const rows  = captures.map(c => flat((c.selectors || [])[si]));
    const diffs = rows.map((r, i) => {
      if (i === 0 || !r || !rows[0]) return [];
      return FACT_KEYS.filter(k => String(r[k]) !== String(rows[0][k]));
    });
    const missing = rows.map(r => !r);
    const allSame = rows.every(Boolean) && diffs.every(d => !d.length);
    return { selector: sel, rows, diffs, missing, allSame };
  });

  // Metrics — fire counts against tagged lines, via each entry's own match
  // mode (mtMatch, shared with the Metric Tracker and Track Metric). This
  // function is synchronous and called from a render path, so it always
  // scores at 'balanced' sensitivity rather than plumbing the async global
  // setting through — the global only governs the Tracker and Track Metric.
  const metricRows = metricEntries.map(m => {
    const counts = captures.map(c => texts(c).filter(t => mtMatch(m, t, { sensitivity: 'balanced' }).hit).length);
    const fired    = counts.map(c => c > 0);
    return {
      metric: m.label || m.pattern, counts,
      allSame: counts.every(c => c === counts[0]),
      mixedFiring: fired.some(Boolean) && !fired.every(Boolean),   // fired somewhere but not everywhere
    };
  });

  // Console — added/missing tagged lines per variant vs baseline; lines present
  // in every variant are the collapsed "shared" set.
  const baseSet = new Set(texts(base));
  const consoleRows = captures.map((c, i) => {
    if (i === 0) return { label: c.label, added: [], missing: [] };
    const set = new Set(texts(c));
    return {
      label: c.label,
      added:   [...set].filter(t => !baseSet.has(t)),
      missing: [...baseSet].filter(t => !set.has(t)),
    };
  });
  const shared = [...baseSet].filter(t =>
    captures.slice(1).every(c => texts(c).includes(t)));

  // Errors — always flagged regardless of diff status.
  const errors = captures.map(c => ({
    label: c.label,
    loadError: c.loadError || null,
    jsErrors: c.errors || [],
  })).filter(e => e.loadError || e.jsErrors.length);

  return { basics, selectorRows, metricRows, consoleRows, shared, errors };
}

// ── Visual Diff (A/B Variant Comparison, opt-in) ────────────────────────────
// 3-stage pipeline: Sonnet scrapes each page (background.js, vision + DOM),
// this file diffs the two scrapes (pure JS, no network), Opus analyzes the
// diff and writes the report (background.js). Replaces the earlier
// pixel/row-hash-alignment pipeline entirely — see VISUAL_DIFF_ISSUES.md and
// CHANGELOG.md for why. No pixel work happens in this file at all; it only
// orchestrates messages and does the Stage-2 diff math.

// ── The local diff now lives in vd-diff.js ─────────────────────────────────
// Everything that used to be here — blockSimilarity, needlemanWunschAlign,
// diffPageScrapes, vdChangeSignals, rankAndCapDiffFindings, and the
// vdBoxesOverlap/vdNormalizeTokens/vdTokenSimilarity helpers — moved into
// extension/vd-diff.js and runs in background.js now. Two reasons, both
// load-bearing: the diff's inputs (two full DOM-candidate lists) already live
// in the worker and shipping them here would newly cross ~1MB over
// sendMessage, and vd-diff.js as a plain globalThis IIFE can be load()ed
// directly by jsc, so the matching logic is unit-testable with no browser and
// no extraction step. This panel still reads those functions as bare globals
// (vd-diff.js is loaded before popup.js in both popup.html and
// sidepanel.html) — nothing here needs to import anything.

// ── Visual Diff diagnostics (console-only, never wired into the UI) ────────
// window.__vdDebug — call from the panel's OWN DevTools console (right-click
// the side panel → Inspect). Deliberately no chrome.storage flag, no
// checkbox, no settings surface: a normal user never opens DevTools on this
// panel, so this is the cheapest possible zero-footprint hidden affordance,
// consistent with keeping the real A/B workflow exactly as seamless as
// before. Navigate to the target page yourself before calling this.
//
// scrapeStabilityCheck() is gone with the Sonnet scrape stage it measured:
// it existed to quantify how much the model's semantic grouping varied
// between two runs of the SAME page, and there is no model in the parse path
// any more for that number to be nonzero.
async function vdShowCandidateOverlay() {
  const res = await chrome.runtime.sendMessage({ action: 'vdShowCandidateOverlay' });
  if (!res?.ok) console.error('[vdDebug] Failed:', res?.error);
  else console.log(`[vdDebug] Drew ${res.count} candidate rects on the active tab — click anywhere or press Esc to clear.`);
  return res;
}

// ── Figma reference diagnostics ────────────────────────────────────────────
// Same console-only contract as showCandidateOverlay above — no storage flag,
// no checkbox, no settings surface. Both take the Figma URL as an argument
// rather than reading it from the active context, so a board can be probed
// before Phase 0 extraction exists to supply one, and so a board that ISN'T
// on the current ticket can be checked when a convention is in doubt.
//
// figmaFile is the go/no-go on PAT file access. figmaVerifyToken (the Save
// button in Test Agent → Figma Access) deliberately cannot answer this: it
// calls /v1/me, which proves the token is live and says nothing about whether
// any particular file is readable at view/comment access.
async function vdFigmaFile(url, depth) {
  const res = await chrome.runtime.sendMessage({ action: 'figmaFetchNodes', url, depth });
  if (!res?.ok) { console.error('[vdDebug] Figma fetch failed —', res?.error || 'no response from worker'); return res; }
  const n = res.node || {};
  const b = n.absoluteBoundingBox;
  const kids = n.children || [];
  console.log(`[vdDebug] file "${res.fileName || '(unnamed)'}" — modified ${res.lastModified || '?'} — role ${res.role || 'unknown'} — editor ${res.editorType || 'unknown'}`);
  console.log(`[vdDebug] node ${n.id} "${n.name}" (${n.type})${b ? ` ${Math.round(b.width)}\u00d7${Math.round(b.height)}` : ''} — ${kids.length} direct children at depth=${res.depth}`);
  console.table(kids.map(c => ({
    id: c.id, name: c.name, type: c.type,
    w: c.absoluteBoundingBox ? Math.round(c.absoluteBoundingBox.width) : null,
    h: c.absoluteBoundingBox ? Math.round(c.absoluteBoundingBox.height) : null,
    visible: c.visible !== false,
    kids: (c.children || []).length,
  })));
  return res;
}

// Board classification over those children. Prints the rejects too, with the
// reason on each: a comp whose boards don't match the v{n} convention looks
// identical to a comp with no boards unless the filter says what it dropped.
async function vdFigmaBoards(url) {
  const res = await chrome.runtime.sendMessage({ action: 'figmaFetchNodes', url, depth: 4 });
  if (!res?.ok) { console.error('[vdDebug] Figma fetch failed —', res?.error || 'no response from worker'); return res; }

  const node = res.node || {};
  const c = figmaClassifyChildren(node.children || []);
  console.log(`[vdDebug] "${node.name}" — ${c.boards.length} board(s), ${c.labels.length} Variation label(s), ${c.rejected.length} other child node(s)`);

  console.table(c.boards.map(b => ({
    nodeId: b.nodeId, name: b.name, variant: b.variantId, breakpoint: b.breakpoint || '(none)',
    measuredW: b.measuredWidth, nominalW: b.nominalWidth,
    // Flagged rather than reconciled. A board named 1440px that measures 1280
    // means every scale factor derived from the name is off by 12%, and the
    // measured number is the only one anything is allowed to use.
    widthDisagrees: b.widthDisagrees,
  })));

  if (c.labels.length) {
    console.table(c.labels.map(l => ({ nodeId: l.nodeId, text: l.text, variant: l.variantId, changeName: l.changeName })));
  } else {
    console.warn('[vdDebug] No Variation label blocks found — board→variant mapping and the link-sourced summary both read from these.');
  }

  const unmapped = c.labels.filter(l => !l.variantId);
  if (unmapped.length) console.warn(`[vdDebug] ${unmapped.length} label(s) don't match the "V0 CONTROL" format — mapping falls back to board names for those.`);

  if (c.rejected.length) console.table(c.rejected.map(r => ({ name: r.name, type: r.type, reason: r.reason })));

  // What board selection would actually pick, per variant id seen on any
  // board or label — the question the caller is really asking.
  const ids = [...new Set([...c.boards.map(b => b.variantId), ...c.labels.map(l => l.variantId)].filter(Boolean))].sort();
  const picks = ids.map(id => {
    const sel = figmaSelectDesktopBoard(c.boards, id);
    const label = c.labels.find(l => l.variantId === id);
    return {
      variant: id,
      board: sel.board ? sel.board.name : '(none — desktop board missing)',
      via: sel.via || '-',
      changeName: label ? (label.changeName || '(label has no name)') : '(no label)',
    };
  });
  if (picks.length) console.table(picks);

  return { node, boards: c.boards, labels: c.labels, rejected: c.rejected, picks };
}

// Dry-run of the Summary of Changes autofill: performs the read and returns
// everything it produced WITHOUT writing to the box. The point is to be able
// to inspect what the model said about the comp before that text becomes the
// thing every finding is graded against — once it is in the box, the report
// treats it as fact.
async function vdFigmaSummary() {
  const ctx = await getActiveContext().catch(() => null);
  const url = (abState?.figmaUrl || '').trim() || (ctx?.reviewed ? ctx.figmaUrl : null);
  const compDataUrl = ctx?.reviewed ? await getCompImage(ctx) : null;

  console.log(`[vdDebug] ticket ${ctx?.ticketKey || '(none)'} — link ${url ? 'yes' : 'no'}, comp image ${compDataUrl ? 'yes' : 'no'}, autofill ${abState?.figmaAutofill ? 'ON' : 'OFF'}`);
  if (!url && !compDataUrl) { console.warn('[vdDebug] Nothing to read.'); return null; }

  let labels = [], boards = [];
  if (url) {
    const res = await chrome.runtime.sendMessage({ action: 'figmaFetchNodes', url, depth: 4 }).catch(() => null);
    if (res?.ok) {
      const c = figmaClassifyChildren(res.node?.children || []);
      labels = c.labels || [];
      const ids = [...new Set([...c.boards.map(b => b.variantId), ...labels.map(l => l.variantId)].filter(Boolean))].sort();
      const picks = ids
        .map(id => ({ id, sel: figmaSelectDesktopBoard(c.boards, id), label: labels.find(l => l.variantId === id) }))
        .filter(p => p.sel.board);
      console.log(`[vdDebug] ${labels.length} label(s), ${picks.length} desktop board(s) to render:`, picks.map(p => p.id + '=' + p.sel.board.nodeId));
      if (picks.length) {
        const rendered = await chrome.runtime.sendMessage({
          action: 'figmaRenderBoards', url, nodeIds: picks.map(p => p.sel.board.nodeId),
        }).catch(e => ({ ok: false, error: e.message }));
        if (rendered?.ok) {
          boards = picks
            .map(p => ({ variantId: p.id, name: p.label?.changeName || p.sel.board.name, dataUrl: rendered.images[p.sel.board.nodeId] }))
            .filter(b => b.dataUrl);
          console.log('[vdDebug] rendered board sizes (base64 chars):', boards.map(b => b.variantId + '=' + b.dataUrl.length));
          (rendered.failures || []).forEach(f => console.warn('[vdDebug] render failure:', f));
        } else console.error('[vdDebug] Board render failed —', rendered?.error);
      }
    }
  }

  if (!boards.length && !compDataUrl) { console.warn('[vdDebug] No images — the autofill would use labels only.'); return { labels }; }
  if (!boards.length) console.warn('[vdDebug] Falling back to the four-up comp image; small text will not be legible.');

  const res = await chrome.runtime.sendMessage({
    action: 'figmaSummarizeComp',
    payload: { boards, compDataUrl, labels, ticketKey: ctx?.ticketKey || null },
  }).catch(e => ({ ok: false, error: e.message }));

  if (!res?.ok) { console.error('[vdDebug] Summary failed —', res?.error, res?.raw || ''); return res; }
  console.log(`[vdDebug] perBoard=${res.perBoard} (${res.boardCount} board image(s)), anchored on file labels=${res.usedFileLabels}`);
  if (res.truncated) console.warn('[vdDebug] Response hit max_tokens — incomplete.');
  (res.flags || []).forEach(f => console.warn('[vdDebug] flag:', f));
  console.table(res.variants || []);
  console.log('[vdDebug] Would write (NOT written):\n' + buildSummaryFromFigmaVariants(res.variants));
  return res;
}

window.__vdDebug = {
  showCandidateOverlay: vdShowCandidateOverlay,
  figmaFile: vdFigmaFile,
  figmaBoards: vdFigmaBoards,
  figmaSummary: vdFigmaSummary,
};

// ── Pipeline orchestrator ────────────────────────────────────────────────────
// Drives Stage 1 (scrape, once for Control then once per variant) → Stage 2
// (local diff, this file) → Stage 3 (Opus report + coarse pixel backstop,
// bundled into one round trip) → Stage 4 (crop toggle, if on) per variant.
// No image data of its own — Stage 1/3/4 all run in background.js via
// OffscreenCanvas; this only decides what to scrape/diff/send and holds
// text-sized results. Renders nothing itself — the whole A/B result
// (this pipeline included) surfaces as a single report tab once the run
// finishes, matching Test Agent's own run → report-tab pattern. `onStatus`,
// if given, receives a short human-readable line for the caller's single
// status element (mirroring Test Agent's own `status.textContent = ...`).
// ── Control-vs-Control is never a valid comparison ──────────────────────────
// Diffing Control against itself yields zero findings, and zero findings is
// indistinguishable from a clean pass — which makes it the most dangerous
// possible outcome: a misconfigured run that reports success. Two ways it
// happens, and both must stop the analysis rather than produce a report.
function vdNormalizeTargetUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}

// (1) Configuration: this target IS Control — same URL, or it redirected onto
// Control's final URL (a forced-variant parameter silently dropped en route).
// Returns { hard, reason } or null. `hard` decides whether this is a reason to
// refuse the comparison outright or merely a reason to be suspicious of it.
//
// The distinction is not cosmetic — treating both as hard produced a false
// stop on a real ticket. ENOC-97's preview links are Optimizely PREVIEW-TOKEN
// URLs: the token establishes a session, then an http -> https/www redirect
// strips the whole query string, so both targets legitimately settle on the
// same final URL while the forced variant persists via the session. The two
// captures came back 4590px and 6698px tall — a 46% difference at an identical
// viewport, so the variant plainly applied — and the run was refused anyway.
//
// A matching CONFIGURED url is still hard: the two targets are literally the
// same address, nothing has been captured yet, and there is nothing a
// comparison could discover.
//
// A matching FINAL url is soft. By the time it can be evaluated both captures
// already exist, and vdRenderedAsControlReason answers the same question from
// far better evidence — the diff itself — while still running BEFORE the model
// call, so deferring to it costs local compute and no spend.
function vdControlDuplicateReason(base, c) {
  const bu = vdNormalizeTargetUrl(base.url), cu = vdNormalizeTargetUrl(c.url);
  if (bu && cu && bu === cu) {
    return { hard: true, reason: `it is configured with the same URL as Control ("${base.label}"), so this would compare Control against itself` };
  }
  const bf = vdNormalizeTargetUrl(base.finalUrl), cf = vdNormalizeTargetUrl(c.finalUrl);
  if (bf && cf && bf === cf) {
    return { hard: false, reason: `it loaded the same final URL as Control ("${base.label}") — ${c.finalUrl} — so the forced-variant parameter may have been dropped on redirect. Forced-variant state can also survive as a session (Optimizely preview tokens do this), so the comparison was run anyway and judged on what actually rendered` };
  }
  return null;
}

// (2) Result: the pages are configured differently but rendered identically.
// The experiment did not apply. Reporting "no differences" here would read as
// a pass on a test that never ran, so it is an error, not a result.
function vdRenderedAsControlReason(diffRes) {
  if (!diffRes || diffRes.mode !== 'normal') return null;
  if ((diffRes.findings || []).length) return null;
  const s = diffRes.structuralStats || {};
  if (s.addedCount || s.removedCount || s.modifiedCount || s.styleChangedCount) return null;
  return 'it rendered identically to Control — no added, removed, changed or restyled element anywhere on the page. '
    + 'The forced-variant parameter most likely did not apply, so there is nothing to QA';
}

// ── Changes common to every variant, reported once ──────────────────────────
// A four-variant run where the variants share a restructured page reports the
// same handful of changes once per variant: measured on a real run, 15 of 27
// finding rows were five shared changes repeated three times, and only 12 rows
// were the copy differences that actually distinguished the variants. Lifting
// the shared ones into their own section removes the repetition without
// removing the information.
//
// Deliberately NOT suppressed. A change every variant makes is still a change
// from Control, and "all three variants dropped the same CTA" is a regression
// worth seeing — hiding it would repeat the mistake that let a run with zero
// findings read as a pass.
//
// The key is (changeClass, control text, variant text) with NO rect: the same
// change lands at different y in different variants (a taller hero pushes it
// down), and including position would defeat the grouping in exactly the cases
// it matters most. `moved` findings likewise vary by a few px between variants
// and are still one change.
function vdFindingIdentity(f) {
  const t = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const c = f.controlBlock, v = f.variantBlock;
  // Control is captured ONCE and reused for every variant, so any control-side
  // attribute is perfectly stable across them — which makes its rect the ideal
  // tiebreaker. Text alone is not enough: two different images both have empty
  // text, so ('removed','','') collided and two distinct removals were reported
  // as one. Position is only safe on the control side; the variant side moves
  // (a taller hero pushes "Contact sales" 50px down in one variant), so only
  // its SIZE participates.
  const cKey = c ? t(c.text) + '@' + (c.rect ? [c.rect.x, c.rect.y, c.rect.w, c.rect.h].join(',') : '-') : '-';
  const vKey = v ? t(v.text) + '@' + (v.rect ? v.rect.w + 'x' + v.rect.h : '-') : '-';
  return [f.changeClass, cKey, vKey].join('\u0000');
}

function vdExtractSharedFindings(perVariant) {
  const analysed = perVariant.filter(v => !v.skipped && !v.error && Array.isArray(v.findings));
  // Needs at least two comparisons for "common to all" to mean anything.
  if (analysed.length < 2) return [];

  const counts = new Map();
  for (const v of analysed) {
    // Count each identity once per variant, so a change appearing twice within
    // one variant can't masquerade as appearing across two.
    for (const id of new Set(v.findings.map(vdFindingIdentity))) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }

  const sharedIds = new Set();
  for (const [id, n] of counts) if (n === analysed.length) sharedIds.add(id);
  if (!sharedIds.size) return [];

  // The first variant's instance represents the group; every variant's copy is
  // identical by construction apart from geometry and the model's own wording.
  const shared = [];
  const taken = new Set();
  for (const f of analysed[0].findings) {
    const id = vdFindingIdentity(f);
    if (!sharedIds.has(id) || taken.has(id)) continue;
    taken.add(id);
    shared.push({ ...f, sharedAcross: analysed.map(v => v.label) });
  }
  for (const v of analysed) {
    v.findings = v.findings.filter(f => !sharedIds.has(vdFindingIdentity(f)));
  }
  return shared;
}

async function runVisualDiffPipeline(captures, { ctx, resumeCheckpoint, onStatus } = {}) {
  if (!abState.visualDiff) return null;
  const bail = (reason) => ({ skipped: true, reason });

  // One shared spec text for every variant, from the standalone Summary of
  // Changes box (abState.summaryOfChanges) — this runs with or without a
  // ticket context at all; no ticket is required. When Initialize IS used
  // and the box is still empty, autofillAbSummaryFromTicket already filled
  // it in from the ticket's variants (see its own comment) before this ever
  // runs, so there's nothing ticket-specific left to resolve here.
  const ticketText = (abState.summaryOfChanges || '').trim();

  // Resolve which capture is Control — ticket-resolved when ctx is present,
  // falling back to the first capture otherwise (see resolveAbBaseline's own
  // comment) — this is independent of spec text and still valuable
  // standalone, since it's the only thing that can identify Control from a
  // ticket's forced-variant-id convention.
  const baseline = resolveAbBaseline(ctx, captures);
  const { index: baselineIdx } = baseline;
  // Distinguish "no ticket at all" (the normal standalone case now — not a
  // problem) from "a ticket exists but couldn't identify Control" (a real
  // warning worth surfacing) — resolveAbBaseline reports both as
  // source:'first-target', since to that function they're the same
  // fallback; only the caller knows whether ctx existed to try against.
  const baselineWarning = (baseline.source === 'first-target' && ctx)
    ? `Control could not be identified from the ticket — using the first target, "${baseline.label}", as the baseline.`
      + (baseline.notes.length ? ' ' + baseline.notes.join(' ') : '')
    : null;

  const base = captures[baselineIdx];
  if (base.skipped || base.loadError || !base.fullPage || base.fullPage.error) {
    return bail('Control failed to load or capture — nothing to compare against.');
  }

  // A resumed run reuses the checkpoint's runId (so background.js's per-call
  // patches keep landing in the SAME entry); a fresh run mints one and
  // writes the root before the loop starts, so even an all-skipped run is
  // distinguishable from "no run happened."
  const runId = resumeCheckpoint?.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Recorded on the run and every checkpoint, not just for display — item
  // 3's per-block pixel check and item 6b's cross-run cache both need
  // Control and a variant to be captured at the same scale, and this is
  // what a resume/cross-run comparison checks against. Within a single run
  // this is never a real risk (every variant shares one capture window by
  // construction) — it's cross-run/resume where widths can actually drift.
  const captureWidth = base.fullPage.pageW;
  if (!resumeCheckpoint) {
    await setVisualDiffCheckpointRoot(WIN_ID, {
      runId, signature: computeVisualDiffRunSignature(ctx, captures), ticketKey: ctx?.ticketKey || null,
      baselineLabel: base.label, startedAt: Date.now(), updatedAt: Date.now(), status: 'running',
      captureWidth, perVariant: {},
    });
  }

  // No Control pre-pass any more. Parsing a page used to be a Sonnet call, so
  // Control was scraped once per run, cached in the checkpoint, and cached
  // again across runs — all of it machinery to avoid re-paying for that call.
  // The diff now reads Control's DOM candidates straight out of vdState on
  // every variant, which is free, so all three caching layers are gone.

  const perVariant = [];
  let stopped = false;

  for (let i = 0; i < captures.length; i++) {
    if (i === baselineIdx) continue;
    const c = captures[i];

    // Break, not continue: the run is over the moment Stop is pressed, and
    // it must NOT finalize as 'completed' — that's what kept the resume
    // banner from ever appearing after the one interruption a user controls.
    if (_abVisualDiffStopRequested) {
      stopped = true;
      for (let k = i; k < captures.length; k++) {
        if (k === baselineIdx) continue;
        perVariant.push({ label: captures[k].label, skipped: true, reason: 'Stopped' });
      }
      break;
    }
    if (c.skipped)   { perVariant.push({ label: c.label, skipped: true, reason: 'Not captured (stopped)' }); continue; }
    if (c.loadError) { perVariant.push({ label: c.label, skipped: true, reason: c.loadError }); continue; }
    if (!c.fullPage || c.fullPage.error) {
      perVariant.push({ label: c.label, skipped: true, reason: c.fullPage?.error || 'Not captured' });
      continue;
    }

    // Stop before spending anything on a comparison that cannot be valid —
    // but only when it CANNOT be. A shared final URL is suspicious, not
    // disqualifying; it is carried forward and reported, and the diff decides.
    const dup = vdControlDuplicateReason(base, c);
    if (dup?.hard) {
      perVariant.push({
        label: c.label, controlDuplicate: true,
        error: `Analysis stopped — ${dup.reason}.`,
      });
      continue;
    }
    const sameUrlNote = dup ? dup.reason : null;

    const prior = resumeCheckpoint?.perVariant?.[c.label];
    if (prior?.status === 'done') {
      // Fully done already — hydrate from the checkpoint, no re-calls at
      // all. Never crops (never persisted), so findings render as text
      // only. This is NOT seamless resume: the page above was still
      // freshly recaptured.
      perVariant.push({
        label: c.label, resumed: true, fullPageTruncated: !!c.fullPage.truncated,
        findings: prior.diffAndReport?.findings || [], overallSummary: prior.diffAndReport?.overallSummary || '',
        pixelDiff: prior.diffAndReport?.pixelDiff || null,
      });
      continue;
    }

    // The entire deterministic diff, in one round trip and with no model
    // call: match, classify, suppress reflow/punctuation/counter noise,
    // group, pixel backstop, rank and cap. There's no per-stage resume left
    // to do here — the expensive stage this used to resume past (Control's
    // Sonnet scrape) no longer exists, and re-running the diff itself is free.
    onStatus?.(`Comparing ${c.label}…`);
    const diffRes = await chrome.runtime.sendMessage({
      action: 'diffVisualDiffVariant',
      payload: {
        winId: WIN_ID, runId, baselineLabel: base.label, variantLabel: c.label,
        watchedRects: (base.selectors || []).map(s => s.rect).filter(Boolean),
        // The capture clip spans [0, pageW] in CSS px, so the worker divides
        // the decoded bitmap's width by this to recover the device pixel ratio
        // and read rects at the right coordinates. See vdImageScale.
        basePageW: base.fullPage?.pageW ?? null, variantPageW: c.fullPage?.pageW ?? null,
      },
    });
    if (!diffRes?.ok) {
      perVariant.push({ label: c.label, error: diffRes?.error || 'Diff failed' });
      continue;
    }
    const { structuralStats, truncatedCount, pixelDiff, aggregate, mode, matchedFraction, matchTierCounts } = diffRes;
    const diffDebug = diffRes.debug || null;
    const kept = diffRes.findings;

    // A variant that renders identically to Control is a broken run, not a
    // clean one. This used to report "No differences detected against
    // control." as an ordinary result, which is the single most misleading
    // thing this tool could say: it is exactly what a forced-variant
    // parameter that never applied looks like, and it reads as a pass.
    // Stop the analysis and say so instead.
    const sameAsControl = vdRenderedAsControlReason(diffRes);
    if (sameAsControl) {
      perVariant.push({
        label: c.label, controlDuplicate: true, sameUrlNote,
        // When both signals agree the URL one is the explanation, so lead with
        // the render evidence and append the cause.
        error: `Analysis stopped — ${sameAsControl}${sameUrlNote ? `. Note: ${sameUrlNote}` : ''}.`,
        structuralStats, pixelDiff, aggregate, diffMode: mode, matchedFraction,
        matchTierCounts, diffDebug, fullPageTruncated: !!c.fullPage.truncated,
      });
      continue;
    }

    // Findings exist but none survived ranking — skip the one remaining model
    // call rather than sending it an empty list. Distinct from the branch
    // above: the page genuinely differs, there is just nothing left to
    // classify. The coarse pixel backstop already ran inside the diff, so it
    // is never a casualty of this optimization.
    if (kept.length === 0) {
      perVariant.push({
        label: c.label, sameUrlNote, findings: [], overallSummary: 'Differences were detected but none ranked high enough to report.',
        noSpecText: !ticketText, structuralStats, truncatedFindingCount: truncatedCount,
        noVerdictCount: 0, duplicateIndexCount: 0, truncated: false, pixelDiff,
        aggregate, diffMode: mode, matchedFraction, matchTierCounts, diffDebug,
        fullPageTruncated: !!c.fullPage.truncated,
      });
      continue;
    }

    onStatus?.(`Analyzing ${c.label}…`);
    const reportRes = await chrome.runtime.sendMessage({
      action: 'reportVisualDiffFindings',
      payload: {
        winId: WIN_ID, runId, baselineLabel: base.label, variantLabel: c.label,
        findings: kept, stats: structuralStats, ticketVariantText: ticketText || null,
        specSource: abState.summarySource || null, pixelDiff,
      },
    });
    if (!reportRes?.ok) {
      if (reportRes?.stoppedAbort) { stopped = true; perVariant.push({ label: c.label, skipped: true, reason: 'Stopped' }); break; }
      perVariant.push({ label: c.label, error: reportRes?.error || 'Analysis failed' });
      continue;
    }

    // Join the model's classification back onto the full diff records — it
    // never saw controlBlock/variantBlock/rect directly, only a text summary
    // of them, so those fields still need to come from `kept`.
    const byId = new Map(reportRes.findings.map(f => [f.findingId, f]));
    let findings = kept.map(f => ({ ...f, ...(byId.get(f.findingId) || {}) }));

    if (abState.visualDiffCrops) {
      onStatus?.(`Cropping ${c.label}…`);
      const cropRes = await chrome.runtime.sendMessage({
        action: 'cropVisualDiffFindings',
        payload: {
          winId: WIN_ID, baselineLabel: base.label, variantLabel: c.label, findings,
          basePageW: base.fullPage?.pageW ?? null, variantPageW: c.fullPage?.pageW ?? null,
        },
      });
      if (cropRes?.ok) findings = findings.map(f => ({ ...f, ...(cropRes.crops[f.findingId] || {}) }));
    }

    perVariant.push({
      label: c.label, sameUrlNote, findings, overallSummary: reportRes.overallSummary,
      noSpecText: !ticketText, structuralStats, truncatedFindingCount: truncatedCount,
      noVerdictCount: reportRes.noVerdictCount, duplicateIndexCount: reportRes.duplicateIndexCount,
      truncated: reportRes.truncated, pixelDiff: reportRes.pixelDiff,
      aggregate, diffMode: mode, matchedFraction, matchTierCounts, diffDebug,
      fullPageTruncated: !!c.fullPage.truncated,
    });
  }

  // The flag is also checked here, not just via `stopped`: Stop pressed
  // during the LAST variant's calls aborts inside background.js and the
  // loop then ends naturally, which would otherwise finalize as 'completed'
  // and hide the resume banner for a run the user did interrupt.
  // Every variant turned out to be Control. Nothing was compared, so the run
  // has no result at all — say that once at the top rather than leaving the
  // reader to infer it from a list of per-variant errors.
  const analysed = perVariant.filter(v => !v.skipped);
  if (analysed.length && analysed.every(v => v.controlDuplicate)) {
    await finalizeVisualDiffCheckpoint(WIN_ID, runId, 'completed');
    chrome.runtime.sendMessage({ action: 'clearVisualDiffCaptures', payload: { winId: WIN_ID } }).catch(() => {});
    return {
      skipped: true, baselineLabel: base.label, baselineWarning, perVariant,
      reason: `Every target resolved to the same page as Control ("${base.label}"), so nothing was compared. `
        + 'Check that each variant carries its own forced-variant parameter and that none of them redirect onto Control.',
    };
  }

  // Runs after every variant is analysed, so it can see the whole set. Mutates
  // each variant's findings in place to strip what it lifts out.
  const sharedFindings = vdExtractSharedFindings(perVariant);

  const wasStopped = stopped || _abVisualDiffStopRequested;
  await finalizeVisualDiffCheckpoint(WIN_ID, runId, wasStopped ? 'stopped' : 'completed');
  // Best-effort — frees the stored full-page PNGs (and DOM candidates) in
  // background.js promptly rather than waiting for the next run or a worker
  // teardown to do it.
  chrome.runtime.sendMessage({ action: 'clearVisualDiffCaptures', payload: { winId: WIN_ID } }).catch(() => {});

  return { skipped: false, baselineLabel: base.label, baselineWarning, perVariant, sharedFindings };
}

// ── Optional per-variant interaction heatmap (opt-in extra on Keep tabs open) ─
// Reuses the Session Replay recording/overlay engine unmodified: sessionRecordStart/
// Stop capture one tab at a time (background enforces this — only one recording
// globally), sessionShowOverlay/HideOverlay draw into whichever tab is active. Each
// action here briefly focuses the target variant tab first so those handlers land
// on the right one. Sessions live in _abHeatmapSessions only for this run.
function abHeatmapEligibleCaptures() {
  return (_abLastRun?.captures || []).filter(c => !c.skipped && c.tabId);
}

function renderAbHeatmapBlock() {
  const el = document.getElementById('ab-heatmap-block');
  if (!el) return;
  const captures = abHeatmapEligibleCaptures();
  if (!captures.length) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="a11y-summary-bar" style="margin-bottom:4px">
      <span>Interaction Heatmap — record your own walk on a variant tab, then view it as an overlay</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px">
      ${captures.map(c => abHeatmapRowHtml(c)).join('')}
    </div>`;

  captures.forEach(c => {
    const row = el.querySelector(`[data-heatmap-tab="${c.tabId}"]`);
    if (!row) return;
    row.querySelector('[data-hm-record]')?.addEventListener('click', () => abHeatmapStart(c));
    row.querySelector('[data-hm-stop]')?.addEventListener('click', () => abHeatmapStop(c));
    row.querySelector('[data-hm-show]')?.addEventListener('click', () => abHeatmapShowOverlay(c));
    row.querySelector('[data-hm-hide]')?.addEventListener('click', () => abHeatmapHideOverlay(c));
  });
}

function abHeatmapRowHtml(c) {
  const recording = _abHeatmapRecordingTabId === c.tabId;
  const blockedByOther = _abHeatmapRecordingTabId && !recording;
  const session = _abHeatmapSessions[c.tabId];
  return `
    <div class="ab-line" data-heatmap-tab="${c.tabId}">
      <b>${esc(c.label)}</b>
      <span class="row" style="gap:5px;margin-top:4px;flex-wrap:wrap">
        ${recording
          ? `<button class="btn danger sm" data-hm-stop>■ Stop Recording</button><span style="font-size:11px;color:var(--fg3)">● Recording — walk the tab, then Stop</span>`
          : `<button class="btn sm" data-hm-record${blockedByOther ? ' disabled title="Recording in progress on another variant tab"' : ''}>● Record walk</button>`}
        ${session ? `
          <button class="btn sm" data-hm-show>Show heatmap overlay</button>
          <button class="btn sm" data-hm-hide>Hide overlay</button>
          <span style="font-size:10px;color:var(--fg3)">${(session.events || []).length} event${(session.events || []).length !== 1 ? 's' : ''} captured</span>` : ''}
      </span>
    </div>`;
}

async function abHeatmapStart(capture) {
  if (_abHeatmapRecordingTabId) { alert('Already recording another variant tab — stop it first.'); return; }
  try {
    await chrome.tabs.update(capture.tabId, { active: true });
  } catch (e) {
    alert('Could not focus that variant tab (it may have been closed): ' + e.message);
    return;
  }
  const res = await chrome.runtime.sendMessage({
    action: 'sessionRecordStart', label: capture.label, captureMove: true, winId: WIN_ID,
  });
  if (!res?.ok) { alert('Could not start recording: ' + (res?.error || 'unknown error')); return; }
  _abHeatmapRecordingTabId = capture.tabId;
  renderAbHeatmapBlock();
}

async function abHeatmapStop(capture) {
  const res = await chrome.runtime.sendMessage({ action: 'sessionRecordStop' });
  _abHeatmapRecordingTabId = null;
  if (res?.ok && res.session) _abHeatmapSessions[capture.tabId] = res.session;
  else if (!res?.ok) alert('Could not stop recording: ' + (res?.error || 'unknown error'));
  renderAbHeatmapBlock();
}

async function abHeatmapShowOverlay(capture) {
  const session = _abHeatmapSessions[capture.tabId];
  if (!session) return;
  try { await chrome.tabs.update(capture.tabId, { active: true }); } catch (_) {}
  const events = session.events || [];
  const ref = (session.segments || [])[0] || {};
  const payload = {
    label: session.label || capture.label || '',
    segPageW: ref.pageW, segPageH: ref.pageH,
    clicks: events.filter(e => e.type === 'click').map(e => ({ x: e.x, y: e.y })),
    trail: events.filter(e => e.type === 'move').slice(0, 3000).map(e => ({ x: e.x, y: e.y })),
    maxDepth: Math.max(0, ...events.filter(e => e.type === 'scroll').map(e => e.maxDepth || e.depth || 0)),
  };
  const res = await chrome.runtime.sendMessage({ action: 'sessionShowOverlay', payload });
  if (!res?.ok) alert('Could not show overlay: ' + (res?.error || 'unknown error'));
}

async function abHeatmapHideOverlay(capture) {
  try { await chrome.tabs.update(capture.tabId, { active: true }); } catch (_) {}
  await chrome.runtime.sendMessage({ action: 'sessionHideOverlay' });
}

// ═════════════════════════════════════════════════════════════════════════════
// Test Modes: shared helpers for the batch-style modes
// ═════════════════════════════════════════════════════════════════════════════

// One entry per WCAG check suite — mirrors the static checkbox list on the
// standalone WCAG subpage and background.js's check keys. The Cross-Variant
// mode builds its check list from this so the two stay in sync.
const WCAG_CHECKS = [
  { key: 'titles',         label: 'Page Identity & Titles',          sc: '2.4.2' },
  { key: 'navconsistency', label: 'Navigation Consistency',          sc: '3.2.3, 3.2.4, 3.2.6' },
  { key: 'multipleways',   label: 'Alternate Paths to Content',      sc: '2.4.5' },
  { key: 'skiplink',       label: 'Skip Link Functionality',         sc: '2.4.1' },
  { key: 'keyboardpath',   label: 'Keyboard Path Verification',      sc: '2.1.1, 2.4.3' },
  { key: 'modalescape',    label: 'Modal & Dialog Escape',           sc: '2.1.2', manual: true },
  { key: 'formerror',      label: 'Form Error Handling',             sc: '3.3.1, 3.3.3, 4.1.3' },
  { key: 'sessiontiming',  label: 'Session Timing',                  sc: '2.2.1, 2.2.6', manual: true },
  { key: 'destructive',    label: 'Destructive Action Confirmation', sc: '3.3.4, 3.3.6', manual: true },
  { key: 'linkpurpose',    label: 'Link Purpose',                    sc: '2.4.4, 2.4.9' },
  { key: 'formlabels',     label: 'Form Labeling',                   sc: '3.3.2, 1.3.1' },
  { key: 'redundant',      label: 'Redundant Entry',                 sc: '3.3.7', manual: true },
  { key: 'focusvis',       label: 'Focus Visibility',                sc: '2.4.7, 2.4.11' },
  { key: 'ariastate',      label: 'ARIA State Toggling',             sc: '4.1.2' },
  { key: 'contrast',       label: 'Color Contrast',                  sc: '1.4.3, 1.4.11' },
  { key: 'reflow',         label: 'Reflow & Zoom',                   sc: '1.4.10, 1.4.4' },
  { key: 'motion',         label: 'Motion & Flashing',               sc: '2.2.2, 2.3.1' },
  { key: 'screenreader',   label: 'Screen Reader Announcements',     sc: '1.1.1, 4.1.3, 4.1.2' },
  { key: 'realworld',      label: 'Real-World Task Usability',       sc: 'cross-cutting', manual: true },
];

// Compose the executable URL for a Test Modes page row — the same rules as the
// Build tab's Open URL step (params appended, cro_mode=qa always last).
function tmComposeUrl(page) {
  let url = (page.inputs.url || '').trim();
  if (!url) return '';
  let params = Array.isArray(page.inputs.params)
    ? page.inputs.params.map(p => String(p).trim()).filter(Boolean)
    : [];
  if (page.inputs.qa_mode) {
    params = params.filter(p => !p.toLowerCase().startsWith('cro_mode='));
    params.push('cro_mode=qa');
  }
  if (params.length) url += (url.includes('?') ? '&' : '?') + params.join('&');
  return url;
}

// The enabled, non-empty page URLs a mode's scaffold currently defines
// (respecting the Single/Multi scope radio).
function tmPagesFor(n) {
  const mode = tmModes[n];
  if (!mode) return [];
  const shown = mode.scope === 'multi' ? mode.pages : mode.pages.slice(0, 1);
  return shown.filter(p => p.enabled).map(p => ({ url: tmComposeUrl(p) })).filter(p => p.url);
}

function shortUrl(u) {
  try { const x = new URL(u); return x.host + x.pathname + (x.search ? x.search : ''); } catch (_) { return u || ''; }
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return Math.round(n) + ' B';
}

// ── IndexedDB (screenshots + recorded sessions outgrow chrome.storage quotas) ─
const IDB_NAME = 'selenite';
let _idb = null;

function idb() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    // v2 added the `figma` store for downscaled comp images. Both creates are
    // guarded by contains(), so an install at v1 gains only `figma` and an
    // install from scratch gets both — onupgradeneeded runs for every version
    // it steps through, and `sessions` must survive untouched either way.
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      // Out-of-line keys: the caller supplies the ticket key, so a re-extract
      // of the same ticket replaces its comp rather than accumulating copies.
      if (!db.objectStoreNames.contains('figma')) db.createObjectStore('figma');
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => reject(req.error);
  });
}

function idbReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(store, value, key) {
  const os = (await idb()).transaction(store, 'readwrite').objectStore(store);
  return idbReq(key === undefined ? os.put(value) : os.put(value, key));
}
async function idbGet(store, key) {
  return idbReq((await idb()).transaction(store).objectStore(store).get(key));
}
async function idbDelete(store, key) {
  return idbReq((await idb()).transaction(store, 'readwrite').objectStore(store).delete(key));
}
async function idbGetAll(store) {
  return idbReq((await idb()).transaction(store).objectStore(store).getAll());
}

// Neither a data: URL nor an extension-created blob: URL can be opened as a
// top-level navigation in recent Chrome (the tab loads with an error), so the
// screenshot is handed to a bundled image.html viewer through
// chrome.storage.session instead — same mechanism as the QA report tab, and a
// non-namespaced key so the viewer page (which has no window id) can read it.
// The map is pruned by total size (screenshots run to several MB each) so it
// can't blow the ~10MB session-storage quota.
async function openImageInTab(dataUrl) {
  if (!dataUrl) return;
  try {
    const id = 'img_' + Date.now();
    const { taImages = {} } = await chrome.storage.session.get('taImages');
    taImages[id] = dataUrl;
    const BUDGET = 6 * 1024 * 1024;
    const ids = Object.keys(taImages).sort();
    let total = ids.reduce((n, k) => n + taImages[k].length, 0);
    while (ids.length > 1 && total > BUDGET) {
      const drop = ids.shift();
      total -= taImages[drop].length;
      delete taImages[drop];
    }
    await chrome.storage.session.set({ taImages });
    chrome.tabs.create({ url: chrome.runtime.getURL('image.html') + '?k=' + id });
  } catch (_) {}
}

// ═════════════════════════════════════════════════════════════════════════════
// Test Agent mode: Cross-Variant Accessibility (#tm5-body)
// ═════════════════════════════════════════════════════════════════════════════
// Hybrid of the WCAG mode (audit engine — performWcagAudit in background) and
// the A/B mode (variant-loading machinery). Runs the same audit against every
// variant and diffs findings vs the baseline: Introduced / Resolved /
// Pre-existing. Never touches the Build tab queue.

let cvaState = null;
let _cvaLastRun = null;
let _cvaProgressPoller = null;

function cvaDefaultState() {
  return {
    baseUrl: '', qaMode: false, settleSec: '3', keepTabs: false, scope: '',
    includeManual: false,
    checks: WCAG_CHECKS.filter(c => !c.manual).map(c => c.key),
    targets: [
      { label: 'v0', url: '', override: '' },
      { label: 'v1', url: '', override: '' },
    ],
  };
}

async function initCvaMode() {
  if (!document.getElementById('cva-target-list')) return;
  const { cvaModeState } = await sessionNS.get('cvaModeState');
  cvaState = { ...cvaDefaultState(), ...(cvaModeState || {}) };
  if (!Array.isArray(cvaState.targets) || !cvaState.targets.length) cvaState.targets = cvaDefaultState().targets;
  if (!Array.isArray(cvaState.checks)) cvaState.checks = cvaDefaultState().checks;

  applyCvaStateToInputs();

  document.getElementById('cva-base-url').addEventListener('input',        e => { cvaState.baseUrl = e.target.value;          persistCvaState(); });
  document.getElementById('cva-qa-mode').addEventListener('change',        e => { cvaState.qaMode = e.target.checked;         persistCvaState(); });
  document.getElementById('cva-settle').addEventListener('input',          e => { cvaState.settleSec = e.target.value;        persistCvaState(); });
  document.getElementById('cva-keep-tabs').addEventListener('change',      e => { cvaState.keepTabs = e.target.checked;       persistCvaState(); });
  document.getElementById('cva-scope').addEventListener('input',           e => { cvaState.scope = e.target.value;            persistCvaState(); });
  document.getElementById('cva-include-manual').addEventListener('change', e => { cvaState.includeManual = e.target.checked;  persistCvaState(); });

  document.getElementById('btn-cva-scope-pick')?.addEventListener('click', () => {
    const row = document.getElementById('cva-scope-row');
    startPicker(row, null, 'cva-scope', (selector) => {
      const val = selector.css || (selector.idValue ? '#' + selector.idValue : '');
      document.getElementById('cva-scope').value = val;
      cvaState.scope = val;
      persistCvaState();
    });
  });

  document.getElementById('btn-cva-add-target').addEventListener('click', () => {
    // v0/v1/v2/… convention, matching A/B's own add-variant handler.
    cvaState.targets.push({ label: 'v' + cvaState.targets.length, url: '', override: '' });
    renderCvaTargets();
    persistCvaState();
  });

  document.getElementById('btn-cva-save-set').addEventListener('click', saveCvaSet);
  document.getElementById('btn-cva-load-set').addEventListener('click', loadCvaSet);
  document.getElementById('btn-cva-delete-set').addEventListener('click', deleteCvaSet);
  // "Fill from ticket" binding + refresh now lives in the fill-target
  // registry (initFillTargets), which runs later in the init chain.
  document.getElementById('btn-run-cva').addEventListener('click', runCvaAudit);
  document.getElementById('btn-cva-stop').addEventListener('click', () =>
    chrome.runtime.sendMessage({ action: 'stop' }));

  renderCvaTargets();
  renderCvaChecks();
  await refreshCvaSets();
}

function applyCvaStateToInputs() {
  document.getElementById('cva-base-url').value          = cvaState.baseUrl || '';
  document.getElementById('cva-qa-mode').checked         = !!cvaState.qaMode;
  document.getElementById('cva-settle').value            = cvaState.settleSec || '3';
  document.getElementById('cva-keep-tabs').checked       = !!cvaState.keepTabs;
  document.getElementById('cva-scope').value             = cvaState.scope || '';
  document.getElementById('cva-include-manual').checked  = !!cvaState.includeManual;
}

function persistCvaState() {
  sessionNS.set({ cvaModeState: cvaState });
}

function renderCvaTargets() {
  const list = document.getElementById('cva-target-list');
  const q = s => esc(s || '').replace(/"/g, '&quot;');
  list.innerHTML = cvaState.targets.map((t, i) => `
    <div class="ab-target" data-cva-target="${i}">
      <div class="arg-row">
        <span class="arg-lbl">Label</span>
        <input type="text" data-cva-field="label" value="${q(t.label)}" placeholder="e.g. v1">
        <button class="btn-icon" data-cva-rm-target title="Remove variant" style="color:var(--err)">✕</button>
      </div>
      <div class="arg-row">
        <span class="arg-lbl">URL</span>
        <input type="text" data-cva-field="url" value="${q(t.url)}" placeholder="(uses base URL)">
      </div>
      <div class="arg-row">
        <span class="arg-lbl">Override</span>
        <input type="text" data-cva-field="override" value="${q(t.override)}" placeholder="e.g. optimizely_x=123456">
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-cva-target]').forEach(block => {
    const i = +block.dataset.cvaTarget;
    block.querySelectorAll('[data-cva-field]').forEach(inp => {
      inp.addEventListener('input', () => {
        cvaState.targets[i][inp.dataset.cvaField] = inp.value;
        persistCvaState();
      });
    });
    block.querySelector('[data-cva-rm-target]').addEventListener('click', () => {
      cvaState.targets.splice(i, 1);
      renderCvaTargets();
      persistCvaState();
    });
  });
}

// Automated checks only — the manual/infoOnly checks produce identical
// guidance on every variant, so they live behind the single "include manual
// checks" toggle instead of individual checkboxes.
function renderCvaChecks() {
  const list = document.getElementById('cva-check-list');
  if (!list) return;
  list.innerHTML = WCAG_CHECKS.filter(c => !c.manual).map(c => `
    <label class="suite-check">
      <input type="checkbox" name="cva-check" value="${c.key}"${cvaState.checks.includes(c.key) ? ' checked' : ''}>
      ${esc(c.label)} <span style="color:var(--fg3);font-size:10px">${esc(c.sc)}</span>
    </label>`).join('');
  list.querySelectorAll('input[name="cva-check"]').forEach(cb => {
    cb.addEventListener('change', () => {
      cvaState.checks = [...list.querySelectorAll('input[name="cva-check"]:checked')].map(x => x.value);
      persistCvaState();
    });
  });
}

// ── Saved variant target sets (chrome.storage.sync, namespaced to this mode
// so the list never collides with the A/B mode's sets) ────────────────────────
async function refreshCvaSets() {
  const { cvaVariantSets = {} } = await chrome.storage.sync.get('cvaVariantSets');
  const names = Object.keys(cvaVariantSets).sort();
  const sel = document.getElementById('cva-set-select');
  sel.innerHTML = names.length
    ? names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : '<option disabled>&lt;no saved sets&gt;</option>';
}

async function saveCvaSet() {
  const name = document.getElementById('cva-set-name').value.trim();
  if (!name) { alert('Enter a set name.'); return; }
  const { cvaVariantSets = {} } = await chrome.storage.sync.get('cvaVariantSets');
  cvaVariantSets[name] = JSON.parse(JSON.stringify(cvaState));
  await chrome.storage.sync.set({ cvaVariantSets });
  await refreshCvaSets();
  document.getElementById('cva-set-select').value = name;
  document.getElementById('cva-set-name').value = '';
  alert(`"${name}" saved.`);
}

async function loadCvaSet() {
  const name = document.getElementById('cva-set-select').value || '';
  if (!name) { alert('Select a saved set first.'); return; }
  const { cvaVariantSets = {} } = await chrome.storage.sync.get('cvaVariantSets');
  if (!cvaVariantSets[name]) return;
  cvaState = { ...cvaDefaultState(), ...cvaVariantSets[name] };
  applyCvaStateToInputs();
  renderCvaTargets();
  renderCvaChecks();
  persistCvaState();
}

async function deleteCvaSet() {
  const name = document.getElementById('cva-set-select').value || '';
  if (!name) return;
  if (!confirm(`Delete "${name}"?`)) return;
  const { cvaVariantSets = {} } = await chrome.storage.sync.get('cvaVariantSets');
  delete cvaVariantSets[name];
  await chrome.storage.sync.set({ cvaVariantSets });
  await refreshCvaSets();
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function runCvaAudit() {
  const btn       = document.getElementById('btn-run-cva');
  const stopBtn   = document.getElementById('btn-cva-stop');
  const resultsEl = document.getElementById('cva-results');

  const targets = cvaState.targets
    .map(t => ({ label: (t.label || '').trim() || 'Variant', url: composeVariantUrl(t, cvaState.baseUrl, cvaState.qaMode) }))
    .filter(t => t.url);
  if (targets.length < 2) {
    resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Define at least two variant targets with a URL (or set a base URL). The first target is the baseline.</div>';
    return;
  }
  const autoChecks = cvaState.checks.filter(k => WCAG_CHECKS.some(c => c.key === k && !c.manual));
  if (!autoChecks.length) {
    resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Select at least one check.</div>';
    return;
  }
  const checks = cvaState.includeManual ? [...autoChecks, ...WCAG_MANUAL_KEYS] : autoChecks;
  const scope = (cvaState.scope || '').trim();

  btn.disabled = true;
  btn.textContent = 'Running…';
  stopBtn.style.display = '';
  resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Auditing variants…</div>';
  _cvaProgressPoller = setInterval(async () => {
    const { cvaProgress } = await sessionNS.get('cvaProgress');
    if (cvaProgress?.running) {
      btn.textContent = `Running ${cvaProgress.index + 1}/${cvaProgress.total}…`;
      resultsEl.innerHTML = `<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Auditing ${esc(cvaProgress.label)} (${cvaProgress.index + 1} of ${cvaProgress.total})…</div>`;
    }
  }, 400);

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'runCrossVariantAudit',
      payload: { targets, settleSeconds: cvaState.settleSec, keepTabs: cvaState.keepTabs, checks, scope, winId: WIN_ID },
    });
    if (!res?.ok) throw new Error(res?.error || 'Audit failed');
    const runs = (res.results || []).filter(r => !r.skipped);
    if (runs.length < 2) {
      resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Stopped before two variants were audited — nothing to compare.</div>';
      return;
    }
    _cvaLastRun = { ts: Date.now(), scope, autoChecks, includeManual: cvaState.includeManual, runs };
    renderCvaResults(_cvaLastRun);
  } catch (e) {
    resultsEl.innerHTML = '<div style="color:var(--err);font-size:12px;padding:6px 0">Error: ' + esc(e.message) + '</div>';
  } finally {
    clearInterval(_cvaProgressPoller);
    _cvaProgressPoller = null;
    btn.disabled = false;
    btn.textContent = 'Run Cross-Variant Audit';
    stopBtn.style.display = 'none';
  }
}

// ── Diff (pure function over the collected result sets) ──────────────────────
// Issue identity: normalized string (trim, collapse whitespace), matched
// exactly within its check. axe node-target strings can differ across runs for
// the same underlying issue — a known v1 limitation; no fuzzy matching.
function diffCvaRuns(runs, checkKeys) {
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const issuesOf = (r, k) => {
    const c = r.results?.[k];
    return c && !c.infoOnly ? (c.issues || []).map(norm) : null;
  };
  const base = runs[0];
  const variants = runs.slice(1).map(r => {
    if (r.loadError || !r.results) {
      return { label: r.label, url: r.url, tabId: r.tabId || null, loadError: r.loadError || 'No results', perCheck: [], introduced: 0, resolved: 0, preexisting: 0 };
    }
    const perCheck = [];
    let ti = 0, tr = 0, tp = 0;
    for (const k of checkKeys) {
      const bv = base.loadError ? null : issuesOf(base, k);
      const cv = issuesOf(r, k);
      if (bv == null && cv == null) continue;
      const bset = new Set(bv || []);
      const cset = new Set(cv || []);
      const introduced  = [...cset].filter(x => !bset.has(x));
      const resolved    = [...bset].filter(x => !cset.has(x));
      const preexisting = [...cset].filter(x => bset.has(x));
      perCheck.push({ key: k, introduced, resolved, preexisting });
      ti += introduced.length; tr += resolved.length; tp += preexisting.length;
    }
    return { label: r.label, url: r.url, tabId: r.tabId || null, loadError: null, perCheck, introduced: ti, resolved: tr, preexisting: tp };
  });
  return { base, variants };
}

// Highlight an issue's element in the variant tab it was found in (kept open
// via keep-tabs), falling back to the active tab; degrades with an inline note.
async function cvaHighlight(selector, tabId, rowEl) {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ action: 'highlightElement', tabId: tabId || null, selector });
  } catch (_) {}
  if ((!res?.ok || !res.found) && rowEl && !rowEl.querySelector('.a11y-loc-miss')) {
    const note = document.createElement('span');
    note.className = 'a11y-loc-miss';
    note.textContent = ' — not found on the current page';
    note.style.color = 'var(--fg3)';
    rowEl.appendChild(note);
    setTimeout(() => note.remove(), 2500);
  }
}

function renderCvaResults(run) {
  const el = document.getElementById('cva-results');
  const checkMeta = Object.fromEntries(WCAG_CHECKS.map(c => [c.key, c]));
  const diff = diffCvaRuns(run.runs, run.autoChecks);
  const base = diff.base;

  const issueHtml = (text, cls, tabId) => {
    const target = extractIssueTarget(text);
    const locAttrs = target
      ? ` class="a11y-issue a11y-issue-loc ${cls}" data-loc="${esc(target).replace(/"/g, '&quot;')}" data-cva-tab="${tabId || ''}" title="Click to highlight this element on the page"`
      : ` class="a11y-issue ${cls}"`;
    return `<div${locAttrs}>${esc(text)}</div>`;
  };

  const blocks = [];
  const notes = [];
  for (const r of run.runs) {
    if (r.scopeError) notes.push(`${r.label}: ${r.scopeError}`);
    if (r.axeError)   notes.push(`${r.label}: axe-core could not run (${r.axeError}) — heuristics only.`);
  }
  if (run.scope && !notes.length) notes.push('Scoped to: ' + run.scope);

  // Baseline block — its findings as-is (everything here is "pre-existing" by
  // definition; the interesting buckets live on the variants below).
  if (base.loadError) {
    blocks.push(`<div class="ab-line"><b>${esc(base.label)}</b> <span style="color:var(--fg3)">(baseline)</span> — <span class="ab-err">Load failure: ${esc(base.loadError)}</span><div class="ab-cline ab-warn">Variants below are shown against an empty baseline — every issue counts as introduced.</div></div>`);
  } else {
    const rows = run.autoChecks.filter(k => base.results?.[k]).map(k => {
      const c = base.results[k];
      const count = c.issues.length;
      const dot = count ? 'a11y-fail-dot' : 'a11y-pass-dot';
      const body = count ? `<div class="a11y-body">${c.issues.map(t => issueHtml(t, '', base.tabId)).join('')}</div>` : '';
      return `
        <div class="a11y-row" data-suite-row>
          <div class="a11y-row-hdr">
            <span class="a11y-dot ${dot}"></span>
            <span class="a11y-row-label">${esc(checkMeta[k]?.label || k)}</span>
            <span class="a11y-wcag">${esc(checkMeta[k]?.sc || '')}</span>
            <span class="a11y-count">${count ? count + ' issue' + (count !== 1 ? 's' : '') : 'Pass'}</span>
            ${count ? '<span class="a11y-chevron">›</span>' : ''}
          </div>
          ${body}
        </div>`;
    });
    const baseTotal = run.autoChecks.reduce((n, k) => n + (base.results?.[k]?.issues.length || 0), 0);
    blocks.push(`
      <div class="a11y-summary-bar" style="margin-top:2px">
        <span><b>${esc(base.label)}</b> (baseline)</span>
        <span class="a11y-summary-total" style="color:${baseTotal ? 'var(--warn)' : 'var(--ok)'}">${baseTotal} issue${baseTotal !== 1 ? 's' : ''}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">${rows.join('')}</div>`);
  }

  // Variant blocks — Introduced expanded (error styling), Resolved positive,
  // Pre-existing collapsed/greyed but never hidden entirely.
  for (const v of diff.variants) {
    if (v.loadError) {
      blocks.push(`<div class="ab-line" style="margin-top:8px"><b>${esc(v.label)}</b> — <span class="ab-err">Load failure: ${esc(v.loadError)}</span></div>`);
      continue;
    }
    const sumColor = v.introduced ? 'var(--err)' : 'var(--ok)';
    const rows = v.perCheck
      .filter(pc => pc.introduced.length || pc.resolved.length || pc.preexisting.length)
      .map(pc => {
        const parts = [];
        if (pc.introduced.length)  parts.push(pc.introduced.length + ' introduced');
        if (pc.resolved.length)    parts.push(pc.resolved.length + ' resolved');
        if (pc.preexisting.length) parts.push(pc.preexisting.length + ' pre-existing');
        const dot = pc.introduced.length ? 'a11y-fail-dot' : (pc.resolved.length ? 'a11y-pass-dot' : 'a11y-skip-dot');
        const body = `
          ${pc.introduced.map(t => issueHtml(t, 'cva-issue-intro', v.tabId)).join('')}
          ${pc.resolved.map(t => `<div class="a11y-issue cva-issue-res">${esc(t)}</div>`).join('')}
          ${pc.preexisting.length ? `
            <details class="cva-pre">
              <summary>${pc.preexisting.length} pre-existing issue${pc.preexisting.length !== 1 ? 's' : ''} (identical to baseline)</summary>
              ${pc.preexisting.map(t => issueHtml(t, '', v.tabId)).join('')}
            </details>` : ''}`;
        return `
          <div class="a11y-row${pc.introduced.length ? ' open' : ''}" data-suite-row>
            <div class="a11y-row-hdr">
              <span class="a11y-dot ${dot}"></span>
              <span class="a11y-row-label">${esc(checkMeta[pc.key]?.label || pc.key)}</span>
              <span class="a11y-wcag">${esc(checkMeta[pc.key]?.sc || '')}</span>
              <span class="a11y-count">${parts.join(' · ')}</span>
              <span class="a11y-chevron">›</span>
            </div>
            <div class="a11y-body">${body}</div>
          </div>`;
      });
    blocks.push(`
      <div class="a11y-summary-bar" style="margin-top:8px">
        <span><b>${esc(v.label)}</b></span>
        <span class="a11y-summary-total" style="color:${sumColor}">${v.introduced} introduced · ${v.resolved} resolved · ${v.preexisting} pre-existing</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">${rows.join('') || '<div class="ab-line ab-same-row">No issues in this variant or the baseline for the selected checks.</div>'}</div>`);
  }

  // Manual checks render once — identical guidance on every variant.
  if (run.includeManual && !base.loadError) {
    const manualRows = WCAG_MANUAL_KEYS.filter(k => base.results?.[k]).map(k => {
      const c = base.results[k];
      const guide = WCAG_MANUAL_GUIDE[k] || [];
      return `
        <div class="a11y-row" data-suite-row>
          <div class="a11y-row-hdr">
            <span class="a11y-dot a11y-info-dot"></span>
            <span class="a11y-row-label">${esc(checkMeta[k]?.label || k)}</span>
            <span class="a11y-wcag">${esc(checkMeta[k]?.sc || '')}</span>
            <span class="a11y-count">Manual</span>
            <span class="a11y-chevron">›</span>
          </div>
          <div class="a11y-body">
            ${c.issues.map(t => `<div class="a11y-issue">${esc(t)}</div>`).join('')}
            ${guide.length ? `<div class="a11y-guide-title">Verify by hand (on every variant):</div>${guide.map(g => `<div class="a11y-guide-item">${esc(g)}</div>`).join('')}` : ''}
          </div>
        </div>`;
    });
    blocks.push(`
      <div class="a11y-summary-bar" style="margin-top:8px"><span>Manual checks — apply to every variant</span></div>
      <div style="display:flex;flex-direction:column;gap:4px">${manualRows.join('')}</div>`);
  }

  const totalIntroduced = diff.variants.reduce((n, v) => n + v.introduced, 0);
  el.innerHTML = `
    <div class="a11y-summary-bar">
      <span>Baseline: ${esc(base.label)}</span>
      <div class="row" style="gap:8px">
        <span class="a11y-summary-total" style="color:${totalIntroduced ? 'var(--err)' : 'var(--ok)'}">${totalIntroduced} introduced issue${totalIntroduced !== 1 ? 's' : ''} across variants</span>
        <button class="btn ghost btn-icon" data-cva-export title="Download results as JSON">Export</button>
        <button class="btn ghost btn-icon" data-clear-results title="Clear results">Clear</button>
      </div>
    </div>
    ${notes.length ? `<div style="color:var(--fg3);font-size:11px;padding:2px 2px 6px">${notes.map(esc).join(' · ')}</div>` : ''}
    ${blocks.join('')}`;

  el.querySelectorAll('[data-suite-row] .a11y-row-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => hdr.closest('[data-suite-row]').classList.toggle('open'));
  });
  el.querySelector('[data-clear-results]')?.addEventListener('click', () => { el.innerHTML = ''; });
  el.querySelector('[data-cva-export]')?.addEventListener('click', () => exportCvaResults(diff, run));
  el.querySelectorAll('.a11y-issue-loc').forEach(row => {
    row.addEventListener('click', () =>
      cvaHighlight(row.dataset.loc, parseInt(row.dataset.cvaTab, 10) || null, row));
  });
}

function exportCvaResults(diff, run) {
  const checkMeta = Object.fromEntries(WCAG_CHECKS.map(c => [c.key, c]));
  const data = {
    timestamp: new Date(run.ts).toISOString(),
    scope: run.scope || null,
    checks: run.autoChecks,
    baseline: {
      label: diff.base.label, url: diff.base.url, loadError: diff.base.loadError || null,
      issues: diff.base.loadError ? null : Object.fromEntries(run.autoChecks
        .filter(k => diff.base.results?.[k])
        .map(k => [k, diff.base.results[k].issues])),
    },
    variants: diff.variants.map(v => ({
      label: v.label, url: v.url, loadError: v.loadError,
      summary: { introduced: v.introduced, resolved: v.resolved, preexisting: v.preexisting },
      checks: v.perCheck.map(pc => ({
        key: pc.key,
        label: checkMeta[pc.key]?.label || pc.key,
        wcag: checkMeta[pc.key]?.sc || '',
        introduced: pc.introduced,
        resolved: pc.resolved,
        preexisting: pc.preexisting,
      })),
    })),
  };
  downloadJson(data, 'cross-variant-a11y-' + new Date(run.ts).toISOString().replace(/[:.]/g, '-') + '.json');
}

// ═════════════════════════════════════════════════════════════════════════════
// Test Agent mode: Performance/Load (#tm6-body)
// ═════════════════════════════════════════════════════════════════════════════
// Background loads each page N times (fresh tab per run, sequential, cache
// optionally disabled over CDP) and returns raw per-run metrics; this side owns
// median math, budget evaluation, rendering, history, and export. Numbers come
// from a real browser on the user's machine — relative comparison, not lab
// absolutes. Never touches the Build tab queue.

const PERF_DEFAULT_BUDGETS = { lcp: 2500, cls: 0.1, ttfb: 800, load: 5000 };
const PERF_METRICS = [
  { key: 'ttfb', label: 'TTFB',                    unit: 'ms', budget: 'ttfb' },
  { key: 'fcp',  label: 'First Contentful Paint',  unit: 'ms' },
  { key: 'lcp',  label: 'LCP',                     unit: 'ms', budget: 'lcp' },
  { key: 'dcl',  label: 'DOMContentLoaded',        unit: 'ms' },
  { key: 'load', label: 'Load event',              unit: 'ms', budget: 'load' },
  { key: 'cls',  label: 'CLS',                     unit: '',   budget: 'cls', digits: 3 },
  { key: 'longTaskMs', label: 'Long-task time',    unit: 'ms' },
];

let perfState = null;      // { settleSec, runs, disableCache }
let perfBudgets = null;    // { lcp, cls, ttfb, load } — sync storage
let _perfLastRun = null;
let _perfProgressPoller = null;

function median(vals) {
  const v = vals.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function fmtMetric(v, m) {
  if (v == null) return '—';
  const digits = m?.digits ?? 0;
  const n = digits ? v.toFixed(digits) : Math.round(v).toLocaleString();
  return n + (m?.unit ? ' ' + m.unit : '');
}

async function initPerfMode() {
  if (!document.getElementById('btn-perf-run')) return;
  const { perfModeState } = await sessionNS.get('perfModeState');
  perfState = { settleSec: '3', runs: '3', disableCache: true, ...(perfModeState || {}) };
  const { perfBudgets: saved } = await chrome.storage.sync.get('perfBudgets');
  perfBudgets = { ...PERF_DEFAULT_BUDGETS, ...(saved || {}) };

  document.getElementById('perf-settle').value          = perfState.settleSec;
  document.getElementById('perf-runs').value            = perfState.runs;
  document.getElementById('perf-disable-cache').checked = !!perfState.disableCache;
  for (const k of ['lcp', 'cls', 'ttfb', 'load']) {
    const inp = document.getElementById('perf-budget-' + k);
    inp.value = perfBudgets[k];
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!Number.isNaN(v) && v > 0) perfBudgets[k] = v;
      chrome.storage.sync.set({ perfBudgets });
    });
  }

  document.getElementById('perf-settle').addEventListener('input',          e => { perfState.settleSec = e.target.value;         persistPerfState(); });
  document.getElementById('perf-runs').addEventListener('input',            e => { perfState.runs = e.target.value;              persistPerfState(); });
  document.getElementById('perf-disable-cache').addEventListener('change',  e => { perfState.disableCache = e.target.checked;    persistPerfState(); });

  document.getElementById('btn-perf-run').addEventListener('click', runPerfMode);
  document.getElementById('btn-perf-stop').addEventListener('click', () =>
    chrome.runtime.sendMessage({ action: 'stop' }));
  document.getElementById('btn-perf-view-history')?.addEventListener('click', viewPerfHistoryRun);
  await renderPerfHistoryList();
}

function persistPerfState() {
  sessionNS.set({ perfModeState: perfState });
}

async function runPerfMode(opts = {}) {
  const btn       = document.getElementById('btn-perf-run');
  const stopBtn   = document.getElementById('btn-perf-stop');
  const resultsEl = document.getElementById('perf-results');

  const pages = tmPagesFor('6');
  if (!pages.length) {
    resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Add at least one page URL above. Tip: add the same page twice with different override params to compare experiment variants.</div>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Running…';
  stopBtn.style.display = '';
  resultsEl.innerHTML = '<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Measuring…</div>';
  _perfProgressPoller = setInterval(async () => {
    const { perfProgress } = await sessionNS.get('perfProgress');
    if (perfProgress?.running) {
      const t = `page ${perfProgress.page}/${perfProgress.pages} · run ${perfProgress.run}/${perfProgress.runs}`;
      btn.textContent = `Running (${t})…`;
      resultsEl.innerHTML = `<div style="color:var(--fg3);font-size:12px;text-align:center;padding:10px 0">Measuring ${esc(shortUrl(perfProgress.label || ''))} — ${t}…</div>`;
    }
  }, 400);

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'runPerfMeasurement',
      payload: {
        pages, settleSeconds: perfState.settleSec,
        runsPerPage: perfState.runs, disableCache: perfState.disableCache,
        winId: WIN_ID, agenticTesting: !!opts.agenticTesting,
      },
    });
    if (!res?.ok) throw new Error(res?.error || 'Measurement failed');
    const summarized = (res.results || []).map(p => ({
      url: p.url, ts: Date.now(), skipped: !!p.skipped && !p.runs.length,
      partial: !!p.skipped && p.runs.length > 0,
      runs: p.runs, summary: perfSummarize(p), agenticNote: p.agenticNote || null,
    }));
    _perfLastRun = { ts: Date.now(), budgets: { ...perfBudgets }, disableCache: perfState.disableCache, pages: summarized };
    renderPerfResults(_perfLastRun);
    await savePerfHistory(summarized);
  } catch (e) {
    resultsEl.innerHTML = '<div style="color:var(--err);font-size:12px;padding:6px 0">Error: ' + esc(e.message) + '</div>';
  } finally {
    clearInterval(_perfProgressPoller);
    _perfProgressPoller = null;
    btn.disabled = false;
    btn.textContent = 'Run Measurement';
    stopBtn.style.display = 'none';
  }
}

function perfSummarize(p) {
  const good = (p.runs || []).filter(r => !r.error);
  const medians = {};
  for (const m of PERF_METRICS) medians[m.key] = median(good.map(r => r[m.key]));
  medians.longTasks     = median(good.map(r => r.longTasks));
  medians.resourceCount = median(good.map(r => r.resourceCount));
  medians.transferBytes = median(good.map(r => r.transferBytes));
  medians.lateCount     = median(good.map(r => r.late?.count));
  medians.lateBytes     = median(good.map(r => r.late?.bytes));
  const byType = {};
  for (const t of ['script', 'css', 'img', 'font', 'other']) {
    byType[t] = {
      count: median(good.map(r => r.byType?.[t]?.count)),
      bytes: median(good.map(r => r.byType?.[t]?.bytes)),
    };
  }
  const verdicts = {};
  for (const m of PERF_METRICS) {
    if (!m.budget) continue;
    const v = medians[m.key];
    verdicts[m.key] = v == null ? null : (v <= perfBudgets[m.budget] ? 'ok' : 'over');
  }
  const jsErrors = [...new Set(good.flatMap(r => r.jsErrors || []))];
  const runErrors = (p.runs || []).map(r => r.error).filter(Boolean);
  return { medians, verdicts, byType, jsErrors, runErrors, runCount: good.length };
}

function perfPageBlock(pg, budgets, { compact = false } = {}) {
  const s = pg.summary;
  const overCount = Object.values(s.verdicts).filter(v => v === 'over').length;
  const bar = `
    <div class="a11y-summary-bar" style="margin-top:8px">
      <span><b>${esc(shortUrl(pg.url))}</b>${pg.partial ? ' <span class="ab-warn">(stopped early)</span>' : ''}</span>
      <span class="a11y-summary-total" style="color:${overCount ? 'var(--err)' : 'var(--ok)'}">${overCount ? overCount + ' metric' + (overCount !== 1 ? 's' : '') + ' over budget' : 'All budgets met'}</span>
    </div>`;
  if (!s.runCount) {
    return bar + `<div class="ab-line"><span class="ab-err">${esc(s.runErrors[0] || 'No successful runs')}</span></div>`;
  }

  const rows = PERF_METRICS.map(m => {
    const v = s.medians[m.key];
    const budget = m.budget ? budgets[m.budget] : null;
    const verdict = m.budget ? s.verdicts[m.key] : null;
    const verdictHtml = verdict === 'ok' ? '<span class="perf-ok">OK</span>'
      : verdict === 'over' ? '<span class="perf-over">OVER</span>'
      : '<span style="color:var(--fg3)">—</span>';
    const extra = m.key === 'longTaskMs' && s.medians.longTasks != null
      ? ` <span style="color:var(--fg3)">(${Math.round(s.medians.longTasks)} task${Math.round(s.medians.longTasks) !== 1 ? 's' : ''})</span>` : '';
    return `
      <tr>
        <td>${esc(m.label)}${extra}</td>
        <td style="${verdict === 'over' ? 'color:var(--err);font-weight:600' : verdict === 'ok' ? 'color:var(--ok)' : ''}">${fmtMetric(v, m)}</td>
        <td style="color:var(--fg2)">${budget != null ? '≤ ' + fmtMetric(budget, m) : '—'}</td>
        <td>${verdictHtml}</td>
      </tr>`;
  }).join('');

  const table = `
    <table class="perf-table">
      <tr><th>Metric</th><th>Median</th><th>Budget</th><th>Verdict</th></tr>
      ${rows}
    </table>`;

  let runsBlock = '';
  if (!compact && pg.runs?.length) {
    const runRows = pg.runs.map((r, i) => r.error
      ? `<div class="ab-cline ab-err">Run ${i + 1}: ${esc(r.error)}</div>`
      : `<div class="ab-cline">Run ${i + 1}: ${PERF_METRICS.map(m => `${esc(m.label)} ${fmtMetric(r[m.key], m)}`).join(' · ')}</div>`
    ).join('');
    runsBlock = `
      <div class="a11y-row" data-suite-row>
        <div class="a11y-row-hdr">
          <span class="a11y-dot a11y-info-dot"></span>
          <span class="a11y-row-label">Individual runs</span>
          <span class="a11y-count">${pg.runs.length} run${pg.runs.length !== 1 ? 's' : ''} · medians reported</span>
          <span class="a11y-chevron">›</span>
        </div>
        <div class="a11y-body">${runRows}</div>
      </div>`;
  }

  let resBlock = '';
  if (!compact) {
    const bt = s.byType;
    const parts = ['script', 'css', 'img', 'font', 'other']
      .filter(t => bt[t].count != null && bt[t].count > 0)
      .map(t => `${t} ${Math.round(bt[t].count)} (${fmtBytes(bt[t].bytes)})`);
    resBlock = `
      <div class="ab-line">
        Resources (median): ${s.medians.resourceCount != null ? Math.round(s.medians.resourceCount) : '—'} requests · ${fmtBytes(s.medians.transferBytes)}
        ${parts.length ? `<div class="ab-cline" style="color:var(--fg2)">${parts.join(' · ')}</div>` : ''}
        <div class="ab-cline ${s.medians.lateCount ? 'ab-warn' : ''}" title="Experiment scripts often inject resources late">After load event: ${s.medians.lateCount != null ? Math.round(s.medians.lateCount) : 0} request${Math.round(s.medians.lateCount || 0) !== 1 ? 's' : ''} · ${fmtBytes(s.medians.lateBytes || 0)}</div>
        ${s.jsErrors.length ? s.jsErrors.map(x => `<div class="ab-cline ab-err">JS error: ${esc(x)}</div>`).join('') : ''}
        ${s.runErrors.length ? s.runErrors.map(x => `<div class="ab-cline ab-err">Run failed: ${esc(x)}</div>`).join('') : ''}
      </div>`;
  }

  return bar + table + runsBlock + resBlock;
}

function renderPerfResults(run) {
  const el = document.getElementById('perf-results');
  const shown = run.pages.filter(p => !p.skipped);
  const skipped = run.pages.length - shown.length;
  const blocks = shown.map(p => perfPageBlock(p, run.budgets)).join('');
  const overTotal = shown.reduce((n, p) => n + Object.values(p.summary.verdicts).filter(v => v === 'over').length, 0);

  el.innerHTML = `
    <div class="a11y-summary-bar">
      <span>${shown.length} page${shown.length !== 1 ? 's' : ''} measured${skipped ? ` · ${skipped} skipped (stopped)` : ''}${run.disableCache ? ' · cache disabled' : ' · cache enabled'}</span>
      <div class="row" style="gap:8px">
        <span class="a11y-summary-total" style="color:${overTotal ? 'var(--err)' : 'var(--ok)'}">${overTotal ? overTotal + ' over budget' : 'All budgets met'}</span>
        <button class="btn ghost btn-icon" data-perf-export title="Download results as JSON">Export</button>
        <button class="btn ghost btn-icon" data-clear-results title="Clear results">Clear</button>
      </div>
    </div>
    <div style="font-size:10px;color:var(--fg3);padding:0 2px 4px">Measured in this browser on this machine and network — treat as relative comparison, not lab-grade absolutes.</div>
    ${blocks}`;

  el.querySelectorAll('[data-suite-row] .a11y-row-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => hdr.closest('[data-suite-row]').classList.toggle('open'));
  });
  el.querySelector('[data-clear-results]')?.addEventListener('click', () => { el.innerHTML = ''; });
  el.querySelector('[data-perf-export]')?.addEventListener('click', () => {
    downloadJson({
      timestamp: new Date(run.ts).toISOString(),
      budgets: run.budgets,
      cacheDisabled: !!run.disableCache,
      note: 'Measured in a real browser on the tester’s machine and network — relative comparison, not lab-grade absolutes.',
      pages: run.pages.map(p => ({
        url: p.url, skipped: !!p.skipped,
        medians: p.summary?.medians, verdicts: p.summary?.verdicts,
        byType: p.summary?.byType, jsErrors: p.summary?.jsErrors,
        runs: p.runs,
      })),
    }, 'perf-measurement-' + new Date(run.ts).toISOString().replace(/[:.]/g, '-') + '.json');
  });
}

// ── Run history (medians + verdicts only, last 10 per URL) ───────────────────
const PERF_HISTORY_PER_URL = 10;

async function savePerfHistory(pages) {
  const { perfHistory = {} } = await chrome.storage.local.get('perfHistory');
  for (const p of pages) {
    if (p.skipped || !p.summary.runCount) continue;
    const arr = perfHistory[p.url] || [];
    arr.unshift({ ts: p.ts, medians: p.summary.medians, verdicts: p.summary.verdicts, runs: p.summary.runCount, budgets: { ...perfBudgets } });
    perfHistory[p.url] = arr.slice(0, PERF_HISTORY_PER_URL);
  }
  await chrome.storage.local.set({ perfHistory });
  await renderPerfHistoryList();
}

async function renderPerfHistoryList() {
  const sel = document.getElementById('perf-history-select');
  if (!sel) return;
  const { perfHistory = {} } = await chrome.storage.local.get('perfHistory');
  const opts = [];
  for (const [url, runs] of Object.entries(perfHistory)) {
    runs.forEach((r, i) => opts.push({ url, i, ts: r.ts }));
  }
  opts.sort((a, b) => b.ts - a.ts);
  sel.innerHTML = opts.length
    ? opts.map(o => `<option value="${encodeURIComponent(o.url)}|${o.i}">${new Date(o.ts).toLocaleString()} — ${esc(shortUrl(o.url))}</option>`).join('')
    : '<option disabled>&lt;no past runs&gt;</option>';
}

async function viewPerfHistoryRun() {
  const v = document.getElementById('perf-history-select')?.value || '';
  const bar = v.lastIndexOf('|');
  if (bar < 0) return;
  const url = decodeURIComponent(v.slice(0, bar));
  const idx = +v.slice(bar + 1);
  const { perfHistory = {} } = await chrome.storage.local.get('perfHistory');
  const h = perfHistory[url]?.[idx];
  if (!h) return;
  const el = document.getElementById('perf-results');
  const pg = { url, ts: h.ts, runs: [], summary: { medians: h.medians, verdicts: h.verdicts, byType: {}, jsErrors: [], runErrors: [], runCount: h.runs } };
  el.innerHTML = `
    <div class="a11y-summary-bar">
      <span>History — ${new Date(h.ts).toLocaleString()} (${h.runs} run${h.runs !== 1 ? 's' : ''}, medians only)</span>
      <button class="btn ghost btn-icon" data-clear-results title="Clear results">Clear</button>
    </div>
    ${perfPageBlock(pg, h.budgets || perfBudgets, { compact: true })}`;
  el.querySelector('[data-clear-results]')?.addEventListener('click', () => { el.innerHTML = ''; });
}

// ── Report badge / section shell ──────────────────────────────────────────────
function rptBadge(kind, label) {
  return `<span class="rpt-badge rpt-badge-${kind}">${esc(label)}</span>`;
}

function rptSection(title, badgeHtml, summaryText, bodyHtml) {
  return `
    <section class="rpt-section">
      <div class="rpt-section-hdr">
        <h2>${esc(title)}</h2>
        ${badgeHtml}
      </div>
      <div class="rpt-summary">${esc(summaryText)}</div>
      ${bodyHtml}
    </section>`;
}

function rptSkipped(title, reason) {
  return rptSection(title, rptBadge('skip', 'SKIPPED'), reason || 'Not configured.', '');
}

// Test Agent: LLM-written verdict over the modeResults already collected —
// prepended to the report, ahead of the per-mode sections below.
function rptAiSummarySection(summary, error) {
  if (!summary) {
    return rptSection('AI Summary', rptBadge('skip', 'UNAVAILABLE'),
      error || 'No API key configured — add one in the AI Summary card.', '');
  }
  return rptSection('AI Summary', rptBadge('info', 'AI'), '',
    `<div style="white-space:pre-wrap">${esc(summary)}</div>`);
}

// ── Per-mode report bodies (reuse each mode's own diff/summarize helpers —
// no new data is invented here, only reformatted for print) ──────────────────

// Agentic Testing: a supplemental Sonnet judgment call, never a replacement
// for the deterministic result rendered above it.
function rptAgenticNoteHtml(note, label) {
  if (!note) return '';
  return `<p class="rpt-muted"><strong>${esc(label || 'Agentic Testing Note (Sonnet)')}:</strong> ${esc(note)}</p>`;
}

function rptAbSection(entry) {
  if (entry.status === 'skipped') return rptSkipped(entry.name, entry.reason);
  const { captures: allCaptures, metricsList, selectors } = entry.data;
  const captures = (allCaptures || []).filter(c => !c.skipped);
  if (captures.length < 2) return rptSkipped(entry.name, 'Stopped before two variants were captured — nothing to compare.');

  const d = diffAbCaptures(captures, metricsList, selectors);
  const errCount = d.errors.reduce((n, e) => n + (e.loadError ? 1 : 0) + e.jsErrors.length, 0);
  const totalDeltas =
    d.basics.filter(b => b.titleDiff || b.urlDiff).length +
    d.selectorRows.filter(s => !s.allSame).length +
    d.metricRows.filter(m => !m.allSame).length +
    d.consoleRows.filter(v => v.added.length || v.missing.length).length;
  const badge = errCount ? rptBadge('fail', 'FAIL') : totalDeltas ? rptBadge('issues', 'ISSUES FOUND') : rptBadge('pass', 'PASS');
  const summary = `Baseline: ${captures[0].label} · ${errCount ? errCount + ' error(s) · ' : ''}${totalDeltas} difference(s) vs baseline`;

  const basicsRows = d.basics.map((b, i) => `<tr><td>${esc(b.label)}${i === 0 ? ' (baseline)' : ''}</td><td>${b.loadError ? 'Load failed: ' + esc(b.loadError) : esc(b.title)}</td><td>${b.loadError ? '—' : esc(b.finalUrl)}</td></tr>`).join('');
  let body = `<h3>Page Basics</h3><table class="rpt-table"><thead><tr><th>Variant</th><th>Title</th><th>URL</th></tr></thead><tbody>${basicsRows}</tbody></table>`;

  if (selectors.length) {
    const selRows = d.selectorRows.map(s => `<tr><td>${esc(s.selector)}</td><td>${s.allSame ? 'Identical in all variants' : 'Differs — see extension for detail'}</td></tr>`).join('');
    body += `<h3>Watched Selectors</h3><table class="rpt-table"><thead><tr><th>Selector</th><th>Result</th></tr></thead><tbody>${selRows}</tbody></table>`;
  }
  if (metricsList.length) {
    const metRows = d.metricRows.map(m => `<tr><td>${esc(m.metric)}</td><td>${m.counts.map((c, i) => esc(captures[i].label) + ' ×' + c).join(' · ')}</td></tr>`).join('');
    body += `<h3>Metrics</h3><table class="rpt-table"><thead><tr><th>Metric</th><th>Fire counts</th></tr></thead><tbody>${metRows}</tbody></table>`;
  }
  if (d.errors.length) {
    const errRows = d.errors.map(e => `<tr><td>${esc(e.label)}</td><td>${[e.loadError, ...e.jsErrors].filter(Boolean).map(esc).join('<br>')}</td></tr>`).join('');
    body += `<h3>Errors</h3><table class="rpt-table"><thead><tr><th>Variant</th><th>Error</th></tr></thead><tbody>${errRows}</tbody></table>`;
  }
  body += '<p class="rpt-muted">Differences are expected in an A/B test — review whether each delta matches the intended variant change. Only errors and load failures are defects.</p>';
  body += rptAgenticNoteHtml(entry.data.agenticNote);
  // visualDiffFull carries the LIVE runVisualDiffPipeline result — crops
  // included — built fresh by the standalone A/B report call, never sourced
  // from _abLastRun/getData(). The Test-Agent-queued path never sets this
  // field, so this stays a no-op there — no crop images flow into that
  // combined report or the AI summarize-results prompt it feeds.
  return rptSection(entry.name, badge, summary, body) + rptAbVisualDiffSection(entry.data.visualDiffFull);
}

// Static-report counterpart driven by the 3-stage pipeline's per-variant
// result shape ({findings, overallSummary, structuralStats, pixelDiff, ...}
// — see runVisualDiffPipeline). Rendered as inert markup instead of live,
// collapsible DOM — a report has no toggle state to preserve, so every
// section renders open except the usually-uninteresting "expected" bucket,
// kept collapsed via <details> to match the old inline version's own choice.
function rptAbVisualDiffSection(vd) {
  if (!vd) return '';
  if (vd.skipped) {
    return rptSection('Visual Diff (AI)', rptBadge('skip', 'SKIPPED'), vd.reason || 'Not run.', '');
  }

  const q = esc;
  const qa = (s) => esc(s || '').replace(/"/g, '&quot;');

  // Findings no longer carry their own `type` — Stage 2's diff only knows
  // added/removed/modified/unchanged. Derived here from status +
  // changeSignals so the vocabulary a reader sees stays familiar.
  const findingType = (f) => {
    if (f.status === 'added' || f.status === 'removed') return f.status;
    if (f.status === 'style-changed') return 'style';
    const signals = f.changeSignals || [];
    if (signals.includes('text-changed')) return 'copy';
    if (signals.some(s => s.startsWith('moved-vertically') || s === 'resized')) return 'layout';
    return 'other';
  };

  const findingRow = (f, resumedVariant) => {
    const rect = f.controlBlock?.rect || f.variantBlock?.rect;
    let media;
    if (f.baselineCrop || f.variantCrop) {
      media = `<div class="row" style="display:flex;gap:8px;align-items:flex-start">
        ${f.baselineCrop ? `<img src="${qa(f.baselineCrop)}" style="max-width:260px;max-height:200px;border:1px solid #d8dbe0;border-radius:3px" alt="Control crop">` : ''}
        ${f.variantCrop ? `<img src="${qa(f.variantCrop)}" style="max-width:260px;max-height:200px;border:1px solid #d8dbe0;border-radius:3px" alt="Variant crop">` : ''}
      </div>`;
    } else if (rect) {
      media = `<p class="rpt-muted">${resumedVariant ? 'Crop unavailable (restored from a saved checkpoint)' : 'No crop for this finding'} — near (${rect.x}, ${rect.y}), ${rect.w}×${rect.h}px.</p>`;
    } else {
      media = `<p class="rpt-muted">No crop available — this content has no direct page element to anchor to.</p>`;
    }
    const label = f.controlBlock?.label || f.variantBlock?.label || '';
    return `<div class="ab-line">
      ${media}
      <div class="ab-cline"><span class="ab-delta">${q(findingType(f))}</span> ${q(label)}${label ? ' — ' : ''}${q(f.note || '')}</div>
    </div>`;
  };

  // Same noSpecText-aware counting as before: a no-spec variant returns
  // ONLY 'unclear' verdicts by construction, so treating 'unexpected' as the
  // only signal would report 0 issues for a variant that actually surfaced
  // real findings.
  const variantIssueCount = (v) => {
    if (v.skipped || v.error) return 0;
    const findings = v.findings || [];
    const unexpected = findings.filter(f => f.classification === 'unexpected').length;
    const unclear = findings.filter(f => f.classification === 'unclear').length;
    return v.noSpecText ? unexpected + unclear : unexpected;
  };
  const shared = vd.sharedFindings || [];
  // Shared changes were lifted out of every variant, so they must be counted
  // here or a run whose only findings are common to all variants would tally
  // zero issues and badge PASS.
  const sharedIssueCount = shared.filter(f =>
    f.classification === 'unexpected' || (f.classification === 'unclear')).length;
  const totalIssues = (vd.perVariant || []).reduce((n, v) => n + variantIssueCount(v), 0) + sharedIssueCount;
  // A Control-vs-Control variant contributes no findings, and variantIssueCount
  // returns 0 for anything errored — so without this a run where the experiment
  // never applied would badge a green PASS. That is the one verdict this
  // section must never show for a comparison that did not happen.
  const dupVariants = (vd.perVariant || []).filter(v => v.controlDuplicate);
  const badge = dupVariants.length ? rptBadge('fail', 'NOT COMPARED')
    : totalIssues ? rptBadge('issues', 'ISSUES FOUND')
    : rptBadge('pass', 'PASS');
  let summary = `Visual Diff vs ${vd.baselineLabel}${vd.baselineWarning ? ' — ' + vd.baselineWarning : ''}`;
  if (dupVariants.length) {
    summary += ` — ${dupVariants.length} variant(s) resolved to the same page as Control and were not compared. `
      + 'Their lack of findings is not a pass.';
  }

  const variantSections = (vd.perVariant || []).map(v => {
    if (v.skipped) return `<h3>${q(v.label)}</h3><p class="rpt-muted">Skipped — ${q(v.reason || 'not captured')}</p>`;
    if (v.error)   return `<h3>${q(v.label)}</h3><p class="ab-err">${q(v.error)}</p>`;

    const findings = v.findings || [];
    const unexpected = findings.filter(f => f.classification === 'unexpected');
    const unclear    = findings.filter(f => f.classification === 'unclear');
    const expected    = findings.filter(f => f.classification === 'expected');
    const s = v.structuralStats || {};

    const summaryHtml = v.overallSummary ? `<p>${q(v.overallSummary)}</p>` : '';

    // MANDATORY, not cosmetic. Every entry here is a filter that removed a
    // real difference from the findings above, and an invisible filter is
    // worse than the noise it removes — a reader who can't see that 38
    // elements were dropped as page reflow has no way to tell a clean diff
    // from an over-aggressive one. If suppression ever hides a genuine
    // regression, this line is what makes that discoverable.
    const agg = v.aggregate || {};
    const reflowDetail = [
      agg.reflowPxMax ? `up to ${Math.round(agg.reflowPxMax)}px vertically` : '',
      agg.reflowHorizontal ? `${agg.reflowHorizontal} of them a horizontal grid re-wrap` : '',
    ].filter(Boolean).join(', ');
    const suppressed = [
      agg.reflow ? `${agg.reflow} suppressed as page reflow${reflowDetail ? ` (${reflowDetail})` : ''}` : '',
      agg.punctuationOnly ? `${agg.punctuationOnly} punctuation- or whitespace-only` : '',
      agg.numericOnly ? `${agg.numericOnly} live counter${agg.numericOnly === 1 ? '' : 's'}` : '',
    ].filter(Boolean);

    const notes = [
      v.noSpecText ? '<div class="ab-cline">No Summary of Changes provided — differences are described but not judged expected vs unexpected.</div>' : '',
      suppressed.length ? `<div class="ab-cline rpt-muted">Filtered before analysis: ${q(suppressed.join(', '))}.</div>` : '',
      // Which identity key actually matched each element. Instrumentation for
      // the load-bearing assumption behind the whole matching scheme — that a
      // structural path survives what experiment JS does to a page. If the
      // 'path' tier is starved on real forced-variant URLs, elements are
      // being carried by the text tiers alone and a copy rewrite inside a
      // restructured subtree would fall through to add/remove.
      v.matchTierCounts && Object.keys(v.matchTierCounts).length
        ? `<div class="ab-cline rpt-muted">Matched by: ${q(Object.entries(v.matchTierCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', '))}.</div>`
        : '',
      v.diffMode === 'redesign' ? `<div class="ab-cline ab-warn">Only ${Math.round((v.matchedFraction || 0) * 100)}% of elements have a counterpart in ${q(vd.baselineLabel)} — this looks like a wholesale redesign rather than a targeted experiment, so differences are summarized per page region instead of element by element.</div>` : '',
      (s.addedCount || s.removedCount || s.modifiedCount || s.styleChangedCount) ? `<div class="ab-cline rpt-muted">${s.addedCount || 0} added, ${s.removedCount || 0} removed, ${s.modifiedCount || 0} modified, ${s.styleChangedCount || 0} style-changed, ${s.unchangedCount || 0} unchanged content block${s.unchangedCount === 1 ? '' : 's'} detected.</div>` : '',
      v.pixelDiff?.flagged ? `<div class="ab-cline ab-warn">${Math.round(v.pixelDiff.ratio * 100)}% of pixels differ across the page (including any changes already described above) — review directly if this seems high relative to the findings above.</div>` : '',
      v.fullPageTruncated ? '<div class="ab-cline ab-warn">Page exceeds the 8000px capture limit — content below the cutoff was not evaluated.</div>' : '',
      abState.qaMode ? '<div class="ab-cline">QA Mode is on — its on-page badge usually shows the variant’s own name, so it may appear as a difference here even though it isn’t one.</div>' : '',
      v.truncatedFindingCount ? `<div class="ab-cline">${v.truncatedFindingCount} finding${v.truncatedFindingCount !== 1 ? 's' : ''} not analyzed — this page has an unusually large number of changes.</div>` : '',
      v.noVerdictCount ? `<div class="ab-cline rpt-muted">${v.noVerdictCount} finding${v.noVerdictCount !== 1 ? 's' : ''} returned without a verdict.</div>` : '',
      v.duplicateIndexCount ? `<div class="ab-cline ab-warn">The model returned inconsistent finding references for ${v.duplicateIndexCount} item${v.duplicateIndexCount !== 1 ? 's' : ''}.</div>` : '',
      v.truncated ? '<div class="ab-cline ab-warn">Response was cut off — some findings may be incomplete.</div>' : '',
      v.resumed ? '<div class="ab-cline rpt-muted">Restored from a previous run that didn’t finish — crops unavailable.</div>' : '',
    ].filter(Boolean).join('');

    const body = summaryHtml + notes + (findings.length ? `
      ${unexpected.map(f => findingRow(f, v.resumed)).join('')}
      ${unclear.map(f => findingRow(f, v.resumed)).join('')}
      ${expected.length ? `<details><summary style="cursor:pointer;font-size:11px;color:#777">${expected.length} expected difference${expected.length !== 1 ? 's' : ''}</summary>${expected.map(f => findingRow(f, v.resumed)).join('')}</details>` : ''}
    ` : `<p class="rpt-muted">${shared.length
        ? 'Nothing unique to this variant — every difference it has from ' + q(vd.baselineLabel) + ' is listed under “Common to all variants” above.'
        : 'No differences detected.'}</p>`);

    return `<h3>${q(v.label)}${v.resumed ? ' <span class="rpt-muted" style="font-size:9px">(resumed)</span>' : ''}</h3>${body}`;
  });

  // Reported once, before the per-variant sections, because it is the same
  // change in every variant — not a per-variant finding repeated N times.
  const sharedHtml = shared.length ? `
    <h3>Common to all variants <span class="rpt-muted" style="font-size:9px">(${shared.length} change${shared.length !== 1 ? 's' : ''} vs ${q(vd.baselineLabel)}, identical in ${q((shared[0].sharedAcross || []).join(', '))})</span></h3>
    <p class="rpt-muted">These differ from ${q(vd.baselineLabel)} in exactly the same way in every variant, so they are listed once here rather than repeated under each. They are still real differences from Control — review them.</p>
    ${shared.map(f => findingRow(f, false)).join('')}` : '';

  return rptSection('Visual Diff (AI)', badge, summary, sharedHtml + variantSections.join(''));
}

function rptWcagSection(entry) {
  if (entry.status === 'skipped') return rptSkipped(entry.name, entry.reason);
  const run = entry.data;
  let passed = 0, withIssues = 0, manual = 0, totalIssues = 0;
  const rows = run.checks.filter(k => run.results[k]).map(k => {
    const { label, issues, infoOnly } = run.results[k];
    const count = issues.length;
    let status;
    if (infoOnly) { manual++; status = 'Manual'; }
    else { totalIssues += count; count === 0 ? passed++ : withIssues++; status = count === 0 ? 'Pass' : count + ' issue(s)'; }
    const issuesHtml = issues.length ? `<ul>${issues.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '—';
    return `<tr><td>${esc(label)}</td><td>${status}</td><td>${issuesHtml}</td></tr>`;
  }).join('');
  const badge = rptBadge(withIssues ? 'issues' : 'pass', withIssues ? 'ISSUES FOUND' : 'PASS');
  const summary = `${passed} passed · ${withIssues} with issues · ${manual} manual review${totalIssues ? ` · ${totalIssues} total issue(s)` : ''}`;
  const notes = [];
  if (run.scope) notes.push('Scoped to: ' + run.scope);
  if (run.axeError) notes.push('axe-core could not run (' + run.axeError + ') — heuristic checks were used instead.');
  if (run.url) notes.push('Audited ' + run.url);
  const body = (notes.length ? `<p class="rpt-muted">${notes.map(esc).join(' · ')}</p>` : '') +
    `<table class="rpt-table"><thead><tr><th>Check</th><th>Status</th><th>Issues</th></tr></thead><tbody>${rows}</tbody></table>` +
    rptAgenticNoteHtml(run.agenticNote);
  return rptSection(entry.name, badge, summary, body);
}

function rptCvaSection(entry) {
  if (entry.status === 'skipped') return rptSkipped(entry.name, entry.reason);
  const run = entry.data;
  const diff = diffCvaRuns(run.runs, run.autoChecks);
  const checkMeta = Object.fromEntries(WCAG_CHECKS.map(c => [c.key, c]));
  const totalIntroduced = diff.variants.reduce((n, v) => n + v.introduced, 0);
  const badge = rptBadge(totalIntroduced ? 'issues' : 'pass', totalIntroduced ? 'ISSUES FOUND' : 'PASS');
  const summary = `Baseline: ${diff.base.label} · ${totalIntroduced} introduced issue(s) across ${diff.variants.length} variant(s)`;
  const rows = diff.variants.map(v => {
    if (v.loadError) return `<tr><td>${esc(v.label)}</td><td colspan="2">Load failure: ${esc(v.loadError)}</td></tr>`;
    const detail = v.perCheck.filter(pc => pc.introduced.length)
      .map(pc => `${esc(checkMeta[pc.key]?.label || pc.key)}: ${pc.introduced.length} introduced`).join('; ') || '—';
    return `<tr><td>${esc(v.label)}</td><td>${v.introduced} introduced · ${v.resolved} resolved · ${v.preexisting} pre-existing</td><td>${detail}</td></tr>`;
  }).join('');
  const body = `<table class="rpt-table"><thead><tr><th>Variant</th><th>Summary</th><th>Introduced checks</th></tr></thead><tbody>${rows}</tbody></table>`;
  return rptSection(entry.name, badge, summary, body);
}

function rptPerfSection(entry) {
  if (entry.status === 'skipped') return rptSkipped(entry.name, entry.reason);
  const run = entry.data;
  const shown = run.pages.filter(p => !p.skipped);
  const overTotal = shown.reduce((n, p) => n + Object.values(p.summary.verdicts).filter(v => v === 'over').length, 0);
  const badge = rptBadge(overTotal ? 'fail' : 'pass', overTotal ? 'FAIL' : 'PASS');
  const summary = `${shown.length} page(s) measured · ${overTotal ? overTotal + ' metric(s) over budget' : 'all budgets met'}`;
  const rows = shown.map(p => {
    const s = p.summary;
    const cells = PERF_METRICS.filter(m => m.budget).map(m =>
      `${esc(m.label)}: ${fmtMetric(s.medians[m.key], m)} (budget ${fmtMetric(run.budgets[m.budget], m)}) — ${s.verdicts[m.key] === 'over' ? 'OVER' : 'OK'}`
    ).join('<br>');
    return `<tr><td>${esc(shortUrl(p.url))}</td><td>${cells}</td></tr>`;
  }).join('');
  const agenticNotes = shown.filter(p => p.agenticNote)
    .map(p => rptAgenticNoteHtml(p.agenticNote, `${shortUrl(p.url)} — Agentic Testing Note (Sonnet)`)).join('');
  const body = `<table class="rpt-table"><thead><tr><th>Page</th><th>Metrics vs budget</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="rpt-muted">Measured in this browser on this machine and network — treat as relative comparison, not lab-grade absolutes.</p>` +
    agenticNotes;
  return rptSection(entry.name, badge, summary, body);
}

function rptFunnelSection(entry) {
  if (entry.status === 'skipped') return rptSkipped(entry.name, entry.reason);
  const run = entry.data || {};
  if (run.error && !(run.segments || []).length) return rptSkipped(entry.name, run.error);
  const segments = run.segments || [];
  const badge = rptBadge(run.reachedEnd ? 'pass' : 'fail', run.reachedEnd ? 'REACHED END' : 'BROKE');
  const failedAt = segments.find(s => !s.reached);
  const summary = run.reachedEnd
    ? `Agent navigated all ${segments.length} segment(s) to End`
    : `Funnel broke at ${failedAt ? esc(shortUrl(failedAt.from)) + ' → ' + esc(shortUrl(failedAt.to)) : 'an early segment'}`;
  const rows = segments.map(s => `<tr>
    <td>${esc(shortUrl(s.from))} → ${esc(shortUrl(s.to))}</td>
    <td>${s.reached ? 'REACHED' : 'FAILED'}</td>
    <td>${s.steps} step${s.steps === 1 ? '' : 's'}${s.error ? ' · ' + esc(s.error) : ''}</td>
  </tr>`).join('');
  let body = `<table class="rpt-table"><thead><tr><th>Segment</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="rpt-muted">An AI agent (Sonnet) navigated by clicking the live UI, up to ~10 actions per segment. A segment fails if the next waypoint wasn't reached within that budget.</p>`;
  for (const s of segments) if (s.note) body += rptAgenticNoteHtml(s.note, `${shortUrl(s.from)} → ${shortUrl(s.to)} — Agent notes (Sonnet)`);
  return rptSection(entry.name, badge, summary, body);
}

// ── Report assembly (pure body builder) + open in a bundled tab ─────────────
// Formats data already produced by each mode's own run — no DOM reads.
// Everything that degraded this run, in one place, at the end of the report.
// The per-section prose already mentions most of these individually, but
// scattered across sections and interleaved with findings — which is how a
// run with a truncated page, an unmatched watched selector, and 12 capped
// findings can still read as clean. Collected here they read as what they
// are: the limits on how much this report is worth trusting.
function rptDiagnosticsSection(problems) {
  const errors = problems.filter(p => p.severity === 'error');
  const warns = problems.filter(p => p.severity === 'warn');
  const infos = problems.filter(p => p.severity === 'info');
  if (!problems.length) {
    return rptSection('Run Diagnostics', rptBadge('pass', 'CLEAN'),
      'Nothing degraded this run — every page loaded, captured, and compared in full.', '');
  }
  const row = (p) => `<tr><td>${esc(p.severity.toUpperCase())}</td><td>${esc(p.where)}</td><td>${esc(p.detail)}</td></tr>`;
  const body = `<table class="rpt-table"><thead><tr><th>Level</th><th>Where</th><th>Detail</th></tr></thead>
      <tbody>${errors.concat(warns, infos).map(row).join('')}</tbody></table>
    <p class="rpt-muted">Download the debug log from the button at the top of this page for the underlying numbers — match tiers, reflow bands, per-finding geometry, and the unmatched residue.</p>`;
  const badge = errors.length ? rptBadge('fail', 'DEGRADED') : rptBadge('issues', 'CAVEATS');
  return rptSection('Run Diagnostics', badge,
    `${errors.length} error(s), ${warns.length} warning(s), ${infos.length} note(s) affecting how much of this run completed`, body);
}

function buildReportBody(sections) {
  const { ts, pageUrls, modes, extraHtml } = sections;
  const builders = {
    2: rptAbSection,
    4: rptWcagSection, 5: rptCvaSection, 6: rptPerfSection,
    funnel: rptFunnelSection,
  };
  let diagnosticsHtml = '';
  try { diagnosticsHtml = rptDiagnosticsSection(vdCollectProblems(sections)); } catch (_) {}
  const body = (extraHtml || '') + modes.map(entry => (builders[entry.mode] || (() => ''))(entry)).join('') + diagnosticsHtml;
  const urlsHtml = pageUrls.length
    ? pageUrls.map(u => `<li>${esc(u)}</li>`).join('')
    : '<li>No page URLs recorded.</li>';

  // Just the inner markup that qa-report.html drops into its .rpt-wrap
  // container. Deliberately NOT a full HTML document opened via a blob: URL —
  // recent Chrome blocks top-level navigation to extension-created blob: URLs
  // (the tab loads with an error), so openReportTab stashes this body in
  // chrome.storage.session and opens the bundled qa-report.html page instead.
  // The CSS + page shell + print button live in qa-report.html.
  return `<header class="rpt-header">
      <h1>Selenite QA Report</h1>
      <div class="rpt-meta">Generated ${esc(new Date(ts).toLocaleString())}</div>
      <div class="rpt-meta" style="margin-top:8px">Page(s) tested:</div>
      <ul>${urlsHtml}</ul>
    </header>
    ${body}`;
}

// ── Debug log ───────────────────────────────────────────────────────────────
// Exported alongside the report, as JSON, from a button on the report page.
// The rendered report answers "what changed"; this answers "why should I
// believe it", and it exists because the first real Visual Diff run couldn't
// answer the second question from the report alone — the numbers said
// something was wrong without saying what, and the cause had to be found by
// reconstructing the page's geometry by hand offline.
//
// `problems` comes first and is the point of the file: every way this run was
// degraded, incomplete, or working from a guess, collected in one list
// instead of scattered across per-section prose. A clean run yields an empty
// array, which is itself the useful signal.
// ── Design reference diagnostics ───────────────────────────────────────────
// Everything about WHY the spec text and the Control resolution came out the
// way they did. Both are ticket-derived, both fail silently, and both failures
// look identical from the outside — "no Summary of Changes" reads the same
// whether no ticket was active, the ticket had no variant descriptions, or the
// user simply didn't type one. Two debugging rounds were spent on exactly that
// ambiguity before this existed.
function buildDesignReferenceDebug(ctx, state, hasFigmaPat) {
  const variants = ctx?.variants || [];
  const previewLinks = ctx?.previewLinks || [];
  const summary = (state?.summaryOfChanges || '').trim();
  return {
    ticketContext: !ctx ? null : {
      ticketKey: ctx.ticketKey || null,
      reviewed: !!ctx.reviewed,
      variantCount: variants.length,
      // The two fields the autofill and the baseline resolver actually read.
      // A context can be present and reviewed and still be useless to both.
      variantsWithDescription: variants.filter(v => (v.rawDescription || '').trim()).length,
      controlVariantId: (variants.find(v => v.isControl) || {}).id || null,
      variantIds: variants.map(v => v.id),
      previewLinkCount: previewLinks.length,
      previewLinkIds: previewLinks.map(l => l.id),
    },
    summaryOfChanges: {
      present: !!summary,
      length: summary.length,
      source: summary ? (state?.summarySource || 'unknown') : null,
    },
    figma: {
      urlUsed: (state?.figmaUrl || '').trim() || null,
      urlFromTicket: ctx?.figmaUrl || null,
      nodeId: ctx?.figmaNodeId || null,
      tokenConfigured: !!hasFigmaPat,
      comp: ctx?.compAttachment
        ? { filename: ctx.compAttachment.filename, w: ctx.compAttachment.w, h: ctx.compAttachment.h }
        : null,
      compCandidateCount: (ctx?.compCandidates || []).length,
    },
  };
}

function vdCollectProblems(sections) {
  const problems = [];
  const add = (severity, where, detail) => problems.push({ severity, where, detail });

  // Spec text and Control resolution first — both are ticket-derived, both
  // degrade the entire report rather than one finding, and both are invisible
  // in the findings themselves.
  const dr = sections.designReference;
  if (dr) {
    const tc = dr.ticketContext;
    if (!dr.summaryOfChanges.present) {
      add('error', 'summary-of-changes',
        'Empty, so every finding is "unclear" — nothing was judged expected vs unexpected. '
        + (!tc ? 'No ticket context was active, and nothing was typed manually.'
              : tc.variantCount === 0
                // Zero variants and zero-with-descriptions are different
                // failures with different fixes, and the count of preview
                // links separates them: links come from the AI extraction,
                // variants from the deterministic Test Specifications parse,
                // so links-without-variants localises the fault precisely.
                ? `Ticket ${tc.ticketKey} is active but NO variants were parsed from it`
                  + (tc.previewLinkCount ? ` (though ${tc.previewLinkCount} preview link(s) were found)` : '')
                  + ". Its Test Specifications section is missing or in a shape the parser doesn't recognise — check the ticket, or type a summary by hand."
                : tc.variantsWithDescription === 0
                  ? `Ticket ${tc.ticketKey} parsed ${tc.variantCount} variant(s) but none carry a description, so the auto-fill had nothing to write. Check the ticket's Test Specifications section, or type a summary by hand.`
                  : 'The ticket has variant descriptions, so the auto-fill should have run — it only fills an EMPTY box, so a stale empty value may have been persisted.'));
    } else {
      add('info', 'summary-of-changes', `Spec text came from: ${dr.summaryOfChanges.source} (${dr.summaryOfChanges.length} chars). Every expected/unexpected verdict below is relative to it.`);
    }

    if (tc && tc.variantCount && !tc.controlVariantId) {
      add('warn', 'ticket-context',
        `Ticket ${tc.ticketKey} has no variant flagged as Control (ids: ${tc.variantIds.join(', ') || 'none'}), so Control could not be resolved from it and the first target was used instead.`);
    }
    if (tc && tc.variantCount && !tc.previewLinkCount) {
      add('warn', 'ticket-context', `Ticket ${tc.ticketKey} parsed ${tc.variantCount} variant(s) but no preview links, so tested URLs cannot be mapped back to ticket variants.`);
    }
    if (tc && !tc.variantCount && tc.previewLinkCount) {
      add('warn', 'ticket-context', `Ticket ${tc.ticketKey} parsed ${tc.previewLinkCount} preview link(s) but no variants. Those come from different parsers — the links are AI-extracted, the variants are read deterministically from Test Specifications — so this points at that section specifically, not at the ticket as a whole.`);
    }

    // Figma reference state — absent is normal and silent; present-but-unusable is not.
    if (dr.figma.urlFromTicket && !dr.figma.tokenConfigured) {
      add('warn', 'design-reference', 'The ticket has a Figma link but no Figma token is configured — add one in Settings to read the board.');
    }
    if (dr.figma.urlFromTicket && !dr.figma.nodeId) {
      add('warn', 'design-reference', 'The ticket\'s Figma link points at the whole file rather than a specific board (no node-id).');
    }
    if (!dr.figma.comp && dr.figma.compCandidateCount) {
      add('info', 'design-reference', `No attachment matched the {TICKET}_comp convention; ${dr.figma.compCandidateCount} other image(s) are attached.`);
    }
  }

  for (const entry of sections.modes || []) {
    if (entry.status === 'skipped') add('info', entry.name || `mode ${entry.mode}`, `Skipped — ${entry.reason || 'no reason recorded'}`);
    if (entry.error) add('error', entry.name || `mode ${entry.mode}`, entry.error);
    if (entry.mode !== 2 || !entry.data) continue;

    // Geometry mismatch invalidates the whole comparison, so it is checked
    // before anything else and reported as an error, not a note. Comparing a
    // responsive page captured at two different widths compares two layouts,
    // not two variants — and the failure is silent by nature: the diff still
    // completes and still reports a finding count, it is just measuring the
    // wrong thing. A real run did exactly this (Control 1693px, variants
    // 1470px) and read as a clean 2-finding result.
    const baseCap = (entry.data.captures || []).find(c => c.fullPage && !c.fullPage.error);
    for (const c of entry.data.captures || []) {
      if (c.skipped) add('warn', `capture/${c.label}`, `Not captured — ${c.reason || 'run stopped'}`);
      if (c.loadError) add('error', `capture/${c.label}`, `Page load failed — ${c.loadError}`);
      if (c.fullPage?.error) add('error', `capture/${c.label}`, `Full-page capture failed — ${c.fullPage.error}`);
      if (c.fullPage?.geometryPinFailed) {
        add('error', `capture/${c.label}`, `Could not pin this capture to the baseline's viewport (${c.fullPage.geometryPinFailed}) — widths may differ, which would invalidate the comparison.`);
      }
      // Real blind spot, not cosmetic: nothing below the cutoff is compared
      // at all, so a regression down there cannot be reported as anything.
      if (c.fullPage?.truncated) {
        // The DOM walk now covers the full page, so this is no longer a
        // comparison blind spot — only a *visual* one. Say which, precisely:
        // reporting "never compared" when text, colors, layout and element
        // presence were in fact all compared would understate the tool, and
        // reporting nothing would overstate it.
        const missedPct = Math.round((1 - c.fullPage.capturedH / c.fullPage.pageH) * 100);
        add('info', `capture/${c.label}`,
          `Page is ${c.fullPage.pageH}px tall; the screenshot stops at ${c.fullPage.capturedH}px. `
          + `Text, colors, layout and element presence were still compared over the whole page — but for the bottom ${missedPct}% `
          + 'there is no image, so the pixel backstop is skipped and findings there have no crop.');
      }
      for (const e of (c.errors || [])) add('warn', `page-js/${c.label}`, e);
      for (const s of (c.selectors || [])) {
        if (!s.exists) add('warn', `watched-selector/${c.label}`, `Selector never matched: ${s.selector}`);
        else if (!s.visible) add('info', `watched-selector/${c.label}`, `Selector matched but was not visible: ${s.selector}`);
      }
    }

    // Real geometry validation. Replaces a per-capture pageW-vs-pageW test
    // that could not detect a viewport mismatch — the same wrong quantity on
    // both sides — and stood in for a validateVisualDiffGeometry that did not
    // exist. Compares viewport dimensions, which are what determine layout.
    try {
      for (const g of validateVisualDiffGeometry(entry.data.captures || [], entry.data.visualDiffFull?.baselineLabel)) {
        add(g.severity, `capture/${g.label}`, g.detail);
      }
    } catch (e) {
      add('warn', 'visual-diff', `Capture geometry could not be validated — ${e.message}`);
    }

    // visualDiffFull only exists on the standalone A/B path; a
    // Test-Agent-queued run carries the metadata mirror instead.
    const vd = entry.data.visualDiffFull || entry.data.visualDiff;
    if (vd?.skipped) add('warn', 'visual-diff', `Skipped — ${vd.reason}`);
    if (vd?.baselineWarning) add('warn', 'visual-diff', vd.baselineWarning);
    for (const v of (vd?.perVariant || [])) {
      const at = `visual-diff/${v.label}`;
      if (v.skipped) { add('warn', at, `Skipped — ${v.reason || 'not captured'}`); continue; }
      // A shared final URL no longer stops the run, so it has to be said out
      // loud — it is the leading explanation if this variant turns out to be
      // Control in disguise.
      if (v.sameUrlNote) add('warn', at, v.sameUrlNote + '.');
      // Control-vs-Control outranks every other note about this variant: the
      // comparison did not happen, so nothing else recorded for it means
      // anything. Never let this degrade into a quiet aside.
      if (v.controlDuplicate) {
        add('error', at, `${v.error} No QA result exists for this variant — do not read the absence of findings as a pass.`);
        continue;
      }
      if (v.error) { add('error', at, v.error); continue; }
      if (v.noSpecText) add('info', at, 'No Summary of Changes was provided, so nothing was judged expected vs unexpected — every finding is "unclear" by construction.');
      if (v.resumed) add('info', at, 'Restored from a checkpoint rather than freshly analyzed — crops unavailable.');
      if (v.truncated) add('error', at, 'The model\'s response was cut off — some findings are incomplete.');
      if (v.truncatedFindingCount) add('warn', at, `${v.truncatedFindingCount} finding(s) exceeded the cap and were never analyzed.`);
      if (v.noVerdictCount) add('warn', at, `${v.noVerdictCount} finding(s) came back without a verdict.`);
      if (v.duplicateIndexCount) add('warn', at, `The model returned inconsistent finding references for ${v.duplicateIndexCount} item(s).`);
      if (v.diffMode === 'redesign') {
        // A geometry mismatch produces a low match rate all by itself, so
        // don't let the redesign verdict stand as if it were a finding about
        // the experiment when there's a known reason to distrust it.
        // Viewport, not content width — same reason as the validator above.
        // A redesign verdict caused by comparing two different LAYOUTS is the
        // exact case this disclaimer exists for, and pageW cannot see it.
        const geomBad = (entry.data.captures || []).some(c =>
          baseCap && c.fullPage && !c.fullPage.error && c !== baseCap
          && c.fullPage.viewportW != null && baseCap.fullPage.viewportW != null
          && (c.fullPage.viewportW !== baseCap.fullPage.viewportW
              || c.fullPage.viewportH !== baseCap.fullPage.viewportH));
        add('warn', at, `Only ${Math.round((v.matchedFraction || 0) * 100)}% of elements matched — treated as a wholesale redesign and rolled up per region, not compared element by element.`
          + (geomBad ? ' This is most likely the capture-width mismatch above rather than a real redesign — fix that and re-run before reading anything into it.' : ''));
      }

      const d = v.diffDebug;
      if (d) {
        const fuzzy = d.matchTierCounts?.fuzzy || 0;
        if (fuzzy) add('warn', at, `${fuzzy} element(s) were paired by approximate similarity rather than an exact key — those pairings may be wrong.`);
        // The signature of broken reflow suppression: an amount that keeps
        // showing up among reported moves but never earned a trusted cluster.
        const trusted = new Set([...(d.shiftClusters?.vertical || []), ...(d.shiftClusters?.horizontal || [])]
          .filter(c => c.trusted).map(c => Math.round(c.delta)));
        const repeated = Object.entries(d.movesByDelta || {}).filter(([, n]) => n >= 3);
        for (const [key, n] of repeated) {
          const dy = Math.round(Number((key.match(/dy=(-?\d+)/) || [])[1] || 0));
          const dx = Math.round(Number((key.match(/dx=(-?\d+)/) || [])[1] || 0));
          if (!trusted.has(dy) && !trusted.has(dx)) {
            add('warn', at, `${n} elements were each reported as moved by the same amount (${key}) with no trusted reflow band to explain it — if these are one cascade, reflow suppression is under-matching.`);
          }
        }
        // The candidate walk truncates from the bottom of the page at
        // VD_MAX_CANDIDATES. That was unreachable while the walk stopped at
        // the screenshot's 8000px; now that it covers the whole document, a
        // very long page can genuinely hit it — and a silent bottom-truncation
        // is exactly the invisible blind spot this run's work removed.
        const cap = typeof VD_MAX_CANDIDATES === 'number' ? VD_MAX_CANDIDATES : 3000;
        if (d.counts?.controlElements >= cap || d.counts?.variantElements >= cap) {
          add('warn', at, `The element walk hit its ${cap}-candidate ceiling, which truncates from the bottom of the page — the lowest part of this page may not have been compared at all.`);
        }
        if (d.belowCapture?.control) {
          // Lead with the coverage, not the caveat: these elements used to be
          // outside the comparison entirely, so the headline is how much of
          // the page is now being checked that previously was not.
          const total = d.counts?.controlElements || 0;
          add('info', at, `${d.belowCapture.control} of ${total} elements sit below the screenshot's reach and were compared from the DOM alone`
            + (d.belowCapture.findings
                ? ` — ${d.belowCapture.findings} finding(s) came from there, and have no crop and were not pixel-checked.`
                : ' — no findings came from there.'));
        }
        if (d.offCanvas?.control || d.offCanvas?.variant) {
          add('info', at, `${d.offCanvas.control} control / ${d.offCanvas.variant} variant element(s) sit outside the page's horizontal bounds — `
            + 'usually an auto-scrolling marquee resting at a different offset in each capture. They are compared from the DOM like any other element'
            + (d.offCanvas.findings
                ? `, and ${d.offCanvas.findings} finding(s) came from there, with no crop and no pixel check.`
                : ', and produced no findings.'));
        }
        if (d.counts?.unmatchedControl > 20 || d.counts?.unmatchedVariant > 20) {
          add('warn', at, `${d.counts.unmatchedControl} control and ${d.counts.unmatchedVariant} variant elements could not be paired at all — see unmatchedControlSample/unmatchedVariantSample.`);
        }
      } else {
        add('info', at, 'No diff diagnostics recorded for this variant.');
      }
    }
  }
  return problems;
}

function buildDebugLog(sections) {
  const abEntry = (sections.modes || []).find(m => m.mode === 2);
  const vd = abEntry?.data?.visualDiffFull || abEntry?.data?.visualDiff;

  return {
    readme: 'Selenite QA debug log. `problems` lists everything that degraded this run — start there. '
      + 'For Visual Diff, cross-reference each variant\'s `movesByDelta` against its `shiftClusters`: a shift amount '
      + 'that appears repeatedly among reported moves but has no trusted cluster means reflow suppression is '
      + 'under-matching and those findings are cascade, not real changes. A starved `path` entry in `matchTierCounts` '
      + 'means structural identity is not surviving this page\'s experiment JS.',
    generatedAt: new Date(sections.ts).toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    problems: vdCollectProblems(sections),
    designReference: sections.designReference || null,
    run: {
      pageUrls: sections.pageUrls || [],
      modes: (sections.modes || []).map(m => ({ mode: m.mode, name: m.name, status: m.status, reason: m.reason || null })),
      settings: {
        qaMode: abState?.qaMode, settleSec: abState?.settleSec, keepTabs: abState?.keepTabs,
        visualDiff: abState?.visualDiff, visualDiffCrops: abState?.visualDiffCrops,
        agenticTesting: abState?.agenticTesting, hasSummaryOfChanges: !!(abState?.summaryOfChanges || '').trim(),
      },
    },
    captures: (abEntry?.data?.captures || []).map(c => ({
      label: c.label, url: c.url, finalUrl: c.finalUrl, title: c.title,
      skipped: !!c.skipped, loadError: c.loadError || null,
      fullPage: c.fullPage || null,
      jsErrors: c.errors || [],
      consoleLineCount: (c.console || []).length,
      selectors: c.selectors || [],
    })),
    visualDiff: !vd || vd.skipped ? { skipped: true, reason: vd?.reason || 'not run' } : {
      baselineLabel: vd.baselineLabel, baselineWarning: vd.baselineWarning || null,
      // Lifted out of the per-variant lists — without these the debug log would
      // show fewer findings per variant than the diff actually produced.
      sharedFindings: (vd.sharedFindings || []).map(f => ({
        changeClass: f.changeClass, region: f.region || null,
        sharedAcross: f.sharedAcross || [],
        controlText: (f.controlBlock?.text || '').slice(0, 160) || null,
        variantText: (f.variantBlock?.text || '').slice(0, 160) || null,
        classification: f.classification || null, severity: f.severity || null,
      })),
      perVariant: (vd.perVariant || []).map(v => ({
        label: v.label, skipped: !!v.skipped, reason: v.reason || null, error: v.error || null,
        controlDuplicate: !!v.controlDuplicate,
        structuralStats: v.structuralStats || null, pixelDiff: v.pixelDiff || null,
        diffMode: v.diffMode || null, matchedFraction: v.matchedFraction ?? null,
        suppressionAggregate: v.aggregate || null,
        reportedFindingCount: (v.findings || []).length,
        truncatedFindingCount: v.truncatedFindingCount || 0,
        // The rendered report shows each finding's prose; this shows the
        // geometry and the identity tier behind it, which is what makes a
        // wrong finding traceable to the pass that produced it.
        findings: (v.findings || []).map(f => ({
          findingId: f.findingId, changeClass: f.changeClass, status: f.status,
          region: f.region || null, matchTier: f.matchTier || null,
          dx: f.dx ?? null, dy: f.dy ?? null, memberCount: f.memberCount || null,
          signals: f.changeSignals || [], pixelRatio: f.pixelRatio ?? null,
          classification: f.classification || null, severity: f.severity || null,
          controlText: (f.controlBlock?.text || '').slice(0, 160) || null,
          variantText: (f.variantBlock?.text || '').slice(0, 160) || null,
          controlRect: f.controlBlock?.rect || null, variantRect: f.variantBlock?.rect || null,
        })),
        diagnostics: v.diffDebug || null,
      })),
    },
  };
}

// Stash the rendered report body under a fresh id in session storage (a
// non-namespaced key so the bundled qa-report.html page, which has no window
// id, can read it — mirrors mxOpenReport), prune to the newest few, then open
// the bundled page pointed at that id.
async function openReportTab(sections) {
  const id = 'r_' + Date.now();
  const { taReports = {} } = await chrome.storage.session.get('taReports');
  let debugLog = null;
  // Never let a debug-log failure cost the user the actual report.
  try { debugLog = buildDebugLog(sections); } catch (e) { debugLog = { error: 'Could not assemble debug log: ' + e.message }; }
  taReports[id] = { title: 'Selenite QA Report', bodyHtml: buildReportBody(sections), debugLog };
  const ids = Object.keys(taReports).sort();
  while (ids.length > 5) delete taReports[ids.shift()];
  await chrome.storage.session.set({ taReports });
  chrome.tabs.create({ url: chrome.runtime.getURL('qa-report.html') + '?k=' + id });
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialize tab — Jira ticket → reviewable Test Context
//
// Context provider, not a test mode. Extraction is a hybrid: Variants,
// Experiment ID, QA Test Plan, and Summary are fully deterministic — no LLM
// call, sourced from direct Jira fields or a clean v0/v1/… marker convention.
// Platform, Preview Links, ITW Link, and Goals are AI-only (see
// runAiFieldExtraction/mergeAiFieldsIntoDraft, further below) — real tickets
// format these loosely enough that regex/heading parsing routinely missed
// them entirely, so there is no deterministic computation for these four at
// all anymore; Extract waits for the AI call before rendering the review
// form. No API token for the Jira fetch itself: authentication rides the user's existing
// Jira session via a same-origin fetch from a content script injected into
// the open ticket tab (see initPageExtractorFn below) — a service-worker
// cross-origin fetch would 401 silently on SameSite cookies. Custom fields
// resolve per-extraction from the issue response's own `names` map
// (expand=names) — nothing is cached. Direct Jira field values always win
// over anything parsed from description text. The merged result is held in
// _initDraft until the user reviews and saves it — nothing here writes to
// chrome.storage.local automatically; only named entries under
// `initContexts` (each reviewed:true) are ever readable by other modes, and
// only the one named by `activeInitContext`.
//
// Every mode that consumes the Test Context does so through the fill-target
// registry (FILL_TARGETS, further below) — either that surface's own "Fill
// from ticket" button, or the "Apply to all modes" fan-out on this tab's
// Active Test Context card. Both are strictly user-initiated: nothing is
// ever pushed automatically. refreshAllFillButtons() (called from tab load,
// from storage.onChanged in another window, and after every fill) may only
// touch button/hint state — it must never call a target's apply().
// ═══════════════════════════════════════════════════════════════════════════

let _initDraft = null;    // extracted-but-uncommitted context; reviewed stays false until Save
let _initWarnings = [];   // review-time flags: missing sections, preview-link diff mismatch, …

async function initInitializeTab() {
  if (!document.getElementById('panel-init')) return;

  await renderIncognitoGuard();

  document.getElementById('btn-init-fetch').addEventListener('click', extractFromActiveTab);
  document.getElementById('init-ticket-key').addEventListener('keydown', e => { if (e.key === 'Enter') extractFromActiveTab(); });
  document.getElementById('btn-init-clear').addEventListener('click', clearActiveContext);
  document.getElementById('btn-init-activate').addEventListener('click', activateSelectedContext);
  document.getElementById('btn-init-delete').addEventListener('click', deleteSelectedContext);

  // The review form re-renders wholesale on structural edits, so its handlers
  // are delegated once here rather than rebound per render.
  const reviewHost = document.getElementById('init-review');
  reviewHost.addEventListener('input',  onInitReviewInput);
  reviewHost.addEventListener('change', onInitReviewChange);
  reviewHost.addEventListener('click',  onInitReviewClick);

  await refreshInitContextSelect();
  await renderActiveContext();

  // Save/clear/activate from another window: keep the saved list, the
  // active-context card, and every registered fill target's button in step.
  // (Never fills anything — display only. See the registry invariant below.)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.initContexts || changes.activeInitContext)) {
      refreshInitContextSelect();
      renderActiveContext();
      refreshAllFillButtons();
      expRefreshCtx();   // display-only — same invariant, just re-renders the Experiment card
    }
  });
}

// ── Prerequisite guard: allow-in-incognito (manual, per-install toggle) ─────
// This can't be set programmatically — if it's off, the incognito window
// never gets an extension instance at all (not just an empty Initialize tab).
// Surfaced here, in the normal window, since that's the only place it can be.
function isAllowedIncognitoAccess() {
  return new Promise(resolve => {
    try { chrome.extension.isAllowedIncognitoAccess(resolve); } catch (_) { resolve(true); }
  });
}

async function renderIncognitoGuard() {
  const el = document.getElementById('init-incognito-warn');
  if (!el) return;
  el.style.display = (await isAllowedIncognitoAccess()) ? 'none' : '';
}

// ── Jira field resolution (dynamic — resolved per fetch from `names`) ───────
// Resolves a rich-text (ADF) custom field by its DISPLAY NAME and returns the
// document itself.
//
// This exists because ticket bodies on these projects do not live in the
// description at all. WOW-1160 and ENOC-97 both return `description: null`
// while carrying a populated "Test Specifications" custom field
// (customfield_10041 on this site) — so parsing only the description found
// zero variants on every real ticket, which left Summary of Changes empty and
// made every Visual Diff finding "unclear" by construction. Preview links kept
// working the whole time because those come from the AI pass, which reads the
// RENDERED page where custom fields are visible. That asymmetry was the
// symptom; this is the cause.
//
// By name rather than id, the same way Platform Experiment ID and QA Test Plan
// already resolve, because custom field ids differ per Jira site.
//
// Prefers a field with content: this site has TWO fields named "Goals"
// (customfield_10040 populated, customfield_10821 empty). Taking the first
// name match by object iteration order would silently pick whichever came
// first, and an empty pick is indistinguishable from a ticket that genuinely
// has nothing to say.
function resolveJiraAdfField(names, fields, label) {
  const want = label.trim().toLowerCase();
  let empty = null;
  for (const [key, name] of Object.entries(names || {})) {
    if ((name || '').trim().toLowerCase() !== want) continue;
    const v = (fields || {})[key];
    if (!v || typeof v !== 'object' || v.type !== 'doc') continue;
    if ((v.content || []).length) return v;
    if (!empty) empty = v;
  }
  return empty;
}

function resolveJiraFieldKey(names, label) {
  const want = label.trim().toLowerCase();
  for (const [key, name] of Object.entries(names || {})) {
    if ((name || '').trim().toLowerCase() === want) return key;
  }
  return null;
}

// Runs INSIDE the open Jira ticket tab via chrome.scripting.executeScript —
// no closures over popup.js state, everything comes in through `overrideKey`.
// Same-origin fetch means the tab's session cookie attaches automatically.
async function initPageExtractorFn(overrideKey) {
  try {
    const m = location.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)/);
    const key = ((overrideKey || '').trim() || (m ? m[1] : '')).toUpperCase();
    if (!key) return { ok: false, error: 'NOT_A_TICKET' };

    const res = await fetch(`${location.origin}/rest/api/3/issue/${encodeURIComponent(key)}?expand=names`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'SESSION_EXPIRED' };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { ok: false, error: 'SESSION_EXPIRED' }; // logged-out HTML redirect
    const issue = await res.json().catch(() => null);
    if (!res.ok || !issue) {
      const detail = [...(issue?.errorMessages || []), ...Object.values(issue?.errors || {})].filter(Boolean).join(' · ');
      return { ok: false, error: 'FETCH_FAILED', status: res.status, detail: detail || res.statusText };
    }

    // Bounded full-text capture of the rendered issue view — feeds the AI
    // field-extraction call, not the deterministic parse below. Covers
    // content that only ever renders client-side (Jira Forms/app panels) and
    // so never appears in the ADF description, e.g. a "Pages" section or the
    // "Key details" tab set. Prefers the issue-view container so it isn't
    // diluted by the rest of the Jira chrome (nav, sidebar). Comments/
    // activity/history are cloned out on purpose — they're the densest
    // source of other people's names and remarks on the page, and none of it
    // is spec content the extraction needs.
    const PAGE_TEXT_BUDGET = 60000;
    const PAGE_TEXT_DROP = '[data-testid*="comment"],[data-testid*="activity"],[data-testid*="history"],[id*="comment"],[id*="activitymodule"],nav,script,style,noscript';
    const container = document.querySelector('[data-testid*="issue"]') || document.querySelector('main') || document.body;
    const containerClone = container ? container.cloneNode(true) : null;
    containerClone?.querySelectorAll?.(PAGE_TEXT_DROP).forEach(n => n.remove());
    const rawPageText = (containerClone?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    const pageTextTruncated = rawPageText.length > PAGE_TEXT_BUDGET;
    const pageText = pageTextTruncated ? rawPageText.slice(0, PAGE_TEXT_BUDGET) : rawPageText;

    // General link inventory — every <a href> left in the same clone
    // pageText was captured from (so comments/activity/history are already
    // excluded), each with its visible text, full href, and nearest block
    // ancestor's text as a label. This is the only place actual preview/ITW
    // URLs are captured at all: pageText is plain innerText, which loses
    // every href — links usually show human text ("v0: Control") rather than
    // the URL itself. Not scoped to any particular heading (tickets phrase
    // section names inconsistently); the AI field-extraction call sorts out
    // which links are preview links, ITW, editor/results, etc.
    const links = [];
    containerClone?.querySelectorAll?.('a[href]').forEach(a => {
      if (links.length >= 300) return;
      const url = a.href;
      if (!/^https?:/i.test(url)) return;
      links.push({
        text: (a.textContent || '').trim().slice(0, 200),
        url: url.slice(0, 500),
        label: (a.closest('li,p,tr,td,div,h1,h2,h3,h4,h5,h6')?.textContent || '').trim().slice(0, 300),
      });
    });

    return { ok: true, issue, pageText, pageTextTruncated, links, origin: location.origin, ticketKey: key };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', detail: e?.message || String(e) };
  }
}

// Runs INSIDE the open Jira tab, same as initPageExtractorFn above — and for
// the same reason: the attachment endpoint needs the tab's session cookie.
//
// The downscale happens HERE rather than in the worker on purpose. A four-up
// comp at full resolution is several MB, and doing it page-side means that
// payload crosses a process boundary once, already small, instead of twice at
// full size. The run-time context is incognito with no Jira session, so this
// is also the only moment the bytes are reachable at all.
//
// JPEG rather than PNG: at 2000px the text stays legible for a vision read,
// and a PNG of a four-up contact sheet is large enough to be worth avoiding.
async function initFetchAttachmentFn(contentUrl, maxEdge) {
  try {
    const res = await fetch(contentUrl, { credentials: 'same-origin' });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' fetching the attachment' };
    const blob = await res.blob();
    if (!/^image\//i.test(blob.type || '')) return { ok: false, error: 'Attachment is not an image (' + (blob.type || 'unknown type') + ')' };

    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Comps are exported on white; without this a transparent PNG flattens to
    // black and every text read off it fails.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return { ok: true, dataUrl: canvas.toDataURL('image/jpeg', 0.85), w, h, srcW: bmp.width, srcH: bmp.height };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Longest edge for the stored comp. 2000 keeps body copy legible on a
// four-up sheet while staying well inside what a vision call will accept.
const COMP_MAX_EDGE = 2000;

// Pulls the matched comp into IndexedDB and rewrites _initDraft.compAttachment
// to point at it. Best-effort by design: a missing comp degrades the design
// reference, it does not invalidate the ticket context, so every failure path
// records a warning and returns rather than throwing.
async function fetchCompAttachment(tabId) {
  if (!_initDraft) return;
  const pending = _initDraft.compPending;
  _initDraft.compPending = null;
  if (!pending?.content) return;

  let injected;
  try {
    [injected] = await chrome.scripting.executeScript({
      target: { tabId }, func: initFetchAttachmentFn, args: [pending.content, COMP_MAX_EDGE],
    });
  } catch (e) {
    _initWarnings.push(`Comp: could not run the attachment fetch on the ticket tab — ${e?.message || e}`);
    return;
  }

  const r = injected?.result;
  if (!r?.ok) {
    _initWarnings.push(`Comp: "${pending.filename}" could not be downloaded — ${r?.error || 'no result'}. The design reference will fall back to the Figma link.`);
    return;
  }

  const idbKey = 'comp:' + _initDraft.ticketKey;
  try {
    await idbPut('figma', { dataUrl: r.dataUrl, filename: pending.filename, storedAt: Date.now() }, idbKey);
  } catch (e) {
    _initWarnings.push(`Comp: "${pending.filename}" downloaded but could not be stored — ${e?.message || e}`);
    return;
  }

  _initDraft.compAttachment = {
    filename: pending.filename, mimeType: 'image/jpeg', idbKey,
    w: r.w, h: r.h, srcW: r.srcW, srcH: r.srcH,
  };
}

async function getCompImage(ctx) {
  const key = ctx?.compAttachment?.idbKey;
  if (!key) return null;
  try { return (await idbGet('figma', key))?.dataUrl || null; } catch (_) { return null; }
}

// ── Extraction pipeline (deterministic fetch/parse, then AI field merge) ────
async function extractFromActiveTab() {
  const statusEl = document.getElementById('init-fetch-status');
  const setStatus = (t, color) => { statusEl.textContent = t; statusEl.style.color = color || 'var(--fg3)'; };

  const overrideKey = document.getElementById('init-ticket-key').value.trim().toUpperCase();
  if (overrideKey && !/^[A-Z][A-Z0-9]*-\d+$/.test(overrideKey)) {
    setStatus(`"${overrideKey}" doesn't look like a ticket key (expected e.g. ABC-123).`, 'var(--err)');
    return;
  }

  const btn = document.getElementById('btn-init-fetch');
  btn.disabled = true;
  setStatus('Extracting from the active tab…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) throw new Error("Open the Jira ticket in this window's active tab first.");

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: initPageExtractorFn,
      args: [overrideKey],
    });
    const r = injected?.result;
    if (!r) throw new Error('Could not run the extractor on this tab.');
    if (!r.ok) {
      if (r.error === 'NOT_A_TICKET')    throw new Error("This doesn't look like a Jira ticket — open the ticket (a /browse/KEY URL) in this window's active tab, or enter its key above.");
      if (r.error === 'SESSION_EXPIRED') throw new Error('Your Jira session looks expired — open/refresh the ticket tab, log in, and try again.');
      throw new Error(r.detail || `Fetch failed (${r.status || 'error'})`);
    }
    extractTestContext(r.issue, r.origin, r.ticketKey, r.links);
    if (_initDraft?.compPending) {
      setStatus(`Extracting… downloading ${_initDraft.compPending.filename}…`);
      await fetchCompAttachment(tab.id);
    }
    setStatus('Extracting… asking AI to fill in Platform, Preview Links, ITW Link, and Goals…');
    const aiRes = await runAiFieldExtraction(r, _initDraft).catch(e => ({ ok: false, error: e?.message || String(e) }));
    mergeAiFieldsIntoDraft(aiRes);
    renderInitReview();
    setStatus(`Extracted from ${_initDraft.ticketKey} — review below, then save.`, 'var(--ok)');
  } catch (e) {
    _initDraft = null; _initWarnings = [];
    document.getElementById('init-review').innerHTML = '';
    setStatus('Error: ' + e.message, 'var(--err)');
  } finally {
    btn.disabled = false;
  }
}

// Custom-field values arrive as strings (URL/text fields), numbers, option
// objects ({value}), or rich-text ADF docs — normalize to a plain string.
function jiraFieldString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if (v.type === 'doc') return adfText(v).trim() || null;
    if (typeof v.value === 'string') return v.value.trim() || null;
  }
  return null;
}

// Convert metric ids are long numeric tokens, but a goal's prose can easily
// contain an unrelated 6+ digit number (a date, another ticket ref, a
// threshold). Only accept a digit run anchored by a label ("metric id"/
// "metric"/"id", a leading #, or enclosure in parens/brackets) — unanchored
// numbers are never guessed at.
function extractConvertMetricId(text) {
  if (/\bTBD\b/i.test(text)) return { id: null, candidates: [] };
  const anchorRes = [
    /\b(?:metric\s*id|metric|id)\s*[:#]?\s*#?\s*(\d{6,})\b/ig,
    /#\s*(\d{6,})\b/g,
    /[([]\s*(\d{6,})\s*[)\]]/g,
  ];
  const candidates = new Set();
  for (const re of anchorRes) {
    let m;
    while ((m = re.exec(text))) candidates.add(m[1]);
  }
  return { id: candidates.size === 1 ? [...candidates][0] : null, candidates: [...candidates] };
}

function extractTestContext(issue, origin, ticketKeyFromPage, links) {
  const f = issue.fields || {};
  const names = issue.names || {};
  const warnings = [];

  // Step 1 — direct fields (always win over anything parsed from text).
  // Platform, Preview Links, ITW Link, and Goals are AI-only (see
  // runAiFieldExtraction/mergeAiFieldsIntoDraft, further below) — real
  // tickets format them loosely enough that deterministic Labels-matching
  // and ADF-heading parsing routinely missed them entirely. Only Variants,
  // Experiment ID, QA Test Plan, and Summary stay deterministic here.
  const ticketKey = issue.key || ticketKeyFromPage;
  const ticketUrl = `${origin}/browse/${ticketKey}`;
  const summary = f.summary || '';

  const experimentIdKey = resolveJiraFieldKey(names, 'Platform Experiment ID');
  const qaTestPlanKey   = resolveJiraFieldKey(names, 'QA Test Plan');
  if (!experimentIdKey) warnings.push('No field named "Platform Experiment ID" was found on this ticket — check the field\'s display name on this Jira site.');
  if (!qaTestPlanKey)   warnings.push('No field named "QA Test Plan" was found on this ticket — check the field\'s display name on this Jira site.');
  const experimentId  = experimentIdKey ? jiraFieldString(f[experimentIdKey]) : null;
  const qaTestPlanUrl = qaTestPlanKey   ? jiraFieldString(f[qaTestPlanKey])   : null;
  if (experimentIdKey && !experimentId) warnings.push('"Platform Experiment ID" field is empty on this ticket.');

  const adf = (f.description && typeof f.description === 'object') ? f.description : null;

  // Step 3 — variants from "Test Specifications".
  //
  // Two shapes, and the custom field wins because it is what real tickets
  // actually use. When the section is its own field the WHOLE field is the
  // section — there is no heading to locate inside it, so its content is used
  // directly rather than being handed to adfSectionNodes.
  const specField = resolveJiraAdfField(names, f, 'Test Specifications');
  const specNodes = specField ? (specField.content || [])
    : adf ? adfSectionNodes(adf, 'Test Specifications')
    : null;

  // Only complain about a missing description when it was the last resort.
  // A ticket with a populated Test Specifications FIELD and no description is
  // normal here, and warning about it trained the reader to ignore the line.
  if (!adf && !specField) warnings.push('Ticket has no description and no "Test Specifications" field — no sections to extract from.');
  if (!specField && adf && specNodes === null) warnings.push('"Test Specifications" heading not found in the ticket description, and no field of that name exists on this ticket.');
  const variants = splitVariantBlocks(adfSectionLines(specNodes || [])).map(b => ({
    id: b.id,
    // v0 is control by convention, always — never inferred from content.
    isControl: b.id === 'v0',
    rawDescription: b.texts.join('\n').trim(),   // verbatim; no summarization
  }));
  if (specNodes && !variants.length) warnings.push(`"Test Specifications" ${specField ? 'field' : 'section'} found, but no v0/v1/… markers inside it.`);

  // Step 3b/3c — Softcoded Tests / Concurrent Tests. Deterministic like
  // variants above — never AI, never fetched. `{prefix:true}` because the
  // real heading text may be just the short label or may swallow the
  // trailing instructional sentence ("Softcoded Tests: Generate preview
  // links that include..."); unknown without seeing raw ADF from a real
  // ticket, so both are tolerated. No warning when the heading is simply
  // absent — unlike Test Specifications, these are a newer, optional
  // template addition and most existing tickets won't have them.
  const softcodedNodes = adf ? adfSectionNodes(adf, 'Softcoded Tests', { prefix: true }) : null;
  const softcodedLines = adfSectionLines(softcodedNodes || []);
  const softcodedTests = isNoneSection(softcodedLines) ? [] : parseRelatedTestBullets(softcodedLines);
  if (softcodedNodes && !softcodedTests.length && !isNoneSection(softcodedLines)) {
    warnings.push('"Softcoded Tests" section found, but no linked tests could be parsed from it.');
  }

  const concurrentNodes = adf ? adfSectionNodes(adf, 'Concurrent Tests', { prefix: true }) : null;
  const concurrentLines = adfSectionLines(concurrentNodes || []);
  const concurrentTests = isNoneSection(concurrentLines) ? [] : parseRelatedTestBullets(concurrentLines);
  if (concurrentNodes && !concurrentTests.length && !isNoneSection(concurrentLines)) {
    warnings.push('"Concurrent Tests" section found, but no linked tests could be parsed from it.');
  }

  // Step 4 — assemble and hold for review. Nothing touches storage yet.
  // platform/previewLinks/itwLink/goals start empty and are filled entirely
  // by mergeAiFieldsIntoDraft — the cross-check between the final
  // previewLinks and these (always deterministic) variants also runs there,
  // once, on final state.
  // ── Figma design reference ────────────────────────────────────────────────
  // Deterministic on purpose — NOT part of INIT_FIELD_EXTRACTION_SCHEMA. A
  // host match needs no judgment, and routing it through the AI call would
  // make the design reference disappear whenever no Anthropic key is set,
  // which is exactly when a user is least likely to notice.
  //
  // The link inventory is the primary source and costs nothing new: Jira
  // renders pasted Figma smart-links as real <a href>, so initPageExtractorFn
  // already captured them. The ADF description is the fallback for a link
  // that never rendered as an anchor.
  const figmaUrlPool = (links || []).map(l => l && l.url).filter(Boolean);
  adfCollectUrls(f.description, figmaUrlPool);
  const { pick: figmaPick, candidates: figmaCandidates } = figmaPickDesignUrl(figmaUrlPool);
  const figmaUrl = figmaPick ? figmaPick.url : null;
  const figmaNodeId = figmaPick ? figmaPick.nodeId : null;

  if (figmaCandidates.length > 1) {
    warnings.push(`Figma: ${figmaCandidates.length} different design links found on this ticket — using ${figmaUrl}. Change it in the A/B tab if that's the wrong board.`);
  }
  if (figmaPick && !figmaNodeId) {
    // A bare file link resolves to the whole file. For a shared master file
    // that is every ticket's boards at once, which is never what was meant.
    warnings.push('Figma: the link points at the whole file rather than a specific board (no node-id). Open the comp frame in Figma, copy the link from there, and paste it in the A/B tab.');
  }

  // Attachment metadata is already in hand — the extractor fetches the issue
  // with no `fields=` filter, so this costs no request. Only the binary needs
  // fetching, and that happens later, in the Jira tab, where the session
  // cookie lives.
  const comp = figmaMatchCompAttachment(f.attachment, ticketKey);
  if (!comp.match && comp.matches.length > 1) {
    warnings.push(`Comp: ${comp.matches.length} attachments match ${ticketKey}_comp — none was selected. Pick one in the A/B tab.`);
  } else if (!comp.match && comp.candidates.length) {
    warnings.push(`Comp: no attachment named ${ticketKey}_comp — ${comp.candidates.length} other image(s) are attached. Pick one in the A/B tab if the comp is among them.`);
  }

  _initDraft = {
    ticketKey, ticketUrl, summary, platform: null, experimentId,
    variants, previewLinks: [], itwLink: null, goals: [], qaTestPlanUrl,
    softcodedTests, concurrentTests,
    figmaUrl, figmaNodeId,
    // Set by fetchCompAttachment() after this returns — it needs the Jira tab
    // and an await, and this function is deliberately synchronous.
    compAttachment: null,
    compCandidates: comp.candidates,
    compPending: comp.match || null,
    extractedAt: new Date().toISOString(),
    reviewed: false,
  };
  _initWarnings = warnings;
}

// ── ADF (Atlassian Document Format) utilities ────────────────────────────────

// All visible text inside a node, depth-first. hardBreak → newline so callers
// can split multi-line paragraphs; cards contribute their URL.
function adfText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'inlineCard' || node.type === 'blockCard' || node.type === 'embedCard') return node.attrs?.url || '';
  return adfText(node.content || []);
}

// Section locator (shared by all three sections): find the heading whose text
// matches (case-insensitive, trimmed) anywhere in the tree, and return its
// sibling nodes up to the next heading of equal-or-higher level. Returns null
// when the heading isn't found — callers distinguish "section missing" (null)
// from "section empty" ([]). `prefix: true` matches a heading that STARTS WITH
// headingText instead of requiring an exact match — for sections whose real
// heading text may swallow a trailing instructional sentence (e.g. "Softcoded
// Tests: Generate preview links that include...").
function adfSectionNodes(doc, headingText, { prefix = false } = {}) {
  const want = headingText.trim().toLowerCase();
  let result = null;
  (function walk(nodes) {
    if (!Array.isArray(nodes) || result) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const headingLower = n?.type === 'heading' ? adfText(n).trim().toLowerCase() : '';
      const matches = prefix ? headingLower.startsWith(want) : headingLower === want;
      if (n?.type === 'heading' && matches) {
        const level = n.attrs?.level ?? 1;
        const out = [];
        for (let j = i + 1; j < nodes.length; j++) {
          const s = nodes[j];
          if (s?.type === 'heading' && (s.attrs?.level ?? 1) <= level) break;
          out.push(s);
        }
        result = out;
        return;
      }
    }
    for (const n of nodes) { if (n?.content) walk(n.content); if (result) return; }
  })(doc?.content);
  return result;
}

// Flatten one block node into logical lines. Each line keeps the URLs of any
// links inside it (link marks, inline/block cards) — preview links are often
// authored as clickable links whose href is the real URL, not the shown text.
// Every URL anywhere in an ADF document, appended to `out`. Both places a URL
// can hide: a `link` mark on a text node, and the card nodes Jira turns pasted
// links into. Used as the FALLBACK source for the Figma reference — the
// rendered-page link inventory is preferred because it also catches links that
// only exist in Jira app panels, but the inventory's clone drops
// comments/activity, so a link that lives only in the description still needs
// this path.
function adfCollectUrls(node, out) {
  const acc = out || [];
  (function walk(n) {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'text') {
      const href = (n.marks || []).find(m => m.type === 'link')?.attrs?.href;
      if (href) acc.push(href);
      return;
    }
    if (n.type === 'inlineCard' || n.type === 'blockCard' || n.type === 'embedCard') {
      if (n.attrs?.url) acc.push(n.attrs.url);
      return;
    }
    walk(n.content);
  })(node);
  return acc;
}

function adfBlockLines(node) {
  const lines = [];
  let cur = { text: '', urls: [] };
  const flush = () => {
    if (cur.text.trim() || cur.urls.length) lines.push({ text: cur.text.trim(), urls: cur.urls });
    cur = { text: '', urls: [] };
  };
  (function walk(n) {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'hardBreak') { flush(); return; }
    if (n.type === 'text') {
      cur.text += n.text || '';
      const href = (n.marks || []).find(m => m.type === 'link')?.attrs?.href;
      if (href) cur.urls.push(href);
      return;
    }
    if (n.type === 'inlineCard' || n.type === 'blockCard' || n.type === 'embedCard') {
      const url = n.attrs?.url;
      if (url) { cur.urls.push(url); cur.text += (cur.text ? ' ' : '') + url; }
      return;
    }
    // Block boundaries force a new line.
    if (n.type === 'paragraph' || n.type === 'listItem' || n.type === 'heading' || n.type === 'tableRow') {
      walk(n.content); flush(); return;
    }
    walk(n.content);
  })(node);
  flush();
  return lines;
}

function adfSectionLines(nodes) {
  return (nodes || []).flatMap(adfBlockLines);
}

// Split section lines into per-variant blocks on the `v<number>` marker
// convention (v0, v1, …). Lines before the first marker are ignored; lines
// after a marker accumulate into that variant's block.
function splitVariantBlocks(lines) {
  const re = /^v(\d+)\s*[:.\-–—]?\s*/i;
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.text.match(re);
    if (m) {
      cur = { id: 'v' + m[1], texts: [], urls: [...line.urls] };
      const rest = line.text.replace(re, '').trim();
      if (rest) cur.texts.push(rest);
      blocks.push(cur);
    } else if (cur) {
      if (line.text) cur.texts.push(line.text);
      cur.urls.push(...line.urls);
    }
  }
  return blocks;
}

// Related-test link parser for the "Softcoded Tests" / "Concurrent Tests"
// sections. Each bullet is one line ({text, urls} — same shape
// splitVariantBlocks consumes above): link text carries a ticket key + human
// label, the href optionally repeats the key (Iris test pages are shaped
// /tests/<KEY>). The href is only ever used here, to help recover the ticket
// key — nothing is fetched, and nothing beyond {ticketKey, label} is kept:
// the label text alone is what Experiment Status matches against live
// experiment names, so the link itself is noise once parsing is done.
function parseRelatedTestBullets(lines) {
  const entries = [];
  for (const line of lines) {
    const text = (line.text || '').trim();
    if (!text) continue;
    const url = line.urls?.[0] || null;
    const fromUrl  = url ? /\/tests\/([A-Za-z][A-Za-z0-9]*-\d+)/i.exec(url) : null;
    const fromText = /^([A-Za-z][A-Za-z0-9]*-\d+)\b/.exec(text);
    const ticketKey = (fromUrl?.[1] || fromText?.[1] || '').toUpperCase() || null;
    if (!ticketKey && !url) continue;   // not a recognizable related-test row
    entries.push({ ticketKey, label: text });
  }
  return entries;
}

// The ticket template's own placeholder for "nothing here" — treated the
// same as a section with zero parseable bullets, so a stray typo can't
// silently read as confirmed-none.
function isNoneSection(lines) {
  return /^none$/i.test(lines.map((l) => l.text).join(' ').trim());
}

// Flattens the whole ADF description into text with heading structure kept
// (as `## <heading>` markers) — feeds the AI field-extraction call further
// below, where knowing "the Goals heading exists but has one line under it"
// matters as much as that line's own text. adfText() intentionally discards
// structure for the deterministic parse above; this is its structure-
// preserving sibling, reusing adfBlockLines() for each block's own text.
function adfDocToHeadedText(doc) {
  const lines = [];
  (function walk(nodes) {
    for (const n of nodes || []) {
      if (!n) continue;
      if (n.type === 'heading') {
        const level = n.attrs?.level ?? 1;
        const text = adfText(n).trim();
        if (text) lines.push(`${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${text}`);
        continue;
      }
      if (n.type === 'paragraph' || n.type === 'listItem' || n.type === 'tableRow') {
        adfBlockLines(n).forEach(l => { if (l.text) lines.push(l.text); });
        continue;
      }
      if (n.content) walk(n.content);
    }
  })(doc?.content);
  return lines.join('\n');
}

// ── Review / Commit UI ───────────────────────────────────────────────────────
// Every extracted field renders editable — including unambiguous ones — so a
// bad parse is caught here, before it can propagate anywhere.
function renderInitReview() {
  const host = document.getElementById('init-review');
  if (!_initDraft) { host.innerHTML = ''; return; }
  const d = _initDraft;
  const q = s => esc(s || '').replace(/"/g, '&quot;');
  const taStyle = 'flex:1;resize:vertical;background:var(--overlay);border:1px solid var(--stroke);border-radius:4px;color:var(--fg1);padding:5px 8px;font-size:12px;font-family:inherit;outline:none';

  const warnHtml = _initWarnings.length ? `
    <div style="background:rgba(204,167,0,.08);border:1px solid rgba(204,167,0,.4);border-radius:4px;padding:6px 9px;margin-bottom:8px">
      ${_initWarnings.map(w => `<div style="font-size:11px;color:var(--warn);line-height:1.5">⚠ ${esc(w)}</div>`).join('')}
    </div>` : '';

  const variantRows = d.variants.length ? d.variants.map((v, i) => `
    <div class="ab-target">
      <div class="arg-row">
        <span class="arg-lbl">ID</span>
        <input type="text" data-init="variants.${i}.id" value="${q(v.id)}" style="max-width:70px;flex:0 1 auto">
        ${(v.id || '').trim() === 'v0' ? '<span style="font-size:10px;color:var(--info);flex-shrink:0">control (v0, by convention)</span>' : ''}
        <span style="flex:1"></span>
        <button class="btn-icon" data-init-rm="variants.${i}" title="Remove" style="color:var(--err)">✕</button>
      </div>
      <div class="arg-row" style="align-items:flex-start">
        <span class="arg-lbl">Description</span>
        <textarea data-init="variants.${i}.rawDescription" rows="3" style="${taStyle}">${esc(v.rawDescription)}</textarea>
      </div>
    </div>`).join('')
    : '<div style="font-size:11px;color:var(--fg3)">Not found in ticket — no variants extracted.</div>';

  const linkRows = d.previewLinks.length ? d.previewLinks.map((l, i) => `
    <div class="ab-sel-row">
      <input type="text" data-init="previewLinks.${i}.id" value="${q(l.id)}" style="max-width:56px;flex:0 1 auto">
      <input type="text" data-init="previewLinks.${i}.url" value="${q(l.url)}" placeholder="https://…">
      <button class="btn-icon" data-init-rm="previewLinks.${i}" title="Remove" style="color:var(--err)">✕</button>
    </div>`).join('')
    : '<div style="font-size:11px;color:var(--fg3)">Not found in ticket — no preview links extracted.</div>';

  const goalRows = d.goals.length ? d.goals.map((g, i) => `
    <div class="ab-sel-row" style="flex-wrap:wrap">
      <input type="text" data-init="goals.${i}.text" value="${q(g.text)}" placeholder="Goal text" style="font-family:inherit">
      <label class="row" style="gap:3px;font-size:10px;color:var(--fg2);cursor:pointer;flex-shrink:0" title="Goal was flagged [NEW] in the ticket">
        <input type="checkbox" data-init="goals.${i}.isNew" ${g.isNew ? 'checked' : ''} style="accent-color:var(--brand)">NEW
      </label>
      ${d.platform === 'Convert' ? `<input type="text" data-init="goals.${i}.convertMetricId" value="${q(g.convertMetricId || '')}" placeholder="Convert ID" style="max-width:90px;flex:0 1 auto">` : ''}
      <button class="btn-icon" data-init-rm="goals.${i}" title="Remove" style="color:var(--err)">✕</button>
    </div>
    ${g.resolutionNeeded ? `<div style="font-size:10px;color:var(--warn);margin:-2px 0 4px 2px">ID not in Jira — ${d.qaTestPlanUrl ? `<a href="${q(d.qaTestPlanUrl)}" target="_blank" style="color:var(--info)">check test plan</a>` : 'check the QA test plan'}</div>` : ''}`).join('')
    : '<div style="font-size:11px;color:var(--fg3)">Not found in ticket — no goals extracted.</div>';

  // Softcoded Tests / Concurrent Tests — same flat row shape for both. Just
  // ticketKey + label — that title text is all Experiment Status matches
  // against live experiment names; the link itself isn't kept.
  const relatedRows = (list, key) => list.length ? list.map((r, i) => `
    <div class="ab-sel-row" style="flex-wrap:wrap">
      <input type="text" data-init="${key}.${i}.ticketKey" value="${q(r.ticketKey || '')}" placeholder="Ticket" style="max-width:80px;flex:0 1 auto">
      <input type="text" data-init="${key}.${i}.label" value="${q(r.label || '')}" placeholder="Title" style="flex:2 1 200px">
      <button class="btn-icon" data-init-rm="${key}.${i}" title="Remove" style="color:var(--err)">✕</button>
    </div>`).join('')
    : '<div style="font-size:11px;color:var(--fg3)">None found in ticket.</div>';
  const softcodedRows  = relatedRows(d.softcodedTests, 'softcodedTests');
  const concurrentRows = relatedRows(d.concurrentTests, 'concurrentTests');

  host.innerHTML = `
  <div class="card">
    <div class="card-title" style="margin-bottom:1px">Review — ${esc(d.ticketKey)}</div>
    <div style="font-size:10px;color:var(--fg3);margin-bottom:2px">Nothing is saved until you commit. <a href="${q(d.ticketUrl)}" target="_blank" style="color:var(--info)">Open ticket ↗</a></div>
    <div style="font-size:10px;color:var(--fg3);margin-bottom:8px">Platform, Preview Links, ITW Link, and Goals below are AI-populated from the ticket — double-check before saving.</div>
    ${warnHtml}
    <div class="arg-row" style="margin-bottom:5px">
      <span class="arg-lbl">Summary</span>
      <input type="text" data-init="summary" value="${q(d.summary)}">
    </div>
    <div class="arg-row" style="margin-bottom:5px">
      <span class="arg-lbl">Platform</span>
      <select data-init="platform">
        <option value="" ${!d.platform ? 'selected' : ''} disabled>— not detected —</option>
        <option value="Optimizely" ${d.platform === 'Optimizely' ? 'selected' : ''}>Optimizely</option>
        <option value="Convert" ${d.platform === 'Convert' ? 'selected' : ''}>Convert</option>
      </select>
    </div>
    <div class="arg-row" style="margin-bottom:5px">
      <span class="arg-lbl">Experiment ID</span>
      <input type="text" data-init="experimentId" value="${q(d.experimentId || '')}" placeholder="from Platform Experiment ID field">
    </div>
    <div class="arg-row" style="margin-bottom:10px">
      <span class="arg-lbl">QA Test Plan</span>
      <input type="text" data-init="qaTestPlanUrl" value="${q(d.qaTestPlanUrl || '')}" placeholder="link only — not parsed">
      ${d.qaTestPlanUrl ? `<a href="${q(d.qaTestPlanUrl)}" target="_blank" style="font-size:11px;color:var(--info);flex-shrink:0">open ↗</a>` : ''}
    </div>

    <label class="cap">Variants (Test Specifications)</label>
    <div style="display:flex;flex-direction:column;gap:5px">${variantRows}</div>
    <button class="btn sm" data-init-add="variants" style="margin:5px 0 10px">+ Add Variant</button>

    <label class="cap">Preview Links</label>
    <div class="arg-row" style="margin-bottom:6px">
      <span class="arg-lbl">ITW Link</span>
      <input type="text" data-init="itwLink" value="${q(d.itwLink || '')}" placeholder="In-the-wild production URL — AI-detected">
      ${d.itwLink ? `<a href="${q(d.itwLink)}" target="_blank" style="font-size:11px;color:var(--info);flex-shrink:0">open ↗</a>` : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:4px">${linkRows}</div>
    <button class="btn sm" data-init-add="previewLinks" style="margin:5px 0 10px">+ Add Preview Link</button>

    <label class="cap">Goals — adding one tracks it immediately but flags it "needs review"; it stays out of Track Metric until you confirm it</label>
    <div style="display:flex;flex-direction:column;gap:4px">${goalRows}</div>
    <button class="btn sm" data-init-add="goals" style="margin:5px 0 10px">+ Add Goal</button>

    <label class="cap">Softcoded Tests — forced 100% dependencies; tracked live in Experiment Status, never auto-forced into generated links</label>
    <div style="display:flex;flex-direction:column;gap:4px">${softcodedRows}</div>
    <button class="btn sm" data-init-add="softcodedTests" style="margin:5px 0 10px">+ Add Softcoded Test</button>

    <label class="cap">Concurrent Tests — expected to be running alongside this one</label>
    <div style="display:flex;flex-direction:column;gap:4px">${concurrentRows}</div>
    <button class="btn sm" data-init-add="concurrentTests" style="margin:5px 0 10px">+ Add Concurrent Test</button>

    <div class="arg-row" style="margin-top:8px">
      <span class="arg-lbl">Save as</span>
      <input type="text" id="init-save-name" value="${q(d.ticketKey)}">
    </div>
    <div class="row" style="gap:6px;margin-top:4px">
      <button class="btn primary sm" id="btn-init-commit">Save Test Context</button>
      <button class="btn sm" id="btn-init-discard">Discard</button>
    </div>
  </div>`;
}

function setInitPath(path, value) {
  const parts = path.split('.');
  let obj = _initDraft;
  for (let i = 0; i < parts.length - 1; i++) obj = obj?.[parts[i]];
  if (obj) obj[parts[parts.length - 1]] = value;
}

function onInitReviewInput(e) {
  const path = e.target?.dataset?.init;
  if (!path || !_initDraft || e.target.type === 'checkbox') return;
  setInitPath(path, e.target.value);
}

function onInitReviewChange(e) {
  const path = e.target?.dataset?.init;
  if (!path || !_initDraft) return;
  if (e.target.type === 'checkbox') { setInitPath(path, e.target.checked); return; }
  // Platform switch shows/hides the Convert-ID column, so re-render.
  if (path === 'platform') { _initDraft.platform = e.target.value || null; renderInitReview(); }
}

function onInitReviewClick(e) {
  if (!_initDraft) return;
  const t = e.target.closest('[data-init-rm],[data-init-add],#btn-init-commit,#btn-init-discard');
  if (!t) return;
  if (t.id === 'btn-init-commit') { commitInitContext(); return; }
  if (t.id === 'btn-init-discard') {
    if (!confirm('Discard the extracted context? Nothing was saved.')) return;
    _initDraft = null; _initWarnings = [];
    document.getElementById('init-review').innerHTML = '';
    document.getElementById('init-fetch-status').textContent = '';
    return;
  }
  if (t.dataset.initRm) {
    const [list, idx] = t.dataset.initRm.split('.');
    _initDraft[list].splice(+idx, 1);
    renderInitReview();
    return;
  }
  if (t.dataset.initAdd) {
    const list = t.dataset.initAdd;
    if (list === 'variants')     _initDraft.variants.push({ id: 'v' + _initDraft.variants.length, isControl: false, rawDescription: '' });
    if (list === 'previewLinks') _initDraft.previewLinks.push({ id: 'v' + _initDraft.previewLinks.length, url: '' });
    if (list === 'goals')        _initDraft.goals.push({ text: '', isNew: false, convertMetricId: null, resolutionNeeded: false });
    if (list === 'softcodedTests')  _initDraft.softcodedTests.push({ ticketKey: '', label: '' });
    if (list === 'concurrentTests') _initDraft.concurrentTests.push({ ticketKey: '', label: '' });
    renderInitReview();
  }
}

// ── Initialize tab — AI field extraction ────────────────────────────────────
// Fires synchronously as part of Extract (see extractFromActiveTab above),
// with the ticket content already fetched — it never re-fetches. AI-only for
// Platform, Preview Links, ITW Link, and Goals — there is no deterministic
// computation for these anymore (extractTestContext leaves them empty; real
// tickets format them loosely enough that regex/heading parsing routinely
// missed them entirely). Deterministic parsing stays authoritative for
// Variants, Experiment ID, QA Test Plan, and Summary. Runs once, before
// renderInitReview() — there is no separate panel and no progressive
// re-render, so an in-progress edit can never be clobbered by a late result.
async function runAiFieldExtraction(extractorResult, draft) {
  const payload = {
    ticketKey: draft.ticketKey,
    ticketUrl: draft.ticketUrl,
    summary: draft.summary,
    labels: Array.isArray(extractorResult?.issue?.fields?.labels) ? extractorResult.issue.fields.labels : [],
    experimentId: draft.experimentId,
    qaTestPlanUrl: draft.qaTestPlanUrl,
    descriptionText: adfDocToHeadedText(extractorResult?.issue?.fields?.description),
    descriptionMissing: !extractorResult?.issue?.fields?.description,
    pageText: extractorResult?.pageText || '',
    pageTextTruncated: !!extractorResult?.pageTextTruncated,
    // Every <a href> captured on the rendered page — the only place real
    // URLs live, since pageText above is plain innerText (no hrefs).
    links: extractorResult?.links || [],
    // Reference only — the ticket's own variant ids from Test Specifications
    // (still deterministic), so the model can assign preview-link ids
    // consistently. Never an instruction to agree with anything else.
    parsed: { variantIds: draft.variants.map(v => v.id) },
    warnings: _initWarnings.slice(),
  };
  return chrome.runtime.sendMessage({ action: 'aiExtractInitFields', payload });
}

// Merges the AI extraction result into _initDraft and _initWarnings. AI-only
// for platform/itwLink/previewLinks/goals — there is no deterministic value
// to fall back to (extractTestContext leaves them empty), so on failure these
// simply stay empty with a warning explaining why. Convert metric IDs are
// still resolved by the existing extractConvertMetricId() regex, run over the
// AI-provided goal text — the model is not asked to invent one.
function mergeAiFieldsIntoDraft(aiRes) {
  if (!_initDraft) return;
  if (aiRes?.ok) {
    const f = aiRes.fields || {};
    _initDraft.platform = f.platform ?? null;
    _initDraft.itwLink = f.itwLink ?? null;
    _initDraft.previewLinks = Array.isArray(f.previewLinks)
      ? f.previewLinks.map(l => ({ id: l.id, url: l.url }))
      : [];
    _initDraft.goals = Array.isArray(f.goals) ? f.goals.map(g => {
      const text = g.text || '';
      let convertMetricId = null, resolutionNeeded = false;
      if (_initDraft.platform === 'Convert') {
        const { id, candidates } = extractConvertMetricId(text);
        if (id) {
          convertMetricId = id;
        } else {
          resolutionNeeded = true;
          if (candidates.length > 1) _initWarnings.push(`Goals: "${text}" has multiple candidate Convert metric ids (${candidates.join(', ')}) — left unresolved, pick the correct one manually.`);
        }
      }
      return { text, isNew: !!g.isNew, convertMetricId, resolutionNeeded };
    }) : [];
    (f.flags || []).forEach(flag => _initWarnings.push(flag));
    if (aiRes.truncated) _initWarnings.push('AI field extraction was cut off at the output limit — Preview Links/Goals may be incomplete.');
  } else {
    const reason = aiRes?.error === 'No API key configured'
      ? 'No Anthropic API key configured — Platform/Preview Links/ITW Link/Goals could not be extracted.'
      : `AI field extraction failed (${aiRes?.error || 'unknown error'}) — Platform/Preview Links/ITW Link/Goals could not be extracted.`;
    _initWarnings.push(reason);
  }

  // Cross-check the FINAL previewLinks (whichever source) against the
  // (always deterministic) variants — relocated here from extractTestContext
  // so it runs once, on final state, instead of on a deterministic preview-
  // links list that AI extraction usually replaces anyway.
  const previewLinks = _initDraft.previewLinks;
  const variants = _initDraft.variants;
  if (previewLinks.length && variants.length) {
    if (previewLinks.length !== variants.length) {
      _initWarnings.push(`Preview links: found ${previewLinks.length} preview link(s) but ${variants.length} variant(s) in Test Specifications — check for a missing/extra link.`);
    } else {
      const linkIds = [...new Set(previewLinks.map(l => l.id))];
      const variantIds = [...new Set(variants.map(v => v.id))];
      const idsMatch = linkIds.length === variantIds.length && linkIds.every(id => variantIds.includes(id));
      if (!idsMatch) _initWarnings.push(`Preview links: ids (${linkIds.join(', ')}) don't match Test Specifications variant ids (${variantIds.join(', ')}) — the link-to-variant mapping may be off.`);
    }
  }
}

// ── Persistence (initContexts, named — mirrors the `scripts` save/load pattern
// at refreshScripts/saveScript/loadScript/deleteScript above) ───────────────
async function getInitContexts() {
  const { initContexts = {} } = await chrome.storage.local.get('initContexts');
  return initContexts;
}

// The one committed context other modes may read — null until the user picks
// one from the saved list via "Set Active".
async function getActiveContext() {
  const { initContexts = {}, activeInitContext } = await chrome.storage.local.get(['initContexts', 'activeInitContext']);
  return activeInitContext ? (initContexts[activeInitContext] || null) : null;
}

async function refreshInitContextSelect() {
  const sel = document.getElementById('init-context-select');
  if (!sel) return;
  const initContexts = await getInitContexts();
  const { activeInitContext } = await chrome.storage.local.get('activeInitContext');
  const names = Object.keys(initContexts).sort();
  sel.innerHTML = names.length
    ? names.map(n => {
        const c = initContexts[n];
        const mark = n === activeInitContext ? '★ ' : '';
        return `<option value="${esc(n)}">${mark}${esc(n)} — ${esc(c.ticketKey)} · extracted ${esc(new Date(c.extractedAt).toLocaleString())}</option>`;
      }).join('')
    : '<option disabled>&lt;none saved&gt;</option>';
}

async function activateSelectedContext() {
  const sel = document.getElementById('init-context-select');
  const name = sel?.value;
  if (!name) { alert('Select a saved context first.'); return; }
  await chrome.storage.local.set({ activeInitContext: name });
  await refreshInitContextSelect();
  await renderActiveContext();
  await refreshAllFillButtons();
}

async function deleteSelectedContext() {
  const sel = document.getElementById('init-context-select');
  const name = sel?.value;
  if (!name) return;
  if (!confirm(`Delete saved context "${name}"?`)) return;
  const initContexts = await getInitContexts();
  delete initContexts[name];
  await chrome.storage.local.set({ initContexts });
  const { activeInitContext } = await chrome.storage.local.get('activeInitContext');
  if (activeInitContext === name) await chrome.storage.local.remove('activeInitContext');
  await refreshInitContextSelect();
  await renderActiveContext();
  await refreshAllFillButtons();
}

// Save is the only path that writes into initContexts — and the only context
// other modes will ever read is the active one, which always has reviewed:true.
async function commitInitContext() {
  if (!_initDraft) return;
  const d = _initDraft;
  // Recompute derived flags from the possibly user-edited values.
  d.variants = d.variants
    .map(v => ({ id: (v.id || '').trim(), isControl: (v.id || '').trim() === 'v0', rawDescription: (v.rawDescription || '').trim() }))
    .filter(v => v.id || v.rawDescription);
  d.previewLinks = d.previewLinks
    .map(l => ({ id: (l.id || '').trim(), url: (l.url || '').trim() }))
    .filter(l => l.url);
  d.itwLink = (d.itwLink || '').trim() || null;
  d.goals = d.goals.map(g => {
    const text = (g.text || '').trim();
    const rawId = (g.convertMetricId || '').toString().trim();
    const hasId = d.platform === 'Convert' && rawId && !/^TBD$/i.test(rawId);
    return {
      text, isNew: !!g.isNew,
      convertMetricId: hasId ? rawId : null,
      resolutionNeeded: d.platform === 'Convert' && !hasId,
    };
  }).filter(g => g.text);
  const normalizeRelated = (list) => (list || [])
    .map(r => ({
      ticketKey: (r.ticketKey || '').trim().toUpperCase() || null,
      label: (r.label || '').trim(),
    }))
    .filter(r => r.ticketKey || r.label);
  d.softcodedTests  = normalizeRelated(d.softcodedTests);
  d.concurrentTests = normalizeRelated(d.concurrentTests);

  const ctx = { ...d, summary: (d.summary || '').trim(), experimentId: (d.experimentId || '').trim() || null, qaTestPlanUrl: (d.qaTestPlanUrl || '').trim() || null, reviewed: true };

  const nameInput = document.getElementById('init-save-name');
  const name = (nameInput?.value || '').trim() || ctx.ticketKey;
  const initContexts = await getInitContexts();
  initContexts[name] = ctx;
  await chrome.storage.local.set({ initContexts, activeInitContext: name });

  _initDraft = null; _initWarnings = [];
  document.getElementById('init-review').innerHTML = '';
  const statusEl = document.getElementById('init-fetch-status');
  statusEl.textContent = `Saved "${name}" (${ctx.ticketKey}) and set it active.`;
  statusEl.style.color = 'var(--ok)';
  await refreshInitContextSelect();
  await renderActiveContext();
  await refreshAllFillButtons();
}

async function clearActiveContext() {
  if (!confirm('Clear the active Test Context? The saved entry is kept — this only unsets which one A/B fills from.')) return;
  await chrome.storage.local.remove('activeInitContext');
  await refreshInitContextSelect();
  await renderActiveContext();
  await refreshAllFillButtons();
}

async function renderActiveContext() {
  const card = document.getElementById('init-active-card');
  if (!card) return;
  const body = document.getElementById('init-active-body');
  const ctx = await getActiveContext();
  // The active context changed (or was cleared) — a stale "Applied ✓" or
  // undo from a previous ticket must not linger next to a different one.
  closeApplyPreview();
  const statusEl = document.getElementById('init-apply-status');
  if (statusEl) statusEl.innerHTML = '';
  _fillUndo = null;
  if (!ctx?.reviewed) { card.style.display = 'none'; body.innerHTML = ''; return; }
  card.style.display = '';
  const q = s => esc(s || '').replace(/"/g, '&quot;');

  const goalsHtml = (ctx.goals || []).map((g, i) => {
    const already = metrics.some(m => m.id === mtGoalId(ctx.ticketKey, g.text));
    return `
    <div class="ab-line" style="display:flex;align-items:center;gap:6px">
      <span style="flex:1">${esc(g.text)}${g.isNew ? ' <span style="color:var(--info);font-size:9px;font-weight:700">NEW</span>' : ''}${g.convertMetricId ? ` <span style="color:var(--fg3)">· Convert ${esc(g.convertMetricId)}</span>` : ''}${g.resolutionNeeded ? ` <span style="color:var(--warn)">· ID TBD${ctx.qaTestPlanUrl ? ` — <a href="${q(ctx.qaTestPlanUrl)}" target="_blank" style="color:var(--info)">test plan</a>` : ''}</span>` : ''}</span>
      <button class="btn sm" data-goal-metric="${i}" ${already ? 'disabled' : ''} title="Add this goal to the shared Metrics list. It is tracked right away and flagged &quot;needs review&quot; — Track Metric will not offer it until you confirm it as a console signal.">${already ? 'Added ✓' : '+ Metric'}</button>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div><b><a href="${q(ctx.ticketUrl)}" target="_blank" style="color:var(--info)">${esc(ctx.ticketKey)}</a></b> — ${esc(ctx.summary || '')}</div>
    <div>Platform: <b>${esc(ctx.platform || '—')}</b> · Experiment ID: <b>${esc(ctx.experimentId || '—')}</b></div>
    <div>${(ctx.variants || []).length} variant(s) · ${(ctx.previewLinks || []).length} preview link(s)${ctx.itwLink ? ` · <a href="${q(ctx.itwLink)}" target="_blank" style="color:var(--info)">ITW ↗</a>` : ''} · committed ${esc(new Date(ctx.extractedAt).toLocaleString())}</div>
    ${goalsHtml ? `<label class="cap" style="margin-top:8px">Goals (tracked once added; not assertable until reviewed)</label>${goalsHtml}` : ''}`;

  body.querySelectorAll('[data-goal-metric]').forEach(btn => btn.addEventListener('click', () => {
    const g = (ctx.goals || [])[+btn.dataset.goalMetric];
    if (!g?.text) return;
    const id = mtGoalId(ctx.ticketKey, g.text);
    if (metrics.some(m => m.id === id)) { btn.textContent = 'Added ✓'; btn.disabled = true; return; }
    metrics.push({
      id, label: g.text, pattern: g.text, mode: 'smart',
      convertMetricId: g.convertMetricId || null,
      enabled: !!g.isNew, source: 'goal', reviewed: false, createdAt: Date.now(),
    });
    mtSyncAfterListChange();
    btn.textContent = 'Added ✓';
    btn.disabled = true;
  }));
}

// ── Context → derived values (shared by several fill targets) ──────────────
// Pure — no state, no DOM. The single-URL surfaces (Queue, Funnel) can only
// seed one variant, so they need a deterministic pick: the control, by
// isControl or the 'v0' convention commitInitContext enforces (popup.js:5084),
// else the first preview link.
function ctxControlLink(ctx) {
  const links = ctx.previewLinks || [];
  const controlIds = new Set((ctx.variants || []).filter(v => v.isControl).map(v => v.id));
  return links.find(l => controlIds.has(l.id)) || links.find(l => l.id === 'v0') || links[0] || null;
}

// {baseUrl, targets:[{label,url,override}]} — one target per preview link,
// each carrying its own full URL verbatim. Shared by the A/B and CVA targets,
// which hold the identical {label,url,override} shape. Previously derived a
// common base URL + override query param by diffing the preview links
// (previewLinkBaseUrl/previewLinkParam, now retired in favor of the
// AI-detected single itwLink field) — baseUrl/override are kept in the
// return shape for structural compatibility with composeVariantUrl(), but
// are now always empty since every target already carries its full URL.
function ctxVariantTargets(ctx) {
  return {
    baseUrl: '',
    targets: ctx.previewLinks.map(l => ({ label: l.id, url: l.url, override: '' })),
  };
}

// Write the derived variant targets into whichever variant-mode state object
// owns them (abState or cvaState — identical shape). State is persisted
// before rendering so a throwing renderer can't lose the write.
function fillVariantState(ctx, state, { applyInputs, render, persist }) {
  if (!state) return;
  const { baseUrl, targets } = ctxVariantTargets(ctx);
  state.baseUrl = baseUrl;
  state.targets = targets;
  persist();
  applyInputs();
  render();
}

// Push tmModes[modeId].scope back onto its radio pair. Extracted out of
// fillPagesFromTicket's old body so restore() can reuse it for undo.
function syncTmScopeRadios(modeId) {
  const m = tmModes[modeId];
  if (!m) return;
  document.querySelectorAll(`input[name="tm-scope-${modeId}"]`)
    .forEach(r => { r.checked = r.value === m.scope; });
}

// The queue's locked first step. ensureOpenUrlFirst (popup.js:1271) guarantees
// it exists and is steps[0] — re-found rather than cached because loadScript
// reassigns `steps` wholesale.
function queueOpenUrlStep() {
  return (steps[0] && steps[0].func === OPEN_URL_FUNC) ? steps[0] : null;
}

function rerenderStepEl(step) {
  const el = document.getElementById('step-' + step.id);
  if (el) rerenderStepArgs(el, step);   // rebuilds args, rewires, persistQueue()s
}

// The funnel card exists only while Funnel is the selected Test Agent mode —
// taRenderFunnel() rebuilds #ta-settings-slot wholesale, and taShowPrimary
// blanks it on the way out (popup.js:410-445). When it isn't on screen there
// is nothing to sync: taRenderFunnel() always reads funnelState fresh, so the
// write is already visible the moment the user switches to Funnel.
function refreshFunnelDom() {
  if (_taActiveBody !== 'funnel') return;
  taRenderFunnel();
  syncFunnelRunEnabled();
}

// DOM ← mxState. Shared by initMatrixAuditor's initial hydration and the "mx"
// fill target's apply()/restore(), so both stay in lockstep with mxState.
function mxSyncFromState() {
  if (!mxState) return;
  const raw = document.getElementById('mx-links-input');
  if (!raw) return;
  raw.value = mxState.linksRaw || '';
  document.getElementById('mx-audit-name').value   = mxState.name || '';
  document.getElementById('mx-variation-id').value = mxState.variationId || '';
  document.getElementById('mx-advance-mode').value = mxState.advanceMode || 'auto';
  mxGroupFilter = null;
  mxSetLinkMode(mxState.linkMode || 'none');
  mxRenderLinkGroups();
}

// ═══════════════════════════════════════════════════════════════════════════
// Fill-target registry
//
// One declarative entry per input surface derivable from the active Test
// Context. Everything context-driven goes through this list: each surface's
// own "Fill from ticket" button, the storage.onChanged refresh, and the
// Initialize card's "Apply to all modes" fan-out. Adding a consumer means
// adding one entry here plus its button markup to BOTH popup.html and
// sidepanel.html — nothing else.
//
// INVARIANT (see the header comment above initInitializeTab): nothing is ever
// pushed to a mode. refreshAllFillButtons() may only touch button/hint state;
// only a user click reaches apply(). The storage.onChanged listener calls the
// former and must never call the latter.
//
// Every target but 'tracker' replaces its slice wholesale. 'tracker' appends
// to a list shared with hand-authored Track Metric assertions, so it merges
// by deterministic id (mtGoalId) and never clobbers an entry the user wrote
// or edited — see its own comments below for why.
//
// Entry contract:
//   id        stable key — error reporting, undo keys, fillOneFromTicket()
//   label     human name, shown in the Apply-to-all summary
//   btnSel    selector for this surface's own button; matching NOTHING is a
//             valid state (the markup may be absent) — hence querySelectorAll
//   hintSel   selector for the hint text beside that button
//   ready     (ctx) => bool. ctx.reviewed is already guaranteed by the
//             caller. MUST also check its state object exists, so an
//             unloaded mode reports as a skip instead of throwing in apply().
//   describe  (ctx) => string. Doubles as the button hint and the summary row.
//   apply     (ctx) => void, SYNCHRONOUS. State → persist → render. Must
//             tolerate its DOM being absent (see refreshFunnelDom).
//   snapshot  () => any. Deep copy of exactly the slice apply() overwrites.
//   restore   (snap) => void. Put that slice back and re-render. Undo.
// ═══════════════════════════════════════════════════════════════════════════

// Performance ('6') holds a flat page list (tmModes[n].pages) with no
// label/override fields — this factory lets the Apply-to-all summary name
// the mode individually.
function tmFillTarget(modeId, label) {
  return {
    id: 'tm' + modeId,
    label,
    btnSel:  `.tm-fill-ticket[data-mode="${modeId}"]`,
    hintSel: `.tm-fill-hint[data-mode="${modeId}"]`,
    ready:    ctx => !!tmModes[modeId] && !!ctx.previewLinks?.length,
    describe: ctx => `${ctx.previewLinks.length} page(s) — one per variant preview URL`,
    snapshot: () => {
      const m = tmModes[modeId];
      return m ? { scope: m.scope, pages: structuredClone(m.pages) } : undefined;
    },
    restore: snap => {
      const m = tmModes[modeId];
      if (!snap || !m) return;
      m.scope = snap.scope;
      m.pages = snap.pages.map(tmNewPage);
      persistTmPages();
      syncTmScopeRadios(modeId);
      renderTmPages(modeId);
    },
    apply: ctx => {
      const m = tmModes[modeId];
      if (!m) return;
      m.scope = ctx.previewLinks.length > 1 ? 'multi' : 'single';
      m.pages = ctx.previewLinks.map(l => tmNewPage({ inputs: { url: l.url } }));
      persistTmPages();
      syncTmScopeRadios(modeId);
      renderTmPages(modeId);
    },
  };
}

const FILL_TARGETS = [
  {
    id: 'ab',
    label: 'A/B Variant Comparison',
    btnSel: '#btn-ab-fill-ticket',
    hintSel: '#ab-fill-hint',
    ready:    ctx => !!abState && !!ctx.previewLinks?.length,
    describe: ctx => `Base URL + ${ctx.previewLinks.length} variant target(s)`,
    snapshot: () => abState ? { baseUrl: abState.baseUrl, targets: structuredClone(abState.targets) } : undefined,
    restore: snap => {
      if (!snap || !abState) return;
      abState.baseUrl = snap.baseUrl; abState.targets = snap.targets;
      persistAbState(); applyAbStateToInputs(); renderAbTargets();
    },
    apply: ctx => {
      fillVariantState(ctx, abState, {
        applyInputs: applyAbStateToInputs, render: renderAbTargets, persist: persistAbState,
      });
      const nameEl = document.getElementById('ab-set-name');
      if (nameEl && !nameEl.value.trim()) nameEl.value = ctx.ticketKey;
    },
  },
  {
    id: 'cva',
    label: 'Cross-Variant Accessibility',
    btnSel: '#btn-cva-fill-ticket',
    hintSel: '#cva-fill-hint',
    ready:    ctx => !!cvaState && !!ctx.previewLinks?.length,
    describe: ctx => `Base URL + ${ctx.previewLinks.length} variant target(s)`,
    snapshot: () => cvaState ? { baseUrl: cvaState.baseUrl, targets: structuredClone(cvaState.targets) } : undefined,
    restore: snap => {
      if (!snap || !cvaState) return;
      cvaState.baseUrl = snap.baseUrl; cvaState.targets = snap.targets;
      persistCvaState(); applyCvaStateToInputs(); renderCvaTargets();
    },
    apply: ctx => {
      fillVariantState(ctx, cvaState, {
        applyInputs: applyCvaStateToInputs, render: renderCvaTargets, persist: persistCvaState,
      });
      const nameEl = document.getElementById('cva-set-name');
      if (nameEl && !nameEl.value.trim()) nameEl.value = ctx.ticketKey;
    },
  },
  tmFillTarget('6', 'Performance / Load'),
  {
    id: 'mx',
    label: 'Matrix Auditor',
    btnSel: '#btn-mx-fill-ticket',
    hintSel: '#mx-fill-hint',
    ready:    ctx => !!mxState && !!ctx.previewLinks?.length,
    describe: ctx => `${ctx.previewLinks.length} link(s) grouped by variant id`
                   + (mxState?.name?.trim() ? '' : ` · audit name "${ctx.ticketKey}"`),
    snapshot: () => mxState ? {
      linksRaw: mxState.linksRaw, links: structuredClone(mxState.links),
      linkMode: mxState.linkMode, name: mxState.name,
    } : undefined,
    restore: snap => {
      if (!snap || !mxState) return;
      Object.assign(mxState, snap);
      persistMxState();
      mxSyncFromState();
    },
    apply: ctx => {
      if (!mxState) return;
      // Preview URLs already carry their own forcing params, so link mode
      // goes to 'none'. 'forced' would send every link through mxComposeUrl
      // (popup.js:5314), which strips optimizely_x and re-stamps ONE shared
      // variation id — collapsing every variant onto the same one.
      // parseMatrixLinks treats ANY comma in ANY line as a CSV url,group
      // split (5374), regardless of where it came from — emitting a URL
      // "bare" doesn't protect a comma that's already inside it, since the
      // parser still finds and splits on it. The only correct guard is to
      // percent-encode literal commas (and stray spaces) in the URL itself
      // before building the row, so the one comma the parser finds is
      // exactly the one this code placed before the group id. %2C/%20 decode
      // back to the original characters wherever the URL is consumed, so
      // this changes nothing about where the link actually goes.
      const csvEncode = u => u.replace(/,/g, '%2C').replace(/\s/g, '%20');
      mxState.linksRaw = ctx.previewLinks
        .map(l => `${csvEncode(l.url)},${l.id || 'ungrouped'}`)
        .join('\n');
      mxState.links    = parseMatrixLinks(mxState.linksRaw);
      mxState.linkMode = 'none';
      if (!mxState.name?.trim()) mxState.name = ctx.ticketKey;
      persistMxState();
      mxSyncFromState();
    },
  },
  {
    id: 'queue',
    label: 'Build → Queue (Open URL step)',
    btnSel: '#btn-queue-fill-ticket',
    hintSel: '#queue-fill-hint',
    // The queue runs one URL, so only the control variant is meaningful here.
    ready:    ctx => !!queueOpenUrlStep() && !!ctxControlLink(ctx),
    describe: ctx => `Open URL step → ${shortUrl(ctxControlLink(ctx).url)}`,
    snapshot: () => { const s = queueOpenUrlStep(); return s ? structuredClone(s.inputs) : undefined; },
    restore: snap => {
      const s = queueOpenUrlStep();
      if (!snap || !s) return;
      s.inputs = snap;
      persistQueue();
      rerenderStepEl(s);
    },
    apply: ctx => {
      const step = queueOpenUrlStep();
      const link = ctxControlLink(ctx);
      if (!step || !link) return;
      // The full preview URL carries its own params — previewLinkBaseUrl/
      // previewLinkParam (a derived common-base+override-param shortcut) are
      // retired in favor of the AI-detected itwLink field.
      step.inputs.url = link.url;

      const nameEl = document.getElementById('save-name');
      if (nameEl && !nameEl.value.trim()) nameEl.value = ctx.ticketKey;

      rerenderStepArgs(document.getElementById('step-' + step.id), step);
    },
  },
  {
    id: 'funnel',
    label: 'Funnel Crawl (Start waypoint)',
    btnSel: '#fn-fill-ticket',
    hintSel: '#fn-fill-hint',
    ready:    ctx => !!ctxControlLink(ctx),
    // Partial by nature — the ticket has no "end of funnel" concept. Say so
    // rather than silently half-filling.
    describe: ctx => `Start = ${shortUrl(ctxControlLink(ctx).url)} · End left blank (not in the ticket)`,
    snapshot: () => structuredClone(funnelState),
    restore: snap => {
      if (!snap) return;
      funnelState = snap;
      persistFunnel();
      refreshFunnelDom();
    },
    apply: ctx => {
      const link = ctxControlLink(ctx);
      if (!link) return;
      // Full preview URL, not the base: funnelWaypoints() (popup.js:335) hands
      // waypoints straight to the background agent with no base/param
      // composition anywhere in the funnel path.
      funnelState.start = link.url;
      persistFunnel();
      refreshFunnelDom();
    },
  },
  {
    id: 'tracker',
    label: 'Metric Tracker (shared Metrics list)',
    btnSel: '#btn-mt-fill-ticket',
    hintSel: '#mt-fill-hint',

    // `metrics` is a module-level array that always exists (popup.js:12), so
    // unlike every other target there is no "state object missing" case —
    // the only readiness question is whether the ticket has usable goal text.
    ready: ctx => (ctx.goals || []).some(g => (g.text || '').trim()),

    describe: ctx => {
      const gs = (ctx.goals || []).filter(g => (g.text || '').trim());
      const withId = gs.filter(g => g.convertMetricId).length;
      const tbd    = gs.filter(g => g.resolutionNeeded).length;
      const isNewCount = gs.filter(g => g.isNew).length;
      return `${gs.length} goal(s) → added, flagged "needs review" (${isNewCount} new → active by default, ${gs.length - isNewCount} off)`
        + (withId ? ` · ${withId} with a Convert metric id` : '')
        + (tbd    ? ` · ${tbd} with an unresolved id`       : '')
        + ' · not assertable by Track Metric until confirmed';
    },

    // The only ADDITIVE target in this registry (see the INVARIANT note
    // above) — the metrics list is shared with hand-authored Functional
    // Testing assertions, so its slice is only the goal-derived entries,
    // never the whole list. Snapshotting all of `metrics` would let an undo
    // delete an assertion the user typed after the fill.
    snapshot: () => structuredClone(metrics.filter(m => m.source === 'goal')),

    restore: snap => {
      if (!Array.isArray(snap)) return;
      metrics = metrics.filter(m => m.source !== 'goal').concat(snap);
      mtSyncAfterListChange();
    },

    apply: ctx => {
      // Additive and idempotent. Goal entries are keyed by a deterministic
      // id (ticketKey + text), so re-applying the same ticket refreshes them
      // in place instead of duplicating, and preserves any reviewed/enabled/
      // mode edits the user already made.
      //
      // reviewed:false is not optional here — it is what keeps this fill
      // honest against the rule at extractTestContext's Step 5 comment: the
      // Metric Tracker counts these, and buildTrackMetricArgsHTML refuses to
      // offer them to Track Metric until a human confirms each one is a real
      // console signal.
      for (const g of (ctx.goals || [])) {
        const text = (g.text || '').trim();
        if (!text) continue;
        const id = mtGoalId(ctx.ticketKey, text);
        const existing = metrics.find(m => m.id === id);
        if (existing) {
          existing.label           = text;
          existing.pattern         = text;
          existing.convertMetricId = g.convertMetricId || null;
          continue; // user's reviewed / enabled / mode edits survive
        }
        metrics.push({
          id, label: text, pattern: text, mode: 'smart',
          convertMetricId: g.convertMetricId || null,
          enabled: !!g.isNew, source: 'goal', reviewed: false, createdAt: Date.now(),
        });
      }
      mtSyncAfterListChange();
    },
  },
];

// One storage read, then every registered surface's own button/hint.
// querySelectorAll (not getElementById) throughout: a surface whose markup is
// absent is a silent no-op, which is what lets one registry serve both
// popup.html and sidepanel.html and any future partial host page.
async function refreshAllFillButtons() {
  let ctx = null;
  try { ctx = await getActiveContext(); }
  catch (e) { console.error('Selenite: could not read the active Test Context —', e); }
  const usable = ctx?.reviewed ? ctx : null;

  for (const t of FILL_TARGETS) {
    try {
      const ok = !!usable && !!t.ready(usable);
      document.querySelectorAll(t.btnSel).forEach(b => { b.disabled = !ok; });
      // Distinguish "no active ticket" from "ticket active, nothing here to
      // fill" — the same generic message for both reads as broken when a
      // real, reviewed ticket is active but e.g. has no Goals section (the
      // Tracker target's readiness condition), which is a common, legitimate
      // ticket shape, not an error.
      const hint = ok
        ? `From ${usable.ticketKey} — ${t.describe(usable)}`
        : usable
          ? `${usable.ticketKey} is active, but nothing in it fills this`
          : 'No active ticket context — use the Initialize tab';
      document.querySelectorAll(t.hintSel).forEach(h => { h.textContent = hint; });
    } catch (e) {
      console.error(`Selenite: fill target "${t.id}" failed to refresh —`, e);
    }
  }

  const applyBtn = document.getElementById('btn-init-apply-all');
  if (applyBtn) {
    let any = false;
    for (const t of FILL_TARGETS) {
      try { if (usable && t.ready(usable)) { any = true; break; } } catch (_) {}
    }
    applyBtn.disabled = !any;
  }
  return usable;
}

function safeSnapshot(t) {
  try { return t.snapshot(); }
  catch (e) {
    console.error(`Selenite: could not snapshot "${t.id}" for undo —`, e);
    return undefined;   // undo skips this one rather than restoring garbage
  }
}

let _fillUndo = null;   // { ticketKey, at, snaps: { [targetId]: any } } — one-shot, in-memory

// One surface, user-initiated — never fires on tab load. Shares the fan-out's
// snapshot/apply path so the two can never drift.
async function fillOneFromTicket(id) {
  const t = FILL_TARGETS.find(x => x.id === id);
  if (!t) return;
  const ctx = await getActiveContext();
  let ready = false;
  try { ready = !!ctx?.reviewed && !!t.ready(ctx); } catch (_) {}
  if (!ready) { await refreshAllFillButtons(); return; }

  const snap = safeSnapshot(t);
  try {
    t.apply(ctx);
    _fillUndo = snap === undefined ? null : { ticketKey: ctx.ticketKey, at: Date.now(), snaps: { [id]: snap } };
    renderApplyStatus({ applied: [t.label], skipped: [], failed: [] });
  } catch (e) {
    console.error(`Selenite: "${t.label}" fill failed —`, e);
    _fillUndo = null;
    renderApplyStatus({ applied: [], skipped: [], failed: [`${t.label} (${e.message})`] });
  }
  await refreshAllFillButtons();
}

// Stage 1 of the two-stage confirm: expand an itemized list of exactly what
// will be written, and where. Nothing is mutated by this function.
function renderApplyAllPreview(ctx) {
  const host = document.getElementById('init-apply-preview');
  if (!host) return;
  const rows = FILL_TARGETS.map(t => {
    try {
      const ok = !!t.ready(ctx);
      return { t, ok, detail: ok ? t.describe(ctx) : 'skipped — nothing in this context fills it' };
    } catch (e) {
      return { t, ok: false, detail: 'skipped — ' + e.message };
    }
  });
  const n = rows.filter(r => r.ok).length;

  host.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">Will write to ${n} of ${rows.length} surfaces from ${esc(ctx.ticketKey)}:</div>
    ${rows.map(r => `<div style="display:flex;gap:6px${r.ok ? '' : ';color:var(--fg3)'}">
      <span style="flex:0 0 45%">${r.ok ? '•' : '○'} ${esc(r.t.label)}</span>
      <span style="flex:1">${esc(r.detail)}</span></div>`).join('')}
    <div style="color:var(--warn);margin-top:6px">Replaces whatever those fields hold now, including in modes you aren't looking at. Goals are added to the shared Metrics list flagged "needs review": the Metric Tracker counts them, Track Metric won't assert on them until each is confirmed.</div>
    <div class="row" style="gap:6px;margin-top:8px">
      <button class="btn primary sm" id="btn-init-apply-confirm"${n ? '' : ' disabled'}>Write these ${n} change${n === 1 ? '' : 's'}</button>
      <button class="btn ghost sm" id="btn-init-apply-cancel">Cancel</button>
    </div>`;
  host.style.display = '';
  host.querySelector('#btn-init-apply-confirm').addEventListener('click', () => applyAllFromTicket(ctx));
  host.querySelector('#btn-init-apply-cancel').addEventListener('click', closeApplyPreview);
}

function closeApplyPreview() {
  const host = document.getElementById('init-apply-preview');
  if (host) { host.style.display = 'none'; host.innerHTML = ''; }
}

async function onApplyAllClick() {
  const ctx = await getActiveContext();
  if (!ctx?.reviewed) { await refreshAllFillButtons(); return; }
  renderApplyAllPreview(ctx);
}

// Stage 2: the fan-out. Each target is snapshotted immediately before its own
// apply() so a mid-loop failure never loses more than the target that threw.
async function applyAllFromTicket(ctxIn) {
  const ctx = ctxIn || await getActiveContext();
  if (!ctx?.reviewed) return;

  const snaps = {}, applied = [], skipped = [], failed = [];
  for (const t of FILL_TARGETS) {
    let ready = false;
    try { ready = !!t.ready(ctx); }
    catch (e) { failed.push(`${t.label} (readiness check: ${e.message})`); continue; }
    if (!ready) { skipped.push(t.label); continue; }

    const snap = safeSnapshot(t);
    try {
      t.apply(ctx);
      applied.push(t.label);
      if (snap !== undefined) snaps[t.id] = snap;
    } catch (e) {
      failed.push(`${t.label} (${e.message})`);
      console.error(`Selenite: "Apply to all" failed on target "${t.id}" —`, e);
    }
  }
  _fillUndo = Object.keys(snaps).length ? { ticketKey: ctx.ticketKey, at: Date.now(), snaps } : null;

  closeApplyPreview();
  renderApplyStatus({ applied, skipped, failed });
  await refreshAllFillButtons();
}

function renderApplyStatus({ applied, skipped, failed }) {
  const el = document.getElementById('init-apply-status');
  if (!el) return;
  const bits = [`<span style="color:var(--ok)">Applied to ${applied.length} mode${applied.length === 1 ? '' : 's'} ✓</span>`];
  if (skipped.length) bits.push(`<span style="color:var(--fg3)">${skipped.length} skipped (${esc(skipped.join(', '))})</span>`);
  if (failed.length)  bits.push(`<span style="color:var(--err)">${failed.length} failed — ${esc(failed.join('; '))}</span>`);
  el.innerHTML = bits.join(' · ')
    + (_fillUndo ? ` · <button class="btn ghost sm" id="btn-init-apply-undo" title="Restore what these modes held before the fill. Lost when this window closes.">Undo</button>` : '');
  el.querySelector('#btn-init-apply-undo')?.addEventListener('click', undoLastFill);
}

// Each restore is isolated for the same reason each apply is: one mode whose
// render throws must not strand the other targets in the filled state.
function undoLastFill() {
  if (!_fillUndo) return;
  let n = 0;
  for (const [id, snap] of Object.entries(_fillUndo.snaps)) {
    const t = FILL_TARGETS.find(x => x.id === id);
    if (!t) continue;
    try { t.restore(snap); n++; }
    catch (e) { console.error(`Selenite: undo failed for "${id}" —`, e); }
  }
  _fillUndo = null;
  const el = document.getElementById('init-apply-status');
  if (el) el.textContent = `Reverted ${n} mode${n === 1 ? '' : 's'} to their previous values.`;
  refreshAllFillButtons();
}

// Bind every registered surface's own "Fill from ticket" button, then the
// Initialize card's Apply-to-all, then set every button's initial state in
// one pass. Called once, late in the init chain — after every state object
// it touches is hydrated (abState/cvaState/tmModes/mxState/steps/funnelState)
// — and wrapped in its own try/catch by the caller, same as
// initInitializeTab/initMatrixAuditor. Per-target try/catch inside the loop
// means one bad selector costs exactly one button, not the whole registry.
async function initFillTargets() {
  for (const t of FILL_TARGETS) {
    try {
      document.querySelectorAll(t.btnSel).forEach(btn =>
        btn.addEventListener('click', () => fillOneFromTicket(t.id)));
    } catch (e) {
      console.error(`Selenite: could not bind the "Fill from ticket" button for "${t.id}" —`, e);
    }
  }
  document.getElementById('btn-init-apply-all')?.addEventListener('click', onApplyAllClick);
  await refreshAllFillButtons();
}

// ── Matrix Auditor ───────────────────────────────────────────────────────────
// Batch element-inspection across many URLs with global + per-selector
// checks. Live editing state (links/selectors/settings) lives in sessionNS,
// same as A/B's abState; named, run audits (config + result history) are
// saved to chrome.storage.local under `matrixAudits` — NOT storage.sync as
// first sketched, since a single run easily exceeds sync's 8KB-per-item cap
// (the same reason wcagHistory/perfHistory all live in local).
// Each URL is audited by its own `runMatrixAuditStep` message round-trip so
// the "Next URL" button in the spec maps directly onto one bounded await —
// no session-storage progress polling needed, unlike the CVA/Perf loops
// that run unattended across many pages in one background call.
let mxState = null;
let mxRun = null;          // { runId, index, total, targets: [{url, group}], results: { [url]: {...} } } while a run is active/complete
let mxNextSelId = 1;
let mxGroupFilter = null;
let _mxRunning = false;
let _mxStopRequested = false;

function mxDefaultGlobalSettings() {
  return {
    waitTime: 1500,
    checkExistence: true,
    checkVisibility: true,
    checkDisplayProperty: true,
    checkVisibilityProperty: true,
    checkBoundingBox: true,
    checkText: true,
    attributesToCheck: ['data-qa', 'aria-label', 'data-test'],
  };
}

function mxDefaultState() {
  return {
    id: null,
    name: '',
    linksRaw: '',
    links: [],           // [{ url, group }] — base URLs as parsed, before link-mode params
    linkMode: 'none',    // 'none' | 'itw' | 'forced' — how link params are composed at run time
    variationId: '',     // optimizely_x value, used only in 'forced' mode
    advanceMode: 'auto', // 'auto' | 'pause' | 'manual' — how hands-on the run is
    selectors: [],       // [{ id, selector, useGlobalSettings, overrides }]
    globalSettings: mxDefaultGlobalSettings(),
  };
}

// ── Link-mode composition — the "Forced Link" / "ITW" switches decide what
// query params get stamped onto every base URL at run time (and in the live
// preview). Params we own are stripped first so toggling never stacks
// duplicates onto a URL the user pasted with its own cro_mode/optimizely_x.
function mxComposeUrl(baseUrl, mode, variationId) {
  let url = String(baseUrl || '').trim();
  if (!url || mode === 'none' || !mode) return url;
  const qi = url.indexOf('?');
  const path = qi === -1 ? url : url.slice(0, qi);
  const owned = ['cro_mode', 'optimizely_x', 'optimizely_force_tracking'];
  let params = (qi === -1 ? '' : url.slice(qi + 1))
    .split('&').filter(Boolean)
    .filter(p => !owned.includes(p.split('=')[0].toLowerCase()));
  if (mode === 'itw') {
    params.push('cro_mode=qa');
  } else if (mode === 'forced') {
    params.push('optimizely_x=' + encodeURIComponent(String(variationId || '').trim()));
    params.push('optimizely_force_tracking=true');
    params.push('cro_mode=qa');
  }
  return path + (params.length ? '?' + params.join('&') : '');
}

// The links actually audited: base URLs with the current link mode applied.
// Group labels stay as parsed (from CSV/template) so the group chips still work.
function mxCurrentTargets() {
  return mxState.links
    .map(l => ({ baseUrl: l.url, url: mxComposeUrl(l.url, mxState.linkMode, mxState.variationId), group: l.group || 'ungrouped' }))
    .filter(t => t.url);
}

// ── Links parsing — full URLs, CSV (url,group), and a Base + Pages template,
// freely mixed line-by-line in the same textarea. Pure function, no DOM/async
// — testable in isolation. ──────────────────────────────────────────────────
function mxJoinBaseUrl(base, page, params) {
  let url = String(base || '').trim().replace(/\/+$/, '') + '/' + String(page || '').trim().replace(/^\/+/, '');
  params = String(params || '').trim().replace(/^[?&]/, '');
  if (params) url += (url.includes('?') ? '&' : '?') + params;
  return url;
}

function parseMatrixLinks(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const template = { base: '', pages: [], forcedParams: '', qaParams: '' };
  const links = [];
  const seen = new Set();
  const addLink = (url, group) => {
    url = String(url || '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ url, group: group || 'ungrouped' });
  };

  for (const line of lines) {
    const baseM   = line.match(/^base\s*:\s*(.+)$/i);
    const pagesM  = line.match(/^pages\s*:\s*(.+)$/i);
    const forcedM = line.match(/^forced\s*params\s*:\s*(.+)$/i);
    const qaM     = line.match(/^qa\s*params\s*:\s*(.+)$/i);
    if (baseM)   { template.base = baseM[1].trim(); continue; }
    if (pagesM)  { template.pages = pagesM[1].split(',').map(p => p.trim()).filter(Boolean); continue; }
    if (forcedM) { template.forcedParams = forcedM[1].trim(); continue; }
    if (qaM)     { template.qaParams = qaM[1].trim(); continue; }

    if (/^https?:\/\//i.test(line)) {
      const csvM = line.match(/^(https?:\/\/\S+?),\s*(.+)$/i);
      if (csvM) addLink(csvM[1], csvM[2].trim());
      else addLink(line, null);
    }
    // Anything else (blank template keys, stray notes) is silently skipped.
  }

  if (template.base && template.pages.length) {
    for (const page of template.pages) {
      if (template.forcedParams) addLink(mxJoinBaseUrl(template.base, page, template.forcedParams), 'forced');
      if (template.qaParams)     addLink(mxJoinBaseUrl(template.base, page, template.qaParams), 'qa_mode');
      if (!template.forcedParams && !template.qaParams) addLink(mxJoinBaseUrl(template.base, page, ''), 'ungrouped');
    }
  }

  return links;
}

// ── Session persistence (live editing state, namespaced per window) ────────
async function persistMxState() {
  await sessionNS.set({ mxState: {
    id: mxState.id, name: mxState.name, linksRaw: mxState.linksRaw,
    links: mxState.links, linkMode: mxState.linkMode, variationId: mxState.variationId,
    advanceMode: mxState.advanceMode, selectors: mxState.selectors, globalSettings: mxState.globalSettings,
  } });
}

function mxBumpSelectorCounter() {
  for (const s of mxState.selectors) {
    const n = parseInt(String(s.id || '').replace('sel_', ''), 10);
    if (Number.isFinite(n) && n >= mxNextSelId) mxNextSelId = n + 1;
  }
}

// ── Links panel ──────────────────────────────────────────────────────────────
function mxUpdateLinkCount() {
  const n = mxCurrentTargets().length;
  const modeNote = mxState.linkMode === 'forced' ? ' (forced)' : mxState.linkMode === 'itw' ? ' (ITW)' : '';
  document.getElementById('mx-link-preview').textContent = `${n} URL${n === 1 ? '' : 's'} ready to audit${modeNote}`;
  document.getElementById('mx-link-count').textContent = `${n} URL${n === 1 ? '' : 's'} ready`;
}

// Forced Link and ITW are mutually exclusive — one, the other, or neither.
// Setting a mode reconciles both checkboxes and the Variation ID field so the
// two switches can never both be on.
function mxSetLinkMode(mode) {
  mxState.linkMode = (mode === 'forced' || mode === 'itw') ? mode : 'none';
  const forced = document.getElementById('mx-mode-forced');
  const itw = document.getElementById('mx-mode-itw');
  const varRow = document.getElementById('mx-variation-row');
  if (forced) forced.checked = mxState.linkMode === 'forced';
  if (itw) itw.checked = mxState.linkMode === 'itw';
  if (varRow) varRow.style.display = mxState.linkMode === 'forced' ? '' : 'none';
  mxRenderLinkList();
  mxUpdateLinkCount();
  persistMxState();
}

function mxRenderLinkGroups() {
  const wrap = document.getElementById('mx-link-groups');
  const groups = [...new Set(mxState.links.map(l => l.group || 'ungrouped'))];
  if (groups.length <= 1) { wrap.innerHTML = ''; return; }
  const chip = (label, value, count) =>
    `<button type="button" class="btn sm${mxGroupFilter === value ? ' primary' : ''}" data-mx-grp="${esc(value || '')}">${esc(label)} (${count})</button>`;
  wrap.innerHTML = chip('All', '', mxState.links.length) +
    groups.map(g => chip(g, g, mxState.links.filter(l => (l.group || 'ungrouped') === g).length)).join('');
  wrap.querySelectorAll('[data-mx-grp]').forEach(btn => {
    btn.addEventListener('click', () => {
      mxGroupFilter = btn.dataset.mxGrp || null;
      mxRenderLinkGroups();
      mxRenderLinkList();
    });
  });
}

function mxRenderLinkList() {
  const list = document.getElementById('mx-link-list');
  const targets = mxCurrentTargets();
  const filtered = mxGroupFilter ? targets.filter(t => (t.group || 'ungrouped') === mxGroupFilter) : targets;
  list.innerHTML = filtered.map(t => `<div style="font-size:11px;color:var(--fg2);padding:2px 4px;
    border-bottom:1px solid var(--stroke);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
    title="${esc(t.url)}">${esc(t.url)} <span style="color:var(--fg3)">· ${esc(t.group || 'ungrouped')}</span></div>`).join('');
}

function mxOnLinksInput() {
  mxState.linksRaw = document.getElementById('mx-links-input').value;
  mxState.links = parseMatrixLinks(mxState.linksRaw);
  mxGroupFilter = null;
  mxRenderLinkGroups();
  mxRenderLinkList();
  mxUpdateLinkCount();
  persistMxState();
}

function mxClearLinks() {
  document.getElementById('mx-links-input').value = '';
  mxState.linksRaw = '';
  mxState.links = [];
  mxGroupFilter = null;
  mxRenderLinkGroups();
  mxRenderLinkList();
  mxUpdateLinkCount();
  persistMxState();
}

// ── Selectors panel ──────────────────────────────────────────────────────────
function mxNewSelector(over) {
  return Object.assign({ id: 'sel_' + (mxNextSelId++), selector: '', useGlobalSettings: true, overrides: null }, over || {});
}

function mxParseAttrs(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}

function mxDefaultOverrides(global) {
  return {
    checkExistence: true,
    checkVisibility: !!global.checkVisibility,
    checkText: !!global.checkText,
    attributesToCheck: [...(global.attributesToCheck || [])],
  };
}

// Per-selector overrides only expose one "Check visibility" toggle (no
// display/visibility-property/bounding-box breakdown — that granularity is
// global-only, per the spec's simpler per-selector toggle group), so an
// override with checkVisibility on runs the full visibility detail.
function mxResolveSettings(sel, global) {
  if (sel.useGlobalSettings || !sel.overrides) {
    return {
      checkExistence: true,
      checkVisibility: !!global.checkVisibility,
      checkDisplayProperty: !!global.checkDisplayProperty,
      checkVisibilityProperty: !!global.checkVisibilityProperty,
      checkBoundingBox: !!global.checkBoundingBox,
      checkText: !!global.checkText,
      attributesToCheck: global.attributesToCheck || [],
    };
  }
  const o = sel.overrides;
  return {
    checkExistence: o.checkExistence !== false,
    checkVisibility: !!o.checkVisibility,
    checkDisplayProperty: !!o.checkVisibility,
    checkVisibilityProperty: !!o.checkVisibility,
    checkBoundingBox: !!o.checkVisibility,
    checkText: !!o.checkText,
    attributesToCheck: o.attributesToCheck || [],
  };
}

function mxRenderSelectors() {
  const list = document.getElementById('mx-selector-list');
  const q = s => esc(s || '').replace(/"/g, '&quot;');
  document.getElementById('mx-sel-count').textContent = `${mxState.selectors.length} selector${mxState.selectors.length === 1 ? '' : 's'}`;
  if (!mxState.selectors.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--fg3)">No selectors yet — click + Add Selector.</div>';
    return;
  }
  list.innerHTML = mxState.selectors.map((s, i) => {
    const ov = s.overrides || mxDefaultOverrides(mxState.globalSettings);
    return `
    <div class="mx-sel-row" data-mx-sel="${i}" style="background:var(--surface);border:1px solid var(--stroke);
      border-radius:5px;padding:6px 8px;display:flex;flex-direction:column;gap:5px">
      <div class="row" style="gap:5px">
        <input type="text" data-mx-sel-input value="${q(s.selector)}" placeholder="[class*=...], #main-cta …"
          style="flex:1;font-family:'Cascadia Code','Menlo',monospace;font-size:11px">
        <button class="btn-pick" data-pick-arg="mx-sel" title="Pick element from page">🎯</button>
        <button class="btn-icon" data-mx-rm-sel title="Remove" style="color:var(--err)">✕</button>
      </div>
      <label class="row" style="gap:5px;font-size:11px;color:var(--fg2);cursor:pointer">
        <input type="checkbox" data-mx-sel-global ${s.useGlobalSettings ? 'checked' : ''}> Use global settings
      </label>
      ${s.useGlobalSettings ? '' : `
      <div class="row" style="gap:12px;flex-wrap:wrap;padding-left:4px">
        <label class="suite-check" style="padding:0"><input type="checkbox" data-mx-ov="checkExistence" ${ov.checkExistence ? 'checked' : ''}> Check existence</label>
        <label class="suite-check" style="padding:0"><input type="checkbox" data-mx-ov="checkVisibility" ${ov.checkVisibility ? 'checked' : ''}> Check visibility</label>
        <label class="suite-check" style="padding:0"><input type="checkbox" data-mx-ov="checkText" ${ov.checkText ? 'checked' : ''}> Check text content</label>
      </div>
      <input type="text" data-mx-ov-attrs value="${q((ov.attributesToCheck || []).join(', '))}"
        placeholder="Attributes to check (comma-separated)" style="font-size:11px">
      `}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-mx-sel]').forEach(row => {
    const i = +row.dataset.mxSel;
    const sel = mxState.selectors[i];
    row.querySelector('[data-mx-sel-input]').addEventListener('input', e => {
      sel.selector = e.target.value;
      persistMxState();
    });
    row.querySelector('.btn-pick').addEventListener('click', () => {
      startPicker(row, null, 'mx-sel', (picked) => {
        const val = picked.css || (picked.idValue ? '#' + picked.idValue : '');
        sel.selector = val;
        row.querySelector('[data-mx-sel-input]').value = val;
        persistMxState();
      });
    });
    row.querySelector('[data-mx-rm-sel]').addEventListener('click', () => {
      mxState.selectors.splice(i, 1);
      mxRenderSelectors();
      persistMxState();
    });
    row.querySelector('[data-mx-sel-global]').addEventListener('change', e => {
      sel.useGlobalSettings = e.target.checked;
      if (!sel.useGlobalSettings) sel.overrides = sel.overrides || mxDefaultOverrides(mxState.globalSettings);
      mxRenderSelectors();
      persistMxState();
    });
    row.querySelectorAll('[data-mx-ov]').forEach(chk => {
      chk.addEventListener('change', e => {
        sel.overrides = sel.overrides || mxDefaultOverrides(mxState.globalSettings);
        sel.overrides[e.target.dataset.mxOv] = e.target.checked;
        persistMxState();
      });
    });
    row.querySelector('[data-mx-ov-attrs]')?.addEventListener('input', e => {
      sel.overrides = sel.overrides || mxDefaultOverrides(mxState.globalSettings);
      sel.overrides.attributesToCheck = mxParseAttrs(e.target.value);
      persistMxState();
    });
  });
}

function mxAddSelector() {
  mxState.selectors.push(mxNewSelector());
  mxRenderSelectors();
  persistMxState();
}

// ── Global Settings panel ───────────────────────────────────────────────────
function mxApplyGlobalSettingsToInputs() {
  const g = mxState.globalSettings;
  document.getElementById('mx-wait-time').value = g.waitTime;
  document.getElementById('mx-check-display').checked = !!g.checkDisplayProperty;
  document.getElementById('mx-check-visibility').checked = !!g.checkVisibilityProperty;
  document.getElementById('mx-check-bbox').checked = !!g.checkBoundingBox;
  document.getElementById('mx-check-text').checked = !!g.checkText;
  document.getElementById('mx-attrs').value = (g.attributesToCheck || []).join(', ');
}

function mxOnGlobalSettingsChange() {
  const g = mxState.globalSettings;
  g.waitTime = Math.max(0, parseInt(document.getElementById('mx-wait-time').value, 10) || 0);
  g.checkDisplayProperty = document.getElementById('mx-check-display').checked;
  g.checkVisibilityProperty = document.getElementById('mx-check-visibility').checked;
  g.checkBoundingBox = document.getElementById('mx-check-bbox').checked;
  g.checkVisibility = g.checkDisplayProperty || g.checkVisibilityProperty || g.checkBoundingBox;
  g.checkText = document.getElementById('mx-check-text').checked;
  g.attributesToCheck = mxParseAttrs(document.getElementById('mx-attrs').value);
  persistMxState();
}

function mxResetGlobalSettings() {
  mxState.globalSettings = mxDefaultGlobalSettings();
  mxApplyGlobalSettingsToInputs();
  persistMxState();
}

// ── Saved audits (chrome.storage.local, keyed by id — see comment above) ───
const MX_MAX_AUDITS = 10;

async function mxSaveAudit() {
  if (!mxRun) return;
  const { matrixAudits = {} } = await chrome.storage.local.get('matrixAudits');
  const now = new Date().toISOString();
  if (!mxState.id) mxState.id = 'audit_' + Date.now();
  const existing = matrixAudits[mxState.id];
  const typedName = document.getElementById('mx-audit-name').value.trim();
  const name = typedName || mxState.name || existing?.name || `Matrix Audit ${new Date().toLocaleString()}`;
  mxState.name = name;
  matrixAudits[mxState.id] = {
    id: mxState.id,
    name,
    createdAt: existing?.createdAt || now,
    lastModified: now,
    config: {
      selectors: mxState.selectors,
      links: mxState.links,
      linkMode: mxState.linkMode,
      variationId: mxState.variationId,
      globalSettings: mxState.globalSettings,
    },
    results: {
      ...(existing?.results || {}),
      [mxRun.runId]: {
        timestamp: now,
        totalUrls: mxRun.total,
        completedUrls: Object.keys(mxRun.results).length,
        findings: mxRun.results,
      },
    },
  };
  // Keep only the most-recently-modified MX_MAX_AUDITS audits — chrome.storage.local
  // is generous (~5-10MB) compared to sync, but an unbounded history still isn't free.
  const ids = Object.keys(matrixAudits).sort((a, b) =>
    new Date(matrixAudits[b].lastModified) - new Date(matrixAudits[a].lastModified));
  const pruned = {};
  ids.slice(0, MX_MAX_AUDITS).forEach(k => { pruned[k] = matrixAudits[k]; });
  await chrome.storage.local.set({ matrixAudits: pruned });
  await mxRefreshAuditDropdown();
  await persistMxState();
}

async function mxRefreshAuditDropdown() {
  const { matrixAudits = {} } = await chrome.storage.local.get('matrixAudits');
  const sel = document.getElementById('mx-load-audit-select');
  const ids = Object.keys(matrixAudits).sort((a, b) =>
    new Date(matrixAudits[b].lastModified) - new Date(matrixAudits[a].lastModified));
  const current = sel.value;
  sel.innerHTML = '<option value="">Load previous audit…</option>' +
    ids.map(id => `<option value="${id}">${esc(matrixAudits[id].name || id)}</option>`).join('');
  if (ids.includes(current)) sel.value = current;
}

async function mxLoadAudit(id) {
  if (!id) return;
  const { matrixAudits = {} } = await chrome.storage.local.get('matrixAudits');
  const audit = matrixAudits[id];
  if (!audit) return;
  mxState.id = audit.id;
  mxState.name = audit.name;
  mxState.selectors = JSON.parse(JSON.stringify(audit.config.selectors || []));
  mxState.links = JSON.parse(JSON.stringify(audit.config.links || []));
  mxState.linkMode = audit.config.linkMode || 'none';
  mxState.variationId = audit.config.variationId || '';
  mxState.globalSettings = { ...mxDefaultGlobalSettings(), ...(audit.config.globalSettings || {}) };
  mxState.linksRaw = mxState.links.map(l => `${l.url},${l.group || 'ungrouped'}`).join('\n');
  mxBumpSelectorCounter();
  mxRun = null;
  document.getElementById('mx-links-input').value = mxState.linksRaw;
  document.getElementById('mx-audit-name').value = mxState.name || '';
  document.getElementById('mx-variation-id').value = mxState.variationId || '';
  mxSetLinkMode(mxState.linkMode);
  mxApplyGlobalSettingsToInputs();
  mxRenderSelectors();
  mxGroupFilter = null;
  mxRenderLinkGroups();
  mxRenderLinkList();
  mxUpdateLinkCount();
  document.getElementById('mx-results-table').innerHTML = '';
  mxSetUiState('idle');
  mxSetStatus('Loaded. Click "Run Audit" to start.');
  await persistMxState();
}

async function mxDeleteAudit() {
  const sel = document.getElementById('mx-load-audit-select');
  const id = sel.value;
  if (!id) return;
  if (!confirm('Delete this saved audit?')) return;
  const { matrixAudits = {} } = await chrome.storage.local.get('matrixAudits');
  delete matrixAudits[id];
  await chrome.storage.local.set({ matrixAudits });
  if (mxState.id === id) {
    mxState.id = null;
    mxState.name = '';
    document.getElementById('mx-audit-name').value = '';
  }
  await mxRefreshAuditDropdown();
}

// ── Results panel ────────────────────────────────────────────────────────────
function mxSetStatus(text) {
  document.getElementById('mx-status').textContent = text;
}

function mxSetUiState(state) {
  const runBtn   = document.getElementById('btn-mx-run');
  const nextBtn  = document.getElementById('btn-mx-next');
  const stopBtn  = document.getElementById('btn-mx-stop');
  const resetBtn = document.getElementById('btn-mx-reset');
  const actions  = document.getElementById('mx-results-actions');
  runBtn.style.display  = (state === 'idle') ? '' : 'none';
  nextBtn.style.display = (state === 'waiting-next') ? '' : 'none';
  stopBtn.style.display = (state === 'busy') ? '' : 'none';
  // Reset is the escape hatch out of a paused/stopped/finished run (returns to
  // idle without touching the config). During 'busy' the Stop button plays
  // that role instead — clearing mxRun mid-audit would break the in-flight step.
  if (resetBtn) resetBtn.style.display = (state === 'waiting-next' || state === 'done') ? '' : 'none';
  actions.style.display = (state === 'done') ? 'flex' : 'none';
}

// A URL "has a problem" if the page failed to load, or any audited selector
// errored or wasn't found — i.e. the cases where the user actually wants to
// stop and look. Drives the "Auto, pause on problems" advance mode.
function mxResultHasProblem(r) {
  if (!r) return true;
  if (r.loadError) return true;
  return Object.values(r.findings || {}).some(f => f && (f.error || !f.exists));
}

function mxShortSelector(sel) {
  const s = sel || '';
  return s.length > 22 ? s.slice(0, 20) + '…' : s;
}

function mxDetailLines(finding) {
  if (!finding) return [];
  if (finding.error) return [`Error: ${finding.error}`];
  if (!finding.exists) return ['Not present in the DOM.'];
  const lines = [`Visible: ${finding.visible === null ? '—' : finding.visible}`];
  if (finding.displayProperty != null) lines.push(`Display: ${finding.displayProperty}`);
  if (finding.visibilityProperty != null) lines.push(`Visibility: ${finding.visibilityProperty}`);
  if (finding.boundingBox) lines.push(`Box: ${Math.round(finding.boundingBox.width)}×${Math.round(finding.boundingBox.height)}`);
  if (finding.text) lines.push(`Text: ${finding.text.slice(0, 140)}`);
  const attrs = Object.entries(finding.attributes || {});
  if (attrs.length) lines.push(`Attrs: ${attrs.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines;
}

function mxRenderCell(finding) {
  if (!finding) return '<td>—</td>';
  const label = finding.error
    ? '<span class="perf-over">ERROR</span>'
    : finding.exists
      ? '<span class="perf-ok">FOUND</span>'
      : '<span class="perf-over">NOT FOUND</span>';
  const lines = mxDetailLines(finding).map(l => esc(l || '')).join('<br>');
  return `<td><details><summary style="cursor:pointer">${label}</summary>
    <div style="font-size:10px;color:var(--fg2);margin-top:3px;line-height:1.5">${lines}</div>
  </details></td>`;
}

function mxRenderResultsTable() {
  const el = document.getElementById('mx-results-table');
  if (!mxRun || !Object.keys(mxRun.results).length) { el.innerHTML = ''; return; }
  const sels = mxState.selectors.filter(s => s.selector.trim());
  const rows = mxRun.targets.filter(t => mxRun.results[t.url]);
  el.innerHTML = `<div style="overflow-x:auto"><table class="perf-table">
    <thead><tr>
      <th>URL</th>
      ${sels.map(s => `<th title="${esc(s.selector)}">${esc(mxShortSelector(s.selector))}</th>`).join('')}
      <th>Status</th>
    </tr></thead>
    <tbody>${rows.map(t => {
      const r = mxRun.results[t.url];
      const status = r.loadError ? '<span class="perf-over">Error</span>' : '<span class="perf-ok">Complete</span>';
      return `<tr>
        <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.url)}">${esc(t.url)}</td>
        ${sels.map(s => mxRenderCell(r.findings?.[s.id])).join('')}
        <td>${status}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// ── Run orchestration — one background round-trip per URL. The Advance mode
// decides how hands-on the run is: 'auto' walks every URL with no clicks,
// 'pause' auto-advances but stops on any problem so the user can look, and
// 'manual' stops after every URL (the original one-at-a-time behavior). Each
// URL is still one bounded await, so resuming is just re-entering the loop —
// no progress polling needed (unlike CVA/Perf's single background call). ──
async function runMatrixAuditStart() {
  if (_mxRunning) return;
  const validSelectors = mxState.selectors.filter(s => s.selector.trim());
  const targets = mxCurrentTargets();
  if (!targets.length) { alert('Add at least one URL first.'); return; }
  if (!validSelectors.length) { alert('Add at least one selector first.'); return; }
  if (mxState.linkMode === 'forced' && !String(mxState.variationId).trim()) {
    alert('Enter a Variation ID for Forced Link mode.'); return;
  }
  _mxStopRequested = false;
  mxRun = { runId: 'run_' + Date.now(), index: -1, total: targets.length, targets, results: {} };
  document.getElementById('mx-results-table').innerHTML = '';
  await mxRunLoop();
}

// The driver. Audits URLs until it hits a natural stopping point (end of run,
// a Stop request, a manual step boundary, or a problem in 'pause' mode), then
// returns and leaves the UI in the right state. The "Next URL" button simply
// calls this again to resume from wherever it left off.
async function mxRunLoop() {
  if (!mxRun || _mxRunning) return;
  // Fresh (re)entry — clear any prior Stop request so the "Next URL" button
  // can resume a run that was stopped. A Stop clicked while this loop is
  // running is still caught by the per-iteration check below.
  _mxStopRequested = false;
  const mode = mxState.advanceMode || 'auto';
  while (true) {
    if (_mxStopRequested) {
      const done = mxRun.index + 1 >= mxRun.total;
      mxSetStatus(`Stopped at ${mxRun.index + 1} of ${mxRun.total}.`);
      mxSetUiState(done ? 'done' : 'waiting-next');
      return;
    }
    if (mxRun.index + 1 >= mxRun.total) { await mxFinishRun(); return; }
    const problem = await mxAuditNext();
    if (mxRun.index + 1 >= mxRun.total) { await mxFinishRun(); return; }
    if (mode === 'manual' || (mode === 'pause' && problem)) {
      mxSetStatus(`Audited ${mxRun.index + 1} of ${mxRun.total}.${(mode === 'pause' && problem) ? ' Problem found —' : ''} Click "Next URL" to continue.`);
      mxSetUiState('waiting-next');
      return;
    }
    // Auto (or pause with a clean result): yield briefly so the table paints
    // and a Stop click can register between URLs, then keep going.
    await new Promise(r => setTimeout(r, 120));
  }
}

// Audits the next URL, stores + renders + persists its result, and reports
// whether it hit a problem (for 'pause' mode). Advances mxRun.index by one.
async function mxAuditNext() {
  mxRun.index++;
  const target = mxRun.targets[mxRun.index];
  _mxRunning = true;
  mxSetUiState('busy');
  mxSetStatus(`Auditing URL ${mxRun.index + 1} of ${mxRun.total}… ${target.url}`);
  const entries = mxState.selectors
    .filter(s => s.selector.trim())
    .map(s => ({ id: s.id, selector: s.selector.trim(), checkSettings: mxResolveSettings(s, mxState.globalSettings) }));
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      action: 'runMatrixAuditStep',
      payload: { url: target.url, entries, waitTime: mxState.globalSettings.waitTime, winId: WIN_ID },
    });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  mxRun.results[target.url] = (res && res.ok)
    ? { findings: res.findings || {}, finalUrl: res.finalUrl || '', loadError: res.loadError || null }
    : { findings: {}, finalUrl: '', loadError: (res && res.error) || 'Unknown error' };
  _mxRunning = false;
  mxRenderResultsTable();
  await mxSaveAudit();
  return mxResultHasProblem(mxRun.results[target.url]);
}

function mxStopRun() {
  _mxStopRequested = true;
  mxSetStatus('Stopping after the current URL…');
}

// Abandon the current run and return to a clean idle state. Leaves the audit
// config (links, selectors, settings) untouched so the user can tweak and
// re-run. Guarded against firing mid-audit — Reset is only offered when a run
// is paused/stopped/finished, never while _mxRunning is in flight.
function mxResetRun() {
  if (_mxRunning) return;
  _mxStopRequested = false;
  mxRun = null;
  document.getElementById('mx-results-table').innerHTML = '';
  mxSetStatus('Ready. Click "Run Audit" to start.');
  mxSetUiState('idle');
}

async function mxFinishRun() {
  mxSetStatus(`Complete — audited ${Object.keys(mxRun.results).length} of ${mxRun.total} URL${mxRun.total === 1 ? '' : 's'}. Report opened in a new tab.`);
  mxSetUiState('done');
  await mxOpenReport();
}

// ── CSV export ───────────────────────────────────────────────────────────────
function mxCsvEscape(v) {
  v = String(v ?? '');
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function mxDownloadCsv(rows, filename) {
  const csv = rows.map(r => r.map(mxCsvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function exportMatrixResultsCsv() {
  if (!mxRun) return;
  const sels = mxState.selectors.filter(s => s.selector.trim());
  const header = ['URL', ...sels.map(s => s.selector), 'Status'];
  const rows = [header];
  mxRun.targets.forEach(t => {
    const r = mxRun.results[t.url];
    if (!r) return;
    const row = [t.url];
    sels.forEach(s => {
      const f = r.findings?.[s.id];
      row.push(!f ? '' : f.error ? 'ERROR' : (f.exists ? 'FOUND' : 'NOT FOUND'));
    });
    row.push(r.loadError ? `Error: ${r.loadError}` : 'Complete');
    rows.push(row);
  });
  mxDownloadCsv(rows, `matrix-audit-${mxRun.runId}.csv`);
}

// ── Full report (opens in a bundled tab, like the Test Agent QA report) ──────
// Renders the report BODY only (the CSS + page shell live in report.html). We
// deliberately do NOT open a blob: URL — recent Chrome blocks top-level
// navigation to extension-created blob: URLs (the tab loads with an error), so
// the report content is handed to a bundled report.html page through
// chrome.storage.session instead. Uses the same .rpt-* visual language as
// buildReportBody so both reports read as one family.
function mxReportBadge(finding) {
  if (!finding) return '<span class="rpt-badge rpt-badge-skip">—</span>';
  if (finding.error) return '<span class="rpt-badge rpt-badge-fail">ERROR</span>';
  return finding.exists
    ? '<span class="rpt-badge rpt-badge-pass">FOUND</span>'
    : '<span class="rpt-badge rpt-badge-fail">NOT FOUND</span>';
}

// Just the inner markup that report.html drops into its .rpt-wrap container.
function mxBuildReportBody() {
  const sels = mxState.selectors.filter(s => s.selector.trim());
  const targets = mxRun.targets.filter(t => mxRun.results[t.url]);
  const modeLabel = mxState.linkMode === 'forced'
    ? `Forced Link — optimizely_x=${esc(String(mxState.variationId || ''))}`
    : mxState.linkMode === 'itw' ? 'ITW — cro_mode=qa' : 'None (links as pasted)';

  const summaryRows = sels.map(s => {
    const found = targets.filter(t => mxRun.results[t.url].findings?.[s.id]?.exists).length;
    const cls = found === targets.length ? 'rpt-badge-pass' : found === 0 ? 'rpt-badge-fail' : 'rpt-badge-issues';
    return `<tr><td><code>${esc(s.selector)}</code></td>
      <td><span class="rpt-badge ${cls}">${found} / ${targets.length} found</span></td></tr>`;
  }).join('');

  const matrixHead = `<tr><th>URL</th>${sels.map(s => `<th><code>${esc(mxShortSelector(s.selector))}</code></th>`).join('')}<th>Status</th></tr>`;
  const matrixBody = targets.map(t => {
    const r = mxRun.results[t.url];
    const status = r.loadError ? '<span class="rpt-badge rpt-badge-fail">Error</span>' : '<span class="rpt-badge rpt-badge-pass">Complete</span>';
    return `<tr>
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a></td>
      ${sels.map(s => `<td>${mxReportBadge(r.findings?.[s.id])}</td>`).join('')}
      <td>${status}</td></tr>`;
  }).join('');

  const details = targets.map(t => {
    const r = mxRun.results[t.url];
    const err = r.loadError ? `<p class="rpt-muted">Load error: ${esc(r.loadError)}</p>` : '';
    const perSel = sels.map(s => {
      const f = r.findings?.[s.id];
      const lines = mxDetailLines(f).map(l => `<li>${esc(l || '')}</li>`).join('') || '<li>—</li>';
      return `<h3><code>${esc(s.selector)}</code> ${mxReportBadge(f)}</h3><ul>${lines}</ul>`;
    }).join('');
    return `<details class="rpt-section"><summary><b>${esc(t.url)}</b></summary>${err}${perSel}</details>`;
  }).join('');

  const name = mxState.name || 'Matrix Audit';
  return `<header class="rpt-header">
      <h1>${esc(name)}</h1>
      <div class="rpt-meta">Matrix Audit Report · generated ${esc(new Date().toLocaleString())}</div>
      <div class="rpt-meta" style="margin-top:6px">${targets.length} URL${targets.length === 1 ? '' : 's'} · ${sels.length} selector${sels.length === 1 ? '' : 's'} · Link mode: ${modeLabel}</div>
    </header>
    <div class="rpt-section">
      <h2>Selector summary</h2>
      <table class="rpt-table"><tbody>${summaryRows || '<tr><td class="rpt-muted">No selectors.</td></tr>'}</tbody></table>
    </div>
    <div class="rpt-section">
      <h2>Results matrix</h2>
      <div class="rpt-scroll"><table class="rpt-table"><thead>${matrixHead}</thead><tbody>${matrixBody}</tbody></table></div>
    </div>
    <h2 style="margin:22px 0 12px">Per-URL detail</h2>
    ${details}`;
}

// Stash the rendered body under a fresh id in session storage (a non-namespaced
// key so the bundled report.html page, which has no window id, can read it),
// prune to the newest few, then open the bundled page pointed at that id.
async function mxOpenReport() {
  if (!mxRun || !Object.keys(mxRun.results).length) return;
  const id = 'r_' + Date.now();
  const title = (mxState.name || 'Matrix Audit') + ' — Matrix Audit Report';
  const { mxReports = {} } = await chrome.storage.session.get('mxReports');
  mxReports[id] = { title, bodyHtml: mxBuildReportBody() };
  const ids = Object.keys(mxReports).sort();
  while (ids.length > 5) delete mxReports[ids.shift()];
  await chrome.storage.session.set({ mxReports });
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html') + '?k=' + id });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function initMatrixAuditor() {
  mxState = mxDefaultState();
  const { mxState: saved } = await sessionNS.get('mxState');
  if (saved) {
    mxState = { ...mxDefaultState(), ...saved, globalSettings: { ...mxDefaultGlobalSettings(), ...(saved.globalSettings || {}) } };
    mxBumpSelectorCounter();
  }

  mxSyncFromState();   // mx-links-input, mx-audit-name, mx-variation-id, mx-advance-mode, link mode + list/groups
  mxApplyGlobalSettingsToInputs();
  mxRenderSelectors();
  mxSetUiState('idle');
  await mxRefreshAuditDropdown();

  document.getElementById('mx-links-input').addEventListener('input', mxOnLinksInput);
  document.getElementById('btn-mx-clear-links').addEventListener('click', mxClearLinks);
  document.getElementById('mx-mode-forced').addEventListener('change', e => mxSetLinkMode(e.target.checked ? 'forced' : 'none'));
  document.getElementById('mx-mode-itw').addEventListener('change', e => mxSetLinkMode(e.target.checked ? 'itw' : 'none'));
  document.getElementById('mx-variation-id').addEventListener('input', e => {
    mxState.variationId = e.target.value;
    mxRenderLinkList();
    mxUpdateLinkCount();
    persistMxState();
  });
  document.getElementById('mx-advance-mode').addEventListener('change', e => {
    mxState.advanceMode = e.target.value;
    persistMxState();
  });
  document.getElementById('btn-mx-add-selector').addEventListener('click', mxAddSelector);
  document.getElementById('mx-load-audit-select').addEventListener('change', e => mxLoadAudit(e.target.value));
  document.getElementById('btn-mx-delete-audit').addEventListener('click', mxDeleteAudit);
  document.getElementById('mx-audit-name').addEventListener('input', () => {
    mxState.name = document.getElementById('mx-audit-name').value;
    persistMxState();
  });

  document.getElementById('mx-wait-time').addEventListener('input', mxOnGlobalSettingsChange);
  document.getElementById('mx-check-display').addEventListener('change', mxOnGlobalSettingsChange);
  document.getElementById('mx-check-visibility').addEventListener('change', mxOnGlobalSettingsChange);
  document.getElementById('mx-check-bbox').addEventListener('change', mxOnGlobalSettingsChange);
  document.getElementById('mx-check-text').addEventListener('change', mxOnGlobalSettingsChange);
  document.getElementById('mx-attrs').addEventListener('input', mxOnGlobalSettingsChange);
  document.getElementById('btn-mx-reset-settings').addEventListener('click', mxResetGlobalSettings);

  document.getElementById('btn-mx-run').addEventListener('click', runMatrixAuditStart);
  document.getElementById('btn-mx-next').addEventListener('click', mxRunLoop);
  document.getElementById('btn-mx-stop').addEventListener('click', mxStopRun);
  document.getElementById('btn-mx-reset').addEventListener('click', mxResetRun);
  document.getElementById('btn-mx-view-report').addEventListener('click', mxOpenReport);
  document.getElementById('btn-mx-export-csv').addEventListener('click', exportMatrixResultsCsv);
  document.getElementById('btn-mx-rerun').addEventListener('click', runMatrixAuditStart);
}

// ── Metric Tracker ───────────────────────────────────────────────────────────
// Live per-metric fire counting. The list itself IS the Build tab's list
// (storage.local.metricsList, the `metrics` global) — this tab is a second
// editor over the same data, never a copy. Matching, counting, and the
// on-page notice all run in the worker (see mtObserve in background.js);
// this panel is a 600ms-poll reader plus a config editor, exactly like every
// other feed here. Match sensitivity is a GLOBAL setting
// (storage.local.metricMatchSensitivity) shared with the Track Metric queue
// step — the Settings accordion's selector edits that same key, not a
// per-window one.
let mtSettings    = { enabled: false, noticeFreq: 'every', notice: true };
let mtCounts      = {};
let _mtCountsKey  = '';   // dirty-check for the 600ms counts poll
let _mtLogLen     = -1;   // dirty-check for the recent-fires poll (mirrors syncBcLogs)
let _mtFiresFloor = 0;    // view-only "Clear" on the fires feed — never writes metricsLog

async function initMetricTracker() {
  if (!document.getElementById('panel-tracker')) return;

  const { mtSettings: saved } = await sessionNS.get('mtSettings');
  if (saved) mtSettings = { enabled: false, noticeFreq: 'every', notice: true, ...saved };
  mtApplySettingsToInputs();

  const { metricMatchSensitivity = 'balanced' } = await chrome.storage.local.get('metricMatchSensitivity');
  const sensSel = document.getElementById('mt-sensitivity');
  if (sensSel) sensSel.value = metricMatchSensitivity;

  await mtSync();        // hydrate counts + fires before first paint
  mtRenderRows();         // structural — reads `metrics`, loaded by loadMetrics() earlier in this chain
  await mtSyncStatus();

  document.getElementById('mt-enabled').addEventListener('change', onMtSettingsChange);
  document.getElementById('mt-notice-enabled').addEventListener('change', onMtSettingsChange);
  document.getElementById('mt-notice-freq').addEventListener('change', onMtSettingsChange);
  document.getElementById('mt-sensitivity').addEventListener('change', onMtSensitivityChange);
  document.getElementById('btn-mt-add').addEventListener('click', mtAddRow);
  document.getElementById('btn-mt-reset').addEventListener('click', mtResetCounts);
  document.getElementById('btn-mt-remove-all').addEventListener('click', mtRemoveAll);
  document.getElementById('btn-mt-clear-fires').addEventListener('click', mtClearFires);
  document.getElementById('btn-mt-fix-capture').addEventListener('click', mtFixCapture);

  // Delegated on #mt-list — pattern typing must NOT rebuild the list (focus
  // loss), so it updates in place; enabled/mode/remove/confirm do rebuild.
  const list = document.getElementById('mt-list');
  list.addEventListener('input',  onMtRowInput);
  list.addEventListener('change', onMtRowChange);
  list.addEventListener('click',  onMtRowClick);

  // Another window changed the global sensitivity — keep this select honest.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.metricMatchSensitivity) return;
    const sel = document.getElementById('mt-sensitivity');
    if (sel) sel.value = changes.metricMatchSensitivity.newValue || 'balanced';
  });

  // Experiment status card — inherits this function's own try/catch at its
  // call site, so a fault here can't take the rest of the init chain with it.
  await initExpStatus();
}

function mtApplySettingsToInputs() {
  const en = document.getElementById('mt-enabled');
  if (en) en.checked = !!mtSettings.enabled;
  const no = document.getElementById('mt-notice-enabled');
  if (no) no.checked = mtSettings.notice !== false;
  const freq = document.getElementById('mt-notice-freq');
  if (freq) freq.value = mtSettings.noticeFreq || 'every';
}

function persistMtSettings() {
  sessionNS.set({ mtSettings });
}

function onMtSettingsChange() {
  mtSettings.enabled    = document.getElementById('mt-enabled').checked;
  mtSettings.notice     = document.getElementById('mt-notice-enabled').checked;
  mtSettings.noticeFreq = document.getElementById('mt-notice-freq').value;
  persistMtSettings();
  mtSyncStatus();
}

async function onMtSensitivityChange(e) {
  await chrome.storage.local.set({ metricMatchSensitivity: e.target.value });
  mtRenderFires();   // re-annotate the feed under the new threshold immediately
}

// ── Rendering — a hard split so the 600ms poll never rebuilds focused inputs ─
// mtRenderRows(): rebuilds #mt-list from `metrics` — init, add/remove, showTab
// entry, and the shared-list fan-out (mtSyncAfterListChange).
// mtRenderCounts(): writes textContent into existing [data-mt-count] spans
// only — safe to call from the poll every 600ms.
// mtRenderFires(): rebuilds #mt-fires only, and only when metricsLog changed.
function mtRenderRows() {
  const list = document.getElementById('mt-list');
  if (!list) return;
  const countEl = document.getElementById('mt-count');
  if (countEl) countEl.textContent = `${metrics.length} metric${metrics.length === 1 ? '' : 's'}`;

  if (!metrics.length) {
    list.innerHTML = '<div id="mt-empty">No metrics yet — click + Add Metric to start tracking</div>';
    return;
  }

  list.innerHTML = metrics.map((m) => {
    const needsReview = m.source === 'goal' && m.reviewed === false;
    const c = mtCounts[m.id];
    const n = c ? c.n : 0;
    return `
    <div class="mt-item${m.enabled === false ? ' mt-off' : ''}" data-mt-item="${esc(m.id)}">
      <div class="mt-row">
        <input type="checkbox" data-mt-toggle="${esc(m.id)}" ${m.enabled !== false ? 'checked' : ''} title="Include in tracking">
        <input type="text" data-mt-pattern="${esc(m.id)}" placeholder="Metric value, e.g. Tagging: hero_cta_click" value="${esc(m.pattern || '').replace(/"/g, '&quot;')}">
        <span class="mt-count${n > 0 ? ' mt-hit' : ''}" data-mt-count="${esc(m.id)}" title="Fires this browser session">${n}</span>
        <button class="btn-icon" data-mt-remove="${esc(m.id)}" title="Remove metric">✕</button>
      </div>
      <div class="mt-sub">
        <select data-mt-mode="${esc(m.id)}" style="flex:0 0 82px;font-size:11px;padding:3px 4px">
          <option value="contains"${m.mode === 'contains' ? ' selected' : ''}>Contains</option>
          <option value="smart"${m.mode === 'smart' ? ' selected' : ''}>Smart</option>
          <option value="exact"${m.mode === 'exact' ? ' selected' : ''}>Exact</option>
          <option value="regex"${m.mode === 'regex' ? ' selected' : ''}>Regex</option>
        </select>
        ${needsReview ? `<span class="btn-icon" data-mt-confirm="${esc(m.id)}" style="font-size:10px;color:var(--warn)" title="From a ticket Goal — needs review before Track Metric can assert on it. Click to confirm.">⚠ needs review — click to confirm</span>` : ''}
        <span data-mt-err="${esc(m.id)}" style="font-size:10px;color:var(--err)"></span>
      </div>
    </div>`;
  }).join('');

  metrics.forEach((m) => mtValidateRow(m.id));
}

function mtRenderCounts() {
  for (const m of metrics) {
    const el = document.querySelector(`[data-mt-count="${m.id}"]`);
    if (!el) continue;
    const c = mtCounts[m.id];
    const n = c ? c.n : 0;
    el.textContent = n;
    el.classList.toggle('mt-hit', n > 0);
  }
}

// A typo'd regex is otherwise an invisible silent no-match — surface it
// inline right where it was typed.
function mtValidateRow(id) {
  const errEl = document.querySelector(`[data-mt-err="${id}"]`);
  if (!errEl) return;
  const m = metrics.find((x) => x.id === id);
  if (!m || m.mode !== 'regex' || !(m.pattern || '').trim()) { errEl.textContent = ''; return; }
  try { new RegExp(m.pattern); errEl.textContent = ''; }
  catch (e) { errEl.textContent = 'Invalid regex: ' + e.message; }
}

// The recent-fires feed needs no new storage — metricsLog already holds
// every tagged line. This is display-only re-matching (client-side, no
// correctness stake — the worker's own mtObserve is the source of truth for
// counts), capped to the 40 most recent so the panel stays light.
async function mtRenderFires() {
  const host = document.getElementById('mt-fires');
  if (!host) return;
  const { metricsLog = [] } = await sessionNS.get('metricsLog');
  if (metricsLog.length === _mtLogLen) return;
  _mtLogLen = metricsLog.length;

  const sensitivity = document.getElementById('mt-sensitivity')?.value || 'balanced';
  const enabledMetrics = metrics.filter((m) => m.enabled !== false && (m.pattern || '').trim());
  const rows = metricsLog.filter((e) => (e.t || 0) > _mtFiresFloor).slice(-40).reverse();

  if (!rows.length) {
    host.innerHTML = '<div id="mt-empty">No tagged console lines seen yet.</div>';
    return;
  }

  host.innerHTML = rows.map((e) => {
    let bestLabel = null;
    for (const m of enabledMetrics) {
      if (mtMatch(m, e.text, { sensitivity }).hit) { bestLabel = m.label || m.pattern; break; }
    }
    const cls = bestLabel ? 'mt-fire mt-fire-hit' : 'mt-fire mt-fire-miss';
    return `<div class="${cls}">
      <span class="mt-fire-t">${esc(e.ts)}</span>
      <span class="mt-fire-lbl">${bestLabel ? esc(bestLabel) : '—'}</span>
      <span class="mt-fire-txt">${esc(e.text)}</span>
    </div>`;
  }).join('');
}

// View-only — deliberately does NOT touch metricsLog. Clearing that would
// destroy track_metric's evidence mid-run (it filters e.t >= _runStartedAt)
// and report "did not fire" for a metric that did. Same idea as logOffset.
function mtClearFires() {
  _mtFiresFloor = Date.now();
  _mtLogLen = -1;   // force a re-render even though metricsLog's length didn't change
  mtRenderFires();
}

// ── Polling ───────────────────────────────────────────────────────────────
async function mtSync() {
  if (!document.getElementById('panel-tracker')) return;
  const { mtCounts: counts = {} } = await sessionNS.get('mtCounts');
  const key = JSON.stringify(counts);
  if (key !== _mtCountsKey) {
    _mtCountsKey = key;
    mtCounts = counts;
    mtRenderCounts();
  }
  await mtRenderFires();
}

// Tracking silently does nothing when console capture is off or detached —
// surface that dependency and offer the fix, rather than letting "0 fires"
// be mistaken for "nothing fired" when nothing was ever being watched.
async function mtSyncStatus() {
  if (!document.getElementById('panel-tracker')) return;
  const statusEl = document.getElementById('mt-status');
  if (!statusEl) return;
  const dot    = document.getElementById('mt-tracking-dot');
  const fixBtn = document.getElementById('btn-mt-fix-capture');

  const { captureStatus, debuggerStatus, captureEnabled } =
    await sessionNS.get(['captureStatus', 'debuggerStatus', 'captureEnabled']);

  const setFix = (show, label, kind) => {
    if (!fixBtn) return;
    fixBtn.style.display = show ? '' : 'none';
    if (show) { fixBtn.textContent = label; fixBtn.dataset.mtFix = kind; }
  };

  if (!mtSettings.enabled) {
    statusEl.textContent = 'Tracking is off — flip the switch to start counting.';
    statusEl.style.color = 'var(--fg3)';
    if (dot) dot.style.display = 'none';
    setFix(false);
    return;
  }
  if (captureEnabled === false) {
    statusEl.textContent = 'Console capture is paused — nothing can be tracked.';
    statusEl.style.color = 'var(--warn)';
    if (dot) dot.style.display = 'none';
    setFix(true, 'Enable Capture', 'enable');
    return;
  }
  if (captureStatus?.capturable === false) {
    statusEl.textContent = "This tab can't be captured (chrome:// or extension page). Switch to a normal page.";
    statusEl.style.color = 'var(--fg3)';
    if (dot) dot.style.display = 'none';
    setFix(false);
    return;
  }
  if (debuggerStatus?.error) {
    statusEl.textContent = `Capture disconnected — ${debuggerStatus.error}`;
    statusEl.style.color = 'var(--err)';
    if (dot) dot.style.display = 'none';
    setFix(true, 'Reconnect', 'reconnect');
    return;
  }
  if (debuggerStatus?.attached) {
    const label = captureStatus?.title || captureStatus?.url || 'this tab';
    statusEl.textContent = `● Tracking ${label}`;
    statusEl.style.color = 'var(--brand)';
    if (dot) dot.style.display = '';
    setFix(false);
    return;
  }
  statusEl.textContent = 'Waiting for a capturable tab…';
  statusEl.style.color = 'var(--fg3)';
  if (dot) dot.style.display = 'none';
  setFix(false);
}

async function mtFixCapture() {
  const btn = document.getElementById('btn-mt-fix-capture');
  const action = btn?.dataset.mtFix === 'reconnect' ? 'reconnectCapture' : 'startCapture';
  if (btn) btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action, winId: WIN_ID });
    // Two toggles for one piece of state is a bug waiting to happen — keep
    // the Console tab's #capture-enabled checkbox honest too.
    await restoreCaptureState();
    await syncBcStatus();
    await syncCaptureStatus();
    await mtSyncStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Experiment status — live "what is this page actually showing" for the
// active Test Context, cross-referenced against the worker's page probe
// (see the "Experiment status runtime" section of background.js). This
// panel does ALL the ticket cross-referencing and v0/v1 label mapping; the
// worker only ever reports raw platform facts (see expProbeFn's header
// comment there) — same split as the rest of this file: worker = runtime,
// panel = reader + editor. Deliberately independent of console-capture
// health: this card can show a live verdict while #mt-status says capture
// is disconnected, since chrome.scripting needs no debugger session.
let expStatus    = null;               // last w<winId>:expStatus envelope read, or null
let expSettings  = { watch: true };
let expCtx       = null;               // the active Test Context, or null
let _expProbedAt = 0;                  // dirty-check for the 1s poll (mirrors _mtCountsKey/_mtLogLen)
let _expCtxKey   = '';                 // dirty-check for context changes: ticketKey + '|' + extractedAt
let _expTickAt   = 0;                  // heartbeat throttle, mirrors the worker's own EXP_TICK_MIN_MS

async function initExpStatus() {
  if (!document.getElementById('exp-card')) return;

  const { expSettings: saved } = await sessionNS.get('expSettings');
  if (saved) expSettings = { watch: true, ...saved };
  const watchEl = document.getElementById('exp-watch');
  if (watchEl) watchEl.checked = expSettings.watch !== false;

  document.getElementById('exp-watch')?.addEventListener('change', onExpWatchChange);
  document.getElementById('btn-exp-refresh')?.addEventListener('click', onExpRefresh);

  await expRefreshCtx();
  await expSync();
}

function onExpWatchChange(e) {
  expSettings.watch = e.target.checked;
  sessionNS.set({ expSettings });
  expRender();
}

// The panel's own "Refresh" — bypasses expSchedule's floor (reason 'manual')
// and awaits the result directly rather than waiting for the next poll, so
// the click feels immediate.
async function onExpRefresh() {
  const btn = document.getElementById('btn-exp-refresh');
  if (btn) btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ action: 'expProbeNow', winId: WIN_ID });
    if (res?.ok && res.status) {
      expStatus = res.status;
      _expProbedAt = res.status.probedAt || 0;
      expRender();
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Polling ───────────────────────────────────────────────────────────────
// The heartbeat lives here rather than as a second interval: while the
// Tracker tab is the visible panel and watching is on, ping the worker at
// most once every 3s so a page that re-buckets client-side (no nav, no
// tagged line) still gets picked up. Fire-and-forget — a slow round trip
// must never delay this poll's own render.
async function expSync() {
  if (!document.getElementById('exp-card')) return;

  const trackerVisible = document.getElementById('panel-tracker')?.classList.contains('active');
  if (trackerVisible && expSettings.watch !== false && Date.now() - _expTickAt >= 3000) {
    _expTickAt = Date.now();
    chrome.runtime.sendMessage({ action: 'expTick', winId: WIN_ID }).catch(() => {});
  }

  const { expStatus: status = null } = await sessionNS.get('expStatus');
  const probedAt = status?.probedAt || 0;
  if (probedAt === _expProbedAt) return;   // nothing new since the last render
  _expProbedAt = probedAt;
  expStatus = status;
  expRender();
}

// Display-only — reads the active Test Context and re-renders. Never writes
// to initContexts/activeInitContext; honors the same "nothing is ever pushed
// to a mode" invariant the fill-target registry documents above.
async function expRefreshCtx() {
  if (!document.getElementById('exp-card')) return;
  const ctx = await getActiveContext();
  const key = ctx ? (ctx.ticketKey + '|' + ctx.extractedAt) : '';
  if (key === _expCtxKey) return;
  _expCtxKey = key;
  expCtx = ctx;
  expRender();
}

// ── Native variation → ticket label mapping ─────────────────────────────────
// Reuses the forcing-param vocabulary mxComposeUrl already owns (popup.js
// ~5522) plus Convert's _conv_eforce. Preview links get pasted through
// redirectors and nested url= params, so this checks the parsed query AND
// hash before falling back to a raw-string scan.
function expExtractForcedVarId(url) {
  if (!url) return null;
  let u = null;
  try { u = new URL(url); } catch (_) { /* not an absolute URL — raw scan below still works */ }
  const haystacks = [];
  if (u) {
    haystacks.push(u.search);
    if (u.hash) haystacks.push(u.hash);
  }
  haystacks.push(String(url));

  for (const s of haystacks) {
    let m = /[?&#]optimizely_x=([^&#]+)/.exec(s);
    if (m) return { varId: decodeURIComponent(m[1]), expId: null };
    m = /[?&#]_conv_eforce=([^&#]+)/.exec(s);
    if (m) {
      const raw = decodeURIComponent(m[1]);
      const dot = raw.lastIndexOf('.');
      if (dot > -1) return { varId: raw.slice(dot + 1), expId: raw.slice(0, dot) };
    }
  }
  return null;
}

// Layer A of the mapping strategy: nativeVarId -> { label, source } built
// from ctx.previewLinks. Pure. Returns notes for any preview link whose
// forced experiment id doesn't match the ticket's — that's evidence worth
// surfacing, not silently dropping.
function expBuildLabelMap(ctx) {
  const map = {};
  const notes = [];
  for (const link of (ctx.previewLinks || [])) {
    const forced = expExtractForcedVarId(link?.url);
    if (!forced || !forced.varId) continue;
    if (forced.expId && ctx.experimentId && String(forced.expId) !== String(ctx.experimentId)) {
      notes.push(`Preview link "${link.id}" forces experiment ${forced.expId}, not this ticket's ${ctx.experimentId}.`);
      continue;
    }
    map[String(forced.varId)] = { label: link.id, source: 'preview-link' };
  }
  return { map, notes };
}

// Resolves one native variation id to a ticket v0/v1 label. Layer A (preview
// link) wins outright; Layer B (ordinal position in the platform's own
// variation order) applies ONLY when the platform and ticket both list the
// same number of variations — otherwise this returns null rather than guess,
// which is what puts the card into BUCKETED_UNMAPPED instead of a confident
// wrong answer. Pure.
function expLabelFor(nativeVarId, row, ctx, labelMap) {
  const fromLink = labelMap[String(nativeVarId)];
  if (fromLink) {
    const variant = (ctx.variants || []).find((v) => v.id === fromLink.label);
    return { label: fromLink.label, source: 'preview-link', rawDescription: variant?.rawDescription || null };
  }

  const variations = row?.variations || [];
  const variants = (ctx.variants || []).slice().sort((a, b) => {
    const na = parseInt(String(a.id).replace(/\D/g, ''), 10);
    const nb = parseInt(String(b.id).replace(/\D/g, ''), 10);
    return (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0);
  });
  if (variations.length && variations.length === variants.length) {
    const idx = variations.findIndex((v) => String(v.id) === String(nativeVarId));
    if (idx > -1) {
      const variant = variants[idx];
      return { label: variant.id, source: 'ordinal', rawDescription: variant.rawDescription || null };
    }
  }
  return null;
}

// ── Related-test name matching ──────────────────────────────────────────────
// Softcoded/Concurrent tests carry no native experiment id — only a
// ticket-authored label ("ARIC-471 (All Users)(PDP) Buy Now (Mobile)"). Per
// the ticket template's own convention the platform's experiment name
// usually resembles that label, so identification is name matching against
// the probe's live catalog — never a page fetch. mtNormalize (metric-match.js)
// is safe to reuse on prose; mtTokens is NOT — its MT_DOMAIN_STOP set is
// console-log-specific and would silently drop a legitimate word like
// "tracking" from a real experiment name, so tokenizing is done locally.
function expTokenize(s) {
  return mtNormalize(s).split(' ').filter((t) => t.length >= 3 || /^\d+$/.test(t));
}
function expStripLabelNoise(label) {
  return String(label || '')
    .replace(/^[A-Za-z][A-Za-z0-9]*-\d+\s*/, '')   // leading ticket key
    .replace(/\([^)]*\)/g, ' ')                     // (All Users)(PDP) audience/page tags
    .trim();
}
// Best-match-above-threshold, never a guess below it — an unmatched entry
// reports "not detected" rather than a low-confidence wrong answer.
function expMatchByName(label, experiments, { minOverlap = 0.5 } = {}) {
  const core = expStripLabelNoise(label) || label;
  const want = new Set(expTokenize(core));
  if (!want.size) return null;
  let best = null;
  for (const e of (experiments || [])) {
    if (!e?.name) continue;
    const have = new Set(expTokenize(e.name));
    if (!have.size) continue;
    let hit = 0;
    for (const t of want) if (have.has(t)) hit++;
    const score = hit / want.size;
    if (score >= minOverlap && (!best || score > best.score)) best = { row: e, score };
  }
  return best;
}

// Cross-references ctx.softcodedTests/concurrentTests against the probe's
// live experiment catalog. Neutral/informational only — matches the
// "list neutrally, no pass/fail" treatment for both, since neither carries a
// forcing param anymore that could be right or wrong about.
function expEvaluateRelated(list, probe) {
  return (list || []).map((r) => {
    const match = probe ? expMatchByName(r.label, probe.experiments) : null;
    if (!match) return { ...r, found: false };
    const row = match.row;
    return {
      ...r, found: true, experimentName: row.name, active: row.active,
      bucketed: row.bucketed, variationId: row.variationId, variationName: row.variationName,
    };
  });
}

// ── The state machine ────────────────────────────────────────────────────────
// Pure — no DOM, no storage, no async — which is what makes a chain this long
// reviewable (and testable via JXA, see the plan's verification section).
// Ordered guard chain, first match wins; `others` and the platform-mismatch
// note are evaluated ORTHOGONALLY on top of the terminal state rather than
// competing with it, so e.g. a real collision with a second live experiment
// is never swallowed just because the expected one also resolved cleanly.
function expEvaluate(status, ctx, settings) {
  const base = { expected: null, actual: null, others: [], notes: [], staleMs: null, softcoded: [], concurrent: [] };

  if (!ctx) {
    return { ...base, state: 'NO_CONTEXT', severity: 'idle',
      headline: 'No active ticket context',
      sub: 'Open the Initialize tab and set an active context to watch its experiment.' };
  }

  const expected = {
    ticketKey: ctx.ticketKey || null,
    platform: ctx.platform || null,
    experimentId: ctx.experimentId ? String(ctx.experimentId).trim() : null,
  };
  base.expected = expected;

  if (!ctx.reviewed) {
    return { ...base, state: 'CONTEXT_UNREVIEWED', severity: 'warn',
      headline: 'Ticket context not yet reviewed',
      sub: `${expected.ticketKey || 'This context'} hasn't been reviewed on the Initialize tab yet.` };
  }
  if (!expected.experimentId) {
    return { ...base, state: 'NO_EXPERIMENT_ID', severity: 'warn',
      headline: 'No experiment ID on this ticket',
      sub: `The Initialize tab found no Platform Experiment ID for ${expected.ticketKey || 'this ticket'}.` };
  }
  if (settings.watch === false) {
    return { ...base, state: 'WATCH_OFF', severity: 'idle',
      headline: 'Watching is off',
      sub: `Flip the switch above to watch this page for experiment ${expected.experimentId}.` };
  }
  if (!status || status.tabId == null) {
    return { ...base, state: 'NO_TAB', severity: 'idle',
      headline: 'No page to watch',
      sub: 'Focus a normal http(s) tab in this window.' };
  }
  if (status.error === 'not-probeable') {
    return { ...base, state: 'TAB_NOT_PROBEABLE', severity: 'idle',
      headline: "This tab can't be probed",
      sub: 'chrome://, the PDF viewer, and other extension pages can’t be read — switch to a normal http(s) page.' };
  }
  if (!status.probe) {
    return { ...base, state: 'NEVER_PROBED', severity: 'idle',
      headline: 'Waiting for a probe…',
      sub: status.error ? `Last attempt failed: ${status.error}` : '' };
  }

  const probe = status.probe;
  base.staleMs = status.probedAt ? Math.max(0, Date.now() - status.probedAt) : null;

  if (ctx.platform && probe.platform && probe.platform !== 'both') {
    const wants = String(ctx.platform).toLowerCase();
    if (wants && wants !== probe.platform) {
      const running = probe.platform === 'optimizely' ? 'Optimizely' : 'Convert';
      base.notes.push(`Ticket says ${ctx.platform}, but this page is running ${running}.`);
    }
  }

  const anyDetected = !!(probe.detected?.optimizely || probe.detected?.convert);
  const hasForcedParam = !!(probe.forced?.optimizely_x || probe.forced?.conv_eforce);

  if (!anyDetected && !probe.detected?.convertScript) {
    if (hasForcedParam) {
      return { ...base, state: 'FORCED_PARAM_ONLY', severity: 'err',
        headline: 'URL forces a variation, but no snippet is on this page',
        sub: 'The experiment is not running here — this page never loaded Optimizely or Convert.' };
    }
    return { ...base, state: 'SNIPPET_NOT_DETECTED', severity: 'err',
      headline: 'No experimentation snippet detected',
      sub: 'Neither Optimizely nor Convert appears to be running on this page.' };
  }
  if (probe.detected?.convertScript && !probe.detected?.convert) {
    return { ...base, state: 'SNIPPET_INITIALIZING', severity: 'idle',
      headline: 'Snippet loading…',
      sub: 'Convert is on the page but hasn’t initialized yet — try Refresh in a moment.' };
  }

  const row = (probe.experiments || []).find((e) => String(e.id) === expected.experimentId) || null;
  // Every OTHER experiment the probe found running on this page — not just
  // ones this visitor happens to be bucketed into. A QA needs to know about
  // a live collision even when they were excluded from it (audience,
  // holdback, mutual exclusion) just as much as when they were bucketed.
  base.others = (probe.experiments || [])
    .filter((e) => e.active && String(e.id) !== expected.experimentId)
    .map((e) => ({ id: e.id, name: e.name, bucketed: e.bucketed, variationId: e.variationId, variationName: e.variationName }));

  // Ticket-declared dependencies (Softcoded/Concurrent Tests) — cross-
  // referenced by name against the same live catalog, independent of
  // whether the primary experiment itself resolved cleanly below.
  base.softcoded  = expEvaluateRelated(ctx.softcodedTests, probe);
  base.concurrent = expEvaluateRelated(ctx.concurrentTests, probe);

  if (!row) {
    if (probe.catalogComplete) {
      return { ...base, state: 'EXPERIMENT_NOT_IN_SNIPPET', severity: 'err',
        headline: `Experiment ${expected.experimentId} not found on this page`,
        sub: 'The snippet’s full catalog was read and this id isn’t in it — wrong site/environment, or unpublished.' };
    }
    return { ...base, state: 'EXPERIMENT_UNKNOWN', severity: 'warn',
      headline: `Can't confirm experiment ${expected.experimentId}`,
      sub: 'The platform’s catalog couldn’t be fully read, so its absence here doesn’t prove it isn’t running.' };
  }

  if (row.known && !row.active && !row.bucketed) {
    return { ...base, state: 'EXPERIMENT_NOT_RUNNING', severity: 'warn',
      headline: `${row.name || expected.experimentId} is not running`,
      sub: row.reason ? `Platform reason: ${row.reason}` : 'The experiment exists but isn’t active on this page.' };
  }
  if (row.active && !row.bucketed) {
    return { ...base, state: 'NOT_BUCKETED', severity: 'warn',
      headline: `${row.name || expected.experimentId} is running, but this visitor isn't bucketed`,
      sub: row.reason ? `Reason: ${row.reason}` : 'Excluded by audience, holdback, or traffic allocation.' };
  }

  // Bucketed — resolve the native variation id back to the ticket's v0/v1.
  const { map: labelMap, notes: mapNotes } = expBuildLabelMap(ctx);
  base.notes = base.notes.concat(mapNotes);
  const mapped = expLabelFor(row.variationId, row, ctx, labelMap);
  const actual = {
    experimentId: row.id, experimentName: row.name || null,
    variationId: row.variationId, variationName: row.variationName || null,
    label: mapped?.label || null, labelSource: mapped?.source || null,
    rawDescription: mapped?.rawDescription || null,
  };
  base.actual = actual;

  const forcedVarId = probe.forced?.optimizely_x
    || (probe.forced?.conv_eforce ? probe.forced.conv_eforce.slice(probe.forced.conv_eforce.lastIndexOf('.') + 1) : null);
  if (forcedVarId && String(forcedVarId) !== String(row.variationId)) {
    const forcedLabel = expLabelFor(forcedVarId, row, ctx, labelMap);
    return { ...base, state: 'EXPECTED_MISMATCH', severity: 'err',
      headline: `Forced ${forcedLabel?.label || forcedVarId} but showing ${actual.label || actual.variationId}`,
      sub: 'The URL asked for a specific variation and the page is showing a different one.' };
  }

  if (!mapped) {
    return { ...base, state: 'BUCKETED_UNMAPPED', severity: 'warn',
      headline: `Bucketed into ${row.variationName || row.variationId}`,
      sub: 'Couldn’t match this native variation id back to the ticket’s v0/v1 labels.' };
  }

  return { ...base, state: 'BUCKETED', severity: 'ok',
    headline: `Bucketed into ${mapped.label} — ${row.variationName || row.variationId}`,
    sub: `${probe.platform === 'convert' ? 'Convert' : 'Optimizely'} · exp ${row.id} · var ${row.variationId}` };
}

// ── Rendering ────────────────────────────────────────────────────────────────
// DOM writes only. All text goes through textContent (auto-escaping) except
// the notes list, which is the one innerHTML rebuild — esc()'d per line and
// holding no focusable inputs, the same split mtRenderCounts/mtRenderRows use.
// Renders one ticket-declared dependency list (Softcoded or Concurrent) —
// the header stays outside this function's reach (static markup) so only the
// rows div is ever rebuilt.
function expRenderRelatedList(wrapId, hostId, list) {
  const wrap = document.getElementById(wrapId);
  const host = document.getElementById(hostId);
  if (!wrap || !host) return;
  if (!list || !list.length) { wrap.style.display = 'none'; host.innerHTML = ''; return; }
  wrap.style.display = '';
  host.innerHTML = list.map((r) => {
    const status = !r.found ? 'not detected on page'
      : r.bucketed ? (r.variationName || r.variationId)
      : r.active ? 'running, not bucketed'
      : 'not active';
    const cls = !r.found ? 'exp-rel-miss' : r.bucketed ? 'exp-rel-hit' : 'exp-rel-warn';
    return `<div class="exp-rel-row ${cls}">
      <span class="exp-rel-lbl">${esc(r.ticketKey || r.label || '—')}</span>
      <span class="exp-rel-v">${esc(status)}</span>
    </div>`;
  }).join('');
}

function expRender() {
  const card = document.getElementById('exp-card');
  if (!card) return;
  const v = expEvaluate(expStatus, expCtx, expSettings);

  card.classList.remove('exp-ok', 'exp-warn', 'exp-err', 'exp-idle');
  card.classList.add('exp-' + v.severity);

  const dot = document.getElementById('exp-dot');
  if (dot) dot.style.display = v.severity === 'ok' ? '' : 'none';

  const headline = document.getElementById('exp-headline');
  if (headline) headline.textContent = v.headline;
  const sub = document.getElementById('exp-sub');
  if (sub) sub.textContent = v.sub || '';

  const expectedV = document.getElementById('exp-expected-v');
  if (expectedV) {
    const e = v.expected;
    expectedV.textContent = e ? ([e.ticketKey, e.platform, e.experimentId].filter(Boolean).join(' · ') || '—') : '—';
  }

  const actualV = document.getElementById('exp-actual-v');
  if (actualV) {
    const a = v.actual;
    actualV.textContent = a ? [a.label, a.variationName || a.variationId || '—'].filter(Boolean).join(' — ') : '—';
  }
  const actualSrc = document.getElementById('exp-actual-src');
  if (actualSrc) {
    const source = v.actual?.labelSource;
    if (source) {
      actualSrc.style.display = '';
      actualSrc.textContent = source === 'preview-link' ? 'via preview link' : 'via order (unverified)';
      actualSrc.classList.toggle('exp-src-weak', source === 'ordinal');
    } else {
      actualSrc.style.display = 'none';
    }
  }

  const desc = document.getElementById('exp-desc');
  if (desc) {
    if (v.actual?.rawDescription) { desc.style.display = ''; desc.textContent = v.actual.rawDescription; }
    else { desc.style.display = 'none'; desc.textContent = ''; }
  }

  const notesHost = document.getElementById('exp-notes');
  if (notesHost) {
    const notes = (v.notes || []).slice();
    // One line per other live experiment — bucketed ones name the variation;
    // ones this visitor was excluded from say so, since "running but I'm not
    // in it" is exactly as important a collision to know about as being in it.
    for (const o of (v.others || [])) {
      const label = o.name || o.id;
      notes.push(o.bucketed
        ? `Also running: ${label} → ${o.variationName || o.variationId}`
        : `Also running: ${label} (not bucketed)`);
    }
    notesHost.innerHTML = notes.map((n) => `<div class="exp-note">${esc(n)}</div>`).join('');
  }

  const staleEl = document.getElementById('exp-stale');
  if (staleEl) {
    if (v.staleMs != null && v.staleMs > 8000) {
      staleEl.style.display = '';
      staleEl.textContent = `As of ${Math.round(v.staleMs / 1000)}s ago — waiting for a fresh read.`;
    } else {
      staleEl.style.display = 'none';
      staleEl.textContent = '';
    }
  }

  expRenderRelatedList('exp-softcoded-wrap', 'exp-softcoded', v.softcoded);
  expRenderRelatedList('exp-concurrent-wrap', 'exp-concurrent', v.concurrent);
}

// ── Row mutations ────────────────────────────────────────────────────────
function mtAddRow() {
  const id = mtNewId();
  metrics.push({ id, label: '', pattern: '', mode: 'smart', convertMetricId: null, enabled: true, source: 'manual', reviewed: true, createdAt: Date.now() });
  mtSyncAfterListChange();
  document.querySelector(`#mt-list input[data-mt-pattern="${id}"]`)?.focus();
}

function onMtRowInput(e) {
  const id = e.target?.dataset?.mtPattern;
  if (id === undefined) return;
  const m = metrics.find((x) => x.id === id);
  if (!m) return;
  m.pattern = e.target.value;
  mtValidateRow(id);
  mtSyncAfterListChange('mt');
}

function onMtRowChange(e) {
  const toggleId = e.target?.dataset?.mtToggle;
  if (toggleId !== undefined) {
    const m = metrics.find((x) => x.id === toggleId);
    if (m) { m.enabled = e.target.checked; mtSyncAfterListChange(); }
    return;
  }
  const modeId = e.target?.dataset?.mtMode;
  if (modeId !== undefined) {
    const m = metrics.find((x) => x.id === modeId);
    if (m) { m.mode = e.target.value; mtValidateRow(modeId); mtSyncAfterListChange(); }
  }
}

function onMtRowClick(e) {
  const confirmBtn = e.target.closest('[data-mt-confirm]');
  if (confirmBtn) {
    const m = metrics.find((x) => x.id === confirmBtn.dataset.mtConfirm);
    if (m) { m.reviewed = true; mtSyncAfterListChange(); }
    return;
  }
  const btn = e.target.closest('[data-mt-remove]');
  if (!btn) return;
  const i = metrics.findIndex((x) => x.id === btn.dataset.mtRemove);
  if (i < 0) return;
  metrics.splice(i, 1);
  mtSyncAfterListChange();
}

// ── Reset / Remove All ───────────────────────────────────────────────────
// No confirm: session-scoped, non-destructive, regenerates immediately — a
// confirm on a button pressed repeatedly during a QA pass is pure friction.
async function mtResetCounts() {
  const btn = document.getElementById('btn-mt-reset');
  if (btn) btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'mtReset', winId: WIN_ID });
    _mtCountsKey = '';
    mtCounts = {};
    mtRenderCounts();
    if (btn) {
      btn.textContent = 'Counts reset';
      setTimeout(() => { btn.textContent = 'Reset Counts'; }, 1200);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Confirm naming the blast radius — this empties the Functional Testing
// tab's Metrics section too, and every Track Metric step loses its
// selection. Matches the clearSteps confirm precedent.
function mtRemoveAll() {
  if (!metrics.length) return;
  if (!confirm(
    `Remove all ${metrics.length} metric${metrics.length === 1 ? '' : 's'}?\n\n` +
    `This is the same list the Functional Testing tab's Metrics section uses — ` +
    `it will be emptied there too, and any "Track Metric" queue steps will lose ` +
    `their selection.\n\nCounts are cleared as well.`
  )) return;
  metrics = [];
  mtSyncAfterListChange();
  chrome.runtime.sendMessage({ action: 'mtReset', winId: WIN_ID }).then(() => {
    _mtCountsKey = '';
    mtCounts = {};
    mtRenderCounts();
  });
}
