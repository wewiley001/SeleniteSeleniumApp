// Visual Diff regression suite — deterministic matching/diffing engine plus the
// debug-log diagnostics built on top of it.
//
//   RUN:  cd extension/tests && jsc vd-diff.test.js
//   (jsc ships with macOS at
//    /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
//    — add it to PATH or invoke by full path.)
//
// NOT wired into .github/workflows/run-tests.yml, which runs pytest against a
// `tests/` directory that does not exist in this repo. Left alone deliberately:
// the Python backend is out of scope for extension work.
//
// Every assertion below traces to a REAL failure observed on a real page, not to
// a hypothetical. The comments name which one, because that is the difference
// between a test that gets maintained and a test that gets deleted as noise:
//
//   * reflow bands overlapping in y collapsed shift segmentation into untrusted
//     singletons (97 segments / 95 untrusted), leaking ~49 pure-reflow elements
//     per variant as false "moved" findings.
//   * horizontal shifts were assumed not to cascade; a wrapping template-link
//     grid re-flowed twelve chips by ~126px and reported each one separately.
//   * captures were never pinned to a common viewport — Control at 1693px vs
//     variants at 1470px silently invalidated an entire run while still
//     reporting a tidy two-finding result.
//   * React 19 useId values (`_R_84qnmlb_-MCP`, `_r_5_-MCP`) were accepted as
//     stable ids and used as structural path ANCHORS, poisoning the path key for
//     everything beneath them.
//   * the DOM walk was clamped to the screenshot's 8000px ceiling, so 60% of a
//     19845px page was never walked on either side and nothing below the fold
//     could be reported at all.
//
// vd-diff.js is loaded directly; the two functions that live in popup.js and
// background.js are sliced out of those files rather than copied, so this suite
// exercises the real shipping code and breaks loudly if either is renamed.

load('../vd-config.js');
load('../vd-diff.js');

var _pu = readFile('../popup.js');
eval(_pu.slice(_pu.indexOf('function vdCollectProblems(sections)'),
                _pu.indexOf('function buildDebugLog(sections)')));
// Control-vs-Control detectors and shared-finding extraction, sliced from the
// pipeline they guard.
eval(_pu.slice(_pu.indexOf('function vdFindingIdentity(f)'),
                _pu.indexOf('async function runVisualDiffPipeline')));
eval(_pu.slice(_pu.indexOf('function vdNormalizeTargetUrl(u)'),
                _pu.indexOf('function vdFindingIdentity(f)')));

var _bg = readFile('../background.js');
eval(_bg.slice(_bg.indexOf('const VD_DEBUG_SAMPLE_CAP'),
                _bg.indexOf('// ── Visual Diff Stage 3')));

// The two pixel-dependent stages, sliced out for the below-capture guards.
// Stubs stand in for the browser-only bits they call.
var VIS_BLOCK_PIXEL_MIN_AREA = 400, VIS_CROP_PAD = 12;
function pixelmatch() { throw new Error('pixelmatch should not be reached in these tests'); }
function clampBox(box, w, h) {
  var x = Math.max(0, Math.min(box.x, w)), y = Math.max(0, Math.min(box.y, h));
  return { x: x, y: y, w: Math.max(0, Math.min(box.w, w - x)), h: Math.max(0, Math.min(box.h, h - y)) };
}
function cropAndDownscale() { return 'data:image/png;base64,STUB'; }
eval(_bg.slice(_bg.indexOf('function vdPixelCheckMatchedPairs'),
                _bg.indexOf('// ── Visual Diff: coarse pixel-similarity backstop') !== -1
                  ? _bg.indexOf('// ── Visual Diff: coarse pixel-similarity backstop')
                  : _bg.indexOf('\n// ──', _bg.indexOf('function vdPixelCheckMatchedPairs'))));
eval(_bg.slice(_bg.indexOf('function cropVisualDiffBlock'),
                _bg.indexOf('\n// ──', _bg.indexOf('function cropVisualDiffBlock'))));

// ── harness ────────────────────────────────────────────────────────────────
var pass = 0, fail = 0, failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, { actual: actual, expected: expected });
}
function section(t) { print('\n' + t); }

// Builds a candidate record the way domCandidateWalkFn does, so hashes and
// normalization come from the real helpers rather than being hand-faked.
var _id = 0;
function cand(o) {
  var raw = o.text || '';
  var norm = vdNormText(raw);
  return {
    candidateId: o.id || ('c' + (_id++)),
    tag: o.tag || 'p',
    rect: { x: o.x || 0, y: o.y || 0, w: o.w || 300, h: o.h || 40 },
    text: raw, textNorm: norm,
    textHash: vdHash32(norm), shapeHash: vdHash32(vdTextShape(norm)),
    path: o.path || ('/body[1]/main[1]/' + (o.tag || 'p') + '[1]'),
    ppath: o.ppath || '/body[1]/main[1]',
    region: o.region || 'main',
    inLiveRegion: !!o.inLiveRegion,
    attrs: {
      role: o.role || null, ariaLabel: o.ariaLabel || null, alt: o.alt || null,
      href: o.href || null, testid: o.testid || null,
    },
    stableId: o.rawId && vdIsStableId(o.rawId) ? o.rawId : null,
    hrefKey: o.href ? vdNormalizeHref(o.href, 'https://example.com') : null,
    styles: Object.assign({
      display: 'block', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
      backgroundImage: null, border: null, boxShadow: null, opacity: null,
      fontSize: '16px', fontWeight: '400', fontFamily: 'Arial',
      textAlign: 'left', textDecorationLine: 'none', borderRadius: null,
      visibility: 'visible',
    }, o.styles || {}),
  };
}

// ── 1. framework-generated ids must never anchor a path ────────────────────
section('framework id rejection (vdIsStableId)');
[ '_R_84qnmlb_-MCP', '_r_5_-MCP', '_R_1_', '_r_2h_',   // React 19 — both seen live
  ':r3h:', '«r0»',                            // React 18 / legacy
  'radix-:r3h:', 'headlessui-menu-button-3', 'ember1234',
  'react-aria-123', 'mui-12', 'chakra-modal-1', 'mantine-abc',
  'field-99999', 'a:b',
].forEach(function (id) { ok('rejects generated id ' + id, !vdIsStableId(id)); });

[ 'main', 'hero', 'nav-primary', 'site-footer', 'pricing_table',
  'signup-form', 'cta2', 'section-3', '_internal-hero',
].forEach(function (id) { ok('accepts authored id ' + id, vdIsStableId(id)); });

// ── 2. normalization ladder ────────────────────────────────────────────────
section('text normalization');
function sameNorm(a, b) { return vdNormText(a) === vdNormText(b); }
ok('em dash vs period',        sameNorm('Save time — fast', 'Save time. fast'));
ok('pipes vs middots',         sameNorm('A | B | C', 'A · B · C'));
ok('newline vs space',         sameNorm('Two\nlines', 'Two lines'));
ok('bang vs question',         sameNorm('Really!', 'Really?'));
ok('curly vs straight quote',  sameNorm('it’s', "it's"));
ok('thousands separator',      sameNorm('$1,000', '$1000'));
ok('real copy change survives', !sameNorm('Buy Now', 'Add to Cart'));
ok('digit change survives',    !sameNorm('6,000+ apps', '6,500+ apps'));
ok('numeric shape folds digits',
   vdTextShape(vdNormText('6,000+ apps')) === vdTextShape(vdNormText('6,500+ apps')));
ok('shape keeps words distinct',
   vdTextShape(vdNormText('6,000 apps')) !== vdTextShape(vdNormText('6,000 users')));

// ── 3. identity matching ───────────────────────────────────────────────────
section('matching');
(function identicalPages() {
  var a = [cand({ text: 'One', y: 0 }), cand({ text: 'Two', y: 50 })];
  var b = a.map(function (c) { return Object.assign({}, c); });
  var m = vdMatchCandidates(a, b);
  eq('identical pages: all matched', m.pairs.length, 2);
  eq('identical pages: nothing removed', m.removed.length, 0);
  eq('identical pages: nothing added', m.added.length, 0);
  var s = vdSuppressFindings(m.pairs);
  eq('identical pages: no reportable findings',
     s.findings.filter(function (f) { return f.changeClass !== 'unchanged'; }).length, 0);
})();

(function wrapperInsertion() {
  // THE load-bearing case. A <div> inserted as body's first child shifts every
  // structural path, so path-based matching cannot help — text identity must
  // carry it. If this regresses, every copy change on a restructured page
  // becomes a false remove+add pair.
  var a = [], b = [];
  for (var i = 0; i < 8; i++) {
    a.push(cand({ text: 'Row ' + i, y: i * 60, path: '/body[1]/div[' + (i + 1) + ']' }));
    b.push(cand({ text: 'Row ' + i, y: i * 60, path: '/body[1]/div[' + (i + 2) + ']' }));
  }
  var m = vdMatchCandidates(a, b);
  eq('wrapper insertion: everything still pairs', m.pairs.length, 8);
  eq('wrapper insertion: no phantom removals', m.removed.length, 0);
  eq('wrapper insertion: no phantom additions', m.added.length, 0);
})();

(function pathOnlyMustNotMisfire() {
  // Text-identity passes MUST run before path-only. Run the other way round,
  // path-only confidently pairs an element with whatever unrelated content now
  // occupies its old slot instead of failing cleanly.
  var a = [cand({ text: 'Alpha', y: 0, path: '/body[1]/p[1]' }),
           cand({ text: 'Beta',  y: 50, path: '/body[1]/p[2]' })];
  var b = [cand({ text: 'Inserted', y: 0,  path: '/body[1]/p[1]' }),
           cand({ text: 'Alpha',    y: 50, path: '/body[1]/p[2]' }),
           cand({ text: 'Beta',     y: 100, path: '/body[1]/p[3]' })];
  var m = vdMatchCandidates(a, b);
  var alpha = m.pairs.filter(function (p) { return p.a.text === 'Alpha'; })[0];
  var beta  = m.pairs.filter(function (p) { return p.a.text === 'Beta'; })[0];
  ok('shifted sibling: Alpha pairs with Alpha', alpha && alpha.b.text === 'Alpha',
     alpha && alpha.b.text);
  ok('shifted sibling: Beta pairs with Beta', beta && beta.b.text === 'Beta',
     beta && beta.b.text);
  eq('shifted sibling: only the new element is added', m.added.length, 1);
  eq('shifted sibling: nothing reported removed', m.removed.length, 0);
})();

(function generatedIdDoesNotSplit() {
  // Same element, regenerated React id between captures — must still pair.
  var a = [cand({ text: 'MCP', tag: 'button', rawId: '_R_84qnmlb_-MCP', y: 100 })];
  var b = [cand({ text: 'MCP', tag: 'button', rawId: '_r_5_-MCP', y: 100 })];
  ok('generated id is not promoted to stableId', a[0].stableId === null && b[0].stableId === null);
  var m = vdMatchCandidates(a, b);
  eq('regenerated id: still one pair', m.pairs.length, 1);
  eq('regenerated id: no add/remove', m.removed.length + m.added.length, 0);
})();

(function duplicateLinks() {
  var a = [], b = [];
  for (var i = 0; i < 12; i++) {
    a.push(cand({ text: 'Learn more', tag: 'a', href: '/x', y: i * 40, path: '/body[1]/a[' + (i + 1) + ']' }));
  }
  for (var j = 0; j < 11; j++) {
    b.push(cand({ text: 'Learn more', tag: 'a', href: '/x', y: j * 40, path: '/body[1]/a[' + (j + 1) + ']' }));
  }
  var m = vdMatchCandidates(a, b);
  eq('12 identical links, one gone: exactly one removed', m.removed.length, 1);
  eq('12 identical links, one gone: nothing added', m.added.length, 0);
})();

(function copyRewriteInPlace() {
  var a = [cand({ text: 'Buy Now', tag: 'h1', y: 0, path: '/body[1]/h1[1]' })];
  var b = [cand({ text: 'Add to Cart', tag: 'h1', y: 0, path: '/body[1]/h1[1]' })];
  var m = vdMatchCandidates(a, b);
  eq('copy rewrite: one pair, not remove+add', m.pairs.length, 1);
  eq('copy rewrite: matched on path', m.pairs[0].tier, 'path');
  var s = vdSuppressFindings(m.pairs);
  eq('copy rewrite: reported as text-changed', s.findings[0].changeClass, 'text-changed');
})();

// ── 4. reflow suppression — the cascade bug ─────────────────────────────────
section('reflow clustering');
(function overlappingBands() {
  // Three shift amounts whose y-ranges OVERLAP — the shape that collapsed the
  // old position-first segmentation into 97 segments / 95 untrusted singletons.
  var samples = [];
  for (var y = 2000; y < 6000; y += 100) samples.push({ pos: y, delta: -35 });
  for (var y2 = 3000; y2 < 7000; y2 += 100) samples.push({ pos: y2, delta: -68 });
  for (var y3 = 3500; y3 < 6500; y3 += 100) samples.push({ pos: y3, delta: -58 });

  var cl = vdClusterShifts(samples, VD_SHIFT_TOL_PX, VD_SHIFT_MIN_RUN);
  eq('overlapping bands collapse to one cluster per amount', cl.length, 3);
  ok('every cluster is trusted', cl.every(function (c) { return c.trusted; }),
     cl.map(function (c) { return [c.delta, c.count, c.trusted]; }));

  var leaked = samples.filter(function (s) {
    return !vdExplainsShift(cl, s.pos, s.delta, VD_SHIFT_TOL_PX);
  }).length;
  eq('no pure-reflow element leaks', leaked, 0);

  ok('a shift with no band is NOT explained',
     !vdExplainsShift(cl, 4000, -400, VD_SHIFT_TOL_PX));
  ok('a band far from this element does NOT explain it',
     !vdExplainsShift(cl, 100, -68, VD_SHIFT_TOL_PX));
})();

(function horizontalCascade() {
  // A wrapping link grid re-flows horizontally when one chip is removed. The
  // original design assumed horizontal shifts don't cascade.
  var xs = [];
  for (var k = 0; k < 12; k++) xs.push({ pos: 100 + k * 200, delta: 126 });
  for (var k2 = 0; k2 < 12; k2++) xs.push({ pos: 100 + k2 * 200, delta: -123 });
  var xcl = vdClusterShifts(xs, VD_SHIFT_TOL_PX, VD_SHIFT_MIN_RUN);
  eq('horizontal: two trusted bands', xcl.filter(function (c) { return c.trusted; }).length, 2);
  eq('horizontal: nothing leaks',
     xs.filter(function (s) { return !vdExplainsShift(xcl, s.pos, s.delta, VD_SHIFT_TOL_PX); }).length, 0);
})();

(function shiftSegmentsWrapperShape() {
  var segs = vdDeriveShiftSegments(
    [{ y: 100, dy: -20 }, { y: 200, dy: -20 }, { y: 300, dy: -20 }],
    VD_SHIFT_TOL_PX, VD_SHIFT_MIN_RUN);
  eq('vdDeriveShiftSegments keeps its {y0,y1,dy} shape', segs.length, 1);
  eq('  dy carried', segs[0].dy, -20);
  ok('  trusted at three members', segs[0].trusted);
})();

// ── 5. suppression decisions ────────────────────────────────────────────────
section('suppression');
(function punctuationAndNumeric() {
  var a = [cand({ text: 'Save time — fast', y: 0, path: '/p[1]' }),
           cand({ text: '6,000+ apps', y: 100, path: '/p[2]', inLiveRegion: true })];
  var b = [cand({ text: 'Save time. fast', y: 0, path: '/p[1]' }),
           cand({ text: '6,500+ apps', y: 100, path: '/p[2]', inLiveRegion: true })];
  var m = vdMatchCandidates(a, b);
  var s = vdSuppressFindings(m.pairs);
  eq('punctuation-only suppressed', s.aggregate.punctuationOnly, 1);
  eq('live-region counter suppressed', s.aggregate.numericOnly, 1);
  eq('nothing reported', s.findings.length, 0);

  var s2 = vdSuppressFindings(m.pairs, { suppressPunctuation: false, suppressNumeric: false });
  ok('flipping the config makes both report', s2.findings.length === 2,
     s2.findings.map(function (f) { return f.changeClass; }));
})();

(function styleDeltaNamesProperty() {
  var a = [cand({ text: 'Claude', tag: 'button', y: 0, path: '/button[1]' })];
  var b = [cand({ text: 'Claude', tag: 'button', y: 0, path: '/button[1]',
                  styles: { color: 'rgb(255, 0, 0)', fontWeight: '700' } })];
  var m = vdMatchCandidates(a, b);
  var s = vdSuppressFindings(m.pairs);
  eq('style change reported', s.findings.length, 1);
  eq('  classified style-changed', s.findings[0].changeClass, 'style-changed');
  ok('  names the changed properties',
     s.findings[0].signals.indexOf('style:color') !== -1 &&
     s.findings[0].signals.indexOf('style:fontWeight') !== -1, s.findings[0].signals);
})();

(function rogueMoveSurvives() {
  // A trusted reflow band exists, and one element moves against it.
  var a = [], b = [];
  for (var i = 0; i < 10; i++) {
    a.push(cand({ text: 'Row ' + i, y: 1000 + i * 100, path: '/p[' + i + ']' }));
    b.push(cand({ text: 'Row ' + i, y: 1000 + i * 100 - 50, path: '/p[' + i + ']' }));
  }
  a.push(cand({ text: 'Rogue', y: 3000, path: '/p[rogue]' }));
  b.push(cand({ text: 'Rogue', y: 3400, path: '/p[rogue]' }));
  var m = vdMatchCandidates(a, b);
  var s = vdSuppressFindings(m.pairs);
  eq('the reflow band is suppressed', s.aggregate.reflow, 10);
  var moved = s.findings.filter(function (f) { return f.changeClass === 'moved'; });
  eq('the rogue move is reported', moved.length, 1);
  eq('  and it is the right element', moved[0].a.text, 'Rogue');
})();

// ── 6. grouping / rollup / ranking ─────────────────────────────────────────
section('grouping, rollup, ranking');
(function grouping() {
  function f(y, cls, region) {
    return { changeClass: cls, a: cand({ y: y, region: region }), b: cand({ y: y, region: region }) };
  }
  var grouped = vdGroupFindings([f(100, 'text-changed', 'main'), f(120, 'text-changed', 'main'),
                                 f(140, 'text-changed', 'main'), f(900, 'text-changed', 'main')]);
  eq('near findings merge, distant one stays separate', grouped.length, 2);
  var merged = grouped.filter(function (g) { return g.memberCount; })[0];
  eq('  merged group has three members', merged.memberCount, 3);

  var across = vdGroupFindings([f(100, 'text-changed', 'header'), f(110, 'text-changed', 'footer')]);
  eq('never merges across regions', across.length, 2);

  var kinds = vdGroupFindings([f(100, 'text-changed', 'main'), f(110, 'style-changed', 'main')]);
  eq('never merges different change classes', kinds.length, 2);
})();

(function redesignMode() {
  // Distinct paths as well as distinct text — a real wholesale redesign changes
  // both. (Leaving the default shared path would make all 40 a single
  // duplicate-key group with equal counts on each side, which the path tier
  // then legitimately pairs in document order.)
  var a = [], b = [];
  for (var i = 0; i < 40; i++) a.push(cand({ text: 'control only ' + i, y: i * 50, region: 'main', path: '/old[' + i + ']' }));
  for (var j = 0; j < 40; j++) b.push(cand({ text: 'variant only ' + j, y: j * 50, region: 'main', path: '/new[' + j + ']' }));
  var m = vdMatchCandidates(a, b);
  eq('wholesale replacement detected as redesign', m.mode, 'redesign');
  var rolled = vdRollupByRegion(m, a, b);
  ok('rolled up per region, not per element', rolled.length < 5, rolled.length);
  ok('  rollup carries counts', rolled[0].controlCount > 0 && rolled[0].variantCount > 0);
  ok('  samples capped at five', rolled.every(function (r) { return r.samples.length <= 5; }));
})();

(function ranking() {
  var watched = [{ x: 0, y: 5000, w: 200, h: 50 }];
  var many = [];
  for (var i = 0; i < 80; i++) {
    many.push({ changeClass: 'style-changed', a: cand({ y: i * 10, text: 'x' }), b: cand({ y: i * 10, text: 'x' }) });
  }
  many.push({ changeClass: 'style-changed', a: cand({ y: 5000, x: 0, text: 'watched thing' }),
              b: cand({ y: 5000, x: 0, text: 'watched thing' }) });
  var r = rankAndCapDiffFindings(many, { watchedRects: watched });
  eq('caps to the configured maximum', r.kept.length, VD_MAX_DIFF_FINDINGS);
  ok('a watched-selector overlap ranks first',
     r.kept[0].a && r.kept[0].a.text === 'watched thing', r.kept[0].a && r.kept[0].a.text);
  ok('reports what it dropped', r.truncatedCount > 0);

  var unchangedOnly = rankAndCapDiffFindings([{ changeClass: 'unchanged', a: cand({}), b: cand({}) }]);
  eq('unchanged findings never surface', unchangedOnly.kept.length, 0);
})();

// ── 7. end-to-end, built from the real page's measured shape ────────────────
section('end-to-end (Zapier shape)');
(function endToEnd() {
  var ctrl = [], vari = [], n = 0;
  function pair(o, vOverride) {
    var c = cand(Object.assign({ id: 'e' + (n++) }, o));
    ctrl.push(c);
    if (vOverride !== null) vari.push(cand(Object.assign({ id: c.candidateId }, o, vOverride || {})));
  }
  // the real copy change
  pair({ y: 300, tag: 'h1', text: 'The automation layer for agentic AI', w: 700, h: 60, path: '/h1[1]' },
       { text: 'Actions speak louder than prompts' });
  pair({ y: 380, text: 'One MCP connection. 9,000+ apps.', w: 700, h: 80, path: '/p[hero]' },
       { text: "Use Zapier's AI-powered automation to take real action." });
  // unmoved content above
  for (var i = 0; i < 25; i++) pair({ y: 100 + i * 4, text: 'Nav item ' + i, w: 100, h: 30, path: '/nav[' + i + ']' });
  // an eyebrow label removed -> -35 cascade below it
  pair({ y: 4000, text: 'Customer stories', w: 200, h: 35, path: '/p[eyebrow]' }, null);
  for (var j = 0; j < 60; j++) {
    pair({ y: 4100 + j * 60, text: 'Story body line ' + j, w: 600, h: 50, path: '/p[s' + j + ']' },
         { y: 4100 + j * 60 - 35 });
  }
  // stat counters in the SAME y band shifting a DIFFERENT amount
  for (var k = 0; k < 20; k++) {
    pair({ y: 4500 + k * 80, text: 'stat ' + k, w: 120, h: 60, x: 400, path: '/div[c' + k + ']' },
         { y: 4500 + k * 80 - 68 });
  }
  for (var q = 0; q < 8; q++) {
    pair({ y: 5000 + q * 100, text: 'Attribution line ' + q, w: 400, h: 40, path: '/div[a' + q + ']' },
         { y: 5000 + q * 100 - 58 });
  }
  // wrapping grid: one link removed, rows re-wrap horizontally
  for (var g = 0; g < 12; g++) {
    pair({ y: 7000, x: 100 + g * 200, tag: 'a', text: 'Template A' + g, href: '/t/a' + g, w: 180, h: 60, path: '/a[A' + g + ']' },
         { x: 100 + g * 200 + 126 });
  }
  for (var h = 0; h < 12; h++) {
    pair({ y: 7100, x: 100 + h * 200, tag: 'a', text: 'Template B' + h, href: '/t/b' + h, w: 180, h: 60, path: '/a[B' + h + ']' },
         { x: 100 + h * 200 - 123 });
  }
  pair({ y: 7200, x: 500, tag: 'a', text: 'Generate posts', href: '/t/gen', w: 180, h: 60, path: '/a[gen]' }, null);
  vari.push(cand({ id: 'eNEW', y: 7200, x: 900, tag: 'a', text: 'See more templates', href: '/templates', w: 180, h: 60, path: '/a[more]' }));
  // one genuine rogue move
  pair({ y: 6000, text: 'Moved on its own', w: 300, h: 40, path: '/p[rogue]' }, { y: 6400 });

  var m = vdMatchCandidates(ctrl, vari);
  var s = vdSuppressFindings(m.pairs);
  var all = s.findings.concat(
    m.removed.map(function (c) { return { changeClass: 'removed', a: c, b: null }; }),
    m.added.map(function (c) { return { changeClass: 'added', a: null, b: c }; }));
  var reportable = vdGroupFindings(all).filter(function (f) { return f.changeClass !== 'unchanged'; });

  eq('normal mode, not redesign', m.mode, 'normal');
  ok('vertical reflow suppressed in bulk', s.aggregate.reflow >= 100, s.aggregate.reflow);
  ok('findings collapse to single digits', reportable.length < 10, reportable.length);

  function has(pred) {
    return reportable.some(function (f) {
      return (f.members || [f]).some(pred);
    });
  }
  ok('hero copy change is reported',
     has(function (f) { return f.a && /automation layer/.test(f.a.text); }));
  ok('the removed eyebrow is reported',
     has(function (f) { return f.changeClass === 'removed' && f.a && /Customer stories/.test(f.a.text); }));
  ok('the added link is reported',
     has(function (f) { return f.changeClass === 'added' && f.b && /See more templates/.test(f.b.text); }));
  ok('the rogue move survives suppression',
     has(function (f) { return f.a && f.a.text === 'Moved on its own'; }));
})();

// ── 8. debug log diagnostics ───────────────────────────────────────────────
section('debug log');
function abSections(captures, perVariant) {
  return { ts: 1756000000000, pageUrls: [], modes: [{
    mode: 2, name: 'A/B Variant Comparison', status: 'ran',
    data: { captures: captures, visualDiffFull: { baselineLabel: 'v0', perVariant: perVariant } },
  }] };
}
function capture(label, o) {
  return { label: label, url: 'https://example.com', skipped: false, loadError: null,
           errors: o.errors || [], selectors: o.selectors || [],
           fullPage: o.fullPage === undefined
             ? { pageW: 1470, pageH: 9000, capturedH: 8000, truncated: true, viewportH: 802, viewportW: 1470 }
             : o.fullPage };
}

(function designReferenceDiagnostics() {
  // Two real debugging rounds were spent on the WOW-1160 runs because the
  // debug log said "no Summary of Changes" without saying WHY, and the three
  // causes need three different fixes. Each is asserted to name its own cause.
  function withDr(dr) {
    var base = abSections([capture('v0', {}), capture('v1', {})],
      [{ label: 'v1', diffMode: 'normal', matchedFraction: 0.84, structuralStats: {} }]);
    base.designReference = dr;
    return vdCollectProblems(base);
  }
  var empty = { present: false, length: 0, source: null };
  var noFigma = { urlUsed: null, urlFromTicket: null, nodeId: null, tokenConfigured: false, comp: null, compCandidateCount: 0 };

  // Cause 1 — no ticket at all.
  ok('no context names the missing context', withDr({
    ticketContext: null, summaryOfChanges: empty, figma: noFigma,
  }).some(function (x) { return x.severity === 'error' && /No ticket context was active/.test(x.detail); }));

  // Cause 2 — the one the real runs hit: context present and reviewed, but
  // its variants carry no descriptions, so the auto-fill had nothing to write.
  // Indistinguishable from cause 1 without this.
  var p2 = withDr({
    ticketContext: { ticketKey: 'WOW-1160', reviewed: true, variantCount: 2, variantsWithDescription: 0,
      controlVariantId: null, variantIds: ['v0', 'v1'], previewLinkCount: 0, previewLinkIds: [] },
    summaryOfChanges: empty, figma: noFigma,
  });
  ok('empty descriptions are named as the cause', p2.some(function (x) {
    return x.severity === 'error' && /parsed 2 variant\(s\) but none carry a description/.test(x.detail);
  }), p2);
  ok('missing Control variant is its own warning', p2.some(function (x) {
    return x.severity === 'warn' && /no variant flagged as Control/.test(x.detail);
  }), p2);

  // The case WOW-1160 actually hit: zero variants, but preview links present.
  // Zero-variants and zero-descriptions are different failures with different
  // fixes, and saying "none of its 0 variants carry a description" describes
  // neither.
  var pz = withDr({
    ticketContext: { ticketKey: 'WOW-1160', reviewed: true, variantCount: 0, variantsWithDescription: 0,
      controlVariantId: null, variantIds: [], previewLinkCount: 2, previewLinkIds: ['v0', 'v1'] },
    summaryOfChanges: empty, figma: noFigma,
  });
  ok('zero variants is named as zero, not as "no descriptions"', pz.some(function (x) {
    return x.severity === 'error' && /NO variants were parsed/.test(x.detail) && /2 preview link\(s\) were found/.test(x.detail);
  }), pz);
  ok('links-without-variants localises the fault to Test Specifications', pz.some(function (x) {
    return x.where === 'ticket-context' && /points at that section specifically/.test(x.detail);
  }), pz);
  // One cause, one line: the Control warning would just restate it.
  ok('no redundant Control warning when nothing parsed', !pz.some(function (x) {
    return /no variant flagged as Control/.test(x.detail);
  }), pz);
  ok('missing preview links is its own warning', p2.some(function (x) {
    return x.severity === 'warn' && /no preview links/.test(x.detail);
  }), p2);

  // A filled box records its SOURCE — the whole report is graded against it,
  // and once the text is in the box there is no other way to tell whether a
  // human wrote it or a model did.
  var p3 = withDr({
    ticketContext: { ticketKey: 'WOW-1160', reviewed: true, variantCount: 2, variantsWithDescription: 2,
      controlVariantId: 'v0', variantIds: ['v0', 'v1'], previewLinkCount: 2, previewLinkIds: ['v0', 'v1'] },
    summaryOfChanges: { present: true, length: 140, source: 'ticket' }, figma: noFigma,
  });
  ok('spec source is recorded', p3.some(function (x) { return /came from: ticket/.test(x.detail); }), p3);
  ok('a healthy context raises no context warnings',
    !p3.some(function (x) { return x.where === 'ticket-context'; }), p3);

  // Figma present-but-unusable is worth saying; Figma absent is silent.
  ok('figma link without a token warns', withDr({
    ticketContext: null, summaryOfChanges: empty,
    figma: { urlUsed: null, urlFromTicket: 'https://figma.com/design/A/B?node-id=1-2', nodeId: '1:2',
      tokenConfigured: false, comp: null, compCandidateCount: 0 },
  }).some(function (x) { return x.severity === 'warn' && /no Figma token is configured/.test(x.detail); }));

  ok('bare file link warns', withDr({
    ticketContext: null, summaryOfChanges: empty,
    figma: { urlUsed: null, urlFromTicket: 'https://figma.com/design/A/B', nodeId: null,
      tokenConfigured: true, comp: null, compCandidateCount: 0 },
  }).some(function (x) { return /whole file rather than a specific board/.test(x.detail); }));

  ok('no figma at all stays silent', !withDr({
    ticketContext: null, summaryOfChanges: empty, figma: noFigma,
  }).some(function (x) { return x.where === 'design-reference'; }));

  // Absent block must not throw — Test-Agent-queued runs don't build one.
  ok('missing designReference is tolerated', Array.isArray(vdCollectProblems(
    abSections([capture('v0', {})], [{ label: 'v1', diffMode: 'normal', structuralStats: {} }]))));
})();

(function geometryValidator() {
  // validateVisualDiffGeometry did not exist until 2026-08-27, despite a
  // comment in background.js asserting it was the backstop. The check that DID
  // exist compared pageW against pageW — the same wrong quantity on both sides,
  // structurally unable to see a viewport mismatch.
  function cap(label, fp) { return { label: label, fullPage: fp }; }
  var ok_ = { pageW: 1470, pageH: 9000, viewportW: 1470, viewportH: 802 };

  eq('matching geometry yields nothing',
    validateVisualDiffGeometry([cap('v0', ok_), cap('v1', ok_)], 'v0').length, 0);

  var w = validateVisualDiffGeometry(
    [cap('v0', { pageW: 1693, viewportW: 1693, viewportH: 1281 }),
     cap('v1', { pageW: 1470, viewportW: 1470, viewportH: 1281 })], 'v0');
  eq('viewport width mismatch is one error', w.length, 1);
  eq('...at error severity', w[0].severity, 'error');
  eq('...naming the field', w[0].field, 'viewportW');

  var h = validateVisualDiffGeometry(
    [cap('v0', { pageW: 1470, viewportW: 1470, viewportH: 1281 }),
     cap('v1', { pageW: 1470, viewportW: 1470, viewportH: 802 })], 'v0');
  eq('viewport height mismatch is caught too', h.length, 1);
  eq('...at error severity', h[0].severity, 'error');

  // Same viewport, wider content. Probably a REAL difference rather than an
  // invalid comparison — so warn, don't error. But say the pixel ratio is
  // unusable, because computeCoarsePixelDiffRatio crops to the narrower image
  // with no alignment.
  var c = validateVisualDiffGeometry(
    [cap('v0', { pageW: 1470, viewportW: 1470, viewportH: 802 }),
     cap('v1', { pageW: 1600, viewportW: 1470, viewportH: 802 })], 'v0');
  eq('content-width difference at same viewport is a WARN', c[0].severity, 'warn');
  ok('...and says the pixel ratio is unusable', /unusable/.test(c[0].detail), c);

  // Old captures have no viewportW. Say they could not be checked rather than
  // passing them silently — a silent pass is what the pageW check did.
  var legacy = validateVisualDiffGeometry(
    [cap('v0', { pageW: 1470, viewportH: 802 }), cap('v1', { pageW: 1470, viewportH: 802 })], 'v0');
  eq('captures without viewportW report info, not silence', legacy[0].severity, 'info');

  // The baseline is whichever label is named, not index 0.
  var reordered = validateVisualDiffGeometry(
    [cap('v1', { pageW: 1470, viewportW: 1470, viewportH: 802 }),
     cap('v0', { pageW: 1470, viewportW: 1693, viewportH: 802 })], 'v0');
  eq('baseline resolved by label, not position', reordered[0].label, 'v1');
  eq('...and compared against v0 geometry', reordered[0].baseline, 1693);

  // Degenerate inputs must not throw — this runs inside vdCollectProblems.
  eq('single capture yields nothing', validateVisualDiffGeometry([cap('v0', ok_)], 'v0').length, 0);
  eq('empty yields nothing', validateVisualDiffGeometry([], 'v0').length, 0);
  eq('null yields nothing', validateVisualDiffGeometry(null, 'v0').length, 0);
  eq('errored captures are excluded',
    validateVisualDiffGeometry([cap('v0', ok_), { label: 'v1', fullPage: { error: 'boom' } }], 'v0').length, 0);
})();

(function geometryMismatch() {
  // The silent run-invalidating failure: Control and variants at different widths.
  var p = vdCollectProblems(abSections([
    capture('v0', { fullPage: { pageW: 1693, pageH: 14201, capturedH: 8000, truncated: true, viewportH: 1281, viewportW: 1693 } }),
    capture('v1', { fullPage: { pageW: 1470, pageH: 15500, capturedH: 8000, truncated: true, viewportH: 802, viewportW: 1470 } }),
  ], [{ label: 'v1', diffMode: 'redesign', matchedFraction: 0.124, structuralStats: {} }]));

  ok('viewport width mismatch is an ERROR', p.some(function (x) {
    return x.severity === 'error' && /1470px viewport width but the baseline/.test(x.detail);
  }), p);
  // Height matters as much as width and used to go entirely unchecked: vh
  // sizing, sticky elements and viewport-triggered lazy loads all resolve
  // differently at 1281 vs 802.
  ok('viewport height mismatch is its own ERROR', p.some(function (x) {
    return x.severity === 'error' && /Viewport height 802px vs the baseline's 1281px/.test(x.detail);
  }), p);
  ok('redesign verdict is blamed on the geometry', p.some(function (x) {
    return /most likely the capture-width mismatch/.test(x.detail);
  }), p);
  // Truncation is a VISUAL limit only, now that the DOM walk covers the full
  // page — the wording must not claim the bottom went uncompared.
  ok('truncation names the fraction with no image', p.some(function (x) {
    return /there is no image/.test(x.detail) && /%/.test(x.detail);
  }), p.map(function (x) { return x.detail; }));
  ok('truncation does NOT claim the page went uncompared', !p.some(function (x) {
    return /never compared/.test(x.detail);
  }));
})();

(function geometryClean() {
  var p = vdCollectProblems(abSections([
    capture('v0', {}), capture('v1', {}),
  ], [{ label: 'v1', structuralStats: {} }]));
  ok('matching widths produce no geometry error',
     !p.some(function (x) { return /wide but the baseline/.test(x.detail); }));
})();

(function pinFailure() {
  var p = vdCollectProblems(abSections([
    capture('v0', {}),
    capture('v1', { fullPage: { pageW: 1470, pageH: 9000, capturedH: 8000, truncated: true, viewportH: 802, geometryPinFailed: 'Emulation not allowed' } }),
  ], []));
  ok('a failed geometry pin is an ERROR', p.some(function (x) {
    return x.severity === 'error' && /Could not pin/.test(x.detail);
  }));
})();

(function hardErrorsVsPageIssues() {
  var p = vdCollectProblems(abSections([
    capture('v0', { errors: ['Script error.'], selectors: [{ selector: '.missing', exists: false }] }),
  ], [{ label: 'v1', noSpecText: true, structuralStats: {} }]));
  ok('a page JS error stays a warning, not an error',
     p.some(function (x) { return x.severity === 'warn' && /Script error/.test(x.detail); }) &&
     !p.some(function (x) { return x.severity === 'error'; }), p.map(function (x) { return x.severity; }));
  ok('a never-matching watched selector is surfaced',
     p.some(function (x) { return /Selector never matched: \.missing/.test(x.detail); }));
  ok('a missing spec is surfaced as info',
     p.some(function (x) { return x.severity === 'info' && /No Summary of Changes/.test(x.detail); }));

  var hard = vdCollectProblems({ ts: 1, modes: [{ mode: 2, name: 'A/B', status: 'ran', data: {
    captures: [{ label: 'v1', url: 'u', loadError: 'Page load timed out after 30s', errors: [], selectors: [] },
               { label: 'v2', url: 'u', errors: [], selectors: [], fullPage: { error: 'Could not attach for capture' } }],
    visualDiffFull: { baselineLabel: 'v0', perVariant: [{ label: 'v3', truncated: true, structuralStats: {} }] } } }] });
  ok('a load failure IS an error', hard.some(function (x) { return x.severity === 'error' && /timed out/.test(x.detail); }));
  ok('a capture failure IS an error', hard.some(function (x) { return x.severity === 'error' && /Could not attach/.test(x.detail); }));
  ok('a cut-off model response IS an error', hard.some(function (x) { return x.severity === 'error' && /cut off/.test(x.detail); }));
})();

(function cascadeSignature() {
  // 30 elements each "moved" by the same amount with no trusted band to explain
  // it — the fingerprint of reflow suppression under-matching.
  var moved = [];
  for (var i = 0; i < 30; i++) {
    moved.push({ changeClass: 'moved', dy: -35, dx: 0,
                 a: cand({ y: 4000 + i * 50, text: 'row ' + i }),
                 b: cand({ y: 3965 + i * 50, text: 'row ' + i }) });
  }
  var dbg = buildVisualDiffDebug({
    match: { pairs: [{ tier: 'path+text' }], removed: [], added: [], mode: 'normal', matchedFraction: 0.98 },
    matchTierCounts: { 'path+text': 270, path: 2 },
    all: moved.concat([{ changeClass: 'text-changed', dy: 0, dx: 0, a: cand({ text: 'a' }), b: cand({ text: 'b' }) }]),
    shiftClusters: { vertical: [{ delta: -68, p0: 5000, p1: 7000, count: 5, trusted: true }], horizontal: [] },
    aggregate: { reflow: 180, reflowPxMax: 68, reflowHorizontal: 0, punctuationOnly: 0, numericOnly: 0 },
    truncatedCount: 0,
  });
  eq('movesByDelta aggregates the cascade', dbg.movesByDelta['dy=-35,dx=0'], 30);
  eq('classCounts computed', dbg.classCounts.moved, 30);
  eq('matchTierCounts carried', dbg.matchTierCounts['path+text'], 270);
  ok('shiftClusters preserved for cross-reference', dbg.shiftClusters.vertical.length === 1);
  ok('unsuppressedMoves carry geometry',
     dbg.unsuppressedMoves.length === 30 && dbg.unsuppressedMoves[0].control.rect);
  ok('sample lists are capped', dbg.unsuppressedMoves.length <= 40);

  var p = vdCollectProblems(abSections([capture('v0', {}), capture('v1', {})],
    [{ label: 'v1', diffDebug: dbg, structuralStats: {} }]));
  ok('the un-explained cascade is NAMED in plain language', p.some(function (x) {
    return /30 elements were each reported as moved by the same amount/.test(x.detail);
  }), p.map(function (x) { return x.detail; }));

  // and the inverse: a properly-explained band must not be flagged
  var good = buildVisualDiffDebug({
    match: { pairs: [], removed: [], added: [], mode: 'normal', matchedFraction: 0.99 },
    matchTierCounts: { 'path+text': 300 }, all: [],
    shiftClusters: { vertical: [{ delta: -35, p0: 4000, p1: 7000, count: 40, trusted: true }], horizontal: [] },
    aggregate: { reflow: 200, reflowPxMax: 35 }, truncatedCount: 0,
  });
  var pg = vdCollectProblems(abSections([capture('v0', {}), capture('v1', {})],
    [{ label: 'v1', diffDebug: good, structuralStats: {} }]));
  ok('a clean run raises no cascade warning',
     !pg.some(function (x) { return /reported as moved by the same amount/.test(x.detail); }));
})();

(function capAndBelowCaptureSurfaced() {
  var dbg = buildVisualDiffDebug({
    match: { pairs: [], removed: [], added: [], mode: 'normal', matchedFraction: 0.9 },
    matchTierCounts: {}, all: [], shiftClusters: { vertical: [], horizontal: [] },
    aggregate: {}, truncatedCount: 0,
  });
  dbg.counts.controlElements = 3000;          // walk hit its ceiling
  dbg.belowCapture = { control: 320, variant: 311, findings: 2 };
  var p = vdCollectProblems(abSections([capture('v0', {}), capture('v1', {})],
    [{ label: 'v1', diffDebug: dbg, structuralStats: {} }]));
  ok('hitting the candidate ceiling is surfaced', p.some(function (x) {
    return /candidate ceiling/.test(x.detail);
  }), p.map(function (x) { return x.detail; }));
  ok('below-capture coverage is reported as coverage first', p.some(function (x) {
    return x.severity === 'info' && /320 of 3000 elements sit below/.test(x.detail);
  }), p.map(function (x) { return x.detail; }));

  // Below-capture elements with NO findings must not read as a problem.
  var quiet = vdCollectProblems(abSections([capture('v0', {}), capture('v1', {})],
    [{ label: 'v1', structuralStats: {}, diffDebug: Object.assign({}, dbg, {
        counts: { controlElements: 521 }, belowCapture: { control: 320, variant: 311, findings: 0 } }) }]));
  ok('zero below-capture findings says so explicitly', quiet.some(function (x) {
    return /no findings came from there/.test(x.detail);
  }), quiet.map(function (x) { return x.detail; }));
})();

(function belowCaptureCounterExcludesUnchanged() {
  // The counter must count REPORTABLE findings only. Counting unchanged pairs
  // made it read 281 on a variant whose real answer was 2, purely because a
  // page-wide 4px shift left every pair sitting in the set as 'unchanged'
  // instead of being suppressed as reflow.
  var deep = function (t) { return Object.assign(cand({ text: t, y: 12000 }), { belowCapture: true }); };
  var all = [];
  for (var i = 0; i < 279; i++) all.push({ changeClass: 'unchanged', a: deep('same ' + i), b: deep('same ' + i) });
  all.push({ changeClass: 'removed', a: deep('Repurpose content'), b: null });
  all.push({ changeClass: 'text-changed', a: deep('old'), b: deep('new') });

  var dbg = buildVisualDiffDebug({
    match: { pairs: [], removed: [], added: [], mode: 'normal', matchedFraction: 0.99 },
    matchTierCounts: {}, all: all, shiftClusters: { vertical: [], horizontal: [] },
    aggregate: {}, truncatedCount: 0,
  });
  eq('counts reportable findings, not unchanged pairs', dbg.belowCapture.findings, 2);
})();

(function fuzzySurfaced() {
  var dbg = buildVisualDiffDebug({
    match: { pairs: [], removed: [], added: [], mode: 'normal', matchedFraction: 0.9 },
    matchTierCounts: { fuzzy: 7 }, all: [], shiftClusters: { vertical: [], horizontal: [] },
    aggregate: {}, truncatedCount: 0,
  });
  var p = vdCollectProblems(abSections([capture('v0', {}), capture('v1', {})],
    [{ label: 'v1', diffDebug: dbg, structuralStats: {} }]));
  ok('approximate pairings are surfaced as a caveat',
     p.some(function (x) { return /paired by approximate similarity/.test(x.detail); }));
})();

// ── 8b. full-page coverage past the screenshot limit ───────────────────────
section('below-capture coverage');
(function belowCaptureStillDiffs() {
  // Control is scanned in its entirety; the screenshot stops at 8000px. A copy
  // change and a removed element BELOW that line must still be found — that is
  // 60% of a real 19845px page which previously could not be reported at all.
  var a = [
    cand({ text: 'Above the line', y: 500, path: '/p[1]' }),
    cand({ text: 'Old headline down low', tag: 'h2', y: 12000, path: '/h2[deep]' }),
    cand({ text: 'Footer button', tag: 'button', y: 15000, path: '/button[deep]' }),
  ];
  a[1].belowCapture = true; a[2].belowCapture = true;
  var b = [
    cand({ text: 'Above the line', y: 500, path: '/p[1]' }),
    cand({ text: 'New headline down low', tag: 'h2', y: 12000, path: '/h2[deep]' }),
  ];
  b[1].belowCapture = true;

  var m = vdMatchCandidates(a, b);
  var s = vdSuppressFindings(m.pairs);
  var all = s.findings.concat(m.removed.map(function (c) { return { changeClass: 'removed', a: c, b: null }; }));

  ok('a copy change below the capture line is reported', all.some(function (f) {
    return f.changeClass === 'text-changed' && f.a && /Old headline down low/.test(f.a.text);
  }), all.map(function (f) { return f.changeClass; }));
  ok('a removed element below the capture line is reported', all.some(function (f) {
    return f.changeClass === 'removed' && f.a && /Footer button/.test(f.a.text);
  }));
  // This mirrors production exactly now. It did not before: diffVisualDiffVariant
  // used to filter `!c.clipped` out of its `all` list while this test did not,
  // so the two could disagree without anything failing. That filter is gone.
  eq('every unmatched control element becomes a finding, unfiltered',
     all.filter(function (f) { return f.changeClass === 'removed'; }).length, m.removed.length);
})();

(function belowCaptureStyleAndLayout() {
  // Colors and layout come from getComputedStyle/getBoundingClientRect, not
  // from pixels, so both work below the line too.
  var a = [cand({ text: 'Deep box', y: 12000, path: '/div[1]' })];
  var b = [cand({ text: 'Deep box', y: 12000, path: '/div[1]',
                  styles: { backgroundColor: 'rgb(255, 0, 0)' } })];
  a[0].belowCapture = true; b[0].belowCapture = true;
  var s = vdSuppressFindings(vdMatchCandidates(a, b).pairs);
  eq('a color change below the line is reported', s.findings.length, 1);
  ok('  and names the property',
     s.findings[0].signals.indexOf('style:backgroundColor') !== -1, s.findings[0].signals);
})();

(function pixelCheckOnlyOnStationaryPairs() {
  // The 4px case. A shift below VD_MOVE_MIN_PX never counts as "moved", so the
  // pair stays 'unchanged' and reaches the pixel check — where a rounded rect
  // leaves sub-pixel residue and text re-renders almost every pixel. Observed
  // live as 31 false style-changed findings on one variant while its siblings,
  // whose shift cleared the move floor and was suppressed as reflow, reported
  // none.
  var reads = 0;
  var ctx = { getImageData: function () { reads++; return { data: new Uint8Array(4) }; } };

  var shifted = { changeClass: 'unchanged', dx: 0, dy: 4,
                  a: cand({ text: 'Same text', y: 4756, w: 480, h: 48 }),
                  b: cand({ text: 'Same text', y: 4760, w: 480, h: 48 }) };
  vdPixelCheckMatchedPairs(ctx, ctx, [shifted]);
  eq('a 4px-shifted pair is never pixel-checked', reads, 0);
  eq('  and stays unchanged', shifted.changeClass, 'unchanged');

  var nudged = { changeClass: 'unchanged', dx: 1, dy: 0,
                 a: cand({ text: 'Same', y: 100, w: 480, h: 48 }),
                 b: cand({ text: 'Same', x: 1, y: 100, w: 480, h: 48 }) };
  vdPixelCheckMatchedPairs(ctx, ctx, [nudged]);
  eq('a 1px horizontal nudge is never pixel-checked', reads, 0);

  // A genuinely stationary pair must still be checked — that is the whole
  // point of the backstop (background-image swaps, dropped shadows).
  var stationary = { changeClass: 'unchanged', dx: 0, dy: 0,
                     a: cand({ text: 'Same', y: 100, w: 480, h: 48 }),
                     b: cand({ text: 'Same', y: 100, w: 480, h: 48 }) };
  var threw = false;
  try { vdPixelCheckMatchedPairs(ctx, ctx, [stationary]); } catch (e) { threw = true; }
  ok('a stationary pair IS still pixel-checked', reads > 0 || threw);
})();

(function pixelStagesSkipBelowCapture() {
  // The regression this change could introduce: reading pixels for a rect the
  // bitmap does not contain. Both pixel consumers must decline.
  var f = { changeClass: 'unchanged',
            a: Object.assign(cand({ text: 'x', y: 12000, w: 400, h: 300 }), { belowCapture: true }),
            b: Object.assign(cand({ text: 'x', y: 12000, w: 400, h: 300 }), { belowCapture: true }) };
  var ctx = { getImageData: function () { throw new Error('read past the captured bitmap'); } };
  var threw = false;
  try { vdPixelCheckMatchedPairs(ctx, ctx, [f]); } catch (e) { threw = true; }
  ok('pixel backstop does not touch below-capture pairs', !threw);
  eq('  and leaves them unchanged', f.changeClass, 'unchanged');

  eq('crop declines a below-capture block',
     cropVisualDiffBlock({ width: 1470, height: 8000 }, { rect: { x: 0, y: 12000, w: 100, h: 50 }, belowCapture: true }),
     null);
})();

// ── 8c. Control-vs-Control must stop the analysis ──────────────────────────
section('control-vs-control');
(function detectors() {
  var base = { label: 'v0', url: 'https://zapier.com/?optimizely_x=AAA', finalUrl: 'https://zapier.com/?optimizely_x=AAA' };

  eq('a differently-configured variant is fine',
     vdControlDuplicateReason(base, { label: 'v1', url: 'https://zapier.com/?optimizely_x=BBB', finalUrl: 'https://zapier.com/?optimizely_x=BBB' }),
     null);

  ok('same configured URL is caught',
     /same URL as Control/.test(vdControlDuplicateReason(base,
       { label: 'v1', url: 'https://zapier.com/?optimizely_x=AAA', finalUrl: 'https://zapier.com/?optimizely_x=AAA' }) || ''));

  ok('trailing-slash / case differences do not hide a duplicate',
     !!vdControlDuplicateReason(base,
       { label: 'v1', url: 'https://Zapier.com/?optimizely_x=AAA/', finalUrl: 'x' }));

  ok('a variant that redirects ONTO control is caught',
     /same final URL as Control/.test(vdControlDuplicateReason(base,
       { label: 'v1', url: 'https://zapier.com/?optimizely_x=BBB', finalUrl: 'https://zapier.com/?optimizely_x=AAA' }) || ''));

  // The dangerous one: configured correctly, but the variant never applied.
  var identical = { mode: 'normal', findings: [],
                    structuralStats: { addedCount: 0, removedCount: 0, modifiedCount: 0, styleChangedCount: 0, unchangedCount: 500 } };
  ok('a variant rendering identically to Control is caught',
     /rendered identically to Control/.test(vdRenderedAsControlReason(identical) || ''));

  ok('a variant with real differences is NOT caught',
     vdRenderedAsControlReason({ mode: 'normal', findings: [{}],
       structuralStats: { addedCount: 1, removedCount: 0, modifiedCount: 0, styleChangedCount: 0 } }) === null);
  ok('differences that exist but ranked out are NOT called control-vs-control',
     vdRenderedAsControlReason({ mode: 'normal', findings: [],
       structuralStats: { addedCount: 0, removedCount: 2, modifiedCount: 0, styleChangedCount: 0 } }) === null);
  ok('redesign mode is never judged by this rule',
     vdRenderedAsControlReason({ mode: 'redesign', findings: [], structuralStats: {} }) === null);
})();

(function surfacedAsError() {
  var p = vdCollectProblems(abSections([capture('v0', {}), capture('v1', {})], [
    { label: 'v1', controlDuplicate: true, error: 'Analysis stopped — it rendered identically to Control.', structuralStats: {} },
  ]));
  var hit = p.filter(function (x) { return x.where === 'visual-diff/v1'; });
  eq('it is the ONLY note for that variant', hit.length, 1);
  eq('  and it is an error', hit[0].severity, 'error');
  ok('  and it says the absence of findings is not a pass',
     /do not read the absence of findings as a pass/.test(hit[0].detail), hit[0].detail);
})();

// ── 8d. changes common to every variant are reported once ──────────────────
section('shared findings across variants');
function wf(cls, ctrl, vari) {
  return { changeClass: cls,
           controlBlock: ctrl == null ? null : { text: ctrl },
           variantBlock: vari == null ? null : { text: vari } };
}
(function liftsSharedOut() {
  // The measured shape: five changes identical in all three variants, plus a
  // copy change whose variant text differs per variant (the actual A/B test).
  var mk = function (hero) {
    return { label: 'v', findings: [
      wf('removed', 'AI automation, governed', null),
      wf('removed', 'Every team has AI. Now they need a system.', null),
      wf('removed', 'Learn more about governance', null),
      wf('moved', 'Explore Zapier for Enterprise', 'Explore Zapier for Enterprise'),
      wf('added', null, 'Contact sales'),
      wf('text-changed', 'Your tools. Your rules. Any AI.', hero),
    ] };
  };
  var pv = [mk('Actions speak louder than prompts'), mk('Smarter workflows. Smaller bills.'), mk('The front door to every system you run')];
  pv[0].label = 'v1'; pv[1].label = 'v2'; pv[2].label = 'v3';

  var shared = vdExtractSharedFindings(pv);
  eq('five changes recognised as common to all', shared.length, 5);
  ok('the per-variant copy change is NOT lifted out',
     !shared.some(function (f) { return f.changeClass === 'text-changed'; }),
     shared.map(function (f) { return f.changeClass; }));
  eq('each variant keeps only what is unique to it', pv[0].findings.length, 1);
  eq('  and it is the copy change', pv[0].findings[0].variantBlock.text, 'Actions speak louder than prompts');
  ok('shared entries record which variants they span',
     (shared[0].sharedAcross || []).join(',') === 'v1,v2,v3', shared[0].sharedAcross);
  eq('rows the reader sees: 5 shared + 3 unique', shared.length + pv[0].findings.length + pv[1].findings.length + pv[2].findings.length, 8);
})();

(function onlySharedWhenTrulyInAll() {
  var pv = [
    { label: 'v1', findings: [wf('removed', 'Gone everywhere', null), wf('removed', 'Only in v1', null)] },
    { label: 'v2', findings: [wf('removed', 'Gone everywhere', null)] },
    { label: 'v3', findings: [wf('removed', 'Gone everywhere', null)] },
  ];
  var shared = vdExtractSharedFindings(pv);
  eq('a change missing from one variant stays per-variant', shared.length, 1);
  eq('  the shared one is the universal change', shared[0].controlBlock.text, 'Gone everywhere');
  eq('  and v1 keeps its own', pv[0].findings.length, 1);
  eq('  while v2 is emptied', pv[1].findings.length, 0);
})();

(function duplicatesWithinOneVariantCannotFake() {
  // The same change twice inside ONE variant must not count as two variants.
  var pv = [
    { label: 'v1', findings: [wf('removed', 'Twice here', null), wf('removed', 'Twice here', null)] },
    { label: 'v2', findings: [wf('added', null, 'Something else')] },
  ];
  eq('a repeat within one variant is not "shared"', vdExtractSharedFindings(pv).length, 0);
  eq('  v1 keeps both', pv[0].findings.length, 2);
})();

(function positionIndependent() {
  // The same change lands at a different y when a taller hero pushes it down —
  // including rect in the identity would defeat grouping exactly when it counts.
  var a = { changeClass: 'added', controlBlock: null, variantBlock: { text: 'Contact sales', rect: { x: 1497, y: 984 } } };
  var b = { changeClass: 'added', controlBlock: null, variantBlock: { text: 'Contact sales', rect: { x: 1497, y: 1034 } } };
  eq('identity ignores position', vdFindingIdentity(a), vdFindingIdentity(b));
  var m = { changeClass: 'moved', controlBlock: { text: 'CTA' }, variantBlock: { text: 'CTA' }, dy: -1553 };
  var m2 = { changeClass: 'moved', controlBlock: { text: 'CTA' }, variantBlock: { text: 'CTA' }, dy: -1503 };
  eq('a move differing by a few px is one change', vdFindingIdentity(m), vdFindingIdentity(m2));
})();

(function distinctChangesNeverCollapse() {
  var diff = vdFindingIdentity(wf('removed', 'Alpha', null)) !== vdFindingIdentity(wf('removed', 'Beta', null));
  ok('different control text stays distinct', diff);
  ok('same text under a different changeClass stays distinct',
     vdFindingIdentity(wf('removed', 'X', null)) !== vdFindingIdentity(wf('added', 'X', null)));
  ok('same control text with different variant text stays distinct',
     vdFindingIdentity(wf('text-changed', 'Old', 'New A')) !== vdFindingIdentity(wf('text-changed', 'Old', 'New B')));
})();

(function needsTwoComparisons() {
  var one = [{ label: 'v1', findings: [wf('removed', 'X', null)] }];
  eq('a single variant has nothing to share against', vdExtractSharedFindings(one).length, 0);
  eq('  and keeps its finding', one[0].findings.length, 1);
  var withErr = [{ label: 'v1', findings: [wf('removed', 'X', null)] },
                 { label: 'v2', error: 'boom' }, { label: 'v3', skipped: true }];
  eq('errored and skipped variants are not counted as agreeing', vdExtractSharedFindings(withErr).length, 0);
})();

(function textlessElementsMustNotCollide() {
  // Two DIFFERENT images both have empty text. Keying on text alone reported
  // them as a single removal — real data loss, observed live.
  var imgA = { changeClass: 'removed', controlBlock: { text: '', rect: { x: 2826, y: 710, w: 136, h: 24 } }, variantBlock: null };
  var imgB = { changeClass: 'removed', controlBlock: { text: '', rect: { x: 2679, y: 711, w: 67, h: 22 } }, variantBlock: null };
  ok('two text-less removals stay distinct', vdFindingIdentity(imgA) !== vdFindingIdentity(imgB));

  var pv = [
    { label: 'v1', findings: [imgA, imgB] },
    { label: 'v2', findings: [JSON.parse(JSON.stringify(imgA)), JSON.parse(JSON.stringify(imgB))] },
  ];
  eq('both are lifted, not merged into one', vdExtractSharedFindings(pv).length, 2);
})();

(function controlRectStableVariantPositionNot() {
  // Control is one capture reused by every variant, so its rect is identical
  // across them; the variant side moves when a taller hero pushes it down.
  var v1 = { changeClass: 'added', controlBlock: null, variantBlock: { text: 'Contact sales', rect: { x: 1497, y: 984, w: 169, h: 48 } } };
  var v3 = { changeClass: 'added', controlBlock: null, variantBlock: { text: 'Contact sales', rect: { x: 1497, y: 1034, w: 169, h: 48 } } };
  eq('same addition at a different y is still one change', vdFindingIdentity(v1), vdFindingIdentity(v3));

  var m1 = { changeClass: 'moved', controlBlock: { text: 'CTA', rect: { x: 1438, y: 2537, w: 299, h: 48 } }, variantBlock: { text: 'CTA', rect: { x: 1181, y: 984, w: 299, h: 48 } } };
  var m3 = { changeClass: 'moved', controlBlock: { text: 'CTA', rect: { x: 1438, y: 2537, w: 299, h: 48 } }, variantBlock: { text: 'CTA', rect: { x: 1181, y: 1034, w: 299, h: 48 } } };
  eq('a move landing at a different y is still one change', vdFindingIdentity(m1), vdFindingIdentity(m3));

  // ...but genuinely different control elements must never merge
  var a = { changeClass: 'removed', controlBlock: { text: 'X', rect: { x: 0, y: 100, w: 50, h: 20 } }, variantBlock: null };
  var b = { changeClass: 'removed', controlBlock: { text: 'X', rect: { x: 0, y: 900, w: 50, h: 20 } }, variantBlock: null };
  ok('same text at different control positions stays distinct', vdFindingIdentity(a) !== vdFindingIdentity(b));
})();

// ── 8e. horizontally off-canvas elements are kept, not dropped ─────────────
section('off-canvas (marquee) handling');
(function scrolledChipSuppressesAsReflow() {
  // THE case. An auto-scrolling marquee rests at a different offset in each
  // capture: "Repurpose content" sits at x=2650 on a 2847px page in Control and
  // scrolls to x=2863 (past the edge) in the Variant. The walk used to discard
  // it there, leaving nothing to match and reporting a phantom removal — in two
  // variants but not the third, purely by where the marquee stopped.
  var ctrl = [], vari = [];
  for (var i = 0; i < 12; i++) {                      // the marquee row
    ctrl.push(cand({ text: 'Chip ' + i, tag: 'a', x: 500 + i * 180, y: 9574, w: 164, h: 42, path: '/a[c' + i + ']' }));
    var v = cand({ text: 'Chip ' + i, tag: 'a', x: 500 + i * 180 + 213, y: 9574, w: 164, h: 42, path: '/a[c' + i + ']' });
    v.offCanvas = (500 + i * 180 + 213 + 164) > 2847;
    vari.push(v);
  }
  for (var j = 0; j < 8; j++) {                        // static page content
    ctrl.push(cand({ text: 'Body ' + j, y: 1000 + j * 100, path: '/p[' + j + ']' }));
    vari.push(cand({ text: 'Body ' + j, y: 1000 + j * 100, path: '/p[' + j + ']' }));
  }
  ok('the scrolled chips are still present on the variant side',
     vari.filter(function (c) { return c.offCanvas; }).length > 0);

  var m = vdMatchCandidates(ctrl, vari);
  eq('every chip finds its counterpart', m.removed.length, 0);
  eq('  and nothing is spuriously added', m.added.length, 0);

  var s = vdSuppressFindings(m.pairs);
  var reported = s.findings.filter(function (f) { return f.changeClass !== 'unchanged'; });
  eq('the whole marquee shift is suppressed as reflow', reported.length, 0);
  ok('  and counted', s.aggregate.reflow >= 12, s.aggregate.reflow);
})();

(function realCarouselChangeStillReports() {
  // Nothing carousel-specific is hidden: an element that is off-canvas in both
  // captures but genuinely different content still reports.
  var a = [Object.assign(cand({ text: 'Old promo', tag: 'a', x: 3000, y: 500, path: '/a[1]' }), { offCanvas: true })];
  var b = [Object.assign(cand({ text: 'New promo', tag: 'a', x: 3000, y: 500, path: '/a[1]' }), { offCanvas: true })];
  var m = vdMatchCandidates(a, b);
  var s = vdSuppressFindings(m.pairs);
  eq('a genuine copy change off-canvas is reported', s.findings.length, 1);
  eq('  as a text change', s.findings[0].changeClass, 'text-changed');

  var gone = [Object.assign(cand({ text: 'Only in control', tag: 'a', x: 3000, y: 500 }), { offCanvas: true })];
  var m2 = vdMatchCandidates(gone, []);
  eq('a genuinely absent off-canvas element is still a removal', m2.removed.length, 1);
})();

(function pixelStagesSkipOffCanvas() {
  // The screenshot is clipped to the page width, so there are no pixels out
  // there — reading them would throw or silently compare the wrong column.
  var reads = 0;
  var ctx = { getImageData: function () { reads++; throw new Error('read outside the captured frame'); } };
  var f = { changeClass: 'unchanged', dx: 0, dy: 0,
            a: Object.assign(cand({ text: 'Chip', x: 3000, y: 500, w: 400, h: 300 }), { offCanvas: true }),
            b: Object.assign(cand({ text: 'Chip', x: 3000, y: 500, w: 400, h: 300 }), { offCanvas: true }) };
  var threw = false;
  try { vdPixelCheckMatchedPairs(ctx, ctx, [f]); } catch (e) { threw = true; }
  ok('pixel backstop does not touch off-canvas pairs', !threw && reads === 0);
  eq('  and leaves them unchanged', f.changeClass, 'unchanged');

  eq('crop declines an off-canvas block',
     cropVisualDiffBlock({ width: 2847, height: 8000 }, { rect: { x: 3000, y: 500, w: 164, h: 42 }, offCanvas: true }),
     null);
})();

// ── 9. perf guard ──────────────────────────────────────────────────────────
section('perf');
(function bigPages() {
  var a = [], b = [];
  for (var i = 0; i < 3000; i++) {
    a.push(cand({ text: 'unique control ' + i, y: i * 20, path: '/p[' + i + ']' }));
    b.push(cand({ text: 'unique variant ' + i, y: i * 20, path: '/q[' + i + ']' }));
  }
  var m = vdMatchCandidates(a, b);
  eq('a fully-disjoint 3000x3000 page falls to redesign, skipping the O(n*m) pass', m.mode, 'redesign');
  eq('  and pairs nothing', m.pairs.length, 0);
})();

// ── report ─────────────────────────────────────────────────────────────────
print('');
if (failures.length) {
  print('FAILURES:');
  failures.forEach(function (f) { print('  - ' + f); });
}
print('=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail) throw new Error(fail + ' assertion(s) failed');
