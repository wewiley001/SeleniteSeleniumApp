// Jira ticket extraction — custom-field resolution and the Test Specifications
// variant parse.
//
//   RUN:  cd extension/tests && jsc jira-extract.test.js
//
// Same standing as the other suites: not wired into the repo's pytest CI.
//
// This file exists because of a specific, expensive failure. Five Visual Diff
// runs across two unrelated tickets (WOW-1160, ENOC-97) all reported
// variantCount:0, which left Summary of Changes empty and made EVERY finding
// "unclear" by construction — the report graded nothing at all. Three rounds of
// debugging went into it, and the diagnosis kept landing on "the Test
// Specifications parser is broken."
//
// It was not. Both tickets return `description: null`. Their content lives in
// NAMED CUSTOM FIELDS — customfield_10041 is literally titled "Test
// Specifications" and holds 9,735 characters of ADF. The parser was reading a
// field these tickets do not populate. Preview links kept working the whole
// time only because those come from the AI pass, which reads the RENDERED page
// where custom fields are visible; that asymmetry was the symptom.
//
// The fixtures below are the REAL field shapes, taken from WOW-1160 over the
// Jira API. Notably that site has TWO fields named "Goals" — one populated,
// one empty — which is why resolution has to prefer content over iteration
// order.

var _pu = readFile('../popup.js');
eval(_pu.slice(_pu.indexOf('function resolveJiraAdfField(names, fields, label)'),
                _pu.indexOf('function extractConvertMetricId')));
eval(_pu.slice(_pu.indexOf('function adfText(node)'),
                _pu.indexOf('function parseRelatedTestBullets(lines)')));

// ── harness ────────────────────────────────────────────────────────────────
var pass = 0, fail = 0, failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function eq(name, actual, expected) { ok(name, actual === expected, { actual: actual, expected: expected }); }
function section(t) { print('\n' + t); }

function para(text) { return { type: 'paragraph', content: [{ type: 'text', text: text }] }; }
function doc(paras) { return { type: 'doc', version: 1, content: paras }; }

// ── field resolution ───────────────────────────────────────────────────────
section('custom field resolution');

// The real name map from this Jira site, trimmed to what matters.
var NAMES = {
  description: 'Description',
  customfield_10041: 'Test Specifications',
  customfield_10040: 'Goals',
  customfield_10821: 'Goals',            // a SECOND field with the same name
  customfield_10044: 'Preview Links',
  customfield_10112: 'Platform Experiment Id',
  customfield_10686: 'QA Test Plan',
};

var SPEC = doc([para('EXPERIMENT REQUIREMENTS'), para('v0: Control (WOW-1160)'), para('No Change')]);

eq('resolves an ADF field by display name',
  resolveJiraAdfField(NAMES, { customfield_10041: SPEC }, 'Test Specifications'), SPEC);

eq('name match is case-insensitive',
  resolveJiraAdfField(NAMES, { customfield_10041: SPEC }, 'test specifications'), SPEC);

// The duplicate-"Goals" case. Object iteration order would hand back whichever
// key came first, and an empty pick is indistinguishable from a ticket that
// genuinely has nothing to say — the exact failure mode this whole file is
// about.
var populated = doc([para('1. [PJS] Successful application')]);
eq('prefers the POPULATED field when two share a name',
  resolveJiraAdfField(NAMES, { customfield_10821: doc([]), customfield_10040: populated }, 'Goals'), populated);
eq('...regardless of key order',
  resolveJiraAdfField(NAMES, { customfield_10040: populated, customfield_10821: doc([]) }, 'Goals'), populated);
ok('falls back to an empty doc when that is all there is',
  resolveJiraAdfField(NAMES, { customfield_10821: doc([]) }, 'Goals') !== null);

// Non-ADF values must never be returned as documents — QA Test Plan is a URL
// string on this site, and handing a string to the section parser would throw.
ok('a string field is not returned as ADF',
  resolveJiraAdfField(NAMES, { customfield_10686: 'https://docs.google.com/x' }, 'QA Test Plan') === null);
ok('a null field yields null', resolveJiraAdfField(NAMES, { customfield_10041: null }, 'Test Specifications') === null);
ok('an unknown label yields null', resolveJiraAdfField(NAMES, {}, 'Nonexistent Field') === null);
ok('null names yields null', resolveJiraAdfField(null, {}, 'Test Specifications') === null);
ok('null fields yields null', resolveJiraAdfField(NAMES, null, 'Test Specifications') === null);

// ── the real Test Specifications content ───────────────────────────────────
section('variant parse over the real field');

// Verbatim shape from WOW-1160's customfield_10041.
var REAL = doc([
  para('EXPERIMENT REQUIREMENTS'),
  para('v0: Control (WOW-1160)'),
  para('No Change'),
  para('v1: Detailed Offer Cards'),
  para('Same as WOW-1134, but on a different page - Locked LP'),
  para('In the offer card row below the "Check WOW! Internet Availability" section, replace the 3 existing cards with 4 cards.'),
  para('Bullet 1: 99.9% Network Reliability*'),
]);

// When the section is its own FIELD, the whole field is the section — there is
// no heading to locate inside it, which is why the caller passes
// field.content directly rather than through adfSectionNodes.
var variants = splitVariantBlocks(adfSectionLines(REAL.content));

eq('both variants parse from the field', variants.length, 2);
eq('control id', variants[0].id, 'v0');
eq('variant id', variants[1].id, 'v1');
// v0 is control BY CONVENTION, never inferred from content — the extractor
// asserts b.id === 'v0' rather than reading the word "Control".
ok('v0 carries its description', /No Change/.test(variants[0].texts.join('\n')));
ok('v1 carries the real spec text', /replace the 3 existing cards with 4 cards/.test(variants[1].texts.join('\n')));

// The finding this whole exercise was supposed to surface: the spec says
// 99.9%, the built page shipped 99%. That is a real defect, and it is only
// visible once the spec is actually read.
ok('spec text reaches the summary verbatim, including "99.9%"',
  /99\.9% Network Reliability/.test(variants[1].texts.join('\n')), variants[1].texts);

// ── the description path still works ───────────────────────────────────────
section('description fallback');

// Tickets that DO use a description must keep working — the custom field is
// preferred, not required.
var DESC = doc([
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Test Specifications' }] },
  para('v0: Control'),
  para('Baseline'),
  para('v1: New Hero'),
  para('Bigger headline'),
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goals' }] },
  para('not a variant'),
]);
var descVariants = splitVariantBlocks(adfSectionLines(adfSectionNodes(DESC, 'Test Specifications')));
eq('heading-based section still parses two variants', descVariants.length, 2);
eq('...and stops at the next heading', descVariants[1].texts.join(' ').indexOf('not a variant'), -1);

ok('a missing heading is distinguishable from an empty one',
  adfSectionNodes(DESC, 'Nonexistent') === null);

// ── report ─────────────────────────────────────────────────────────────────
print('');
if (failures.length) {
  print('FAILURES:');
  failures.forEach(function (f) { print('  - ' + f); });
}
print('=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail) throw new Error(fail + ' assertion(s) failed');
