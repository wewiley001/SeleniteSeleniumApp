// Selenite Visual Diff debug overlay — injected on demand, console-only (see
// window.__vdDebug in popup.js). Draws one labeled rect per candidate from
// window.__seleniteVdCandidates (seeded by a preceding exec() call,
// background.js's own established pattern for feeding data into a
// files-based injection — see srInjectRecorder's window.__seleniteRecMove).
//
// Deliberately NOT a picker.js edit: picker.js is a live feature (the
// step-builder element picker), not overlay scaffolding, and mutating it to
// draw N simultaneous rects would risk that real feature for a debug tool's
// benefit. This copies its visual style only.
(function () {
  if (window.__seleniteVdOverlay) return;
  window.__seleniteVdOverlay = true;

  const candidates = window.__seleniteVdCandidates || [];
  const nodes = [];

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';

  const hint = document.createElement('div');
  hint.textContent = `Visual Diff candidates: ${candidates.length}   •   click anywhere or Esc to clear`;
  hint.style.cssText = [
    'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:2147483647', 'pointer-events:none',
    'background:rgba(0,0,0,.75)', 'color:#fff', 'font:12px/1.5 sans-serif',
    'padding:6px 14px', 'border-radius:20px',
    'box-shadow:0 2px 8px rgba(0,0,0,.4)',
  ].join(';');

  for (const c of candidates) {
    if (!c.rect) continue;
    const box = document.createElement('div');
    box.style.cssText = [
      'position:absolute', 'pointer-events:none', 'box-sizing:border-box',
      'border:1px solid #E0364C', 'background:rgba(224,54,76,0.08)',
    ].join(';');
    box.style.left = (c.rect.x - window.scrollX) + 'px';
    box.style.top = (c.rect.y - window.scrollY) + 'px';
    box.style.width = c.rect.w + 'px';
    box.style.height = c.rect.h + 'px';

    const badge = document.createElement('div');
    badge.textContent = `${c.candidateId} <${c.tag}>`;
    badge.style.cssText = [
      'position:absolute', 'top:-16px', 'left:0', 'pointer-events:none',
      'background:#E0364C', 'color:#fff', 'font:bold 9px/1.4 monospace',
      'padding:1px 4px', 'white-space:nowrap',
    ].join(';');
    box.appendChild(badge);
    overlay.appendChild(box);
    nodes.push(box);
  }

  document.body.append(overlay, hint);

  function cleanup() {
    overlay.remove();
    hint.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClick, true);
    window.__seleniteVdOverlay = false;
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } }
  function onClick(e) { e.preventDefault(); e.stopPropagation(); cleanup(); }

  document.addEventListener('keydown', onKey, true);
  // Captured on document, not `overlay` itself: overlay is pointer-events:none
  // so real page interaction still works until the user deliberately clears
  // the debug view via any click.
  document.addEventListener('click', onClick, true);
})();
