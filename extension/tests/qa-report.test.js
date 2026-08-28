// QA report rendering suite — what the printed/shared report actually shows.
//
//   RUN:  cd extension/tests && jsc qa-report.test.js
//   (jsc ships with macOS at
//    /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
//    — add it to PATH or invoke by full path.)
//
// Same standing as vd-diff.test.js and figma.test.js: NOT wired into
// .github/workflows/run-tests.yml, which runs pytest against a `tests/`
// directory this repo does not have. The Python backend is out of scope.
//
// This suite exists because of one measured failure, not a hypothetical. Two
// runs of ENOC-97 (OnDeck) taken 106 seconds apart produced byte-identical
// deterministic diff output — 85 control / 140 variant elements, 34 matched
// pairs, matchedFraction 0.24285714285714285, pixelDiff 0.6694682506079291,
// the same seven region rollups with the same rects — and DIFFERENT grades:
//
//   run 1: expected ×7
//   run 2: expected ×5, unclear ×2  (regions `main` and `footer`)
//
// The report used to collapse every "expected" finding into a closed
// <details>, so run 1 rendered a PASS with all seven findings behind one
// triangle — including a footer that matched 11/11 against a ticket asking for
// new disclaimer copy, which run 2 surfaced as a question. Sampling variance
// cannot be tuned away here: `temperature` is not a parameter on
// claude-opus-5 (removed across the current family, returns 400). So the
// invariant this suite protects is that the grade decides ORDER and LABEL,
// never VISIBILITY.
//
// Findings below are wire-shaped (controlBlock/variantBlock), the shape
// vdFindingToWire emits and the renderer consumes — NOT the flattened
// controlRect/controlText shape the debug log stores. Getting that wrong makes
// every rect assertion silently exercise the no-rect branch and pass for the
// wrong reason.

var _pu = readFile('../popup.js');
function slicePopup(from, to) {
  var a = _pu.indexOf(from), b = _pu.indexOf(to, a + 1);
  if (a === -1 || b === -1) throw new Error('slice marker missing: ' + from);
  return _pu.slice(a, b);
}
// Sliced, not copied, so renaming any of these breaks the suite loudly rather
// than leaving it to test a stale duplicate.
eval(slicePopup('function esc(s) {', '\nfunction '));
eval(slicePopup('function rptBadge(kind, label) {', 'function rptAgenticNoteHtml('));
eval(slicePopup('function rptAbVisualDiffSection(vd) {', '\nfunction rptWcagSection('));
var abState = { qaMode: false };

// ── harness ────────────────────────────────────────────────────────────────
var pass = 0, fail = 0, failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function eq(name, actual, expected) { ok(name, actual === expected, { actual: actual, expected: expected }); }
function section(t) { print('\n' + t); }

// A region rollup as the wire adapter emits one: no text on either side, a
// union box per side, engineNote carrying the whole of its content.
var _fid = 0;
function rollup(region, grade, opts) {
  opts = opts || {};
  var block = function (rect) {
    return rect ? { type: 'region', label: region, text: null, rect: rect, rectSource: 'region-union' } : null;
  };
  return {
    findingId: 'f' + (_fid++), changeClass: 'region-rollup', status: 'modified',
    classification: grade, severity: grade === 'expected' ? null : 'low',
    region: region, synthetic: true, changeSignals: ['region-rollup'],
    controlBlock: block(opts.controlRect || { x: 695, y: 187, w: 1296, h: 3105 }),
    variantBlock: 'variantRect' in opts ? block(opts.variantRect) : block({ x: 80, y: 178, w: 2526, h: 5195 }),
    engineNote: region + ': 11 elements in Control, 11 in Variant, 11 matched.',
    note: opts.note || (region + ' rollup note'),
  };
}
function render(findings, over) {
  return rptAbVisualDiffSection(Object.assign({
    baselineLabel: 'v0', sharedFindings: [],
    perVariant: [Object.assign({
      label: 'v1', findings: findings, diffMode: 'redesign', matchedFraction: 0.243,
      overallSummary: 'A full landing-page rebuild.',
      structuralStats: { addedCount: 106, removedCount: 51, modifiedCount: 1, styleChangedCount: 11, unchangedCount: 0 },
      matchTierCounts: { 'path+text': 23, stableId: 5, text: 6 },
      aggregate: { reflow: 23, reflowPxMax: 2108 },
    }, (over || {}).variant || {})],
  }, (over || {}).vd || {}));
}
function rowCount(h) { return h.split('class="ab-line"').length - 1; }
function chipCount(h) { return (h.match(/text-transform:uppercase/g) || []).length; }

// ── 1. the grade must not gate visibility ──────────────────────────────────
section('grade decides order and label, never visibility');

// The exact run-1 shape: everything graded expected. This is the case that
// used to render as a single closed triangle.
(function allExpected() {
  var h = render(['section', 'form', 'main', 'nav#menu-footer', 'nav#menu-awards', 'footer', 'nav#menu-social']
    .map(function (r) { return rollup(r, 'expected'); }));
  ok('7/7 expected: no <details> gate', h.indexOf('<details') === -1);
  eq('7/7 expected: all seven render as rows', rowCount(h), 7);
  eq('7/7 expected: all seven carry a grade chip', chipCount(h), 7);
  ok('7/7 expected: the reader is told the grade is unstable',
     h.indexOf('move between runs') !== -1);
})();

// The run-2 shape over the SAME findings. What renders must not change.
(function twoUnclear() {
  var regions = ['section', 'form', 'main', 'nav#menu-footer', 'nav#menu-awards', 'footer', 'nav#menu-social'];
  var run1 = render(regions.map(function (r) { return rollup(r, 'expected'); }));
  var run2 = render(regions.map(function (r) {
    return rollup(r, (r === 'main' || r === 'footer') ? 'unclear' : 'expected');
  }));
  eq('regrading two findings does not change how many render', rowCount(run2), rowCount(run1));
  eq('regrading two findings does not change how many are labelled', chipCount(run2), chipCount(run1));
  // The rects a reader can see are the subject of each row. Identical diff
  // output must present identical subjects regardless of grade.
  function subjects(h) {
    var out = [], re = /near \((-?\d+), (-?\d+)\), (\d+)×(\d+)px/g, m;
    while ((m = re.exec(h))) out.push(m[1] + ',' + m[2] + ' ' + m[3] + 'x' + m[4]);
    return out.sort().join(' | ');
  }
  ok('identical diff output renders identical subjects under either grading',
     subjects(run1) === subjects(run2) && subjects(run1).length > 0,
     { run1: subjects(run1), run2: subjects(run2) });
  ok('the two gradings really do differ (else the assertions above prove nothing)',
     run1 !== run2);
})();

// ── 2. the grade is still visible, and still orders the list ───────────────
section('grade is still reported');

// Parse the grade chips out in document order rather than string-matching their
// closing tags — the chip's contents grew a severity suffix once severity
// started rendering, and three assertions here were pinned to `grade</span>`.
function chipTexts(h) {
  var out = [], re = /letter-spacing:\.03em;[^>]*>([^<]*)<\/span>/g, m;
  while ((m = re.exec(h))) out.push(m[1]);
  return out;
}

(function gradeStillShown() {
  var h = render([rollup('section', 'unexpected'), rollup('main', 'unclear'), rollup('footer', 'expected')]);
  var chips = chipTexts(h);
  eq('one chip per finding', chips.length, 3);
  // Severity-first reading order: unexpected, then unclear, then expected. The
  // chip text carries the grade and, for the two non-expected kinds, a severity.
  eq('rows are ordered unexpected -> unclear -> expected',
     chips.map(function (c) { return c.split(' \u00b7 ')[0]; }).join(','),
     'unexpected,unclear,expected');
})();

(function severityIsShown() {
  // severity was computed by the model, exported to the debug log, and rendered
  // nowhere — the only per-finding urgency signal the pipeline produces, thrown
  // away. It is shown but never sorted on: runs 5 and 6 of ENOC-97 returned
  // `low` then `medium` for the same finding from a byte-identical prompt.
  var chips = chipTexts(render([rollup('main', 'unclear'), rollup('footer', 'expected')]));
  eq('an unclear finding shows its severity beside the grade', chips[0], 'unclear \u00b7 low');
  eq('an expected finding shows no severity (the model emits null there)', chips[1], 'expected');
  // A junk severity must not reach the page, and must not cost the grade.
  var bad = rollup('main', 'unclear');
  bad.severity = 'catastrophic';
  eq('an unrecognized severity is dropped, grade still shown', chipTexts(render([bad]))[0], 'unclear');
  var none = rollup('main', 'unclear');
  none.severity = null;
  eq('a missing severity is dropped, grade still shown', chipTexts(render([none]))[0], 'unclear');
  ok('the honesty line now covers severity too',
     render([rollup('footer', 'expected')]).indexOf('severity are model judgments') !== -1);
})();

(function ungradedFindingStillRenders() {
  // Found by this suite: the three-bucket filter dropped anything that was
  // not exactly unexpected/unclear/expected, so a finding the model returned
  // no usable verdict for vanished from the report — while v.noVerdictCount
  // went on telling the reader it existed. The chip is what goes missing on
  // an ungraded finding, not the row.
  var f = rollup('section', null);
  f.classification = null;
  var h = render([f]);
  eq('an ungraded finding still renders', rowCount(h), 1);
  eq('an ungraded finding gets no chip', chipCount(h), 0);
  ok('an ungraded finding is called unjudged, not cleared',
     h.indexOf('unjudged, not cleared') !== -1);
  // A junk grade must take the same path as a missing one, not be trusted.
  var g = rollup('form', 'expected');
  g.classification = 'probably-fine';
  eq('an unrecognized grade still renders', rowCount(render([g])), 1);
})();

// ── 3. a rollup with one side missing still anchors ────────────────────────
section('one-sided rollups');

(function missingVariantSide() {
  // ENOC-97's `main` rollup had variantRect null — the region emptied out.
  // It must still render with the control-side rect as its anchor.
  var h = render([rollup('main', 'unclear', { controlRect: { x: 719, y: 1203, w: 1248, h: 136 }, variantRect: null })]);
  eq('a rollup with no variant side still renders', rowCount(h), 1);
  ok('it anchors on the control rect', h.indexOf('719, 1203') !== -1);
})();

// ── 4. suppression disclosure survives ─────────────────────────────────────
section('suppression disclosure');

(function suppressionLine() {
  var h = render([rollup('section', 'expected')]);
  ok('reflow suppression is still disclosed', h.indexOf('23 suppressed as page reflow') !== -1);
  ok('and names the largest shift', h.indexOf('2108px') !== -1);
})();

// ── 4b. redesign mode's two tiers must be distinguishable ──────────────────
section('region rollups vs itemised findings');

// An element-level finding as vdFindingToWire emits one for an added/removed
// element — the tier redesign mode used to withhold entirely.
function element(status, region, label, opts) {
  opts = opts || {};
  var side = status === 'removed' ? 'controlBlock' : 'variantBlock';
  var f = {
    findingId: 'e' + (_fid++), changeClass: status, status: status,
    classification: opts.grade || 'unclear', severity: opts.grade === 'expected' ? null : 'low',
    region: region, changeSignals: [status], memberCount: opts.memberCount || null,
    note: label + ' was ' + status,
    controlBlock: null, variantBlock: null,
  };
  f[side] = { type: 'paragraph', label: label, text: label, rect: opts.rect || { x: 700, y: 900, w: 400, h: 40 } };
  return f;
}

(function rollupLabelledRegionNotOther() {
  // A rollup fell through findingType's chain to 'other', which is why a real
  // redesign report read "Other main —" for a whole-region summary. With both
  // tiers now in one report that label had to stop being a catch-all.
  var h = render([rollup('main', 'unclear'), element('added', 'main', 'Trust Stats Bar')]);
  var kinds = [];
  var re = /class="ab-delta">([^<]*)</g, m;
  while ((m = re.exec(h))) kinds.push(m[1]);
  eq('two findings, two type labels', kinds.length, 2);
  eq('the rollup is labelled region', kinds[0], 'region');
  eq('the element keeps its own type', kinds[1], 'added');
  ok('neither is the "other" catch-all', kinds.indexOf('other') === -1, kinds);
})();

(function bothTiersRender() {
  // The regression this guards: redesign mode reporting rollups only.
  var findings = [rollup('section', 'expected'), rollup('footer', 'expected')]
    .concat([element('added', 'section', 'Testimonial 1', { grade: 'expected' }),
             element('removed', 'main', '185K+ Businesses funded', { grade: 'expected' }),
             element('added', 'section', 'Feature grid', { grade: 'expected', memberCount: 6 })]);
  var h = render(findings);
  eq('all five render', h.split('class="ab-line"').length - 1, 5);
  var kinds = [];
  var re = /class="ab-delta">([^<]*)</g, m;
  while ((m = re.exec(h))) kinds.push(m[1]);
  eq('rollups precede the itemised findings within a grade bucket',
     kinds.join(','), 'region,region,added,removed,added');
})();

// ── 5. the debug export must carry the spec, not just its size ─────────────
section('debug export records the spec text');

eval(slicePopup('function buildDesignReferenceDebug(ctx, state, hasFigmaPat) {', '\nfunction '));

(function specTextRecorded() {
  // Every expected/unexpected verdict is relative to this string, and both
  // model calls quote it back as justification. Recording only its length
  // meant a claim like "the ticket specifies updated disclaimer footnotes"
  // could not be checked against anything — which is exactly what happened
  // when the two ENOC-97 runs made opposite claims about the footer.
  var spec = 'Rebuild the hero. Update the \u2020/*/** disclaimer footnotes in the footer.';
  var d = buildDesignReferenceDebug(null, { summaryOfChanges: spec, summarySource: 'ticket' }, false);
  eq('the spec text is recorded verbatim', d.summaryOfChanges.text, spec);
  eq('length still agrees with the text', d.summaryOfChanges.length, spec.length);
  eq('source is still recorded', d.summaryOfChanges.source, 'ticket');
  ok('present is still true', d.summaryOfChanges.present === true);
})();

(function specProvenanceRecorded() {
  // `source: 'ticket'` was true and useless — it never said WHICH ticket, and
  // the Summary of Changes box persists across ticket switches. Run
  // 1787945015802 graded 61 of 67 findings "unexpected" on ENOC-97 against a
  // Zapier contact-sales form spec because of exactly that gap.
  var d = buildDesignReferenceDebug(null, {
    summaryOfChanges: 'Rebuild the hero.', summarySource: 'ticket', summaryTicketKey: 'ENOC-97',
  }, false);
  eq('the auto-filling ticket is recorded', d.summaryOfChanges.ticketKey, 'ENOC-97');
  var typed = buildDesignReferenceDebug(null, {
    summaryOfChanges: 'Typed by hand.', summarySource: 'manual', summaryTicketKey: null,
  }, false);
  eq('hand-typed text records no ticket', typed.summaryOfChanges.ticketKey, null);
  var legacy = buildDesignReferenceDebug(null, {
    summaryOfChanges: 'From before provenance existed.', summarySource: 'ticket',
  }, false);
  eq('state persisted before this existed records null, not undefined',
     legacy.summaryOfChanges.ticketKey, null);
  var none = buildDesignReferenceDebug(null, { summaryOfChanges: '   ' }, false);
  eq('no spec records no ticket', none.summaryOfChanges.ticketKey, null);
})();

(function noSpecRecordsNull() {
  var d = buildDesignReferenceDebug(null, { summaryOfChanges: '   ' }, false);
  eq('an empty spec records null rather than an empty string', d.summaryOfChanges.text, null);
  eq('and is not marked present', d.summaryOfChanges.present, false);
  eq('and reports zero length', d.summaryOfChanges.length, 0);
})();

// ── report ─────────────────────────────────────────────────────────────────
print('\n' + (fail ? 'FAILURES:\n  - ' + failures.join('\n  - ') + '\n' : '') +
      '=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail) throw new Error(fail + ' assertion(s) failed');
