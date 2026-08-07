// metric-match.js — the single metric-matching implementation, shared verbatim
// by popup.js (via <script src> in BOTH popup.html and sidepanel.html, loaded
// before popup.js) and by background.js (via importScripts as the worker's
// very first statement). Plain classic script, no module syntax — the
// manifest declares no "type":"module" for the service worker, and the
// panels load popup.js as a classic script too.
//
// Unlike the TAGS list (console-capture.js / background.js), which is one
// short array kept in sync by comment because console-capture.js runs
// standalone in the page's MAIN world and can't see this file, this is ~150
// lines of scoring with tunable thresholds. A drift here is not a cosmetic
// mismatch — it is the Metric Tracker reporting "fired ×3" while the same
// run's Track Metric step logs "did not fire," from the same console line,
// in the same second. That is exactly the class of silent wrong answer the
// Goals-review-gate design (see popup.js) exists to prevent. Do not
// duplicate this file; only ever load it from one place per surface.
(function (g) {
  'use strict';

  // ── Tags ─────────────────────────────────────────────────────────────────
  // The [PJS]/[cro] badge every tracked console line carries. Kept here as
  // the one canonical copy for background.js; console-capture.js (injected
  // standalone into the page's MAIN world) must keep its own literal copy in
  // sync by hand, since it cannot load this file.
  const MT_TAGS = ['[pjs]', '[cro]'];
  const MT_TAG_RE = /\[(?:pjs|cro)\]/ig;

  // ── Normalization ────────────────────────────────────────────────────────
  // All candidate console lines are already flattened and %c-stripped by the
  // capture pipeline before they ever reach mtMatch. Normalization here only
  // has to erase the tag badge and ordinary human-formatting variance, so
  // "hero_cta_click", "hero-cta-click", "Hero CTA Click" and "hero.cta.click"
  // all collapse onto the same string — that collapse is what lets a metric
  // match without being typed word-for-word.
  function mtNormalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .toLowerCase()
      .replace(MT_TAG_RE, ' ')
      .replace(/[‘’“”]/g, "'")
      .replace(/[_\-/\\.:;,|]+/g, ' ')
      .replace(/[^\p{L}\p{N} ']+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Tokenization ─────────────────────────────────────────────────────────
  const MT_STOP = new Set([
    'a', 'an', 'and', 'the', 'of', 'to', 'for', 'on', 'in', 'is', 'was', 'are', 'were',
    'it', 'this', 'that', 'with', 'at', 'by', 'from', 'as', 'or', 'be', 'been', 'has', 'have', 'had', 'not',
  ]);
  // Applied only when it doesn't empty the token set — these words are
  // ubiquitous in instrumentation text ("metric fired", "event tracked") and
  // carry almost no discriminating power on their own. click/tagging/view/
  // submit/impression are deliberately NOT here: in CRO instrumentation
  // those are the action slot of <area>_<element>_<action> and are exactly
  // the high-signal part of the name.
  const MT_DOMAIN_STOP = new Set([
    'metric', 'metrics', 'event', 'events', 'fired', 'fire', 'fires',
    'track', 'tracking', 'tracked', 'sent', 'send', 'log', 'logged', 'console',
  ]);

  function mtTokens(normText) {
    const raw = String(normText || '').split(' ').filter(Boolean);
    const keep = (t) => !MT_STOP.has(t) && (t.length >= 3 || /^\d+$/.test(t));
    let toks = raw.filter(keep);
    const lean = toks.filter((t) => !MT_DOMAIN_STOP.has(t));
    if (lean.length) toks = lean;
    return toks.length ? toks : raw;
  }

  // Ids are the highest-signal tokens there are; long common words get a
  // gentle length bonus so specific terms outweigh filler.
  function mtWeight(t) {
    if (/^\d{4,}$/.test(t)) return 3;
    return 1 + Math.min(t.length, 12) / 12;
  }

  // Longest-common-subsequence ratio over the pattern's tokens — an order
  // tiebreaker, not the primary signal (see mtScore).
  function mtLcsRatio(pTokens, lTokens) {
    const n = pTokens.length, m = lTokens.length;
    if (!n || !m) return 0;
    let prev = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(0);
      for (let j = 1; j <= m; j++) {
        cur[j] = pTokens[i - 1] === lTokens[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[m] / n;
  }

  // Coverage-weighted overlap between pattern tokens and line tokens, plus
  // substitution detection: a missed pattern token paired with an
  // unexplained line token is a SWAP (sibling metric), not an omission —
  // CRO metric names differ from their siblings by exactly one slot
  // ("hero_cta_click" vs "footer_cta_click"), so this is the single most
  // valuable guard in the whole engine.
  function mtScore(pTokens, lTokens) {
    const lineSet = new Set(lTokens);
    const patternSet = new Set(pTokens);
    const uniq = [...new Set(pTokens)];
    let hit = 0, total = 0;
    const missed = [];
    for (const t of uniq) {
      const w = mtWeight(t);
      total += w;
      if (lineSet.has(t)) { hit += w; continue; }
      const stem = t.length >= 5 && lTokens.some((x) => x.length >= 5 && (x.startsWith(t) || t.startsWith(x)));
      if (stem) { hit += w * 0.6; continue; }
      missed.push(t);
    }
    const coverage = total ? hit / total : 0;
    const order = mtLcsRatio(pTokens, lTokens);

    let substitution = null;
    if (missed.length) {
      const lineExtra = [...new Set(lTokens)].filter((t) => !patternSet.has(t) &&
        !(t.length >= 5 && uniq.some((p) => p.length >= 5 && (p.startsWith(t) || t.startsWith(p)))));
      if (lineExtra.length) substitution = missed[0] + '↔' + lineExtra[0];
    }

    return { coverage, order, score: coverage * 0.85 + order * 0.15, missed, substitution };
  }

  // ── Sensitivity tiers (global setting) ───────────────────────────────────
  const MT_SENSITIVITY = {
    strict: { minScore: 0.90, minCoverage: 0.95, numericVeto: true, substVeto: true },
    balanced: { minScore: 0.72, minCoverage: 0.80, numericVeto: true, substVeto: true },
    loose: { minScore: 0.55, minCoverage: 0.55, numericVeto: false, substVeto: false },
  };

  const MT_MODES = ['exact', 'contains', 'smart', 'regex'];
  const MT_SOURCES = ['manual', 'goal', 'legacy'];

  // ── Convert metric id — highest-signal path ──────────────────────────────
  // Convert always stamps the numeric metric id verbatim onto a fired goal
  // line. If the id is present, that alone is decisive — token overlap can
  // be poor and it still doesn't matter. If the line carries a DIFFERENT
  // 6+ digit id, that's a hard veto: it's provably a sibling metric, not a
  // fuzzy near-miss of this one.
  const MT_ANY_ID_RE = /(?<![0-9])\d{6,}(?![0-9])/;
  function mtEscapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function mtMatchConvertId(id, rawText) {
    const idRe = new RegExp('(?<![0-9])' + mtEscapeRe(String(id)) + '(?![0-9])');
    if (idRe.test(rawText)) return { hit: true, score: 1, reason: 'convert-id', missed: [], warning: null };
    if (MT_ANY_ID_RE.test(rawText)) return { hit: false, score: 0, reason: 'convert-id-mismatch', missed: [], warning: null };
    return null; // no id anywhere on the line — fall through to normal mode dispatch
  }

  // ── regex mode ────────────────────────────────────────────────────────────
  // A user-authored regex runs against up to METRICS_CAP lines per assertion
  // — catastrophic backtracking is a real hang, not a theoretical one. Cap
  // pattern length, cap tested text length, and memoize compilation.
  const _mtRegexCache = new Map();
  function mtCompileRegex(pattern) {
    if (_mtRegexCache.has(pattern)) return _mtRegexCache.get(pattern);
    let re = null;
    try { re = new RegExp(pattern, 'i'); } catch (_) { re = null; }
    _mtRegexCache.set(pattern, re);
    return re;
  }

  function mtMatchRegex(pattern, rawText, mode) {
    if (pattern.length > 400) {
      return { hit: false, score: 0, mode, reason: 'bad-regex', missed: [], warning: 'pattern too long (max 400 chars)' };
    }
    const re = mtCompileRegex(pattern);
    if (!re) return { hit: false, score: 0, mode, reason: 'bad-regex', missed: [], warning: 'invalid regular expression' };
    const testText = rawText.length > 4000 ? rawText.slice(0, 4000) : rawText;
    const hit = re.test(testText);
    return { hit, score: hit ? 1 : 0, mode, reason: hit ? 'regex' : 'no-match', missed: [], warning: null };
  }

  // ── smart mode ────────────────────────────────────────────────────────────
  const MT_NEG_RE = /\b(not|failed|error|blocked|skipped)\b/;

  function mtMatchSmart(normPattern, normText, cfg, mode) {
    const pTokens = mtTokens(normPattern);
    const lTokens = mtTokens(normText);

    // Guard: a single short token ("cta") must not fuzzy-match the world —
    // degrade to a plain substring test instead.
    const uniqP = [...new Set(pTokens)];
    if (uniqP.length < 2 && uniqP[0] && uniqP[0].length < 5) {
      const hit = normText.includes(normPattern);
      return { hit, score: hit ? 1 : 0, mode, reason: hit ? 'contains-short-token' : 'no-match', missed: [], warning: 'single short token — matched as substring' };
    }

    // Guard: every numeric pattern token must appear as a numeric line
    // token. Kills "checkout step 2" ~= "checkout step 3" outright, before
    // the token-overlap score ever gets a chance to look close.
    if (cfg.numericVeto) {
      const pNums = pTokens.filter((t) => /^\d+$/.test(t));
      const lNumSet = new Set(lTokens.filter((t) => /^\d+$/.test(t)));
      const missingNum = pNums.find((n) => !lNumSet.has(n));
      if (missingNum) {
        return { hit: false, score: 0, mode, reason: 'numeric-token-missing: ' + missingNum, missed: [missingNum], warning: null };
      }
    }

    const { coverage, order, score, missed, substitution } = mtScore(pTokens, lTokens);

    if (cfg.substVeto && substitution) {
      return { hit: false, score, mode, reason: 'token-substitution: ' + substitution, missed, warning: null };
    }

    // Dilution guard: a huge line (a stringified object, say) incidentally
    // containing a few pattern words is noise, not a match, unless coverage
    // is still very high.
    let minCoverage = cfg.minCoverage;
    if (lTokens.length > 25 * Math.max(pTokens.length, 1)) {
      minCoverage = Math.max(minCoverage, 0.9);
    }

    const hit = score >= cfg.minScore && coverage >= minCoverage;

    // Advisory only — never changes the verdict, just flags it for the
    // "recent fires" debugging feed.
    let warning = null;
    if (MT_NEG_RE.test(normText) && !MT_NEG_RE.test(normPattern)) {
      warning = 'line reads as a failure';
    }

    return { hit, score, mode, reason: hit ? 'smart' : 'below-threshold', missed, warning };
  }

  // ── mtMatch — the public entry point ─────────────────────────────────────
  // entry: { pattern, mode, convertMetricId }. opts: { sensitivity }.
  // Returns { hit, score, mode, reason, missed[], warning }.
  function mtMatch(entry, text, opts) {
    opts = opts || {};
    const sensitivity = MT_SENSITIVITY[opts.sensitivity] ? opts.sensitivity : 'balanced';
    const cfg = MT_SENSITIVITY[sensitivity];
    const mode = MT_MODES.includes(entry && entry.mode) ? entry.mode : 'contains';
    const pattern = (entry && entry.pattern) || '';
    const rawText = String(text == null ? '' : text);

    if (!pattern.trim()) {
      return { hit: false, score: 0, mode, reason: 'empty-pattern', missed: [], warning: null };
    }

    if (entry && entry.convertMetricId && mode !== 'regex' && mode !== 'exact') {
      const idRes = mtMatchConvertId(entry.convertMetricId, rawText);
      if (idRes) return Object.assign({ mode }, idRes);
    }

    if (mode === 'regex') return mtMatchRegex(pattern, rawText, mode);

    const normPattern = mtNormalize(pattern);
    const normText = mtNormalize(rawText);

    if (mode === 'exact') {
      const hit = !!normPattern && normPattern === normText;
      return { hit, score: hit ? 1 : 0, mode, reason: hit ? 'exact' : 'no-exact-match', missed: [], warning: null };
    }

    if (mode === 'contains') {
      if (!normPattern) {
        // Normalization emptied the pattern (pure punctuation, say) — fall
        // back to a raw substring test so it isn't a silent always-match.
        const hit = !!pattern && rawText.toLowerCase().includes(pattern.toLowerCase());
        return { hit, score: hit ? 1 : 0, mode, reason: hit ? 'contains-raw' : 'no-match', missed: [], warning: null };
      }
      const hit = normText.includes(normPattern);
      return { hit, score: hit ? 1 : 0, mode, reason: hit ? 'contains' : 'no-match', missed: [], warning: null };
    }

    // smart
    return mtMatchSmart(normPattern, normText, cfg, mode);
  }

  // ── List normalization / migration ───────────────────────────────────────
  // djb2 — stable across windows and across service-worker restarts, so two
  // panels migrating the same legacy string independently mint the SAME id.
  // Random ids here would race: each panel would mint a different id for the
  // same string, last write wins, and the losing panel's in-memory list would
  // carry ids that no longer exist in storage, orphaning any Track Metric
  // step pointed at one.
  function mtHash(s) {
    let h = 5381;
    const str = String(s);
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  const mtLegacyId = (pattern) => 'm_l_' + mtHash(pattern);
  const mtGoalId = (ticketKey, text) => 'm_g_' + mtHash((ticketKey || '') + ' ' + (text || ''));
  const mtNewId = () => 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function normalizeMetricEntry(raw) {
    if (typeof raw === 'string') {
      return {
        id: mtLegacyId(raw), label: '', pattern: raw,
        // 'contains' reproduces the pre-Tracker text.includes(value) rule
        // byte-for-byte — an existing install's assertions must not
        // silently loosen into fuzzy matching on upgrade.
        mode: 'contains',
        convertMetricId: null, enabled: true,
        source: 'legacy', reviewed: true, createdAt: 0,
      };
    }
    if (!raw || typeof raw !== 'object') return null;
    const pattern = typeof raw.pattern === 'string' ? raw.pattern
      : typeof raw.value === 'string' ? raw.value
        : typeof raw.text === 'string' ? raw.text : '';
    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : mtLegacyId(pattern || mtNewId()),
      label: typeof raw.label === 'string' ? raw.label : '',
      pattern,
      mode: MT_MODES.includes(raw.mode) ? raw.mode : 'contains',
      convertMetricId: raw.convertMetricId ? String(raw.convertMetricId) : null,
      enabled: raw.enabled !== false,
      source: MT_SOURCES.includes(raw.source) ? raw.source : 'manual',
      reviewed: raw.reviewed !== false,
      // Default 0, NOT Date.now() — a stamped-on-read default would make
      // this function non-idempotent and defeat the write-back guard that
      // stops N open panels ping-ponging writes through storage.onChanged.
      createdAt: Number(raw.createdAt) || 0,
    };
  }

  function normalizeMetricsList(raw) {
    const out = [], seen = new Set();
    for (const r of (Array.isArray(raw) ? raw : [])) {
      const e = normalizeMetricEntry(r);
      if (!e) continue;
      while (seen.has(e.id)) e.id = mtNewId(); // repair a corrupted duplicate-id write
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }

  g.mtNormalize = mtNormalize;
  g.mtTokens = mtTokens;
  g.mtMatch = mtMatch;
  g.MT_MODES = MT_MODES;
  g.MT_SOURCES = MT_SOURCES;
  g.MT_SENSITIVITY = MT_SENSITIVITY;
  g.MT_TAGS = MT_TAGS;
  g.mtHash = mtHash;
  g.mtLegacyId = mtLegacyId;
  g.mtGoalId = mtGoalId;
  g.mtNewId = mtNewId;
  g.normalizeMetricEntry = normalizeMetricEntry;
  g.normalizeMetricsList = normalizeMetricsList;
})(typeof globalThis !== 'undefined' ? globalThis : this);
