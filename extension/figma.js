// figma.js -- Figma URL parsing, board selection, and node-tree reading.
// Pure JS, no DOM, no network, no LLM anywhere in this file. Same global-
// attachment convention as vd-config.js/vd-diff.js/metric-match.js:
// (function(g){...})(globalThis), loaded via importScripts in background.js
// and via <script src> in both popup.html and sidepanel.html, BEFORE
// popup.js.
//
// Deliberately regex-based rather than URL/URLSearchParams. jsc -- which runs
// the unit suite with no browser -- has neither (verified: both are
// `undefined` there), and the same parser has to give identical answers in
// the service worker, the panel, and a test run. A parser that can only be
// exercised inside Chrome is a parser whose edge cases never get tested.
//
// Figma is a REFERENCE source for the existing control-vs-variant scan, not a
// second comparison: nothing here produces findings, and nothing here feeds
// the diff engine. See the plan's scope decision (2026-08-27) and
// figma-ab-phase2-revised.md for the comparison design that was deferred.
(function (g) {
  'use strict';

  // -- URL parsing ---------------------------------------------------------
  // Both URL shapes Figma has shipped:
  //   figma.com/design/{key}/{slug}?node-id=40001337-575   (current)
  //   figma.com/file/{key}/{slug}?node-id=40001337%3A575   (older)
  // Matched on host + path prefix so a link to figma.com/pricing or a
  // community page can never be mistaken for a design reference.
  var FIGMA_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*figma\.com\/(design|file|proto)\/([A-Za-z0-9]+)(?:\/|\?|#|$)/i;

  // A node id is exactly two integers joined by one separator. Figma writes
  // the separator three ways depending on where the link came from: a literal
  // colon, a percent-encoded colon, or a hyphen (what the "Copy link" button
  // produces today). The API only accepts the colon form, so everything
  // normalizes to that.
  //
  // Split-and-rejoin rather than a blind replace: a blind `-` -> `:` would
  // silently mangle anything that is not the two-integer shape into something
  // that still LOOKS like a node id, and the resulting 404 would read as a
  // permissions problem rather than a parse bug.
  function figmaNormalizeNodeId(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    s = s.replace(/%3A/gi, ':');
    var parts = s.split(/[:-]/);
    if (parts.length !== 2) return null;
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
    return parts[0] + ':' + parts[1];
  }

  // Returns { fileKey, nodeId, kind } or null. nodeId is null when the link
  // points at the file root rather than a specific node -- a real case (a
  // bare file link), and the caller decides whether that is usable.
  function figmaParseUrl(url) {
    var s = String(url == null ? '' : url).trim();
    var m = FIGMA_URL_RE.exec(s);
    if (!m) return null;
    var q = /[?&]node-id=([^&#]+)/i.exec(s);
    return {
      fileKey: m[2],
      nodeId: q ? figmaNormalizeNodeId(decodeURIComponent(q[1])) : null,
      kind: m[1].toLowerCase(),
    };
  }

  function figmaIsDesignUrl(url) {
    return !!figmaParseUrl(url);
  }

  // -- Ticket extraction ---------------------------------------------------
  // Picks the design link out of a ticket's link inventory. Returns
  // { pick, candidates } where pick is the parsed winner or null.
  //
  // A link naming a specific node beats a bare file link, and it is not
  // close: the WOW comps live in a shared master file, so a bare file link
  // resolves to thousands of nodes across every ticket's boards, while a
  // node link resolves to exactly the comp container someone meant to share.
  //
  // `candidates` carries every DISTINCT design link found, so the caller can
  // warn when a ticket has more than one rather than silently taking the
  // first. Distinct by fileKey+nodeId, not by raw URL -- the same board gets
  // pasted with different tracking params all the time, and warning about
  // that would be noise.
  function figmaPickDesignUrl(urls) {
    var seen = Object.create(null), candidates = [];
    var list = Array.isArray(urls) ? urls : [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!raw) continue;
      var parsed = figmaParseUrl(raw);
      if (!parsed) continue;
      var key = parsed.fileKey + '#' + (parsed.nodeId || '');
      if (seen[key]) continue;
      seen[key] = 1;
      candidates.push({ url: String(raw).trim(), fileKey: parsed.fileKey, nodeId: parsed.nodeId, kind: parsed.kind });
    }
    var pick = null;
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].nodeId) { pick = candidates[j]; break; }
    }
    if (!pick && candidates.length) pick = candidates[0];
    return { pick: pick, candidates: candidates };
  }

  // Comp attachment matching against the `{TICKET}_comp` house convention.
  // Deliberately loose about separators and case, because the convention is a
  // habit rather than a rule -- and deliberately strict about everything
  // else.
  //
  // Returns { match, candidates }. A SINGLE match is used. Zero or several
  // return match:null with every image attachment listed, for the caller to
  // offer with none pre-selected. Never auto-select a filename that does not
  // fit the pattern: that is exactly how a QA screenshot ends up driving the
  // comparison, and a wrong comp is worse than no comp because it looks like
  // it worked.
  var COMP_IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

  function figmaNormalizeFilename(name) {
    return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function figmaMatchCompAttachment(attachments, ticketKey) {
    var list = Array.isArray(attachments) ? attachments : [];
    var images = [], matches = [];
    var wantKey = figmaNormalizeFilename(ticketKey);

    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.filename) continue;
      var isImage = COMP_IMAGE_RE.test(a.filename) || /^image\//i.test(a.mimeType || '');
      if (!isImage) continue;
      var entry = {
        filename: a.filename, mimeType: a.mimeType || null,
        size: a.size == null ? null : a.size, content: a.content || null, id: a.id || null,
      };
      images.push(entry);
      // Strip the extension before normalizing so `.png` can't accidentally
      // satisfy part of the pattern.
      var base = figmaNormalizeFilename(String(a.filename).replace(COMP_IMAGE_RE, ''));
      if (wantKey && base.indexOf(wantKey) === 0 && base.slice(wantKey.length).indexOf('comp') === 0) matches.push(entry);
    }

    return { match: matches.length === 1 ? matches[0] : null, matches: matches, candidates: images };
  }

  // -- Node tree reading ---------------------------------------------------
  // All text under a node, in document order. Figma puts the string on TEXT
  // nodes as `characters`; every container type just holds children. Used for
  // the Variation labels below, and it is the same shape a future converter
  // would read, so it lives here rather than inline at the call site.
  function figmaNodeText(node, out) {
    var acc = out || [];
    if (!node || typeof node !== 'object') return acc;
    if (node.visible === false) return acc;
    if (node.type === 'TEXT' && node.characters) acc.push(String(node.characters));
    var kids = node.children;
    if (Array.isArray(kids)) for (var i = 0; i < kids.length; i++) figmaNodeText(kids[i], acc);
    return acc;
  }

  function figmaNodeTextJoined(node) {
    return figmaNodeText(node).join(' ').replace(/\s+/g, ' ').trim();
  }

  // -- Board identification ------------------------------------------------
  // House convention, from the round-1 pull: `v1 Desktop (1440px)`,
  // `v0 Mobile (375px)`. The parenthesised width is a NOMINAL LABEL a designer
  // typed, not a measurement -- callers must take real geometry from
  // absoluteBoundingBox and never from this. It is parsed only so a
  // diagnostic can say when the two disagree, which is itself worth knowing.
  var BOARD_NAME_RE = /^\s*(v\d+)\b[\s._-]*(desktop|mobile|tablet)?[\s._-]*(?:\(\s*(\d+)\s*px\s*\))?/i;

  function figmaParseBoardName(name) {
    var m = BOARD_NAME_RE.exec(String(name == null ? '' : name));
    if (!m) return null;
    return {
      variantId: m[1].toLowerCase(),
      breakpoint: m[2] ? m[2].toLowerCase() : null,
      nominalWidth: m[3] ? parseInt(m[3], 10) : null,
    };
  }

  // FRAME/COMPONENT/COMPONENT_SET are the types a board can be. GROUP is
  // deliberately excluded: the round-1 container held `Group 1`/`Group 2`
  // sitting between the real boards in layer order, and treating those as
  // boards is exactly the phantom this filter exists to prevent.
  var BOARD_TYPES = { FRAME: 1, COMPONENT: 1, COMPONENT_SET: 1 };

  function figmaBoardGeometry(node) {
    var b = node && node.absoluteBoundingBox;
    if (!b) return null;
    return {
      x: Math.round(b.x), y: Math.round(b.y),
      w: Math.round(b.width), h: Math.round(b.height),
    };
  }

  // Every direct child of the comp container, classified. Returns BOTH the
  // boards and the rejects, with a reason on each reject -- a silent filter
  // here would be indistinguishable from a board that does not exist, and the
  // round-1 container had four unnamed frames and a stray rectangle parked
  // beside the real boards.
  function figmaClassifyChildren(children) {
    var boards = [], labels = [], rejected = [];
    var list = Array.isArray(children) ? children : [];

    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n || typeof n !== 'object') continue;
      var entry = {
        nodeId: n.id || null, name: n.name || '', type: n.type || null,
        rect: figmaBoardGeometry(n),
      };

      if (n.visible === false) { rejected.push(Object.assign({ reason: 'not visible' }, entry)); continue; }

      // Read the Variation labels before the board filter rejects them: they
      // are the board -> variant mapping and the only human-written
      // description of the change anywhere on the comp, which makes them the
      // link-sourced input for the Summary of Changes autofill.
      if (/^variation\b/i.test(entry.name)) {
        var text = figmaNodeTextJoined(n);
        labels.push(Object.assign({ text: text }, figmaParseVariationLabel(text), entry));
        continue;
      }

      if (!BOARD_TYPES[entry.type]) { rejected.push(Object.assign({ reason: 'not a frame/component' }, entry)); continue; }

      var parsed = figmaParseBoardName(entry.name);
      if (!parsed) { rejected.push(Object.assign({ reason: 'name does not match v{n} convention' }, entry)); continue; }

      boards.push(Object.assign({}, entry, parsed, {
        // The number that is allowed to drive anything. Kept beside
        // nominalWidth precisely so a mismatch is visible rather than
        // averaged away.
        measuredWidth: entry.rect ? entry.rect.w : null,
        widthDisagrees: !!(parsed.nominalWidth && entry.rect && parsed.nominalWidth !== entry.rect.w),
      }));
    }

    return { boards: boards, labels: labels, rejected: rejected };
  }

  // "V0 CONTROL" / "V1 DETAILED OFFER CARDS" -> { variantId, changeName }.
  // Round-1 open question #3 asked whether this format is universal; it is
  // not assumed to be. A label that does not match still keeps its raw text,
  // and the caller reports the miss rather than dropping the label.
  function figmaParseVariationLabel(text) {
    var m = /^\s*(v\d+)\b[\s:._-]*(.*)$/i.exec(String(text == null ? '' : text));
    if (!m) return { variantId: null, changeName: null };
    return {
      variantId: m[1].toLowerCase(),
      changeName: (m[2] || '').trim() || null,
    };
  }

  // Desktop board for a given variant id. Mobile is parsed and returned by
  // figmaClassifyChildren but never selected here -- nominal 375 against a
  // real 390/414 capture makes every geometry read drift, and the scope
  // decision is desktop-only until that is handled deliberately.
  function figmaSelectDesktopBoard(boards, variantId) {
    var want = String(variantId == null ? '' : variantId).toLowerCase();
    var list = Array.isArray(boards) ? boards : [];
    var exact = null, unlabelled = null;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.variantId !== want) continue;
      if (b.breakpoint === 'desktop') { if (!exact) exact = b; continue; }
      // A board with no breakpoint in its name is the fallback for round-1
      // open question #4 -- some comps name boards `v1` with no qualifier at
      // all. Only used when no explicit Desktop board exists, and the caller
      // is told which happened.
      if (!b.breakpoint && !unlabelled) unlabelled = b;
    }
    if (exact) return { board: exact, via: 'name' };
    if (unlabelled) return { board: unlabelled, via: 'fallback-no-breakpoint' };
    return { board: null, via: null };
  }

  g.figmaPickDesignUrl = figmaPickDesignUrl;
  g.figmaMatchCompAttachment = figmaMatchCompAttachment;
  g.figmaNormalizeFilename = figmaNormalizeFilename;
  g.figmaParseUrl = figmaParseUrl;
  g.figmaIsDesignUrl = figmaIsDesignUrl;
  g.figmaNormalizeNodeId = figmaNormalizeNodeId;
  g.figmaNodeText = figmaNodeText;
  g.figmaNodeTextJoined = figmaNodeTextJoined;
  g.figmaParseBoardName = figmaParseBoardName;
  g.figmaParseVariationLabel = figmaParseVariationLabel;
  g.figmaClassifyChildren = figmaClassifyChildren;
  g.figmaSelectDesktopBoard = figmaSelectDesktopBoard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
