// Renders the Test Agent "Selenite QA Report" in its own bundled extension page.
// runTestAgent stashes the report body under chrome.storage.session['taReports'][id]
// and opens qa-report.html?k=<id>; this script reads it back and injects it.
// Bundled (script-src 'self') so it satisfies the MV3 extension-page CSP — an
// inline <script>, an inline onclick, or a blob: page would not. Deliberately a
// sibling of report.js (Matrix Auditor) rather than shared: the two reports
// have distinct .rpt-* CSS shells living in their own HTML files.
(async () => {
  const content = document.getElementById('qa-report-content');
  const printBtn = document.getElementById('qa-print-btn');
  const debugBtn = document.getElementById('qa-debug-btn');
  const debugNote = document.getElementById('qa-debug-note');
  printBtn?.addEventListener('click', () => window.print());

  // A closed <details> prints CLOSED — its content is simply absent from the
  // PDF. The Visual Diff section files every "expected" finding into one, so a
  // report whose spec text is working (and where most differences therefore
  // grade as expected) printed with the majority of its findings and all their
  // crop images missing. Observed on a real ENOC-97 run: 6 of 7 findings
  // invisible in the exported PDF.
  //
  // Collapsing is right on screen — expected differences are the noise a
  // reviewer skims past. It is wrong on paper, where there is nothing to click
  // and the reader cannot tell anything was omitted. So: open everything for
  // the print, restore exactly what the reader had afterwards.
  //
  // Done in JS rather than CSS because a closed <details> hides its children
  // through UA behaviour that `display: block` does not reliably override
  // across print paths, and a half-working override would fail silently in the
  // same way this bug did.
  let reopened = [];
  window.addEventListener('beforeprint', () => {
    reopened = [...document.querySelectorAll('details:not([open])')];
    reopened.forEach(d => { d.open = true; });
  });
  window.addEventListener('afterprint', () => {
    reopened.forEach(d => { d.open = false; });
    reopened = [];
  });

  const id = new URLSearchParams(location.search).get('k');
  if (!id) {
    content.innerHTML = '<p class="rpt-muted">No report id in the URL.</p>';
    return;
  }
  try {
    const { taReports = {} } = await chrome.storage.session.get('taReports');
    const report = taReports[id];
    if (!report) {
      content.innerHTML = '<p class="rpt-muted">Report data not found — it may have expired (only the most recent few are kept). Re-run the Test Agent to generate a fresh report.</p>';
      return;
    }
    if (report.title) document.title = report.title;
    content.innerHTML = report.bodyHtml || '';

    // The debug log is a separate download rather than a section in the page:
    // it's JSON meant to be attached to a bug report or diffed between runs,
    // and it must not print. A blob + <a download> works here without the
    // "downloads" permission because this is a normal extension page.
    if (report.debugLog) {
      const problems = report.debugLog.problems || [];
      const errors = problems.filter(p => p.severity === 'error').length;
      const warns = problems.filter(p => p.severity === 'warn').length;
      debugNote.textContent = problems.length
        ? `Debug log: ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`
        : 'Debug log: nothing degraded this run';
      debugBtn.disabled = false;
      debugBtn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(report.debugLog, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `selenite-debug-${id}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke on the next tick, not synchronously — Chrome needs the URL
        // to still resolve while it starts the download.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
    } else {
      debugNote.textContent = 'No debug log recorded for this report.';
    }
  } catch (e) {
    content.innerHTML = '<p class="rpt-muted">Could not load report: ' + (e && e.message ? e.message : String(e)) + '</p>';
  }
})();
