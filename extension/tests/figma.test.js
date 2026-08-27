// Figma reference-path suite — URL parsing, board classification, and the
// Variation label read.
//
//   RUN:  cd extension/tests && jsc figma.test.js
//   (jsc ships with macOS at
//    /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
//    — add it to PATH or invoke by full path.)
//
// Same standing as vd-diff.test.js: NOT wired into
// .github/workflows/run-tests.yml, which runs pytest against a `tests/`
// directory this repo does not have. The Python backend is out of scope.
//
// The fixture below is the REAL round-1 pull recorded in
// figma-extraction-test-01.md — the `WOW-1160_comp` container and its actual
// children, names and all. That matters more than it looks: every filter in
// figma.js exists because of something specific in this list (four unnamed
// frames parked outside the boards, two Groups sitting between the real
// boards in layer order, a stray Rectangle, and board names whose
// parenthesised width is a designer's label rather than a measurement).
// Inventing a tidy fixture would test none of it.

load('../figma.js');

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

function textNode(chars) { return { type: 'TEXT', characters: chars }; }
function box(x, y, w, h) { return { x: x, y: y, width: w, height: h }; }

// ── URL parsing ────────────────────────────────────────────────────────────
section('url parsing');

var real = figmaParseUrl('https://www.figma.com/design/N18oeFuqzZ2X8LKQxZ7gl8/-NEW--WOW-Master?node-id=40001337-575');
eq('real ticket link — file key', real && real.fileKey, 'N18oeFuqzZ2X8LKQxZ7gl8');
// The hyphen form is what Figma's own "Copy link" button produces today; the
// API accepts only the colon form, so this normalization is the difference
// between a working pull and a 404 that reads like a permissions problem.
eq('real ticket link — node id normalized', real && real.nodeId, '40001337:575');
eq('real ticket link — kind', real && real.kind, 'design');

eq('older /file/ URL still parses',
  (figmaParseUrl('https://figma.com/file/ABC123/Thing?node-id=1%3A2') || {}).fileKey, 'ABC123');
eq('percent-encoded colon normalizes',
  (figmaParseUrl('https://figma.com/file/ABC123/Thing?node-id=1%3A2') || {}).nodeId, '1:2');
eq('literal colon passes through',
  (figmaParseUrl('https://figma.com/design/ABC123/Thing?node-id=40001248:4314') || {}).nodeId, '40001248:4314');
eq('bare file link has no node id',
  (figmaParseUrl('https://figma.com/design/ABC123/Thing') || {}).nodeId, null);
eq('node-id among other params',
  (figmaParseUrl('https://figma.com/design/ABC123/T?t=xyz&node-id=7-9&mode=design') || {}).nodeId, '7:9');

// Host discipline: the whole point of matching host + path prefix is that a
// marketing or community link can never be mistaken for a design reference
// and sent to the API as one.
ok('figma.com marketing page rejected', figmaParseUrl('https://www.figma.com/pricing') === null);
ok('community file rejected', figmaParseUrl('https://www.figma.com/community/file/123') === null);
ok('lookalike host rejected', figmaParseUrl('https://notfigma.com/design/ABC/T?node-id=1-2') === null);
ok('figma-lookalike subdomain-ish host rejected', figmaParseUrl('https://evilfigma.com/design/ABC/T') === null);
ok('non-figma host rejected', figmaParseUrl('https://example.com/design/ABC/T') === null);
ok('empty input rejected', figmaParseUrl('') === null);
ok('null input rejected', figmaParseUrl(null) === null);
ok('isDesignUrl agrees with parseUrl', figmaIsDesignUrl('https://figma.com/design/A/B') === true);

// Split-and-rejoin rather than a blind `-` -> `:` replace. A blind replace
// turns any hyphenated junk into something that still LOOKS like a node id,
// so the resulting 404 gets misread as an access problem instead of a parse
// bug — which is exactly the wrong place to go looking.
eq('three-part id rejected, not mangled', figmaNormalizeNodeId('1-2-3'), null);
eq('non-numeric id rejected', figmaNormalizeNodeId('abc-def'), null);
eq('empty id rejected', figmaNormalizeNodeId(''), null);
eq('whitespace trimmed', figmaNormalizeNodeId('  40001248:4314  '), '40001248:4314');

// ── board name parsing ─────────────────────────────────────────────────────
section('board names');

var bn = figmaParseBoardName('v1 Desktop (1440px)');
eq('variant id', bn && bn.variantId, 'v1');
eq('breakpoint', bn && bn.breakpoint, 'desktop');
eq('nominal width parsed', bn && bn.nominalWidth, 1440);

eq('mobile board breakpoint', (figmaParseBoardName('v0 Mobile (375px)') || {}).breakpoint, 'mobile');
eq('no-breakpoint board still parses', (figmaParseBoardName('v2') || {}).variantId, 'v2');
eq('no-breakpoint board has null breakpoint', (figmaParseBoardName('v2') || {}).breakpoint, null);
ok('unnamed layer rejected', figmaParseBoardName('Group 1') === null);
ok('generated frame name rejected', figmaParseBoardName('Frame 3765535') === null);
ok('rectangle rejected', figmaParseBoardName('Rectangle 945') === null);

// ── Variation labels ───────────────────────────────────────────────────────
section('variation labels');

var v0 = figmaParseVariationLabel('V0 CONTROL');
eq('V0 CONTROL — variant', v0.variantId, 'v0');
eq('V0 CONTROL — name', v0.changeName, 'CONTROL');

var v1 = figmaParseVariationLabel('V1 DETAILED OFFER CARDS');
eq('V1 multi-word name — variant', v1.variantId, 'v1');
eq('V1 multi-word name — name', v1.changeName, 'DETAILED OFFER CARDS');

// Round-1 open question #3 asked whether the V{n} format is universal. It is
// not assumed to be: a label that does not match keeps its raw text and the
// caller reports the miss rather than silently dropping the board mapping.
eq('non-conforming label yields null variant', figmaParseVariationLabel('Hero Redesign').variantId, null);

// Nested text is concatenated in document order — a label block is a frame
// containing text nodes, not a text node itself.
eq('nested text joined', figmaNodeTextJoined({
  type: 'FRAME', children: [textNode('V1'), { type: 'GROUP', children: [textNode('DETAILED OFFER CARDS')] }],
}), 'V1 DETAILED OFFER CARDS');
eq('invisible text excluded', figmaNodeTextJoined({
  type: 'FRAME', children: [textNode('shown'), { type: 'TEXT', characters: 'hidden', visible: false }],
}), 'shown');

// ── the real container ─────────────────────────────────────────────────────
section('WOW-1160_comp children (round-1 fixture)');

var children = [
  { id: '1:1', name: 'Group 1', type: 'GROUP', absoluteBoundingBox: box(0, 0, 100, 100) },
  { id: '1:2', name: 'Variation', type: 'FRAME', absoluteBoundingBox: box(0, 0, 300, 40),
    children: [textNode('V0 CONTROL')] },
  { id: '40001248:4314', name: 'v1 Desktop (1440px)', type: 'FRAME', absoluteBoundingBox: box(1500, 0, 1440, 1920) },
  { id: '1:4', name: 'Variation', type: 'FRAME', absoluteBoundingBox: box(1500, -60, 300, 40),
    children: [textNode('V1 DETAILED OFFER CARDS')] },
  { id: '1:5', name: 'Group 2', type: 'GROUP', absoluteBoundingBox: box(0, 0, 100, 100) },
  { id: '1:6', name: 'v0 Mobile (375px)', type: 'FRAME', absoluteBoundingBox: box(3100, 0, 375, 1800) },
  { id: '1:7', name: 'v0 Desktop (1440px)', type: 'FRAME', absoluteBoundingBox: box(0, 0, 1440, 1920) },
  { id: '1:8', name: 'Frame 3765535', type: 'FRAME', absoluteBoundingBox: box(4200, 0, 200, 200) },
  { id: '1:9', name: 'Frame 3765599', type: 'FRAME', absoluteBoundingBox: box(4200, 300, 200, 200) },
  { id: '1:10', name: 'Frame 3765604', type: 'FRAME', absoluteBoundingBox: box(4200, 600, 200, 200) },
  { id: '1:11', name: 'Rectangle 945', type: 'RECTANGLE', absoluteBoundingBox: box(4200, 900, 200, 200) },
];

var c = figmaClassifyChildren(children);

eq('three real boards found', c.boards.length, 3);
eq('two variation labels found', c.labels.length, 2);
eq('label maps to v0', c.labels[0].variantId, 'v0');
eq('label maps to v1', c.labels[1].variantId, 'v1');
eq('label carries the change name', c.labels[1].changeName, 'DETAILED OFFER CARDS');

// The three unnamed Frames are the specific phantom the name filter exists
// for: they are the right TYPE and would otherwise be walked as boards.
var frameRejects = c.rejected.filter(function (r) { return /^Frame 3765/.test(r.name); });
eq('unnamed frames rejected', frameRejects.length, 3);
eq('unnamed frames rejected for the right reason', frameRejects[0].reason, 'name does not match v{n} convention');

// Groups are excluded by TYPE, not by name — they sit between the real boards
// in layer order and would otherwise read as containers worth descending into.
var groupRejects = c.rejected.filter(function (r) { return r.type === 'GROUP'; });
eq('both groups rejected', groupRejects.length, 2);
eq('groups rejected for the right reason', groupRejects[0].reason, 'not a frame/component');
eq('rectangle rejected', c.rejected.filter(function (r) { return r.type === 'RECTANGLE'; }).length, 1);

// ── board selection ────────────────────────────────────────────────────────
section('board selection');

var picked = figmaSelectDesktopBoard(c.boards, 'v1');
eq('v1 desktop selected by name', picked.board && picked.board.nodeId, '40001248:4314');
eq('selection route recorded', picked.via, 'name');
// Measured, never nominal. The parenthesised 1440 in the name is a label a
// designer typed; the geometry is what the API measured. They agree here, and
// the point is that the code reads the second one.
eq('measured width used', picked.board && picked.board.measuredWidth, 1440);
eq('widths agree on this board', picked.board && picked.board.widthDisagrees, false);

eq('v0 desktop selected, not v0 mobile',
  (figmaSelectDesktopBoard(c.boards, 'v0').board || {}).name, 'v0 Desktop (1440px)');
ok('unknown variant selects nothing', figmaSelectDesktopBoard(c.boards, 'v9').board === null);

// Round-1 open question #4 — the fallback for comps that do not qualify board
// names at all.
var noBp = figmaClassifyChildren([
  { id: '2:1', name: 'v1', type: 'FRAME', absoluteBoundingBox: box(0, 0, 1440, 1920) },
]);
eq('unqualified board is a fallback match', figmaSelectDesktopBoard(noBp.boards, 'v1').via, 'fallback-no-breakpoint');

// A nominal/measured disagreement is surfaced rather than averaged away: a
// board named 1440px that actually measures 1280 means the scale factor every
// downstream number depends on would be wrong by 12%.
var lying = figmaClassifyChildren([
  { id: '3:1', name: 'v1 Desktop (1440px)', type: 'FRAME', absoluteBoundingBox: box(0, 0, 1280, 1920) },
]);
eq('nominal/measured mismatch flagged', lying.boards[0].widthDisagrees, true);
eq('measured width wins', lying.boards[0].measuredWidth, 1280);

// Mobile is parsed and kept — reporting "found but skipped" is a different
// thing from silently not seeing it, and the desktop-only scope decision
// should be visible in a diagnostic rather than implied by absence.
eq('mobile board still classified', c.boards.filter(function (b) { return b.breakpoint === 'mobile'; }).length, 1);

// ── ticket link picking ────────────────────────────────────────────────────
section('ticket link picking');

// The real inventory shape: mostly non-Figma links, with the design link
// somewhere among them.
var inv = [
  'https://wowway.com/internet/save?optimizely_x=123',
  'https://crometrics.atlassian.net/browse/WOW-1160',
  'https://www.figma.com/design/N18oeFuqzZ2X8LKQxZ7gl8/-NEW--WOW-Master?node-id=40001337-575',
];
var picked = figmaPickDesignUrl(inv);
eq('design link found among ticket links', picked.pick && picked.pick.nodeId, '40001337:575');
eq('only the design link is a candidate', picked.candidates.length, 1);

// A node link beats a bare file link regardless of order. The WOW comps live
// in one shared master file, so a bare file link resolves to every ticket's
// boards at once — thousands of nodes — while the node link resolves to the
// one comp container someone meant to share.
eq('node link wins over bare file link',
  figmaPickDesignUrl([
    'https://figma.com/design/AAA/master',
    'https://figma.com/design/AAA/master?node-id=7-9',
  ]).pick.nodeId, '7:9');
eq('node link still wins when it comes first',
  figmaPickDesignUrl([
    'https://figma.com/design/AAA/master?node-id=7-9',
    'https://figma.com/design/AAA/master',
  ]).pick.nodeId, '7:9');
eq('bare file link used when it is all there is',
  figmaPickDesignUrl(['https://figma.com/design/AAA/master']).pick.nodeId, null);

// Deduped by fileKey+nodeId, not raw URL: the same board gets pasted with
// different tracking params constantly, and warning about that is noise.
eq('same board with different params is one candidate',
  figmaPickDesignUrl([
    'https://figma.com/design/AAA/m?node-id=7-9&t=abc',
    'https://figma.com/design/AAA/m?node-id=7-9&t=xyz',
  ]).candidates.length, 1);
eq('genuinely different boards are two candidates',
  figmaPickDesignUrl([
    'https://figma.com/design/AAA/m?node-id=7-9',
    'https://figma.com/design/AAA/m?node-id=8-1',
  ]).candidates.length, 2);

ok('no figma links yields no pick', figmaPickDesignUrl(['https://example.com']).pick === null);
ok('empty list yields no pick', figmaPickDesignUrl([]).pick === null);
ok('null list yields no pick', figmaPickDesignUrl(null).pick === null);

// ── comp attachment matching ───────────────────────────────────────────────
section('comp attachment matching');

var atts = [
  { filename: 'WOW-1160_comp.png', mimeType: 'image/png', size: 900000, content: 'https://jira/att/1' },
  { filename: 'qa-screenshot.png', mimeType: 'image/png', size: 120000, content: 'https://jira/att/2' },
  { filename: 'spec.pdf', mimeType: 'application/pdf', size: 4000, content: 'https://jira/att/3' },
];
var m = figmaMatchCompAttachment(atts, 'WOW-1160');
eq('exact convention matches', m.match && m.match.filename, 'WOW-1160_comp.png');
eq('non-images excluded from candidates', m.candidates.length, 2);

// Order-agnostic and format-agnostic: the name must carry BOTH the ticket id
// and "comp", and nothing else about the shape matters. The original rule
// required the name to START with the key and be immediately followed by
// "comp" — that described one team's habit, and ENOC-97 matched none of its 17
// image attachments.
[
  'WOW-1160_comp.png',            // the original convention
  'WOW-1160-comp.png',
  'WOW-1160 comp.jpg',
  'wow1160comp.PNG',              // run together, no separators at all
  'WOW1160_Comp.webp',
  'comp_WOW-1160.png',            // reversed
  'comp-wow-1160.jpg',
  'WOW-1160_comp_v2.png',         // suffixed
  'WOW-1160 comp final.png',
  'desktop_WOW-1160_comp.png',    // prefixed
  'old-WOW-1160_comp.png',        // was explicitly rejected before; now valid
  'v1 comp WOW-1160 desktop.jpeg',
  'WOW-1160_COMP.HEIC',
].forEach(function (fn) {
  eq('matches ' + fn,
    (figmaMatchCompAttachment([{ filename: fn, mimeType: 'image/png' }], 'WOW-1160').match || {}).filename, fn);
});

// Both tokens are required — either alone is not a comp.
ok('bare ticket key does not match', figmaMatchCompAttachment([{ filename: 'WOW-1160.png' }], 'WOW-1160').match === null);
ok('bare comp does not match', figmaMatchCompAttachment([{ filename: 'comp.png' }], 'WOW-1160').match === null);
ok('another ticket does not match', figmaMatchCompAttachment([{ filename: 'WOW-1161_comp.png' }], 'WOW-1160').match === null);
ok('unrelated image does not match', figmaMatchCompAttachment([{ filename: 'qa-screenshot.png' }], 'WOW-1160').match === null);

// "comp" must be its own token. These are the words that would otherwise be
// swept in by a plain substring test.
['WOW-1160_component.png', 'WOW-1160-comparison.jpg', 'WOW-1160_composite.png',
 'WOW-1160_compressed.png', 'WOW-1160-competitor-audit.png'].forEach(function (fn) {
  ok('"comp" inside a longer word does not match: ' + fn,
    figmaMatchCompAttachment([{ filename: fn, mimeType: 'image/png' }], 'WOW-1160').match === null);
});

// The ticket number must not match a LONGER one. WOW-1160 vs WOW-11605 is a
// realistic collision once a project passes ten thousand tickets, and substring
// matching would silently take the wrong file.
ok('1160 does not match 11605', figmaMatchCompAttachment([{ filename: 'WOW-11605_comp.png' }], 'WOW-1160').match === null);
eq('...but 11605 matches itself',
  (figmaMatchCompAttachment([{ filename: 'WOW-11605_comp.png' }], 'WOW-11605').match || {}).filename, 'WOW-11605_comp.png');
// A digit AFTER comp is fine — that is a version suffix, not another ticket.
eq('run-together with a version digit still matches',
  (figmaMatchCompAttachment([{ filename: 'wow1160comp2.png' }], 'WOW-1160').match || {}).filename, 'wow1160comp2.png');
ok('run-together into a longer word does not match',
  figmaMatchCompAttachment([{ filename: 'wow1160component.png' }], 'WOW-1160').match === null);

// mimeType is the gate, not the extension — an attachment can be image/png
// with no extension at all, and any format list is an incomplete guess.
eq('extensionless image/* is accepted',
  (figmaMatchCompAttachment([{ filename: 'WOW-1160 comp', mimeType: 'image/png' }], 'WOW-1160').match || {}).filename,
  'WOW-1160 comp');
ok('a PDF named like a comp is not an image',
  figmaMatchCompAttachment([{ filename: 'WOW-1160_comp.pdf', mimeType: 'application/pdf' }], 'WOW-1160').match === null);
// The extension must not be able to satisfy the pattern on its own.
ok('a .comp extension is not the token', figmaMatchCompAttachment([{ filename: 'WOW-1160.comp', mimeType: 'image/png' }], 'WOW-1160').match === null);

// The real ENOC-97 shape: 17 images, none carrying the ticket id.
var enoc = figmaMatchCompAttachment(
  ['hero.png', 'nav-desktop.png', 'card-1.jpg', 'footer.png'].map(function (f) {
    return { filename: f, mimeType: 'image/png' };
  }), 'ENOC-97');
ok('a ticket whose images are all generic matches none', enoc.match === null);
eq('...but every image is still offered as a candidate', enoc.candidates.length, 4);

// Ambiguity is reported, never resolved by guessing.
var multi = figmaMatchCompAttachment([
  { filename: 'WOW-1160_comp.png', mimeType: 'image/png' },
  { filename: 'comp_WOW-1160_v2.png', mimeType: 'image/png' },
], 'WOW-1160');
ok('two matches yield no auto-selection', multi.match === null);
eq('but both are reported as matches', multi.matches.length, 2);

eq('no attachments yields no candidates', figmaMatchCompAttachment([], 'WOW-1160').candidates.length, 0);
ok('null attachments handled', figmaMatchCompAttachment(null, 'WOW-1160').match === null);
ok('empty ticket key never matches', figmaMatchCompAttachment([{ filename: 'comp.png' }], '').match === null);

// ── report ─────────────────────────────────────────────────────────────────
print('');
if (failures.length) {
  print('FAILURES:');
  failures.forEach(function (f) { print('  - ' + f); });
}
print('=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail) throw new Error(fail + ' assertion(s) failed');
