import { LinkerPluginSettings } from 'main';
import { App, MarkdownView, Menu, TFile } from 'obsidian';
import { convertVirtualLinkToReal } from './convertLink';
// The class lives in its own module now; it is imported back here because the
// helpers below are typed against it (and re-exported so existing imports of
// VirtualMatch from this file keep working).
import { VirtualMatch } from './virtualLinkMatch';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('main').default;

// ---------------------------------------------------------------------------
// Heading alignment after navigation
//
// A jump to a heading lands exactly on it, but content ABOVE the heading can
// still change height afterwards. Images, PDF++ crops and note embeds are
// covered by the size-reservation observers in main.ts; MathJax is not, and
// cannot be: the typeset size of a formula does not exist until it has been
// typeset, so there is nothing to reserve up front. In a note whose headings
// sit under many formulas the accumulated difference pushes the heading away
// again and the jump ends up at the wrong offset.
//
// Nothing can be reserved here, so watch instead of guess: keep the heading at
// the top of its scroller while the surface settles, and stop as soon as the
// user touches the page (they are reading, not waiting).
//
// The watch must NOT stop at the first quiet moment. A PDF embed waits with
// its RESERVED height and releases it when the real render lands - seconds
// later. That release shrinks everything above the heading, which is what
// pushes the heading ABOVE the viewport (the exact symptom this fixes).
// ---------------------------------------------------------------------------
const ALIGN_MAX_MS = 12000;       // call sites pass their own window
const ALIGN_DEBOUNCE_MS = 150;    // coalesce a burst of layout changes
const ALIGN_SAFETY_MS = 4000;     // backstop check for surfaces we cannot observe
// Ignore anything this close. It used to be 6 (sub-pixel jitter only), which
// made the watcher correct offsets nobody can see - each correction costs a
// scroll and reads as the view twitching. Matching the editor path's
// HEADING_EPSILON_PX so both agree on what counts as "in place".
const ALIGN_TOLERANCE_PX = 24;

/**
 * Where a heading of this height belongs when it is being actively CENTRED -
 * used by the preview path, where a popover opens at the link's position and
 * the heading can be anywhere (often scrolled just out of view above).
 */
function centeredOffset(scroller: HTMLElement, height: number): number {
    return Math.max(12, Math.round((scroller.clientHeight - height) / 2));
}
// How long the layout must hold still, with every image loaded, before the
// heading is moved. There is no event for "rendering finished" - PDF.js paints
// embeds and MathJax typesets without announcing it - so this is the closest
// available proxy for "rendered": a page whose content height has not changed
// and whose images have all loaded. Waiting costs a moment; the correction
// then lands on a page that has stopped moving, so ONE scroll is enough
// (each extra scroll is what CodeMirror answers with a measure restart, and
// what leaves the heading slightly off-centre).
const ALIGN_STABLE_MS = 1000;
// Every scroll can make the view mount content that had never been rendered,
// which moves things again - so late corrections are unavoidable. Worse, when
// CodeMirror hits its measure-restart limit it stalls: the content height then
// holds still while nothing is actually rendered, so "no change for a second"
// can be a false alarm. The answer is not to trust it once, but to keep
// watching afterwards and correct again whenever the page moves - each
// correction still has to wait for a full idle period, so this stays rare.

// A surface with no editor handle (a cm-scroller we cannot map to a view) gets
// at most this many direct scrollTop writes - more than that and the two would
// only fight over the position.
const DOM_WRITE_BUDGET = 6;
// The budget is per EPISODE: once the page has been quiet and then moves again
// (a late PDF landing, an image finishing) the count starts over, so a slow but
// well-behaved note is not cut off by spending the whole allowance on the first
// burst of changes. This ceiling still applies across the whole watch window, so
// a page that never stops moving cannot be corrected forever.
const DOM_WRITE_TOTAL_BUDGET = 30;

/**
 * "Is MathJax still typesetting?" - proxied by the number of finished formula
 * containers inside the surface. Images were the only "still rendering" signal
 * before, and a page of $$...$$ moves the layout for seconds without a single
 * one of them: the height keeps changing while every img reports complete.
 *
 * The check itself is throttled (one querySelectorAll at most every 800ms) and
 * only reacts to the COUNT of containers changing - typesetting an existing
 * formula does not create a new one, but it does not matter: the height-based
 * settled test catches that, this catches the "new formula just landed" bursts.
 */
/**
 * Height changes the plugin causes ITSELF.
 *
 * Reserving an embed's height (and releasing it again once the real content
 * measured) changes the layout on purpose. The watcher cannot tell that from
 * content genuinely landing - it just sees a resize - so it would "correct" a
 * drift that the reservation was in the middle of fixing. That loop (reserve ->
 * resize -> correct -> release -> resize -> correct) is what made alignment
 * twitchy on notes with embeds.
 *
 * Mark those moments and let the watcher sit them out.
 */
let selfInflictedUntil = 0;
export function markSelfInflictedLayout(ms = 500): void {
    selfInflictedUntil = Math.max(selfInflictedUntil, Date.now() + ms);
}
export function isSelfInflictedLayout(): boolean {
    return Date.now() < selfInflictedUntil;
}

export function createMathBusyWatcher(scroller: HTMLElement): () => boolean {
    let lastCount = -1;
    let changedAt = 0;
    return () => {
        const now = Date.now();
        if (now - changedAt > 800) {
            const n = scroller.querySelectorAll('mjx-container').length;
            if (lastCount >= 0 && n !== lastCount) changedAt = now;
            lastCount = n;
        }
        return now - changedAt < 1200;
    };
}

/**
 * The ROW that carries a heading, which is what Obsidian actually positions.
 *
 * In Live Preview the heading element is an inline span around the text only,
 * while the row (`.cm-line`) is what gets centred - and what heading decoration
 * plugins (padding, borders, icons) enlarge. Measuring the span aims a few
 * dozen pixels off, which reads as "not quite centred" and gets worse the more
 * decoration a heading carries.
 */
export function headingRowElement(el: HTMLElement): HTMLElement {
    return el.closest<HTMLElement>('.cm-line, h1, h2, h3, h4, h5, h6') ?? el;
}

function normalizeHeading(s: string): string {
    return s
        .replace(/^#+\s*/, '')                              // live preview keeps the markup text
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The element that actually scrolls this heading: the nearest ancestor that
 * can scroll. Picking by class name instead (`.cm-scroller`, `.markdown-preview-view`)
 * can land on a container that does not scroll at all - then setting scrollTop
 * does nothing and the heading never moves, which looks like a fixed offset.
 */
export function findScrollableAncestor(node: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = node.parentElement;
    while (cur) {
        if (cur.clientHeight > 0 && cur.scrollHeight > cur.clientHeight + 1) return cur;
        cur = cur.parentElement;
    }
    return null;
}

/**
 * The rendered heading element for `headingId` inside `scope`, if present.
 * A heading can carry decorations inside its element (a virtual-link suffix or
 * icon that the raw heading text does not have), so an exact match is tried
 * first and a "starts with" match second.
 */
export function findHeadingElement(scope: ParentNode, headingId: string): HTMLElement | null {
    const want = normalizeHeading(headingId);
    if (!want) return null;
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>(HEADING_SEL));
    const textOf = (el: HTMLElement) => normalizeHeading(el.getAttribute('data-heading') ?? el.textContent ?? '');
    for (const el of candidates) if (textOf(el) === want) return el;
    // Index entries built by older versions stored the heading as a lowercased,
    // dash-separated slug ("my heading" => "my-heading"). Such an id can still
    // reach this function - it is compiled into the virtual-link href - so the
    // slug form is accepted as well, instead of failing to find the heading and
    // letting the alignment centre a neighbour.
    const wantSlug = want.replace(/\s+/g, '-').toLowerCase();
    for (const el of candidates) if (textOf(el).replace(/\s+/g, '-').toLowerCase() === wantSlug) return el;
    for (const el of candidates) if (textOf(el).startsWith(want)) return el;
    // A link's headingId can carry a chapter-number prefix ("（六）牙痛") while
    // the rendered heading is the stripped "牙痛" (the chapter number is rendered
    // separately by the heading decorator). Fall back to "want ends with the
    // candidate", and the prefix must be short (a chapter number like "（六）" is
    // 3-6 chars).
    for (const el of candidates) {
        const t = textOf(el);
        if (t && want.endsWith(t) && want.length - t.length <= 8) return el;
    }
    return null;
}

/**
 * The heading a surface is currently scrolled to: the one crossing (or just
 * below) the top edge of its own scroller. A heading whose top edge sits ABOVE
 * the scroller top - i.e. one showing only its lower half - is included on
 * purpose: that is exactly the state this code has to repair.
 */

/**
 * Ask the CodeMirror editor that owns `el` to scroll to `headingText` - the
 * same call Obsidian makes for its own heading links (centred, `center = true`).
 *
 * Writing scrollTop into a cm-scroller instead fights the view: CM6 re-applies
 * its own scroll position on the next measurement, so the move partly undoes
 * itself, the next check finds the heading off again, and the repeated writes
 * make the view report "Measure loop restarted more than 5 times". Handing the
 * job to the editor avoids the fight entirely.
 *
 * Returns false when no editor could be resolved (the caller then falls back to
 * scrolling the container directly, which is correct for rendered surfaces).
 */
export function resolveHeadingTarget(
    app: App,
    el: HTMLElement | null,
    headingText: string,
    file?: TFile | null,
): { view: MarkdownView; line: number } | null {
    const want = normalizeHeading(headingText);
    if (!want) return null;

    // The heading's LINE comes from Obsidian's metadata cache, which is exact:
    // it does not depend on how the heading happens to be decorated in the DOM
    // (a virtual-link suffix, icons, hidden markup), which is what made text
    // matching fail and the alignment fall back to guessing a neighbour.
    // Dom text and source text can differ by decorations (a virtual-link
    // suffix or icon lands in the element's text), so the comparison allows
    // both directions - but only for a SHORT extra part, so that a shorter
    // heading can never swallow a longer one.
    const sameHeading = (candidate: string): boolean => {
        if (candidate === want) return true;
        if (candidate.startsWith(want)) return true;
        if (want.startsWith(candidate) && want.length - candidate.length <= 12) return true;
        // Chapter-number prefix: "（六）牙痛" (want) matches "牙痛" (candidate).
        return want.endsWith(candidate) && want.length - candidate.length <= 8;
    };
    const findLine = (file: TFile): number => {
        const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
        const hit = headings.find((h) => normalizeHeading(h.heading) === want)
            ?? headings.find((h) => normalizeHeading(h.heading).startsWith(want))
            ?? headings.find((h) => sameHeading(normalizeHeading(h.heading)));
        return hit ? hit.position.start.line : -1;
    };

    const targetFile = file ?? null;
    const candidates: { view: MarkdownView; line: number; preferred: boolean }[] = [];
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) continue;
        const shown = view.file;
        if (!shown) continue;
        const line = findLine(shown);
        if (line < 0) continue;
        // Preferred: the view that actually contains the element we measured,
        // or (when only the target file is known) the view showing that file.
        const preferred = el
            ? view.contentEl.contains(el)
            : !!targetFile && targetFile.path === shown.path;
        candidates.push({ view, line, preferred });
    }
    const pick = candidates.find((c) => c.preferred) ?? candidates[0];
    return pick ? { view: pick.view, line: pick.line } : null;
}

/**
 * The rendered ROW element of a heading, resolved through its metadata line
 * number instead of through its text.
 *
 * Text lookup is what breaks inside a CodeMirror surface: the row carries
 * decorations (heading decorator icons, a virtual-link suffix), so its
 * textContent is not the heading text. The line number comes from Obsidian's
 * metadata cache and stays exact no matter how the row is decorated, and
 * CodeMirror can return the row element for it.
 *
 * The editor is taken from `scope` itself, not from the view the line number
 * came from: a hover popover hosts its own editor and that view is not in the
 * workspace's leaf list at all, so it would always resolve to the main pane -
 * and centring a row in the wrong pane is exactly the kind of move this
 * function exists to avoid. Returns null while the row is not rendered (yet);
 * the caller then leaves the view alone and asks again.
 */
export function headingElementByLine(app: App, scope: HTMLElement | null, headingId: string): HTMLElement | null {
    const want = normalizeHeading(headingId);
    if (!want) return null;
    // Only the LINE NUMBER is taken from the metadata cache here (see above for
    // why its view is not used).
    const target = resolveHeadingTarget(app, scope, headingId, null);
    if (!target) return null;
    const root: ParentNode = scope ?? activeDocument.body;
    const cmEl = root.querySelector('.cm-editor');
    const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
    if (!cm) return null;

    const lineNumber = Math.min(target.line + 1, cm.state.doc.lines);
    // Verify the line by its SOURCE text - the rendered row carries decorations
    // (heading decorator icons, a virtual-link suffix), the source does not.
    // This is what turns a line number that belongs to a different file (the
    // same heading name can exist in two notes) into a miss instead of a move.
    const source = normalizeHeading(cm.state.doc.line(lineNumber).text);
    if (!source || (source !== want && !source.startsWith(want) && !want.endsWith(source))) return null;

    // BlockInfo carries no element in these typings, so go through domAtPos -
    // and then VERIFY the row: a position outside the viewport resolves to the
    // nearest rendered edge, and centring THAT row would be the very "wrong
    // neighbour" this function exists to prevent. posAtDOM tells us which line
    // the element really is, so a mismatch (or a node CodeMirror does not know)
    // simply means "not rendered right now" and the caller leaves the view
    // alone until a later check finds it in the viewport.
    const pos = cm.state.doc.line(lineNumber).from;
    const at = cm.domAtPos(pos);
    const node = at.node.nodeType === Node.TEXT_NODE ? at.node.parentElement : (at.node as HTMLElement | null);
    const row = node?.closest<HTMLElement>('.cm-line') ?? null;
    if (!row) return null;
    try {
        if (cm.state.doc.lineAt(cm.posAtDOM(row)).number !== lineNumber) return null;
    } catch {
        return null;
    }
    // Last line of defence: never hand back a row outside the surface that is
    // being aligned.
    if (scope && scope.isConnected && !scope.contains(row)) return null;
    return row;
}

/**
 * Centre a heading through the editor itself, waiting for the document to
 * render and repeating a few times while late content (images, PDF embeds,
 * formulas) lands underneath.
 *
 * Every attempt is the editor's own API, so repeating is free of side effects
 * and cannot fight the view - which is the whole point: this needs no layout
 * measurement and does not depend on finding the heading's DOM element, so a
 * link whose heading is known can never end up centred on a neighbour instead.
 */
export function keepEditorHeadingCentered(
    plugin: LinkerPluginType,
    anchorEl: HTMLElement | null,
    file: TFile | null,
    headingText: string,
    label = '',
    maxMs = ALIGN_MAX_MS,
): void {
    if (!headingText) return;
    const abort = new AbortController();
    const { signal } = abort;
    const stop = () => abort.abort();
    window.addEventListener('wheel', stop, { capture: true, passive: true, signal });
    window.addEventListener('mousedown', stop, { capture: true, signal });
    window.addEventListener('keydown', stop, { capture: true, signal });

    // Resolve the heading once the document has rendered, then hand over to the
    // editor's own measured loop (centerHeadingLine). A single "scroll to it"
    // call reports success even when the position does not hold, which is what
    // made the earlier attempts look fine and land nowhere.
    const start = (delay: number) => {
        if (signal.aborted) return;
        const target = resolveHeadingTarget(plugin.app, anchorEl, headingText, file);
        if (target) {
            plugin.centerHeadingLine(target.view, target.line, Math.max(4000, maxMs - delay));
        } else if (delay < maxMs) {
            window.setTimeout(() => start(delay + 1500), 1500);
        }
    };
    window.setTimeout(() => start(900), 900);
}

export function findHeadingAtTop(scope: HTMLElement | null, allowGlobalFallback = true): HTMLElement | null {
    const search = (root: ParentNode): HTMLElement | null => {
        const headings = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SEL));
        let best: HTMLElement | null = null;
        let bestDist = Infinity;
        for (const h of headings) {
            const scroller = findScrollableAncestor(h);
            if (!scroller) continue;
            const rect = h.getBoundingClientRect();
            const top = rect.top - scroller.getBoundingClientRect().top;
            const height = rect.height || 1;
            // Only headings the scroller is actually showing count as "the one
            // it was scrolled to" - a heading clipped at the top is included on
            // purpose, since that is the state this repairs.
            if (top < -height - 8 || top > scroller.clientHeight - 24) continue;
            // Identified by distance to the TOP EDGE, not to the final resting
            // position: that is where the jump leaves the heading, so this picks
            // the heading that was jumped to. (Measuring against the centred
            // target instead would often pick a neighbouring heading further
            // down - and then centre THAT one, which looks like the jump simply
            // never happened.)
            const dist = Math.abs(top);
            if (dist < bestDist) { bestDist = dist; best = h; }
        }
        return best;
    };
    if (scope && scope.isConnected) {
        const inScope = search(scope);
        if (inScope) return inScope;
    }
    // The global fallback is used only when the caller explicitly allows it: a
    // preview popover's target heading always lives inside the popover, and if we
    // fell back to document.body while its content was still rendering we would
    // pick up a heading from another leaf and align to that.
    return allowGlobalFallback ? search(document.body) : null;
}

/**
 * A live-preview heading is NOT an <h1..h6>: Obsidian renders the line as
 * `div.cm-line.HyperMD-header.HyperMD-header-N`, and only the reading view
 * produces real heading elements (with data-heading). Both are covered here -
 * matching only the tags is what made this find nothing in a popover.
 */
const HEADING_SEL = 'h1, h2, h3, h4, h5, h6, [data-heading], [class*="HyperMD-header"]';

// The numbered targets of a multi-file link (1|2|3) are only shown on :hover.
// Showing them reflows the line, which can push the link out from under the
// pointer - which hid them again, reflowed the line a second time and made the
// view jump. So they are kept open while the pointer is on the link and only
// released a moment after it really left.
export const MULTI_REFERENCE_HOVER_GRACE_MS = 400;
export const hoverUnlockTimers = new WeakMap<HTMLElement, number>();

// Links locked while the context menu is open (identified by key, independent of
// the DOM). A virtual-link widget is rebuilt wholesale by CodeMirror after a
// right-click, and the lock class on the old span dies with the old DOM; this set
// lets the new span restore its lock when rebuilt, so [1|2|3] does not collapse.
export const contextLockedLinks = new Set<string>();

/** Remove the right-click lock for a key (also used to unlock when the rendered-table file-menu closes). */
export function clearContextLock(key: string): void {
    contextLockedLinks.delete(key);
}

// Heading id the most recently hovered virtual link points at. The preview
// popover (onInsert) uses it to find the target exactly instead of guessing by
// "top of the viewport" - when Obsidian centres an h1 mid-view, guessing by the
// top picks up a smaller heading above it.
let lastHoveredHeadingId: string | null = null;
export function setHoveredHeadingId(id: string | null): void { lastHoveredHeadingId = id; }
export function getHoveredHeadingId(): string | null { return lastHoveredHeadingId; }

/**
 * Pin the heading returned by `resolve` just below the top of its scroller,
 * for as long as the surface keeps settling.
 *
 * Everything here is driven by the DOM itself - no Obsidian event names and no
 * href parsing - so it cannot silently do nothing. The counters kept in the
 * loop (realigns / settledIn / via) are there for the `console.log`
 * diagnostics that were used while this was being tuned; the helper
 * `describeSurface` prints what a surface actually contains if that is needed
 * again.
 */
function keepAligned(
    resolve: () => HTMLElement | null,
    label: string,
    maxMs: number,
    alive: () => boolean,
    scrollEditor?: (el: HTMLElement, headingText: string) => boolean,
    onBaseline?: (offset: number) => void,
    /**
     * 'hold'   - keep the heading where the JUMP left it (Obsidian's centring is
     *            known-good), only putting it back when content drifts it.
     * 'centre' - move the heading to the middle of the surface. Needed for hover
     *            previews: a popover opens at the position of the LINK, so its
     *            heading is frequently nowhere near the middle - holding that
     *            position just preserves a wrong one.
     */
    mode: 'hold' | 'centre' = 'hold',
): void {
    const abort = new AbortController();
    const { signal } = abort;
    const stop = () => abort.abort();
    window.addEventListener('wheel', stop, { capture: true, passive: true, signal });
    window.addEventListener('mousedown', stop, { capture: true, signal });
    window.addEventListener('keydown', stop, { capture: true, signal });

    const startedAt = Date.now();
    let lastSignature = '';
    // Where the jump left the heading. Recorded on the FIRST check only: that
    // position is Obsidian's own centring, which is known-good (a real link
    // jump is stable). Everything after that is drift protection - put the
    // heading back when content changes move it - and never a second guess at
    // "where centred should be", which is what pulled correct headings off.
    let baseline = Number.NaN;
    let stableSince = Date.now();
    let settledInMs = -1;
    let domWrites = 0;         // direct writes in the current episode
    let domWritesTotal = 0;    // across the whole watch window
    // "Are all images in this surface loaded?" must not turn every check into a
    // full scan: these notes hold hundreds of embeds, so the list is re-read at
    // most every second and a half.
    let imgs: HTMLImageElement[] = [];
    let imgsAt = 0;

    // Watching is EVENT-DRIVEN: a ResizeObserver fires the moment the content
    // around the heading changes height - a PDF embed landing seconds late, an
    // image finishing, MathJax typesetting - instead of a timer asking every few
    // hundred milliseconds and possibly missing a change that falls between two
    // questions. While nothing moves, this costs nothing at all.
    //
    // The scroller's own box keeps its size when content is added, so it is the
    // content container (its first element child) that has to be observed.
    let observed: Element | null = null;
    let ro: ResizeObserver | null = null;
    let mathBusy: (() => boolean) | null = null;
    let debounce: number | null = null;     // coalesces a burst of observer hits
    let pending: number | null = null;      // a check that is already queued
    let rearm: number | null = null;        // follow-up while something settles
    let safety: number | null = null;       // backstop for unobservable surfaces

    const stopTimers = () => {
        for (const t of [debounce, pending, rearm, safety]) {
            if (t !== null) window.clearTimeout(t);
        }
        debounce = pending = rearm = safety = null;
        ro?.disconnect();
        ro = null;
    };
    signal.addEventListener('abort', stopTimers);

    function schedule(delay: number) {
        if (signal.aborted || pending !== null) return;
        pending = window.setTimeout(() => {
            pending = null;
            check();
        }, delay);
    }

    /** A slow backstop: some surfaces expose nothing reliable to observe. */
    function armSafety() {
        if (safety !== null) window.clearTimeout(safety);
        safety = window.setTimeout(() => {
            safety = null;
            schedule(0);
            armSafety();
        }, ALIGN_SAFETY_MS);
    }

    function observe(scroller: HTMLElement | null) {
        const target: Element | null = scroller ? (scroller.firstElementChild ?? scroller) : null;
        if (target === observed) return;
        ro?.disconnect();
        ro = null;
        observed = target;
        mathBusy = scroller ? createMathBusyWatcher(scroller) : null;
        if (target) {
            ro = new ResizeObserver(() => {
                if (debounce !== null) window.clearTimeout(debounce);
                debounce = window.setTimeout(() => {
                    debounce = null;
                    schedule(0);
                }, ALIGN_DEBOUNCE_MS);
            });
            ro.observe(target);
        }
    }

    function check() {
        if (signal.aborted) return;
        if (!alive()) { stop(); return; }               // popover closed / view gone
        if (Date.now() - startedAt > maxMs) { stop(); return; }
        // A resize we caused ourselves (embedding height being reserved, then
        // released) is not content landing - let it settle and look again.
        if (isSelfInflictedLayout()) {
            schedule(ALIGN_DEBOUNCE_MS);
            return;
        }

        let wrote = false;
        let moved = false;
        const found = resolve();
        if (found) {
            const scroller = findScrollableAncestor(found);
            observe(scroller);
            // Where the heading is, plus a signature of the layout around it:
            // the content height together with the heading's position INSIDE
            // the content. While the page is still rendering - MathJax
            // typesetting, a PDF embed releasing its reserved height, CM6
            // measuring lines it has not seen yet - that signature keeps
            // changing, and nothing is touched.
            const headingText = found.getAttribute('data-heading') ?? found.textContent ?? '';
            const inEditor = !!found.closest('.cm-editor');

            // Measure the ROW, not the inline heading span (see headingRowElement):
            // the row is what gets centred, and decorations live on it.
            const foundRect = headingRowElement(found).getBoundingClientRect();
            const offset = scroller
                ? foundRect.top - scroller.getBoundingClientRect().top
                : 0;
            if (scroller) {
                const signature = scroller.scrollHeight + ':' + Math.round(scroller.scrollTop + offset);
                if (signature !== lastSignature) {
                    // A new episode begins: the page had been quiet and then
                    // moved again, so the correction gets a fresh budget instead
                    // of having spent the whole allowance on the first burst.
                    if (Date.now() - stableSince >= ALIGN_STABLE_MS) domWrites = 0;
                    lastSignature = signature;
                    stableSince = Date.now();
                    moved = true;
                }
                // Correct a page that has STOPPED changing, and only once: after
                // the write the layout counts as new again, so the check re-arms
                // instead of snapping again on the next check. Waiting for the
                // render to finish is what keeps CM6 out of its measure-restart
                // loop (and the position is only worth setting once, anyway).
                // "Rendered" = the content height has held still AND every image
                // in this surface has finished loading. Only then is the first
                // scroll issued, so it lands on a page that has stopped moving.
                if (Date.now() - imgsAt > 1500) {
                    imgs = Array.from(scroller.querySelectorAll('img'));
                    imgsAt = Date.now();
                }
                const stillLoading = imgs.some((img) => !img.complete);
                const settleReady = !stillLoading && !mathBusy?.()
                    && Date.now() - stableSince >= ALIGN_STABLE_MS;
                // Record where the jump left the heading - but only once the
                // surface has SETTLED. The jump is not one action: the document
                // is loaded first (scrollTop back to 0) and Obsidian applies its
                // own scroll afterwards. Reading during that gap captured a
                // mid-jump position, and holding it is what parked headings at
                // the top of the pane.
                if (mode === 'hold' && Number.isNaN(baseline)
                    && (settleReady || Date.now() - startedAt > 3000)) {
                    baseline = offset;
                    onBaseline?.(offset);
                }
                const desired = mode === 'centre'
                    ? centeredOffset(scroller, foundRect.height)
                    : baseline;
                const miss = Math.abs(offset - desired);
                // Safety valve: a page that never stops changing (an animation,
                // a playing video) would otherwise never be positioned at all -
                // after a moment, correct a large miss anyway. Kept short on
                // purpose: in media-heavy notes settleReady may not hold for
                // seconds, and waiting 4s just reads as "it takes ages to snap".
                // A note full of display math never satisfies settleReady while
                // MathJax is still typesetting, and demanding miss > 60 on top
                // meant a heading sitting 40px off was never handed to the
                // alignment at all - so it simply stayed off-centre. After a
                // couple of seconds any real miss is worth acting on; the
                // tolerance test just above is what keeps jitter out.
                const impatient = Date.now() - startedAt > 2500;
                if (miss > ALIGN_TOLERANCE_PX && (settleReady || impatient)) {
                    // Inside a CodeMirror editor the view owns the scroll, so the
                    // job is handed to the editor (centred - the same call
                    // Obsidian makes for its own heading links). A surface
                    // without an editor handle is scrolled directly, at most a
                    // few times, so the two can never end up fighting.
                    const handled = inEditor && scrollEditor ? scrollEditor(found, headingText) : false;
                    const withinBudget = domWrites < DOM_WRITE_BUDGET && domWritesTotal < DOM_WRITE_TOTAL_BUDGET;
                    if (handled || !inEditor || withinBudget) {
                        if (!handled) {
                            // Same reachability rule as the editor path: never
                            // scroll past the end. A heading near either end of
                            // the note cannot be centred, and forcing it carried
                            // the view into the edge and the heading away from
                            // the middle. At the limit, the position is already
                            // the best one - leave it.
                            const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                            const want = Math.min(Math.max(0, scroller.scrollTop + offset - desired), maxTop);
                            if (Math.abs(want - scroller.scrollTop) >= 2) {
                                scroller.scrollTop = want;
                                if (inEditor) { domWrites++; domWritesTotal++; }
                            }
                        }
                        lastSignature = '';
                        if (settledInMs < 0) settledInMs = Date.now() - startedAt;
                        wrote = true;
                    }
                }
            }
        }

        // A follow-up is only needed while something is settling: a change must
        // be allowed to become quiet (ALIGN_STABLE_MS) before it is acted on, and
        // a write must be verified afterwards. Everything else is left to the
        // slow backstop - no timer asks questions while nothing moves.
        if (wrote || moved) {
            if (rearm !== null) window.clearTimeout(rearm);
            rearm = window.setTimeout(() => {
                rearm = null;
                schedule(0);
            }, ALIGN_STABLE_MS + 200);
        }
    }

    armSafety();
    schedule(0);
}

/**
 * Align whichever heading the surface is currently scrolled to, without
 * knowing its name. Needed because some navigations cannot be observed at all:
 * a hover preview popover creates itself - already scrolled to the heading -
 * and a rendered link may not expose a usable #fragment.
 */
export function keepScrolledHeadingAligned(
    scope: HTMLElement | null,
    label = '',
    maxMs = ALIGN_MAX_MS,
    scrollEditor?: (el: HTMLElement, headingText: string) => boolean,
    headingId?: string,
    onBaseline?: (offset: number) => void,
    mode: 'hold' | 'centre' = 'hold',
    /**
     * Last-resort lookup for a heading whose NAME is known. Text matching in a
     * CodeMirror surface fails as soon as the row carries decorations (heading
     * decorator icons, a virtual-link suffix), so the caller may supply a
     * lookup that goes through the metadata line number instead. Consulted
     * only when the text lookups found nothing; returning null is fine.
     */
    resolveByName?: (id: string) => HTMLElement | null,
): void {
    let cached: HTMLElement | null = null;
    // A preview popover has no headingId, so it can only guess by "the heading
    // nearest the top". But once it scrolls, the top becomes a different heading
    // and the guessed target changes with it - chasing different headings forever.
    // So the first guess pins its name, and later lookups go by name, so the
    // target stops drifting.
    let pinnedId: string | null = null;
    keepAligned(
        () => {
            if (cached && cached.isConnected) return cached;
            // A known heading name is always preferred over guessing from the
            // layout - the click path knows exactly which heading was linked.
            const lookupId = headingId ?? pinnedId;
            if (lookupId) {
                const byName = (scope && scope.isConnected ? findHeadingElement(scope, lookupId) : null)
                    ?? findHeadingElement(document.body, lookupId)
                    ?? resolveByName?.(lookupId)
                    ?? null;
                if (byName) { cached = byName; return cached; }
                // The heading is known BY NAME but its element is not in the DOM
                // (yet). Never fall back to the "nearest the top" guess here: that
                // is a DIFFERENT heading, and centring it moves the view off the
                // one that was linked to. This is exactly what used to happen a
                // few seconds after a jump into a CodeMirror surface - the row's
                // text is not the heading text once a decorator renders inside
                // it, the text lookup kept failing, and the fallback centred a
                // neighbour. Returning null leaves the position Obsidian chose
                // (which is the right one), and the next check - the safety pass
                // keeps those coming - looks again.
                return null;
            }
            const top = findHeadingAtTop(scope, false);
            if (top && !headingId && !pinnedId) {
                pinnedId = normalizeHeading(top.getAttribute('data-heading') ?? top.textContent ?? '');
            }
            cached = top;
            return cached;
        },
        label,
        maxMs,

        () => !scope || scope.isConnected,
        scrollEditor,
        onBaseline,
        mode,
    );
}

import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { Range } from '@codemirror/state';

/**
 * Marks indented lines (a leading Tab or two or more spaces) together with the
 * line above each of them. Obsidian renders those lines as bare `.cm-line`s
 * with no indentation class at all, so neither they nor the line above them can
 * be reached from CSS - and "the line above" is a previous sibling anyway, which
 * CSS can only express with :has(). The classes added here are what the
 * "Background" rules in styles.css paint.
 */
export function buildIndentBackground(view: EditorView): DecorationSet {
    const doc = view.state.doc;
    const marks: Range<Decoration>[] = [];
    // visibleRanges can overlap around block widgets/folds, so a single line may
    // be visited more than once - without this the same class ends up duplicated
    // on the element (e.g. "fakelink-indent-line fakelink-indent-line ...").
    const done = new Set<number>();
    const isIndented = (text: string): boolean => text.startsWith('\t') || /^ {2,}/.test(text);
    for (const { from, to } of view.visibleRanges) {
        const last = doc.lineAt(to).number;
        for (let n = doc.lineAt(from).number; n <= last; n++) {
            if (done.has(n)) continue;
            done.add(n);
            const line = doc.line(n);
            if (!isIndented(line.text)) continue;
            marks.push(Decoration.line({ class: 'fakelink-indent-line' }).range(line.from));
            if (n <= 1) continue;
            const above = doc.line(n - 1);
            if (above.text.trim().length === 0 || isIndented(above.text)) continue;
            marks.push(Decoration.line({ class: 'fakelink-indent-above' }).range(above.from));
        }
    }
    return Decoration.set(marks, true);
}

/**
 * True when the element sits inside an editor-mode table cell - the special
 * contentEditable Obsidian uses while editing a single cell (.cm-table-widget
 * wrapped in .table-cell-wrapper). Read-mode tables and the source editor have
 * neither, so this is the signal for the table-cell-only behaviours (right-click
 * suppression, cell-local line boundaries, active-view override).
 */
export function isInTableCellEditor(el: Element | null): boolean {
    return Boolean(el?.closest('.cm-table-widget') && el?.closest('.table-cell-wrapper'));
}

/**
 * Per-note disable (source side): stop this one note from rendering any virtual
 * link. Which mechanism is used is decided by the linkIgnoreMode setting:
 *   'off'      - disabled
 *   'tag'      - disabled when it carries the configured tag (both frontmatter
 *                tags and #tags in the body count; nested tags such as
 *                #linker-ignore/xxx are supported)
 *   'property' - disabled when the configured frontmatter property is true
 *                (e.g. fakelink-ignore: true)
 */
export function isLinkingDisabledInNote(
    file: TFile | null | undefined,
    app: App,
    settings: LinkerPluginSettings
): boolean {
    const mode = settings.linkIgnoreMode ?? 'off';
    if (mode === 'off' || !file) return false;

    const cache = app.metadataCache.getFileCache(file);
    if (!cache) return false;

    // Use an explicit annotation instead of `as`: cache.frontmatter is already a
    // compatible index type, so an assertion would not change the type (the lint
    // flags it as unnecessary); it also narrows any to unknown so downstream
    // accesses do not propagate any.
    const fm: Record<string, unknown> | undefined = cache.frontmatter;

    if (mode === 'property') {
        const prop = settings.linkIgnoreProperty;
        if (!prop || !fm) return false;
        const raw = fm[prop];
        // Lenient check: linker-ignore: "true" (quoted) in YAML parses as a
        // string, and accepting only boolean true would look like "I set it but it
        // does nothing". true / "true" / "True" all count as enabled here.
        return raw === true
            || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
    }

    // mode === 'tag'
    const tag = settings.linkIgnoreTag;
    if (!tag) return false;
    const want = tag.replace(/^#/, '').toLowerCase();

    // Check both the body #tags (cache.tags) and the frontmatter tags: Obsidian
    // versions differ on whether frontmatter tags are merged into cache.tags, so
    // checking both sides is the reliable path.
    const candidates: string[] = [];
    for (const t of cache.tags ?? []) candidates.push(t.tag);
    const fmTags = fm?.tags;
    if (Array.isArray(fmTags)) {
        for (const t of fmTags) if (typeof t === 'string') candidates.push(t);
    } else if (typeof fmTags === 'string') {
        candidates.push(...fmTags.split(/[,\s]+/));
    }

    for (const raw of candidates) {
        const name = raw.replace(/^#/, '').toLowerCase();
        if (name === want || name.startsWith(want + '/')) return true;
    }
    return false;
}

type DispatchSelectionLike = {
    anchor?: number; head?: number; from?: number; to?: number;
    ranges?: { from: number; to: number }[];
};

/**
 * Arm one CodeMirror view's dispatch with a guard: in a complex layout (big
 * table / PDF-heavy note) Obsidian occasionally dispatches an out-of-range
 * selection and throws "Selection points outside of document". Catch it here,
 * clamp the selection into the document length and retry - actually defusing the
 * error rather than hiding it. Idempotent; calling it again only arms once.
 */
export function patchDispatchClamp(cm: EditorView): void {
    const cmAny = cm as unknown as {
        dispatch: (...a: unknown[]) => unknown;
        __fkDispatchPatched?: boolean;
    };
    if (cmAny.__fkDispatchPatched) return;
    cmAny.__fkDispatchPatched = true;
    const origDispatch = cm.dispatch.bind(cm);
    cmAny.dispatch = (...args: unknown[]) => {
        try {
            return origDispatch(...args);
        } catch (e) {
            const msg = String((e as Error)?.message ?? '');
            if (!msg.includes('outside of document')) throw e;
            const docLen = cm.state.doc.length;
            const spec = (args[0] ?? {}) as { selection?: DispatchSelectionLike } & Record<string, unknown>;
            const sel = spec.selection;
            if (!sel) throw e;
            const clamp = (v: number) => Math.min(Math.max(Number(v) || 0, 0), docLen);
            const rawAnchor = sel.ranges?.[0]?.from ?? sel.anchor ?? sel.from ?? 0;
            const rawHead = sel.ranges?.[0]?.to ?? sel.head ?? sel.to ?? sel.anchor ?? sel.from ?? 0;
            return origDispatch({
                ...spec,
                selection: { anchor: clamp(rawAnchor), head: clamp(rawHead) },
            });
        }
    };
}

/** Arm the dispatch guard on every CodeMirror editor in the current document. */
export function patchAllEditorsDispatchClamp(): void {
    const doc: Document = (typeof activeDocument !== 'undefined' ? activeDocument : document);
    Array.from(doc.querySelectorAll('.cm-editor')).forEach((el) => {
        const cm = EditorView.findFromDOM(el as HTMLElement);
        if (cm) patchDispatchClamp(cm);
    });
}

/**
 * Attach the table-cell take-over context menu to a virtual-link span. In an
 * editor-mode table cell Obsidian runs BOTH of its context-menu pipelines, so
 * file-menu fires twice and every plugin's items appear twice; blocking both
 * pipelines and showing our own menu here is the only reliable way.
 *
 * Extracted from getLinkRootSpan so liveLinker can attach it lazily: cell
 * editors are built detached, so at toDOM() time the span has no .table-cell-wrapper
 * ancestor yet and isInTableCellEditor() reads false. Attaching after the span
 * is actually inserted (requestAnimationFrame) makes the check reliable even in
 * large documents with many tables (where the earlier eager check flaked).
 */
export function attachTableCellContextMenu(span: HTMLElement, match: VirtualMatch): void {
    span.classList.add('no-context-menu');
    span.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // The reference list ([1][2][3]) expands on hover and collapses when the
        // mouse leaves. A right-click must lock it first, otherwise moving to a
        // menu item collapses the list and takes the menu with it.
        const holder = span.closest<HTMLElement>('.virtual-link-span') ?? span;
        holder.classList.add('virtual-link-hover-lock');
        // Flag it so mouseleave does not unlock while the menu is open.
        holder.dataset.fkContextLock = '1';
        // Add to the lock set: when CodeMirror rebuilds the widget after the right-click, the new span restores its lock from it.
        const lockKey = match.getLockKey();
        contextLockedLinks.add(lockKey);
        const unlock = () => {
            contextLockedLinks.delete(lockKey);
            delete holder.dataset.fkContextLock;
            holder.classList.remove('virtual-link-hover-lock');
        };

        const menu = new Menu();
        menu.addItem((item) => {
            item.setTitle('Add to excluded keywords')
                .setIcon('ban')
                .onClick(async () => {
                    if (match.originText) {
                        const newExcludedKeywords = [...new Set([...match.settings.excludedKeywords, match.originText])];
                        await match.plugin.updateSettings({ excludedKeywords: newExcludedKeywords });
                        match.plugin.updateManager.update();
                    }
                });
        });

        // Use the link that was actually right-clicked (which of [1]/[2]/[3]),
        // not the first link in the cell - so right-clicking [2] converts the
        // second file. The menu still has a single "Convert to real link"; the
        // target file just follows the reference number that was clicked.
        const hit = (e.target as HTMLElement | null)?.closest?.('.virtual-link-a') as Element | null;
        const anchor = (hit && span.contains(hit)) ? hit : span.querySelector('.virtual-link-a');

        if (anchor) {
            const href = anchor.getAttribute('href') || '';
            const targetFile = match.plugin.app.vault.getAbstractFileByPath(href.split('#')[0]);
            if (targetFile instanceof TFile) {
                menu.addItem((item) => {
                    item.setTitle('Convert to real link')
                        .setIcon('link')
                        .onClick(() => {
                            convertVirtualLinkToReal(anchor, targetFile, match.plugin.app, match.settings);
                        });
                });
            }
        }

        // Unlock only when the menu actually closes. A 10s timer fallback used to
        // unlock the list while the menu was still open and the user had not
        // chosen yet (that was the source of the "collapses after 10s" symptom).
        // Drop the timer and rely entirely on onHide: the list stays expanded as
        // long as the menu is open.
        menu.onHide(unlock);

        menu.showAtMouseEvent(e);
    }, true);
}


export { VirtualMatch } from './virtualLinkMatch';
