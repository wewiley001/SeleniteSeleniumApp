// vd-config.js — Visual Diff's tunable constants, shared verbatim by
// popup.js (via <script src> in BOTH popup.html and sidepanel.html, loaded
// before popup.js) and by background.js (via importScripts). Same
// global-attachment convention metric-match.js/pixelmatch.js already use —
// see metric-match.js's own header for why this isn't duplicated inline.
//
// As of the deterministic-diff rearchitecture, everything below is pure JS
// with no network call anywhere upstream of it — free to sweep against a
// saved candidate corpus with zero API cost per iteration. (The prior
// split between "Stage 2, free to sweep" and "pixel-check, needs eval-style
// measurement" no longer applies: the pixel check below is now a capped
// backstop over pairs the deterministic diff has already matched, not a
// judgment call downstream of two model calls.)
(function (g) {
  'use strict';

  // ── Candidate walk (domCandidateWalkFn, background.js) ────────────────────
  // Replaces the old VIS_SCRAPE_MAX_CANDIDATES (400) — that cap existed
  // because every candidate cost Sonnet prompt tokens. Parsing is no longer
  // an API call, so this is sized for real pages, not token budget. Still a
  // cap, not unbounded: domCandidateWalkFn truncates from the bottom of the
  // page past this count.
  const VD_MAX_CANDIDATES = 3000;

  // ── Matching (vd-diff.js) ──────────────────────────────────────────────────
  // P9's narrow fuzzy fallback — only pairs P1-P8's exact passes leave
  // unmatched. Reuses vdTokenSimilarity for the text term; see vd-diff.js's
  // own header for the full weighting.
  const VD_FUZZY_THRESHOLD = 0.62;
  // Hard skip for P9 when the leftover pools are this large (leftoverA ×
  // leftoverB) — a wholesale redesign case where O(n·m) fuzzy matching is
  // both slow and meaningless. Falls through to redesign/region-rollup mode
  // instead (VD_REDESIGN_MATCH_FLOOR below).
  const VD_FUZZY_MAX_PAIRS = 250000;
  // Below this fraction of elements matched (of the larger side's count),
  // treat the page as a wholesale redesign rather than a targeted
  // experiment: skip P9, roll findings up by region, and send the model
  // both full-page screenshots instead of an element-by-element list.
  const VD_REDESIGN_MATCH_FLOOR = 0.5;

  // ── Cascade / shift suppression (vd-diff.js) ──────────────────────────────
  // Real reflow is piecewise constant, not a single global shift — these
  // drive vdDeriveShiftSegments's run-length segmentation of Δy across
  // content-identical pairs, sorted by control y.
  const VD_SHIFT_TOL_PX = 2;     // Δy tolerance for "same segment"
  const VD_SHIFT_MIN_RUN = 3;    // minimum pairs before a segment counts as trusted
  const VD_MOVE_MIN_PX = 8;      // below this, a shift is rounding/sub-pixel noise, not a finding
  // A reflow aggregate accounting for more cumulative shift than this
  // surfaces as its own low-severity finding rather than a silent count —
  // suppression must never be the only place a large layout change is
  // visible.
  const VD_REFLOW_ALERT_PX = 400;

  // Whether a punctuation-only / numeric-only-shape text difference is
  // suppressed by default (counted in the aggregate line) rather than
  // reported as a finding. Flip either to false to see everything that
  // class would otherwise catch — useful when auditing suppression itself.
  const VD_SUPPRESS_PUNCTUATION_ONLY = true;
  const VD_SUPPRESS_NUMERIC_ONLY = true;

  // ── Grouping (vd-diff.js) — runs AFTER matching, never before ─────────────
  // Findings sharing (changeClass, region, shift segment) merge when their
  // rects are within this many px vertically. A grouping error here can
  // only merge or split real findings, never manufacture one — unlike the
  // old semantic pre-grouping this replaces.
  const VD_GROUP_GAP_PX = 48;
  const VD_GROUP_MAX_MEMBERS = 12;

  // ── Crop (vdCropFinding, background.js) ───────────────────────────────────
  const VIS_CROP_PAD = 12;           // px padding around a crop's own tight rect
  const VD_CROP_MIN_W = 320;         // minimum crop context box — a bare tight rect (e.g. a
  const VD_CROP_MIN_H = 120;         // 20x18px icon) is unreadable with no surrounding context
  // For a grouped finding, crop the member union only when it's this
  // spatially coherent (member-area / union-area); otherwise crop the
  // largest member alone. Guards against reintroducing the old
  // mostly-whitespace union-bbox crop bug at the group level.
  const VD_CROP_FILL_MIN = 0.35;

  // ── Pixel-check backstop (vdPixelCheckMatchedPairs, background.js) ────────
  // Demoted from primary CSS-change detector to backstop now that the
  // deterministic style diff (comparing the walk's own captured style
  // fields) does that job for free and names the property that changed.
  // Only reached for pairs that are text-identical, same-size, AND show no
  // style-field delta.
  const VIS_PIXELMATCH_THRESHOLD = 0.1;    // pixelmatch's own documented default, not yet tuned
  const VIS_PIXELMATCH_INCLUDE_AA = false;
  const VIS_BLOCK_PIXEL_RATIO = 0.02;
  const VD_PIXEL_CHECK_MAX = 60;           // cap CPU: largest-by-area pairs win

  // ── Coarse whole-page backstop (computeCoarsePixelDiffRatio, background.js) ─
  // Independent, unsuppressible cross-check — a "something changed broadly
  // enough to look closer" sanity flag, not a regression detector. No
  // alignment, so one large inserted/removed block reads as a high ratio
  // for everything below it even if nothing else changed — an accepted
  // cost of staying simple.
  const VIS_WHOLE_PAGE_RATIO = 0.4;
  const VIS_BAND_HEIGHT_PX = 400;   // pixelmatch band height — bounds peak per-band RGBA to
                                     // ~8MB regardless of page height

  g.VD_SUPPRESS_PUNCTUATION_ONLY = VD_SUPPRESS_PUNCTUATION_ONLY;
  g.VD_SUPPRESS_NUMERIC_ONLY = VD_SUPPRESS_NUMERIC_ONLY;
  g.VD_MAX_CANDIDATES = VD_MAX_CANDIDATES;
  g.VD_FUZZY_THRESHOLD = VD_FUZZY_THRESHOLD;
  g.VD_FUZZY_MAX_PAIRS = VD_FUZZY_MAX_PAIRS;
  g.VD_REDESIGN_MATCH_FLOOR = VD_REDESIGN_MATCH_FLOOR;
  g.VD_SHIFT_TOL_PX = VD_SHIFT_TOL_PX;
  g.VD_SHIFT_MIN_RUN = VD_SHIFT_MIN_RUN;
  g.VD_MOVE_MIN_PX = VD_MOVE_MIN_PX;
  g.VD_REFLOW_ALERT_PX = VD_REFLOW_ALERT_PX;
  g.VD_GROUP_GAP_PX = VD_GROUP_GAP_PX;
  g.VD_GROUP_MAX_MEMBERS = VD_GROUP_MAX_MEMBERS;
  g.VIS_CROP_PAD = VIS_CROP_PAD;
  g.VD_CROP_MIN_W = VD_CROP_MIN_W;
  g.VD_CROP_MIN_H = VD_CROP_MIN_H;
  g.VD_CROP_FILL_MIN = VD_CROP_FILL_MIN;
  g.VIS_PIXELMATCH_THRESHOLD = VIS_PIXELMATCH_THRESHOLD;
  g.VIS_PIXELMATCH_INCLUDE_AA = VIS_PIXELMATCH_INCLUDE_AA;
  g.VIS_BLOCK_PIXEL_RATIO = VIS_BLOCK_PIXEL_RATIO;
  g.VD_PIXEL_CHECK_MAX = VD_PIXEL_CHECK_MAX;
  g.VIS_WHOLE_PAGE_RATIO = VIS_WHOLE_PAGE_RATIO;
  g.VIS_BAND_HEIGHT_PX = VIS_BAND_HEIGHT_PX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
