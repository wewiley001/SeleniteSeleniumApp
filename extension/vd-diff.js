// vd-diff.js -- Visual Diff's deterministic matching/diffing engine. Pure
// JS, no DOM, no network call, no LLM anywhere in this file. Same global-
// attachment convention as vd-config.js/pixelmatch.js/metric-match.js:
// (function(g){...})(globalThis), loaded via importScripts in background.js
// and via <script src> in both popup.html and sidepanel.html, AFTER
// vd-config.js (this file reads its tunables as bare globals) and BEFORE
// popup.js.
//
// A handful of functions here (vdNormText/vdTextShape/vdHash32/
// vdIsStableId/vdNormalizeHref/vdIsLiveRegionSignal) are ALSO injected
// directly into the page as a content script -- see background.js's
// capture path, which does executeScript({files:['vd-diff.js']}) right
// before running domCandidateWalkFn via exec(). Both run in the same
// ISOLATED world (same convention picker.js/recorder.js use for
// window.__seleniteBuildSelector), so domCandidateWalkFn can call these as
// bare globals without them being duplicated inline. This is why those six
// functions in particular must stay free of anything DOM-shaped in their
// own bodies -- they need to work identically whether loaded into a
// service worker, the panel, or a live page.
//
// Replaces the old LLM-based Stage 1 (Sonnet groups DOM candidates into
// semantic blocks) and Stage 2 (needlemanWunschAlign + blockSimilarity over
// those blocks). Both were deleted because grouping was non-deterministic --
// re-running the same page could re-group differently, manufacturing
// phantom added/removed/modified findings. Matching here works directly
// over domCandidateWalkFn's per-element output, using identity keys that
// are element-local (cannot change because unrelated content changed) --
// see each pass's own comment in vdMatchCandidates.
(function (g) {
  'use strict';

  // -- Text normalization --------------------------------------------------
  // NFKC+lowercase+collapse-non-alphanumeric-runs-to-one-space. Deliberately
  // Unicode-aware (\p{L}\p{N}, not [a-z0-9]) -- unlike vdNormalizeTokens
  // below, this needs to work correctly on non-English pages too, since it
  // is the PRIMARY identity signal (textHash), not just a similarity score.
  function vdNormText(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      // Digit-group separators are formatting, not content: "$1,000" and
      // "$1000" are the same number. Without this the general collapse below
      // turns them into "1 000" vs "1000", which reads as a real copy change
      // — on a page of prices and stat counters that is a steady source of
      // exactly the phantom findings this file exists to eliminate. Narrow
      // by construction: only a separator sitting between a digit and
      // EXACTLY three more digits is stripped, so a decimal comma ("1,5")
      // and an ordinary comma between words are both left alone.
      .replace(/(\p{N})[,   ](?=\p{N}{3}(?!\p{N}))/gu, '$1')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  // Takes ALREADY-NORMALIZED text (vdNormText's output) and folds digit runs
  // to '#' -- "6 000 apps" and "6 500 apps" both become "6 # apps". Used to
  // detect numeric-only differences (live counters, chart axis labels)
  // separately from real text changes.
  function vdTextShape(normText) {
    return String(normText || '').replace(/\p{N}+/gu, '#');
  }

  // FNV-1a, 32-bit, over UTF-16 code units. Not cryptographic -- just a
  // short, deterministic, low-collision key for map lookups and for
  // detecting "same text past character 300" (domCandidateWalkFn still caps
  // the stored text field at 300 chars for display, but hashes the FULL
  // normalized text, closing a real hole: two pages differing only past
  // char 300 used to read as identical).
  function vdHash32(s) {
    var h = 0x811c9dc5;
    var str = String(s || '');
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  // Rejects framework-generated ids (React/Vue/Radix/Headless UI/Ember/
  // long numeric ids) from being used as a first-tier identity key. A
  // generated id used as a stable key would silently mis-key across two
  // captures and manufacture exactly the add/remove noise this file exists
  // to eliminate -- ship this conservative; a rejected id just falls
  // through to a later matching tier instead.
  // `_R_…` / `_r_…` is React 19's useId format and was found live: Zapier's
  // MCP/SDK/CLI tab buttons carried id="_R_84qnmlb_-MCP" on one run and
  // id="_r_5_-MCP" on another — same elements, regenerated id. Neither was
  // rejected by the earlier pattern list (no leading colon, fewer than four
  // consecutive digits), so both were accepted as stable and used as path
  // ANCHORS, which silently poisons the structural key for the entire subtree
  // beneath them. `«r0»` is React's older format, included for completeness.
  var STABLE_ID_REJECT = /^:r|^_[rR]_|^«|»$|^ember\d|^headlessui-|^radix-|^react-aria|^mui-|^chakra-|^mantine-|\d{4,}|:/;
  function vdIsStableId(id) {
    if (!id) return false;
    return !STABLE_ID_REJECT.test(id);
  }

  // Strips the same-origin prefix, the #hash, and known-volatile query
  // params (experiment/tracking params that vary per request but don't
  // change where the link actually goes), then sorts remaining params for
  // determinism. Plain string ops only -- no URL/URLSearchParams -- so this
  // works identically in a real page, the service worker, and jsc.
  var VD_VOLATILE_PARAMS = {
    optimizely_x: 1, optimizely_force_tracking: 1, cro_mode: 1,
    gclid: 1, fbclid: 1, msclkid: 1,
    utm_source: 1, utm_medium: 1, utm_campaign: 1, utm_term: 1, utm_content: 1,
  };
  function vdNormalizeHref(href, origin) {
    if (!href) return null;
    var h = String(href);
    if (origin && h.indexOf(origin) === 0) h = h.slice(origin.length);
    h = h.split('#')[0];
    var qIdx = h.indexOf('?');
    if (qIdx !== -1) {
      var path = h.slice(0, qIdx);
      var kept = h.slice(qIdx + 1).split('&').filter(Boolean)
        .filter(function (kv) { return !VD_VOLATILE_PARAMS[kv.split('=')[0]]; })
        .sort();
      h = kept.length ? (path + '?' + kept.join('&')) : path;
    }
    return h || '/';
  }

  // True when an element's own aria-live/role marks it (and therefore its
  // descendants, via domCandidateWalkFn's inherited inLiveRegion flag) as
  // dynamic content whose text is expected to change independent of any
  // real page edit -- live counters, carousels, marquees.
  function vdIsLiveRegionSignal(ariaLive, role) {
    if (ariaLive && String(ariaLive).toLowerCase() !== 'off') return true;
    if (role && /carousel|slider|marquee/i.test(String(role))) return true;
    return false;
  }

  // -- Similarity (fuzzy pass only -- NOT identity) ------------------------
  // Set-based Jaccard similarity: order- and duplicate-lossy ("A B" == "B
  // A"), which is fine for a similarity SCORE but wrong for an identity KEY
  // -- this is why every exact pass in vdMatchCandidates uses textHash
  // (order-sensitive, exact) and only the fuzzy fallback uses this.
  function vdNormalizeTokens(s) {
    var set = new Set();
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).forEach(function (t) { if (t) set.add(t); });
    return set;
  }
  function vdTokenSimilarity(a, b) {
    var setA = vdNormalizeTokens(a), setB = vdNormalizeTokens(b);
    if (!setA.size && !setB.size) return 1;
    if (!setA.size || !setB.size) return 0;
    var inter = 0;
    for (var t of setA) if (setB.has(t)) inter++;
    var union = setA.size + setB.size - inter;
    return union ? inter / union : 1;
  }

  function vdBoxesOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function vdByDocOrder(x, y) {
    var ay = x.rect ? x.rect.y : Infinity, by = y.rect ? y.rect.y : Infinity;
    if (ay !== by) return ay - by;
    var ax = x.rect ? x.rect.x : Infinity, bx = y.rect ? y.rect.x : Infinity;
    return ax - bx;
  }

  // -- Matching -------------------------------------------------------------
  // A series of exact hash-map passes, each over whatever's still unmatched
  // after the passes before it -- deterministic, O(n), no scoring, no DP.
  // Replaces needlemanWunschAlign + blockSimilarity + the old reorder pass:
  // those existed because Sonnet's blocks had no identity at all, making
  // soft sequence alignment the only option. Real per-element keys don't
  // need that -- they need enough REDUNDANT tiers that no single kind of
  // change (a wrapper div, a copy rewrite, a reposition) can defeat all of
  // them at once. The path+text pass runs before path-only or text-only
  // specifically so neither is tried while a stronger, unambiguous match
  // could still exist.
  //
  // Path-only and text-only are the redundant pair for exactly this reason,
  // but they are NOT interchangeable in order, and getting this backwards
  // is worse than it sounds: unlike a plain miss, path-only doesn't fail
  // cleanly on a shifted subtree -- it MISFIRES, confidently pairing a
  // control element with whatever unrelated content now happens to occupy
  // its old path slot, because path-only has no way to know that pairing
  // is wrong. Text-only can't misfire the same way: a control-side text
  // that no longer has a matching count on the variant side (the exact
  // signature of an insertion/removal) simply defers rather than guessing.
  // So text-only MUST run first -- it either resolves an element correctly
  // or leaves it alone, whereas path-only, run first, would have already
  // consumed it on a coincidence by the time text-only got a turn. A copy
  // rewrite (same slot, different text) is unaffected by this ordering
  // either way, since text-only never has a hash to match on in that case
  // and simply passes the residue through to path-only intact. (Caught by
  // hand-simulating the wrapper-insertion case before trusting it to the
  // test suite -- the first draft had these two passes swapped.)
  function vdRunExactPass(unmatchedA, unmatchedB, pairs, tierName, keyFn) {
    if (!unmatchedA.length || !unmatchedB.length) return;
    var byKey = new Map();
    var i, a, b, k, entry;
    for (i = 0; i < unmatchedA.length; i++) {
      a = unmatchedA[i];
      k = keyFn(a);
      if (k == null) continue;
      entry = byKey.get(k);
      if (!entry) { entry = { aList: [], bList: [] }; byKey.set(k, entry); }
      entry.aList.push(a);
    }
    for (i = 0; i < unmatchedB.length; i++) {
      b = unmatchedB[i];
      k = keyFn(b);
      if (k == null) continue;
      entry = byKey.get(k);
      if (!entry) continue;
      entry.bList.push(b);
    }
    var matchedA = new Set(), matchedB = new Set();
    for (var group of byKey.values()) {
      var aList = group.aList, bList = group.bList;
      if (!aList.length || !bList.length) continue;
      // A duplicate-key group (e.g. 12 identical "Learn more" links) only
      // pairs when both sides have the SAME count -- same content, same
      // slot count, safe to pair by document order. A count mismatch means
      // a real add/remove happened among the duplicates; defer to a later
      // pass (ultimately the fuzzy pass, or left as add/remove) rather than
      // guess which ones correspond.
      if (aList.length !== bList.length) continue;
      var as = aList.slice().sort(vdByDocOrder), bs = bList.slice().sort(vdByDocOrder);
      for (var idx = 0; idx < as.length; idx++) {
        pairs.push({ a: as[idx], b: bs[idx], tier: tierName });
        matchedA.add(as[idx]); matchedB.add(bs[idx]);
      }
    }
    if (matchedA.size) for (i = unmatchedA.length - 1; i >= 0; i--) if (matchedA.has(unmatchedA[i])) unmatchedA.splice(i, 1);
    if (matchedB.size) for (i = unmatchedB.length - 1; i >= 0; i--) if (matchedB.has(unmatchedB[i])) unmatchedB.splice(i, 1);
  }

  function vdFuzzyScore(a, b) {
    var textSim = vdTokenSimilarity(a.textNorm, b.textNorm);
    var tagMatch = a.tag === b.tag ? 1 : 0;
    var tailA = (a.path || '').split('/').slice(-4).join('/');
    var tailB = (b.path || '').split('/').slice(-4).join('/');
    var pathTailOverlap = tailA && tailA === tailB ? 1 : 0;
    var ay = a.rect ? a.rect.y : 0, by = b.rect ? b.rect.y : 0;
    var proximity = 1 / (1 + Math.abs(ay - by) / 500);
    return 0.55 * textSim + 0.20 * tagMatch + 0.15 * pathTailOverlap + 0.10 * proximity;
  }

  // Deliberately narrow: only reached for whatever the exact passes
  // couldn't resolve, so the surface for a bad pairing is a fraction of
  // what the old DP's reorder pass had to cover. Mutual-best (score-sorted,
  // greedy, one-to-one) rather than per-control-item-best -- a single
  // shared candidate can't be claimed by two different control elements.
  function vdFuzzyMatch(unmatchedA, unmatchedB, threshold) {
    var scored = [];
    for (var a of unmatchedA) {
      for (var b of unmatchedB) {
        if (a.tag !== b.tag) continue;
        var score = vdFuzzyScore(a, b);
        if (score >= threshold) scored.push({ a: a, b: b, score: score });
      }
    }
    scored.sort(function (x, y) { return y.score - x.score; });
    var usedA = new Set(), usedB = new Set(), out = [];
    for (var s of scored) {
      if (usedA.has(s.a) || usedB.has(s.b)) continue;
      usedA.add(s.a); usedB.add(s.b);
      out.push(s);
    }
    return out;
  }

  // controlList/variantList: domCandidateWalkFn's own output arrays
  // (already in document order). Returns matched pairs plus the residue on
  // each side, and whether the page looks like a targeted change or a
  // wholesale redesign (matchedFraction, mode).
  function vdMatchCandidates(controlList, variantList, opts) {
    opts = Object.assign({
      fuzzyThreshold: g.VD_FUZZY_THRESHOLD, fuzzyMaxPairs: g.VD_FUZZY_MAX_PAIRS,
      redesignMatchFloor: g.VD_REDESIGN_MATCH_FLOOR,
    }, opts || {});

    var unmatchedA = controlList.slice();
    var unmatchedB = variantList.slice();
    var pairs = [];
    function ariaOrAlt(c) { return (c.attrs && (c.attrs.ariaLabel || c.attrs.alt)) || null; }
    function keyTestid(c) { return (c.attrs && c.attrs.testid) ? (c.tag + ' ' + c.attrs.testid) : null; }
    function keyStableId(c) { return c.stableId ? (c.tag + ' ' + c.stableId) : null; }
    function keyPathText(c) { return c.path ? (c.tag + ' ' + c.path + ' ' + c.textHash) : null; }
    function keyText(c) { return c.textHash ? (c.tag + ' ' + c.textHash) : null; }
    function keyHrefText(c) { return c.hrefKey ? (c.tag + ' ' + c.hrefKey + ' ' + c.textHash) : null; }
    function keyHref(c) { return c.hrefKey ? (c.tag + ' ' + c.hrefKey) : null; }
    function keyAriaText(c) { var v = ariaOrAlt(c); return v ? (c.tag + ' ' + v + ' ' + c.textHash) : null; }
    function keyAria(c) { var v = ariaOrAlt(c); return v ? (c.tag + ' ' + v) : null; }
    function keyPath(c) { return c.path ? (c.tag + ' ' + c.path) : null; }
    function keyShapePpath(c) { return c.shapeHash ? (c.tag + ' ' + c.shapeHash + ' ' + (c.ppath || '')) : null; }

    // 1: stable per-element attribute, cheapest and least ambiguous.
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'testid', keyTestid);
    // 2: a real, non-generated id.
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'stableId', keyStableId);
    // 3: structural position AND content both agree -- zero ambiguity, the
    // bulk of a normal page lands here.
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'path+text', keyPathText);
    // 4: same content, structural position may differ -- the restructure
    // pass (e.g. a wrapper div inserted around it). Runs BEFORE path-only
    // (below) -- see the header comment above for why that order matters.
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'text', keyText);
    // 5: a link/button identified by where it goes.
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'href+text', keyHrefText);
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'href', keyHref);
    // 6: identified by its accessible name (icons, images with no text).
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'aria+text', keyAriaText);
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'aria', keyAria);
    // 7: same structural slot, content differs -- the copy-change pass.
    // Only reaches elements text-based matching (pass 4, above) already
    // passed on, so it never gets a chance to misfire on a shifted subtree.
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'path', keyPath);
    // 8: numeric-shape match under the same parent slot (live counters,
    // stat rows) -- content differs only in digits.
    vdRunExactPass(unmatchedA, unmatchedB, pairs, 'shape+ppath', keyShapePpath);

    var totalMax = Math.max(controlList.length, variantList.length, 1);
    var matchedFractionExact = pairs.length / totalMax;
    var mode = 'normal';

    if (matchedFractionExact < opts.redesignMatchFloor) {
      // Wholesale redesign: an O(n*m) fuzzy pass over a large, mostly-
      // unrelated residue would be both slow and meaningless -- the caller
      // switches to region rollup instead (see vdRollupByRegion).
      mode = 'redesign';
    } else if (unmatchedA.length && unmatchedB.length && unmatchedA.length * unmatchedB.length <= opts.fuzzyMaxPairs) {
      // Gated the same way even in the normal case: a huge residue on an
      // otherwise-normal page is just as meaningless to brute-force.
      var fuzzy = vdFuzzyMatch(unmatchedA, unmatchedB, opts.fuzzyThreshold);
      for (var fp of fuzzy) {
        pairs.push({ a: fp.a, b: fp.b, tier: 'fuzzy', score: fp.score });
        var ia = unmatchedA.indexOf(fp.a); if (ia !== -1) unmatchedA.splice(ia, 1);
        var ib = unmatchedB.indexOf(fp.b); if (ib !== -1) unmatchedB.splice(ib, 1);
      }
    }

    return {
      pairs: pairs, removed: unmatchedA, added: unmatchedB, mode: mode,
      matchedFraction: pairs.length / totalMax,
    };
  }

  // -- Content classification (position-independent) ----------------------
  var VD_STYLE_KEYS = [
    'color', 'backgroundColor', 'backgroundImage', 'border', 'boxShadow', 'opacity',
    'fontSize', 'fontWeight', 'fontFamily', 'textAlign', 'textDecorationLine',
    'borderRadius', 'visibility',
  ];
  function vdStyleDelta(a, b) {
    var sa = a.styles || {}, sb = b.styles || {};
    var changed = [];
    for (var i = 0; i < VD_STYLE_KEYS.length; i++) {
      var k = VD_STYLE_KEYS[i];
      var va = sa[k] == null ? null : sa[k], vb = sb[k] == null ? null : sb[k];
      if (va !== vb) changed.push(k);
    }
    return changed;
  }

  // Purely content-based -- never looks at position. A pair's movement is
  // decided separately (vdSuppressFindings), since that needs page-wide
  // shift-segment context this function doesn't have.
  function vdClassifyPair(a, b) {
    var normEqual = a.textHash === b.textHash;
    var shapeEqual = a.shapeHash === b.shapeHash;
    var styleDelta = vdStyleDelta(a, b);
    var rectA = a.rect, rectB = b.rect;
    var resized = !!(rectA && rectB && (Math.abs(rectA.w - rectB.w) > 2 || Math.abs(rectA.h - rectB.h) > 2));

    if (!normEqual) return { changeClass: shapeEqual ? 'numeric-only' : 'text-changed', styleDelta: styleDelta, resized: resized };
    if (styleDelta.length) return { changeClass: 'style-changed', styleDelta: styleDelta, resized: resized };
    if (resized) return { changeClass: 'resized', styleDelta: styleDelta, resized: resized };
    if (a.text !== b.text) return { changeClass: 'punctuation-only', styleDelta: styleDelta, resized: resized };
    return { changeClass: 'unchanged', styleDelta: styleDelta, resized: resized };
  }

  // -- Cascade suppression --------------------------------------------------
  // Real reflow is piecewise constant (content above a shortened hero has
  // dy=0, content below has dy=-259), so a single global median would report
  // one of the two halves as "moved". The fix is to find the page's distinct
  // shift AMOUNTS and treat each as its own band.
  //
  // Cluster by the shift amount, NOT by document position. An earlier version
  // sorted by y and broke a run as soon as dy changed, which sounds
  // equivalent and is not: two reflow bands routinely OVERLAP in y -- a
  // section that loses a label shifts its own children by one amount and
  // everything after it by another -- and in the overlap, consecutive
  // elements alternate between the two amounts, so every run terminates after
  // a single element and nothing ever reaches minRun. Measured on a real page
  // (Zapier, 4 variants) that produced 97 segments, 95 of them untrusted
  // singletons, and leaked ~49 pure-reflow elements per variant as false
  // "moved" findings while correctly suppressing only the bands that happened
  // to sit alone in their y-range. Clustering on the amount is immune to how
  // the bands interleave.
  function vdMedian(nums) {
    var s = nums.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // samples: [{pos, delta}] -> [{p0, p1, delta, count, trusted}], one entry
  // per distinct shift amount. p0/p1 are the positional span over which that
  // amount was observed, kept so a lone element far outside the band that
  // produced an amount isn't waved through on a coincidence.
  function vdClusterShifts(samples, tolPx, minRun) {
    var sorted = samples.slice().sort(function (x, y) { return x.delta - y.delta; });
    var out = [];
    var i = 0;
    while (i < sorted.length) {
      var ref = sorted[i].delta;
      var members = [sorted[i]];
      var j = i + 1;
      while (j < sorted.length && Math.abs(sorted[j].delta - ref) <= tolPx) { members.push(sorted[j]); j++; }
      var positions = members.map(function (m) { return m.pos; });
      out.push({
        p0: Math.min.apply(null, positions), p1: Math.max.apply(null, positions),
        delta: vdMedian(members.map(function (m) { return m.delta; })),
        count: members.length, trusted: members.length >= minRun,
      });
      i = j;
    }
    return out;
  }

  function vdDeriveShiftSegments(deltas, tolPx, minRun) {
    return vdClusterShifts(deltas.map(function (d) { return { pos: d.y, delta: d.dy }; }), tolPx, minRun)
      .map(function (s) { return { y0: s.p0, y1: s.p1, dy: s.delta, count: s.count, trusted: s.trusted }; });
  }

  // A shift is explained when a TRUSTED band of that same amount exists and
  // this element sits within (a generous margin of) the span where that band
  // was observed. Matching on the amount first is the whole point -- asking
  // "which band is this element in?" positionally is what the overlap case
  // defeats.
  function vdExplainsShift(clusters, pos, delta, tolPx) {
    var best = null;
    for (var i = 0; i < clusters.length; i++) {
      var c = clusters[i];
      if (!c.trusted) continue;
      if (Math.abs(delta - c.delta) > tolPx) continue;
      var margin = Math.max(200, (c.p1 - c.p0) * 0.25);
      if (pos < c.p0 - margin || pos > c.p1 + margin) continue;
      if (!best || Math.abs(delta - c.delta) < Math.abs(delta - best.delta)) best = c;
    }
    return best;
  }

  // Orchestrator: classifies every pair, derives shift segments from the
  // content-identical ones, then decides what actually gets reported.
  // Suppression only ever applies to pairs with NO real content difference
  // (unchanged/punctuation-only) -- a text, numeric, or style change that
  // also happens to have moved is never silently dropped, regardless of how
  // well its dy matches the page's own reflow.
  function vdSuppressFindings(pairs, opts) {
    opts = Object.assign({
      tolPx: g.VD_SHIFT_TOL_PX, minRun: g.VD_SHIFT_MIN_RUN, moveMinPx: g.VD_MOVE_MIN_PX,
      reflowAlertPx: g.VD_REFLOW_ALERT_PX,
      suppressPunctuation: g.VD_SUPPRESS_PUNCTUATION_ONLY, suppressNumeric: g.VD_SUPPRESS_NUMERIC_ONLY,
    }, opts || {});

    var classified = pairs.map(function (p) { return Object.assign({}, p, vdClassifyPair(p.a, p.b)); });

    // Horizontal reflow gets the same treatment as vertical. The original
    // design assumed horizontal shifts don't cascade and so needed no
    // banding -- a real page disproved that: removing one chip from a
    // wrapping link grid re-flows every chip after it, and the rows re-wrap,
    // so twelve links shift by ~126px and each was reported as its own
    // "moved horizontally" finding. Whether a shift cascades is a property of
    // the container, not of the axis.
    var ySamples = [], xSamples = [];
    for (var i = 0; i < classified.length; i++) {
      var f = classified[i];
      if ((f.changeClass === 'unchanged' || f.changeClass === 'punctuation-only') && f.a.rect && f.b.rect) {
        ySamples.push({ pos: f.a.rect.y, delta: f.b.rect.y - f.a.rect.y });
        xSamples.push({ pos: f.a.rect.x, delta: f.b.rect.x - f.a.rect.x });
      }
    }
    var yClusters = vdClusterShifts(ySamples, opts.tolPx, opts.minRun);
    var xClusters = vdClusterShifts(xSamples, opts.tolPx, opts.minRun);
    var segments = yClusters.map(function (s) { return { y0: s.p0, y1: s.p1, dy: s.delta, count: s.count, trusted: s.trusted }; });

    var findings = [];
    var aggregate = { reflow: 0, reflowPxMax: 0, reflowHorizontal: 0, punctuationOnly: 0, numericOnly: 0 };

    for (var idx = 0; idx < classified.length; idx++) {
      var fc = classified[idx];
      var rectA = fc.a.rect, rectB = fc.b.rect;
      var dx = 0, dy = 0, moved = false;
      if (rectA && rectB) {
        dx = rectB.x - rectA.x; dy = rectB.y - rectA.y;
        moved = Math.abs(dx) > opts.moveMinPx || Math.abs(dy) > opts.moveMinPx;
      }
      var signals = [];
      if (fc.styleDelta.length) fc.styleDelta.forEach(function (p) { signals.push('style:' + p); });
      if (fc.resized) signals.push('resized');

      var contentUnchanged = fc.changeClass === 'unchanged' || fc.changeClass === 'punctuation-only';
      var suppressed = false;
      if (moved && contentUnchanged && rectA && !signals.length) {
        // Each axis is explained independently: a shift is reflow only if
        // BOTH components are accounted for, either by being below the
        // noise floor or by matching a trusted band of that same amount.
        var ySeg = Math.abs(dy) <= opts.moveMinPx ? null : vdExplainsShift(yClusters, rectA.y, dy, opts.tolPx);
        var xSeg = Math.abs(dx) <= opts.moveMinPx ? null : vdExplainsShift(xClusters, rectA.x, dx, opts.tolPx);
        var yOk = Math.abs(dy) <= opts.moveMinPx || !!ySeg;
        var xOk = Math.abs(dx) <= opts.moveMinPx || !!xSeg;
        if (yOk && xOk) {
          aggregate.reflow++;
          if (ySeg) aggregate.reflowPxMax = Math.max(aggregate.reflowPxMax, Math.abs(ySeg.delta));
          if (xSeg && !ySeg) aggregate.reflowHorizontal++;
          suppressed = true; // same content, same style, matches the page's own reflow
        } else {
          signals.push(Math.abs(dy) >= Math.abs(dx)
            ? ('moved-vertically:' + (dy > 0 ? '+' : '') + dy + 'px')
            : ('moved-horizontally:' + (dx > 0 ? '+' : '') + dx + 'px'));
          // Promote to its own changeClass -- leaving this as 'unchanged'
          // would make it invisible to rankAndCapDiffFindings's
          // changeClass!=='unchanged' filter, silently dropping the one
          // case this whole branch exists to catch: something that moved
          // in a way the page's own reflow doesn't explain.
          fc.changeClass = 'moved';
        }
      }
      if (suppressed) continue;

      if (!moved && fc.changeClass === 'punctuation-only' && !signals.length && opts.suppressPunctuation) {
        aggregate.punctuationOnly++; continue;
      }
      if (fc.changeClass === 'numeric-only' && !signals.length && opts.suppressNumeric && fc.a.inLiveRegion && fc.b.inLiveRegion) {
        aggregate.numericOnly++; continue;
      }

      findings.push(Object.assign({}, fc, { dx: dx, dy: dy, moved: moved, signals: signals }));
    }

    if (aggregate.reflowPxMax > opts.reflowAlertPx) {
      findings.push({
        changeClass: 'reflow-alert', synthetic: true,
        note: aggregate.reflow + ' elements shifted by up to ' + aggregate.reflowPxMax + 'px as a consequence of other content changes.',
      });
    }

    // shiftClusters rides along for the debug log. It is the single most
    // diagnostic thing this function knows and none of it is inferable from
    // the findings alone: when reflow suppression misbehaves, the tell is a
    // shift amount that shows up repeatedly among the REPORTED moves while
    // having no trusted cluster of its own. Reading those two lists side by
    // side is what turns "49 findings leaked" into a named cause.
    return {
      findings: findings, segments: segments, aggregate: aggregate,
      shiftClusters: { vertical: yClusters, horizontal: xClusters },
    };
  }

  // -- Labels (deterministic -- Sonnet only names GROUPS, in the report stage) --
  function vdInferRole(c) {
    var tag = (c.tag || '').toLowerCase();
    var role = ((c.attrs && c.attrs.role) || '').toLowerCase();
    if (tag === 'nav' || role === 'navigation') return 'nav';
    if (tag === 'header' || role === 'banner') return 'header';
    if (tag === 'footer' || role === 'contentinfo') return 'footer';
    if (tag === 'form') return 'form';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'input';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'a' && c.attrs && c.attrs.href) return 'link';
    if (tag === 'img' || tag === 'svg' || (c.styles && c.styles.backgroundImage)) return 'image';
    if (tag === 'video') return 'video';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'li' || tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'table') return 'table';
    if (tag === 'p') return 'paragraph';
    return 'other';
  }
  function vdDescribeCandidate(c) {
    var role = vdInferRole(c);
    var text = (c.text || '').trim();
    var snippet = text ? text.slice(0, 60) : '';
    if (role === 'link' && c.attrs && c.attrs.href) return 'link "' + (snippet || c.attrs.href) + '" -> ' + c.attrs.href;
    if (role === 'image') return 'image' + (c.attrs && c.attrs.alt ? (' alt="' + c.attrs.alt + '"') : '');
    if (snippet) return role + ' "' + snippet + '"';
    return role;
  }

  // -- Grouping -- runs AFTER matching, never before -----------------------
  // A grouping error here can only merge or split REAL findings, never
  // manufacture one out of thin air -- the entire "re-parsed into / split
  // out of / merged into" noise class the old semantic-grouping-first
  // design produced is gone by construction, not by tuning.
  function vdFindingY(f) {
    var r = (f.a && f.a.rect) || (f.b && f.b.rect);
    return r ? r.y : Infinity;
  }
  function vdFindingRegion(f) {
    // f.region first: a MERGED group (vdGroupFindings' own output) carries
    // region directly and has no .a/.b at all, so checking .a/.b first
    // would silently return null for exactly the objects this function
    // most needs to work on when called by a downstream consumer.
    return f.region || (f.a && f.a.region) || (f.b && f.b.region) || null;
  }
  function vdGroupFindings(findings, opts) {
    opts = Object.assign({ gapPx: g.VD_GROUP_GAP_PX, maxMembers: g.VD_GROUP_MAX_MEMBERS }, opts || {});
    var real = findings.filter(function (f) { return !f.synthetic; });
    var synthetic = findings.filter(function (f) { return f.synthetic; });
    var order = real.map(function (_, i) { return i; }).sort(function (i, j) { return vdFindingY(real[i]) - vdFindingY(real[j]); });
    var used = new Array(real.length).fill(false);
    var groups = [];

    for (var oi = 0; oi < order.length; oi++) {
      var i = order[oi];
      if (used[i]) continue;
      var f = real[i];
      var group = [f];
      used[i] = true;
      var anchorY = vdFindingY(f);
      for (var oj = 0; oj < order.length; oj++) {
        var j = order[oj];
        if (used[j] || group.length >= opts.maxMembers) continue;
        var cand = real[j];
        if (cand.changeClass !== f.changeClass) continue;
        if (vdFindingRegion(cand) !== vdFindingRegion(f)) continue;
        var cy = vdFindingY(cand);
        if (Math.abs(cy - anchorY) <= opts.gapPx) {
          group.push(cand); used[j] = true; anchorY = cy; // chain: extends reach for a run of close members
        }
      }
      groups.push(group);
    }

    return groups.map(function (group) {
      return group.length === 1 ? group[0] : {
        changeClass: group[0].changeClass,
        region: vdFindingRegion(group[0]),
        members: group,
        memberCount: group.length,
      };
    }).concat(synthetic);
  }

  // -- Redesign-mode rollup -------------------------------------------------
  function vdRollupByRegion(matchResult, controlList, variantList) {
    var regions = new Map();
    function ensure(key) {
      var r = regions.get(key);
      if (!r) { r = { region: key, controlCount: 0, variantCount: 0, matchedCount: 0, samples: [] }; regions.set(key, r); }
      return r;
    }
    controlList.forEach(function (c) { ensure(c.region || '(unregioned)').controlCount++; });
    variantList.forEach(function (v) { ensure(v.region || '(unregioned)').variantCount++; });
    matchResult.pairs.forEach(function (p) {
      var key = vdFindingRegion(p) || '(unregioned)';
      var r = regions.get(key);
      if (r) r.matchedCount++;
    });
    function addSample(list, side) {
      list.forEach(function (c) {
        var r = regions.get(c.region || '(unregioned)');
        if (r) r.samples.push({ side: side, area: (c.rect ? c.rect.w * c.rect.h : 0), desc: vdDescribeCandidate(c) });
      });
    }
    addSample(matchResult.removed, 'removed');
    addSample(matchResult.added, 'added');
    var out = Array.from(regions.values());
    out.forEach(function (r) {
      r.samples.sort(function (a, b) { return b.area - a.area; });
      r.samples = r.samples.slice(0, 5);
    });
    return out;
  }

  // -- Ranking / capping -----------------------------------------------------
  // Moved from popup.js's old rankAndCapDiffFindings, re-tiered over
  // changeClass instead of status, and now runs AFTER grouping so it caps
  // groups rather than individual elements.
  var VD_MAX_DIFF_FINDINGS = 60;
  var VD_STATUS_TIER = {
    'text-changed': 3, added: 3, removed: 3,
    moved: 2, resized: 2,
    'numeric-only': 1, 'style-changed': 1, 'reflow-alert': 1,
    'punctuation-only': 0,
  };
  function rankAndCapDiffFindings(findings, opts) {
    opts = Object.assign({ watchedRects: [], maxTotal: VD_MAX_DIFF_FINDINGS }, opts || {});
    var actionable = findings.filter(function (f) { return f.changeClass !== 'unchanged'; });
    if (actionable.length <= opts.maxTotal) return { kept: actionable, truncatedCount: 0 };
    var scored = actionable.map(function (f) {
      var rect = (f.a && f.a.rect) || (f.b && f.b.rect);
      var overlapsWatched = rect ? opts.watchedRects.some(function (r) { return vdBoxesOverlap(rect, r); }) : false;
      var statusTier = VD_STATUS_TIER[f.changeClass];
      if (statusTier == null) statusTier = 1;
      var textLen = ((f.a && f.a.text) || '').length + ((f.b && f.b.text) || '').length;
      return { f: f, overlapsWatched: overlapsWatched, statusTier: statusTier, textLen: textLen };
    });
    scored.sort(function (x, y) {
      if (x.overlapsWatched !== y.overlapsWatched) return x.overlapsWatched ? -1 : 1;
      if (x.statusTier !== y.statusTier) return y.statusTier - x.statusTier;
      return y.textLen - x.textLen;
    });
    var kept = scored.slice(0, opts.maxTotal).map(function (s) { return s.f; });
    return { kept: kept, truncatedCount: actionable.length - kept.length };
  }

  g.vdNormText = vdNormText;
  g.vdTextShape = vdTextShape;
  g.vdHash32 = vdHash32;
  g.vdIsStableId = vdIsStableId;
  g.vdNormalizeHref = vdNormalizeHref;
  g.vdIsLiveRegionSignal = vdIsLiveRegionSignal;
  g.vdNormalizeTokens = vdNormalizeTokens;
  g.vdTokenSimilarity = vdTokenSimilarity;
  g.vdBoxesOverlap = vdBoxesOverlap;
  g.vdMatchCandidates = vdMatchCandidates;
  g.vdClassifyPair = vdClassifyPair;
  g.vdStyleDelta = vdStyleDelta;
  g.vdDeriveShiftSegments = vdDeriveShiftSegments;
  g.vdClusterShifts = vdClusterShifts;
  g.vdExplainsShift = vdExplainsShift;
  g.vdSuppressFindings = vdSuppressFindings;
  g.vdInferRole = vdInferRole;
  g.vdDescribeCandidate = vdDescribeCandidate;
  g.vdFindingRegion = vdFindingRegion;
  g.vdGroupFindings = vdGroupFindings;
  g.vdRollupByRegion = vdRollupByRegion;
  g.rankAndCapDiffFindings = rankAndCapDiffFindings;
  g.VD_MAX_DIFF_FINDINGS = VD_MAX_DIFF_FINDINGS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
