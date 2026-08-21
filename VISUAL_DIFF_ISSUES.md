# A/B Visual Diff — Known Issues (all 10 fixed 2026-08-17, unverified on a real page)

> **2026-08-18 — this whole document now describes a RETIRED pipeline.**
> Everything below (row-hash alignment, pixelmatch region detection, the
> `VIS_PAD`/`VIS_ROWHASH_*`/`VIS_MAX_REGIONS_TOTAL`-style tuning constants,
> the single-Sonnet-call-per-batch classification) was deleted and replaced
> with a 3-stage LLM pipeline (Sonnet scrapes each page → a deterministic
> local diff compares the two scrapes → Opus classifies and writes the
> report) — see `CHANGELOG.md`'s `## 2026-08-18` entry for the full design
> and reasoning. Every fix recorded below is still historically accurate
> (each really was a real bug in the pipeline that existed *at the time*),
> and several of the underlying lessons (don't let a pixel-diff pipeline
> silently swallow a skip reason; keep Control resolution consistent across
> two independent code paths; watch for false-positive/false-negative
> alignment at merge boundaries) carried forward into the new design's own
> test coverage — but none of the *code* this document references still
> exists. Kept as a historical record, not as a description of current
> behavior.

> **Status update — all 10 findings below have been fixed in the working tree.**
> Each fix is described in the "What was done" note appended to its section.
> Every fix is still **static-only**: verified by re-reading the code, a
> jsc unit test over `collapseAdjacentModifiedPairs`/`opsToBlocks`, and a
> parse check of both files. **None of it has been run against the loaded
> extension on a real page** — the manual test matrix in step 4 of "Suggested
> order of attack" is still outstanding and is the only thing that will
> confirm the reported symptom is actually gone.
>
> The original findings text is left intact below as the record of what was
> wrong and why.

## Finding #11 — found via a live manual test, fixed same day

The user ran a real comparison against two OnDeck URLs with a genuine, large
visual difference (a full hero redesign) and Visual Diff reported nothing —
not even a skip reason, just an absent section. Two bugs, found in sequence:

1. **`runVisualDiffPass`'s three early-return skip paths never rendered.**
   `!ctx?.reviewed`, `baselineIdx === -1`, and a failed-Control-capture check
   all returned `{skipped, reason}` as data with no call to
   `renderAbVisualDiff` — `#ab-visual-diff-block` stayed exactly as
   `renderAbResults` initialized it: empty. Fixed with a `bail()` helper that
   renders before returning on all three paths. This is what surfaced the
   real cause below.
2. **Control identification requires a forcing param that a Control URL often
   won't have.** `resolveTicketVariantForUrl` only resolves a URL to a ticket
   variant via `optimizely_x=`/`_conv_eforce=` in the query string
   (`expExtractForcedVarId`). The user's Control target
   (`http://ondeck.com/soc/b`) was a plain, unforced production URL — a normal
   way to express "Control," not an edge case — so it could never match, and
   the whole pass bailed via the same `baselineIdx === -1` path fixed above.

**Fix:** `resolveControlLabel` (single caller) replaced with
`resolveAbBaseline(ctx, items)`, used by both `runAbComparison` (pre-capture,
for the noise-baseline double-capture) and `runVisualDiffPass` (post-capture).
Ticket resolution still wins; when it can't decide, the first target is
assumed, with a visible warning naming which target was assumed, folding in
`expBuildLabelMap`'s own diagnostic `notes` (previously built and silently
discarded at both call sites). Per-variant, a target with no matching ticket
spec text is no longer skipped either — it still gets the pixel diff and AI
comparison, told explicitly there's no spec (`buildVisualDiffPrompt`'s new
no-spec branch), with every finding pinned to `unclear` (schema already
allowed it; `runOneVisionBatch` also coerces server-side as a backstop against
the model ignoring the instruction). `noSpecText` is stamped on
background.js's own response (not just computed transiently in popup.js) so
it survives into the checkpoint and a resumed row doesn't lose the marker.

One rendering trap this surfaced: `abSection`'s delta-count badge renders 0 as
a collapsed, green "Identical" row — exactly what an all-`unclear` no-spec
result would produce using `unexpected.length` as the count. Fixed by
counting `unclear` instead of `unexpected` specifically on `noSpecText` rows,
otherwise the fix would have reproduced the same "says identical when it
isn't" complaint one layer down.

**Deliberately not done:** a design-review pass (run in parallel, after the
plan was already approved) proposed a smarter middle layer — matching a
target's URL directly against the ticket's own Control preview link
(`ctxControlLink`) before falling back to "assume the first target." That
would resolve this exact ticket's Control *without* a warning, since a
Control preview link is very often the same unforced URL. It's a good
follow-up, not folded in here to avoid expanding an already-approved fix
after the fact.

Verification is static only, same caveats as the rest of this document —
confirmed by re-reading every call site, not by loading the extension.

---

# Original punch list (as written before the fixes)

Punch list from a code review triggered by a user report: **"i'm not getting the
results i want with the a/b test tab when running a comparison"** — narrowed via
follow-up to: the test completes, but Visual Diff results are wrong (cropped
images misaligned/mismatched between Control and Variant, and/or the AI's
classification/note text doesn't match what actually changed).

(At the time this was written, nothing below had been fixed — see the status
block above.) See `CHANGELOG.md`'s `## 2026-08-17` entry for full
context on the pipeline architecture (row-hash alignment, pixelmatch, baseline
subtraction, ranking, batching, checkpointing) — this doc only covers what's
*wrong* with it.

All 10 findings below were independently confirmed by directly reading the
current code (not just trusting the review agents that first surfaced them).
8 are marked **CONFIRMED** (verified by tracing the exact execution path).
2 are marked **PLAUSIBLE** (the code pattern is clearly present and risky, but
the exact runtime interleaving wasn't traced step by step).

None of this has been run against the real, loaded extension — `chrome://
extensions` and `chrome-extension://` pages are outside the sandbox this was
built in. Everything here is from static reading, not observed behavior.

---

## Priority tier 1 — most likely explains the reported symptom

### 1. Row-shift misalignment when a "modified" block's two sides differ in height
**File:** `extension/background.js` — `collapseAdjacentModifiedPairs` (~line 1862), `diffBlockBanded` (~line 2032)
**Verdict:** CONFIRMED

`collapseAdjacentModifiedPairs` merges an adjacent delete+insert pair into one
`'modified'` block whenever their heights differ by no more than
`VIS_MODIFY_PAIR_TOLERANCE_PX` (24px) — this is what lets an ordinary in-place
edit (e.g. a headline that wraps differently) get pixel-diffed instead of
misreported as a structural change. But `diffBlockBanded` then reads both
sides using **one constant `yOffset`** and clamps to
`blockH = Math.min(aHeight, bHeight)`.

**Failure scenario:** A variant's headline wraps to one extra line, adding
~20px inside a merged block. Every row after the wrap point is actually offset
~20px more than the block's single `yOffset` accounts for, so pixelmatch
compares the wrong rows for the rest of the block — real differences get
masked as row-shift noise, spurious diff boxes appear, and the taller side's
last ~20px of real content (past `blockH`) is never read, diffed, or cropped
at all. This is probably the single most likely explanation for "the crop/
verdict doesn't match what actually changed," since any text reflow triggers it.

**Fix direction:** Don't treat a height-mismatched merge as a single uniform
block. Either diff the shared `min(aHeight,bHeight)` prefix normally and treat
the taller side's remaining tail as its own small region/finding, or drop the
uniform-offset assumption and re-align within the block.

**What was done:** first option. `collapseAdjacentModifiedPairs` now emits the
`'modified'` block over only the SHARED-height prefix (`min` of the two band
counts) and pushes the taller side's tail as its own `insert`/`delete` op
(zero-width on the other side). The tail is no longer silently outside every
block. Since a residual is ≤ `VIS_MODIFY_PAIR_TOLERANCE_PX` (24px) it falls
under `VIS_MIN_INOUT_BLOCK_PX` (40px) and `buildStructuralFindings` drops it
as an artifact — the same policy already applied to any other sub-threshold
insert/delete. Covered by a jsc unit test (both orderings, both taller sides,
past-tolerance pass-through, and block tiling with no gap). The within-block
row shift itself was NOT re-aligned — the two sides of a modified block are
known-different by construction, and the blocks below it carry their own
LCS-derived offsets, so top-aligning the shared prefix remains the behavior.

### 2. Padded crop box can bleed into an adjacent block's territory
**File:** `extension/background.js` — `diffBlockBanded` (~line 2069)
**Verdict:** CONFIRMED

The padded box is clamped only against the whole image
(`clampBox(..., w, controlH)`), never against the current row-hash block's own
`aY0..aY1` bounds. `VIS_PAD` (24px) can therefore push a box's edge into a
neighboring block — which may have a **different** `yOffset` (the control↔
variant vertical shift for that block).

**Failure scenario:** A variant deletes a 150px banner between two paragraphs
(the block after it has `yOffset = -150`). If that block also has a real
change within 24px of its own top edge, the resulting box's padding reaches
back into the deleted banner's old rows but is still cropped on the variant
side using -150. Control and Variant crops for that one region show different,
unrelated locations on the page — the "misaligned crops" the report described.

**Fix direction:** Clamp the padded box against `block.aY0`/`block.aY1` (not
just the full image) before or in addition to the existing `clampBox` call.

**What was done:** as directed, with one refinement. `diffBlockBanded` now
clamps the padded box's top to `block.aY0` and its bottom to
`block.aY0 + blockH` — `blockH`, i.e. the SHORTER of the two sides, rather
than `block.aY1`, so the variant-side crop at `y + yOffset` is guaranteed to
land inside the block on both sides for a height-mismatched `'modified'`
block too. The existing whole-image `clampBox` call is kept on top of it.

### 3. Two independent, disagreeing mechanisms for "which target is Control"
**File:** `extension/popup.js` — `diffAbCaptures`/`renderAbResults` (~line 3076), `resolveControlLabel`/`resolveTicketVariantForUrl` (~lines 2425-2441)
**Verdict:** CONFIRMED

The deterministic sections always treat `captures[0]` (whichever target is
first in the user's list) as "the baseline" and print `Baseline:
${captures[0].label}`. Visual Diff instead resolves Control by matching each
capture's URL against the ticket's forced-variant-id convention — a
completely separate, order-independent mechanism.

**Failure scenario:** If targets aren't in Control-first order (easy to end up
this way — "Fill from ticket" populates targets in whatever order
`ctx.previewLinks` came back in, nothing sorts Control to index 0), the
panel's `Baseline: X` header names one target while `Visual Diff vs Y` names a
different one. Worse: if `resolveTicketVariantForUrl` fails to match a
variant's URL to its ticket entry at all (e.g. a manually-typed URL with no
recognizable forcing parameter), that variant's `ticketVariantText` sent to
the model is wrong or missing — producing classifications/notes that don't
correspond to the real spec.

**Fix direction:** Make `diffAbCaptures`/`renderAbResults` use the same
ticket-resolved Control (when available) instead of blindly using
`captures[0]`, or at minimum surface a visible warning when the two disagree.

**What was done:** first option, implemented by reordering rather than by
threading a baseline index through `diffAbCaptures` (which assumes index 0 in
a dozen places). `runAbComparison` now moves the capture matching the
already-resolved `controlLabel` to index 0 before calling `renderAbResults`,
`runVisualDiffPass`, and before storing `_abLastRun` — so the two mechanisms
agree by construction and the report-replay path inherits the same order.
Only applies when Visual Diff is on, since that's the only time
`controlLabel` is resolved; with it off there is no second mechanism to
disagree with. Verified no code couples result order to `abState.targets`
order (`abHeatmapEligibleCaptures` filters by `tabId`, not index).

The second half of this finding — a variant whose URL doesn't resolve to a
ticket entry getting wrong spec text — turned out to be already handled:
`runVisualDiffPass` skips any variant whose `ticketText` is empty with "No
matching ticket variant spec text for this target URL." No change needed.

### 4. Self-contradicting "no differences" message
**File:** `extension/background.js` — `compareVisualRegions` handler (~line 4265)
**Verdict:** CONFIRMED

When `!diff.boxes.length`, the handler hardcodes
`note: 'No visible differences detected.'` without checking whether
`diff.structuralFindings` is non-empty.

**Failure scenario:** A variant that only adds or removes a whole content
block (no other pixel-level diffs anywhere) produces zero boxes but one or
more structural findings. The panel shows "No visible differences detected."
directly next to a line describing "The variant adds ~200px of content around
y=1200" — a self-contradicting result a user would reasonably call "wrong."

**Fix direction:** Only use the "no differences" note when *both*
`diff.boxes` and `diff.structuralFindings` are empty.

**What was done:** as directed, plus the matching renderer guard. The handler
emits "No visible differences detected." only when `structuralFindings` is
empty, and otherwise "No pixel-level differences detected outside the
structural changes below." `renderAbVisualDiff` had a second, independent
copy of the same sentence as its empty-body fallback (`v.note ? '' : …`),
which would have contradicted the structural lines on the no-verdict path —
that condition now also checks `v.structuralFindings`.

---

## Priority tier 2 — real bugs, lower odds of being today's specific cause

### 5. Noise-mask anchor uses the wrong image's coordinate space
**File:** `extension/background.js` — `computeControlNoiseMask` (~line 2120)
**Verdict:** CONFIRMED (narrower trigger — needs prior divergence between Control's two loads)

For an `insert`-type block, `anchorY = block.bY0` — a row index in the
*second* Control capture's (`bi2`) coordinate space — but it's used to mark
rows noisy in `mask`, which is sized/indexed in the *first* capture's (`bi`)
space.

**Failure scenario:** If `bi`/`bi2` have already diverged anywhere earlier on
the page (e.g. an ad slot's height jitters 40px between Control's two
back-to-back loads), a later insert block's `bY0` no longer corresponds to the
same real row in `bi`. The noise mask marks the wrong band of rows — either
failing to suppress real Control jitter, or spuriously suppressing a genuine
variant change.

**Fix direction:** Use `block.aY0` consistently (it's still a valid,
zero-width anchor in `bi`'s own space for an insert block) instead of `bY0`.

**What was done:** as directed — `anchorY` is now unconditionally
`block.aY0`. One additional change was required by fix #1: since
`collapseAdjacentModifiedPairs` now emits a residual insert/delete for every
height-mismatched merge, the unconditional ±60px
(`VIS_NOISE_STRUCTURAL_MARGIN_PX`) noise band would have fired on ordinary
jitter and blanked 120px of the page per occurrence, suppressing real variant
changes. The full margin is now used only for blocks at or above
`VIS_MIN_INOUT_BLOCK_PX` — i.e. the ones `buildStructuralFindings` also
considers real; smaller ones get a margin of their own height instead.

### 6. Region index double-offset across vision-call batches
**File:** `extension/background.js` — `buildRegionCrops` (~line 2275), `runOneVisionBatch` (~line 2314), `compareVisualRegions` handler merge (~line 4310)
**Verdict:** CONFIRMED, deterministic — but currently invisible in the UI (see failure scenario)

`buildRegionCrops` assigns each region a **global** index before batching.
`runOneVisionBatch`'s merge spreads `flattenBox(r)` last, so the returned
region already carries the correct global index. The handler then does
`r.regions.map(x => ({ ...x, index: batchStart + x.index }))` — adding
`batchStart` a **second** time on top of an already-global value.

**Failure scenario:** A region at global position 5 (batch 2, `batchStart=4`)
ends up stamped `index: 9`. Nothing in `renderAbVisualDiff` currently reads
`.index` for display, so this doesn't show up visually today — but the
corrupted value is written into the `chrome.storage.local` checkpoint, the one
mechanism that exists specifically to correlate a resumed finding back to its
region. Silently breaks that correlation for any variant needing more than
one batch (routine once more than 4 regions are kept).

**Fix direction:** Drop the `batchStart +` addition in the handler — the index
is already global by the time `runOneVisionBatch` returns it.

**What was done:** as directed. `batchStart` is still accumulated, because
`analyzedRegionCount` reports it.

### 7. Partial batch failure still checkpoints the variant as fully done
**File:** `extension/background.js` — `compareVisualRegions` handler (~line 4334)
**Verdict:** CONFIRMED

When a non-abort batch failure occurs (`batchError = r.error; break;`),
`stoppedEarly` is never set true, so `status: stoppedEarly ? 'stopped' :
'done'` records `'done'` even though only some batches ran.

**Failure scenario:** Batch 2 of 3 hits a transient API error. The checkpoint
is stamped `done` with `analyzedRegionCount` short of `keptRegionCount`. On
Resume, `runVisualDiffPass` sees `status:'done'` and skips re-analysis for
that variant entirely — the un-run batch's regions (possibly containing the
real regression) are never evaluated, with no indication anything was skipped.

**Fix direction:** Treat a `batchError` outcome as its own status (e.g.
`'partial'`), and have the resume check re-run anything not strictly `'done'`.

**What was done:** as directed. The per-variant status is now
`stoppedEarly ? 'stopped' : (batchError ? 'partial' : 'done')`. The resume
check needed no change — `runVisualDiffPass` already tests
`prior?.status === 'done'` strictly, so `'partial'` re-runs.

### 8. Stop doesn't break the loop or mark the checkpoint incomplete
**File:** `extension/popup.js` — `runVisualDiffPass` (~line 3146)
**Verdict:** CONFIRMED

The Stop check uses `continue`, not `break`, so the loop still runs to its
natural end (marking each remaining variant "Stopped") and always reaches the
unconditional `finalizeVisualDiffCheckpoint(WIN_ID, runId)` call, which stamps
`status: 'completed'` regardless of whether Stop was pressed.

**Failure scenario:** A user clicks Stop after 1 of 3 variants finishes,
intending to resume later. Because the checkpoint always finalizes as
`'completed'`, the resume banner never appears for this run — the one
interruption path a user actually controls gets none of the checkpointing
feature's benefit. Only an involuntary crash/panel-close (which skips the
finalize call entirely) does.

**Fix direction:** `break` immediately on Stop, bulk-mark the rest as skipped,
and finalize with a status that reflects the interruption (not `'completed'`).

**What was done:** all three, as directed. `finalizeVisualDiffCheckpoint`
takes a `status` argument (default `'completed'`) and receives `'stopped'`
when the run was interrupted. One case the fix direction doesn't mention is
also covered: Stop pressed during the LAST variant's batches aborts inside
`background.js` and the loop then ends naturally with `stopped` still false,
so the finalize call checks `stopped || _abVisualDiffStopRequested`.
`checkForResumableVisualDiff` needed no change — it already shows the banner
for any status other than `'completed'`.

### 9. Visual Diff module state isn't locked per window
**File:** `extension/background.js` — `compareVisualRegions` handler (~line 4244), `runVariantComparison`
**Verdict:** PLAUSIBLE (needs two side-panel windows to trigger)

`runVariantComparison` (capture phase) is wrapped in `beginTmRun`/`endTmRun`,
which lock `_runWin` to the active window. `compareVisualRegions` (comparison
phase, called repeatedly afterward) is explicitly **not** wrapped in that
lock — but it reads shared, unscoped module state (`_visualDiffCaptures`,
`_visualDiffNoiseMaskCache`) that `runVariantComparison` resets to fresh Maps
at the top of every run.

**Failure scenario:** Two side-panel windows open (a supported case per
`winFollow`/`tabToWin`). Window B starts a new comparison while window A is
still mid-way through its own `compareVisualRegions` calls — window B's
`runVariantComparison` wipes the shared Maps out from under window A. Window
A's next call either fails cleanly, or (if both windows use matching default
labels like "Control"/"Variant A") silently gets served window B's page data.

**Fix direction:** Scope `_visualDiffCaptures`/`_visualDiffNoiseMaskCache` per
window (keyed by `winId`), mirroring the existing `ns(winId)` convention.

**What was done:** as directed. All three module Maps (captures, Control's
noise captures, and the noise-mask cache) are collapsed into one
`_visualDiffState` keyed by `winId`, reached through `vdState(winId)` /
`vdResetState(winId)`. `winId` is threaded through `runVariantComparison` →
`captureVariant` → `captureControlNoiseShot` and into
`getOrComputeControlNoiseMask`; the `clearVisualDiffCaptures` message now
carries `winId` so one panel's cleanup can't wipe another's captures.

### 10. Checkpoint storage has a cross-context write race
**File:** `extension/background.js` — `patchVisualDiffCheckpoint` (~line 2386), `extension/popup.js` — `setVisualDiffCheckpointRoot`/`finalizeVisualDiffCheckpoint`
**Verdict:** PLAUSIBLE (needs precise timing overlap to trigger)

Both files independently do `chrome.storage.local.get` → mutate
`all[winId]` → `chrome.storage.local.set` on the same shared
`visualDiffCheckpoints` blob, from two separate JS contexts (service worker
and panel document), with no locking between the read and the write.

**Failure scenario:** A popup.js write and a background.js write interleave —
one reads the blob before the other's write lands, then writes back its own
stale copy. The other side's just-written progress is silently overwritten,
with no error surfaced anywhere.

**Fix direction:** Route every checkpoint mutation through one context only
(e.g. popup.js sends a message instead of writing storage directly), or add a
simple write queue/mutex around the read-modify-write.

**What was done:** both. Every mutation now happens in `background.js`,
serialized through a promise-chain queue (`vdCheckpointTx`) that owns the
whole get → mutate → set cycle; the mutator returns `false` to skip the write
(that's how the `runId` guard aborts cleanly). `setVisualDiffCheckpointRoot` /
`finalizeVisualDiffCheckpoint` / `clearVisualDiffCheckpoint` moved there and
became message handlers (`vdCheckpointRoot`/`…Finalize`/`…Clear`); popup.js's
same-named functions are now thin `sendMessage` wrappers. Reads
(`getVisualDiffCheckpoint`) stay local — a stale read is harmless. The three
wrappers swallow send failures so a service-worker restart mid-message can't
propagate into `runAbComparison`'s catch and blow away the rendered A/B
results, which the previous direct-storage writes could never do.

---

## Suggested order of attack

Steps 1–3 are done; **step 4 is the remaining work.**

1. Fix #1–#4 first — these are the ones most likely responsible for the
   reported symptom on a single, normal (non-Stop, single-window) run.
2. Fix #6–#8 together — they're all in the same checkpoint/batch-loop code
   and touch overlapping logic.
3. Fix #9–#10 together — both are the same underlying "shared state needs
   per-window scoping" problem, just manifesting in two different places.
4. Re-verify by loading the unpacked extension and running the manual test
   matrix from the rev2 plan (`~/.claude/plans/users-crometrics-ww-downloads-ab-visual-zippy-lagoon.md`,
   if it still exists) — nothing here has been confirmed against a real page yet.
