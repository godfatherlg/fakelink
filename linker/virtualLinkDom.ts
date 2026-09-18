import IntervalTree from '@flatten-js/interval-tree';
import { LinkerPluginSettings } from 'main';
import { App, MarkdownView, TFile, getLinkpath } from 'obsidian';
import { MatchType } from './linkerCache';
import { t } from '../src/lang/helpers';

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
const ALIGN_POLL_FAST_MS = 300;   // while watching the layout settle
const ALIGN_POLL_SLOW_MS = 1200;  // afterwards: just watch for late shifts
const ALIGN_SETTLE_MS = 2500;     // how long the fast poll is kept after a write
const ALIGN_TOLERANCE_PX = 6;     // ignore sub-pixel jitter
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

// A jumped-to heading is CENTRED in its pane, exactly like Obsidian's own
// heading navigation - and for a practical reason on top of matching it: a
// centred heading sits half a pane away from the top edge, so content above it
// reflowing (a PDF embed releasing its reserved height, MathJax finishing)
// can never clip it behind the pane edge, which is what pinning it to the top
// kept doing.
const ALIGN_MIN_GAP = 12;      // floor, for panes shorter than the heading

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
function findScrollableAncestor(node: HTMLElement): HTMLElement | null {
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
    for (const el of candidates) if (textOf(el).startsWith(want)) return el;
    return null;
}

/**
 * The heading a surface is currently scrolled to: the one crossing (or just
 * below) the top edge of its own scroller. A heading whose top edge sits ABOVE
 * the scroller top - i.e. one showing only its lower half - is included on
 * purpose: that is exactly the state this code has to repair.
 */
/** Where a heading of this height belongs: centred, never above ALIGN_MIN_GAP. */
function centeredOffset(scroller: HTMLElement, height: number): number {
    return Math.max(ALIGN_MIN_GAP, Math.round((scroller.clientHeight - height) / 2));
}

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
        return want.startsWith(candidate) && want.length - candidate.length <= 12;
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

/** One-shot version: used for surfaces where no persistent loop runs. */
export function scrollEditorHeadingIntoView(app: App, el: HTMLElement | null, headingText: string, file?: TFile | null): boolean {
    const target = resolveHeadingTarget(app, el, headingText, file);
    if (!target) return false;
    const edge = target.view.editor.getLine(target.line).length;
    target.view.editor.scrollIntoView({ from: { line: target.line, ch: 0 }, to: { line: target.line, ch: edge } }, true);
    return true;
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

export function findHeadingAtTop(scope: HTMLElement | null): HTMLElement | null {
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
    return search(document.body);
}

/**
 * A live-preview heading is NOT an <h1..h6>: Obsidian renders the line as
 * `div.cm-line.HyperMD-header.HyperMD-header-N`, and only the reading view
 * produces real heading elements (with data-heading). Both are covered here -
 * matching only the tags is what made this find nothing in a popover.
 */
const HEADING_SEL = 'h1, h2, h3, h4, h5, h6, [data-heading], [class*="HyperMD-header"]';

/**
 * What a surface actually contains, for the diagnostics. If the alignment ever
 * reports "nothing", these counts say which markup to match instead of leaving
 * it to guesswork.
 */
function describeSurface(scope: HTMLElement | null): string {
    const root: ParentNode = scope && scope.isConnected ? scope : document.body;
    const n = (sel: string) => root.querySelectorAll(sel).length;
    return (scope ? String(scope.className || '').split(' ')[0] : 'document') + ' ' + JSON.stringify({
        h: n('h1,h2,h3,h4,h5,h6'),
        dataHeading: n('[data-heading]'),
        hypermd: n('[class*="HyperMD-header"]'),
        cmLine: n('.cm-line'),
        preview: n('.markdown-preview-view'),
        scroller: n('.cm-scroller'),
        // The first few heading texts actually present - so "found nothing"
        // says WHY instead of leaving it to guesswork.
        texts: Array.from(root.querySelectorAll(HEADING_SEL))
            .slice(0, 3)
            .map((el) => normalizeHeading(el.getAttribute('data-heading') ?? el.textContent ?? '').slice(0, 24)),
    });
}

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
    describe: () => string,
    alive: () => boolean,
    scrollEditor?: (el: HTMLElement, headingText: string) => boolean,
): void {
    const abort = new AbortController();
    const { signal } = abort;
    const stop = () => abort.abort();
    window.addEventListener('wheel', stop, { capture: true, passive: true, signal });
    window.addEventListener('mousedown', stop, { capture: true, signal });
    window.addEventListener('keydown', stop, { capture: true, signal });

    const startedAt = Date.now();
    let lastWriteAt = 0;
    let lastSignature = '';
    let stableSince = Date.now();
    let settledInMs = -1;
    let domWrites = 0;

    const tick = () => {
        if (signal.aborted) return;
        if (!alive()) { stop(); return; }               // popover closed / view gone

        const found = resolve();
        if (found) {
            const scroller = findScrollableAncestor(found);
            // Where the heading is, plus a signature of the layout around it:
            // the content height together with the heading's position INSIDE
            // the content. While the page is still rendering - MathJax
            // typesetting, a PDF embed releasing its reserved height, CM6
            // measuring lines it has not seen yet - that signature keeps
            // changing, and nothing is touched.
            const headingText = found.getAttribute('data-heading') ?? found.textContent ?? '';
            const inEditor = !!found.closest('.cm-editor');

            const foundRect = found.getBoundingClientRect();
            const offset = scroller
                ? foundRect.top - scroller.getBoundingClientRect().top
                : 0;
            // Where the heading belongs: centred in the pane, like Obsidian's
            // own heading navigation - and impossible to clip from above.
            const desired = scroller ? centeredOffset(scroller, foundRect.height) : 0;
            if (scroller) {
                const signature = scroller.scrollHeight + ':' + Math.round(scroller.scrollTop + offset);
                if (signature !== lastSignature) {
                    lastSignature = signature;
                    stableSince = Date.now();
                }
                // Correct a page that has STOPPED changing, and only once: after
                // the write the layout counts as new again, so the check re-arms
                // instead of snapping again on the next tick. Waiting for the
                // render to finish is what keeps CM6 out of its measure-restart
                // loop (and the position is only worth setting once, anyway).
                const miss = Math.abs(offset - desired);
                // "Rendered" = the content height has held still AND every image
                // in this surface has finished loading. Only then is the first
                // scroll issued, so it lands on a page that has stopped moving.
                const stillLoading = Array.from(scroller.querySelectorAll('img'))
                    .some((img) => !img.complete);
                const settleReady = !stillLoading && Date.now() - stableSince >= ALIGN_STABLE_MS;
                // Safety valve: a page that never stops changing (an animation,
                // a playing video) would otherwise never be positioned at all -
                // after a few seconds, correct a large miss anyway.
                const impatient = Date.now() - startedAt > 4000 && miss > 60;
                if (miss > ALIGN_TOLERANCE_PX && (settleReady || impatient)) {
                    // Inside a CodeMirror editor the view owns the scroll, so the
                    // job is handed to the editor (centred - the same call
                    // Obsidian makes for its own heading links). A surface
                    // without an editor handle is scrolled directly, at most a
                    // few times, so the two can never end up fighting.
                    const handled = inEditor && scrollEditor ? scrollEditor(found, headingText) : false;
                    if (handled || !inEditor || domWrites < DOM_WRITE_BUDGET) {
                        if (!handled) {
                            scroller.scrollTop = Math.max(0, scroller.scrollTop + offset - desired);
                            if (inEditor) domWrites++;
                        }
                        lastWriteAt = Date.now();
                        lastSignature = '';
                        if (settledInMs < 0) settledInMs = Date.now() - startedAt;
                    }
                }
            }
        }

        const elapsed = Date.now() - startedAt;
        if (elapsed > maxMs) {
            stop();
            return;
        }
        // Poll fast while things are moving, slowly once they hold: a late
        // shift (a slow PDF landing) is still caught, but the common case stops
        // poking the scroller - which is what CM6 reacts to.
        const settling = Date.now() - startedAt < ALIGN_SETTLE_MS || Date.now() - lastWriteAt < ALIGN_SETTLE_MS;
        window.setTimeout(tick, settling ? ALIGN_POLL_FAST_MS : ALIGN_POLL_SLOW_MS);
    };

    window.setTimeout(tick, ALIGN_POLL_FAST_MS);
}

/**
 * Align the heading a link points at, in the surface it was clicked in - or
 * wherever the heading turns up, if the file opened in another leaf.
 */
export function keepHeadingAligned(scope: HTMLElement | null, headingId: string, label = '', maxMs = ALIGN_MAX_MS): void {
    if (!headingId) return;
    let cached: HTMLElement | null = null;
    keepAligned(
        () => {
            if (cached && cached.isConnected) return cached;
            cached = (scope && scope.isConnected ? findHeadingElement(scope, headingId) : null)
                ?? findHeadingElement(document.body, headingId);
            return cached;
        },
        label,
        maxMs,
        () => 'heading=' + headingId,
        () => !scope || scope.isConnected,
    );
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
): void {
    const requestedAt = Date.now();
    let cached: HTMLElement | null = null;
    keepAligned(
        () => {
            if (cached && cached.isConnected) return cached;
            // A known heading name is always preferred over guessing from the
            // layout - the click path knows exactly which heading was linked.
            if (headingId) {
                const byName = (scope && scope.isConnected ? findHeadingElement(scope, headingId) : null)
                    ?? findHeadingElement(document.body, headingId);
                if (byName) { cached = byName; return cached; }
                // Not rendered yet: keep waiting for THAT heading instead of
                // latching onto a neighbour (which would be centred instead).
                if (Date.now() - requestedAt < 4000) return null;
            }
            cached = findHeadingAtTop(scope);
            return cached;
        },
        label,
        maxMs,
        () => describeSurface(scope),
        () => !scope || scope.isConnected,
        scrollEditor,
    );
}

export class VirtualMatch {
    private fileHeaderIds: Map<string, string> = new Map();

    constructor(
        public id: number,
        public originText: string,
        public from: number,
        public to: number,
        public files: TFile[],
        public type: MatchType,
        public isSubWord: boolean,
        public settings: LinkerPluginSettings,
        public plugin: LinkerPluginType, // Add plugin parameter
        public headerId?: string,
        public isBoldContext: boolean = false,
        public isItalicContext: boolean = false,
        public isHighlightContext: boolean = false,
        public isTripleStarContext: boolean = false,
        public isStrikethroughContext: boolean = false,
        public isCommentContext: boolean = false,
        public isInHeaderContext: boolean = false,
        public isFuzzy: boolean = false
    ) {
        if (headerId) {
            for (const file of files) {
                this.fileHeaderIds.set(file.path, headerId);
            }
        }
    }

    setFileHeaderId(file: TFile, headerId: string) {
        this.fileHeaderIds.set(file.path, headerId);
    }

    getFileHeaderId(file: TFile): string | undefined {
        return this.fileHeaderIds.get(file.path);
    }

    get isAlias(): boolean {
        return this.type === MatchType.Alias;
    }

    // True when this match has so many targets that NO link is rendered at all
    // (see the "hide link when references exceed" setting). Such a widget is just
    // plain text, so a click should place the caret rather than being swallowed —
    // otherwise that line becomes unclickable, which defeats the threshold.
    get isHiddenByReferenceLimit(): boolean {
        return this.settings.maxReferencesToHideLink > 0
            && this.files.length > this.settings.maxReferencesToHideLink;
    }

    // DOM methods

    /**
     * A compact signature of everything that can change the rendered DOM (or the
     * anchor's click behaviour). VirtualLinkWidget.eq() compares these so that
     * CodeMirror is allowed to reuse an existing widget's DOM.
     *
     * Why this exists: the widget set is rebuilt on every cursor move, scroll and
     * doc change. Without eq(), CodeMirror destroys and recreates every virtual
     * link's DOM each time, which swaps out the very <a> the pointer is resting
     * on. Obsidian's "require Mod key" hover path remembers that element when the
     * hover starts and refuses to show the preview once it is no longer in the
     * document, so pressing Ctrl after any rebuild silently did nothing.
     *
     * Everything that feeds getCompleteLinkElement / getLinkAnchorElement must be
     * listed here — including the render-affecting settings, otherwise changing a
     * setting would keep the stale DOM alive because eq() still reported "equal".
     *
     * Recompute-per-call is deliberate: a match can be mutated after construction
     * (setFileHeaderId(), isFuzzy), and a cached signature would then be stale.
     * Callers that need it cheaper can memoise it per widget instance.
     */
    renderKey(): string {
        const s = this.settings;

        // Only the file *set* affects the DOM: display order comes from
        // getFileTypeOrder(), so the array's own order is irrelevant. Sort for
        // a stable signature.
        const filePaths = this.files.map((f) => f.path).sort().join('\u0001');
        const headerIds = this.files
            .map((f) => `${f.path}=${this.fileHeaderIds.get(f.path) ?? ''}`)
            .sort()
            .join('\u0001');

        return [
            this.from,
            this.to,
            this.originText,
            this.type,
            this.isSubWord ? 1 : 0,
            this.isFuzzy ? 1 : 0,
            this.headerId ?? '',
            this.isBoldContext ? 1 : 0,
            this.isItalicContext ? 1 : 0,
            this.isHighlightContext ? 1 : 0,
            this.isTripleStarContext ? 1 : 0,
            this.isStrikethroughContext ? 1 : 0,
            this.isCommentContext ? 1 : 0,
            this.isInHeaderContext ? 1 : 0,
            filePaths,
            headerIds,
            // Settings used by the render methods / the anchor's handlers.
            s.maxReferencesToHideLink,        // hides the link entirely
            s.maxReferenceCount,              // truncates the [1|2|3] list
            s.suppressSuffixForSubWords ? 1 : 0,
            s.applyDefaultLinkStyling ? 1 : 0,
            s.disableVirtualLinkPreview ? 1 : 0,  // hover preview on/off
            s.alwaysShowMultipleReferences ? 1 : 0,
            s.virtualLinkSuffix ?? '',
            s.virtualLinkAliasSuffix ?? '',
            s.headerJumpRetryDelay,                // re-navigate delays
        ].join('\u0002');
    }

    getCompleteLinkElement(inTableCellEditor = false) {
        // Hide the link entirely when the total number of matches exceeds the
        // configured threshold (too noisy to be useful).
        if (this.settings.maxReferencesToHideLink > 0 && this.files.length > this.settings.maxReferencesToHideLink) {
            const emptySpan = activeDocument.createElement('span');
            emptySpan.textContent = this.originText;
            // The term DID match — there are simply too many targets, so no link is
            // rendered. Keep the line visually quiet (that is the point of the
            // threshold) but explain it on hover, so it does not look like a bug.
            const tip = t('Matched {count} notes, over the hide limit ({limit}) — no virtual link is shown');
            emptySpan.setAttribute('title', tip
                .replace('{count}', String(this.files.length))
                .replace('{limit}', String(this.settings.maxReferencesToHideLink)));
            return emptySpan;
        }

        // Sort files: Note → Alias → Header
        const sortedFiles = [...this.files].sort((a, b) => {
            const typeA = this.getFileTypeOrder(a);
            const typeB = this.getFileTypeOrder(b);
            return typeA - typeB;
        });

        // Limit visible files, and show a "..." indicator when there are more
        // references than the configured display limit (instead of silently
        // truncating, which made users think only N references existed).
        let visibleFiles = sortedFiles;
        let hasMore = false;
        if (this.settings.maxReferenceCount > 0 && sortedFiles.length > this.settings.maxReferenceCount) {
            visibleFiles = sortedFiles.slice(0, this.settings.maxReferenceCount);
            hasMore = true;
        }

        const span = this.getLinkRootSpan(inTableCellEditor);
        const firstFile = visibleFiles.length > 0 ? visibleFiles[0] : undefined;
        const firstPath = firstFile ? getLinkpath(firstFile.path) : "";
        span.appendChild(this.getLinkAnchorElement(this.originText, firstPath, firstFile));
        if (visibleFiles.length > 1) {
            if (!this.isSubWord) {
                span.appendChild(this.getMultipleReferencesIndicatorSpan());
            }
            span.appendChild(this.getMultipleReferencesSpan(visibleFiles, hasMore ? sortedFiles.length - visibleFiles.length : 0));
        } else if (hasMore) {
            span.appendChild(this.getOverflowIndicatorSpan(sortedFiles.length - visibleFiles.length));
        }

        if (!this.isSubWord || !this.settings.suppressSuffixForSubWords) {
            const icon = this.getIconSpan();
            if (icon) span.appendChild(icon);
        }
        return span;
    }

    // Get sort order for file type: 0=Note, 1=Alias, 2=Header
    private getFileTypeOrder(file: TFile): number {
        if (this.fileHeaderIds.has(file.path)) return 2; // Header
        // Check if file basename matches (Note match)
        const keyword = this.originText;
        if (file.basename.toLowerCase() === keyword.toLowerCase()) return 0;
        if (file.basename.includes(keyword)) return 0;
        return 1; // Alias
    }



    getLinkAnchorElement(linkText: string, href: string, file?: TFile) {
        const link = activeDocument.createElement('a');

        let headerIdToUse: string | undefined;
        if (file) {
            headerIdToUse = this.getFileHeaderId(file);
        } else if (this.files.length > 0) {
            headerIdToUse = this.getFileHeaderId(this.files[0]) || this.headerId;
        } else {
            headerIdToUse = this.headerId;
        }

        let fullPath = href;
        if (headerIdToUse) {
            link.href = `${href}#${headerIdToUse}`;
            link.setAttribute('data-heading-id', headerIdToUse);
            fullPath = `${href}#${headerIdToUse}`;
        } else {
            link.href = href;
        }
        link.textContent = linkText;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('from', this.from.toString());
        link.setAttribute('to', this.to.toString());
        link.setAttribute('origin-text', this.originText);
        // `internal-link` is the signal Obsidian's Page preview (and therefore
        // Hover Editor) uses to open a hover popover. A virtual link is drawn by
        // this plugin rather than written in the note, so that popover is not
        // always wanted - when it is switched off the class is simply left out.
        // Styling comes from the plugin's own classes (.virtual-link-span a /
        // .virtual-link-a) and clicking is handled by this widget, so nothing
        // else depends on it.
        link.classList.add('virtual-link-a');
        if (!this.settings.disableVirtualLinkPreview) {
            link.classList.add('internal-link');
        }

        // Show which note this link opens, so the numbered candidates of a
        // multi-file heading match ([1|2|3]) can be told apart before clicking.
        // Obsidian's own hover preview shows the same heading content for every
        // candidate, so it cannot distinguish them - a title tooltip can.
        const titleFile = file || (this.files.length > 0 ? this.files[0] : undefined);
        if (titleFile) {
            link.title = t('Open note: {name}').replace('{name}', titleFile.basename);
        }

        link.onclick = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const targetFile = file || (this.files.length > 0 ? this.files[0] : null);
            if (!targetFile) return false;

            if (this.plugin && this.plugin.app) {
                // The surface the click happened in: a hover popover hosts its
                // own editor (Hover Editor), i.e. it is NOT a workspace leaf,
                // while openLinkText() can only ever scroll a workspace leaf -
                // which is why the retries below cannot fix a popover.
                const clicked = event.target as HTMLElement | null;
                const scope = (clicked?.closest?.('.hover-popover') as HTMLElement | null)
                    ?? (clicked?.closest?.('.workspace-leaf') as HTMLElement | null);

                void this.plugin.app.workspace.openLinkText(fullPath, '', false, { active: true });

                // Align the surface that was actually navigated, until its
                // layout settles: a heading jump is only exact at the instant
                // it happens, and content above the heading keeps changing
                // height afterwards. The heading is detected from the DOM
                // (whichever one sits at the top), so this still works when the
                // link's #fragment cannot be read back. The watch window comes
                // from the existing "Header jump retry delay" setting
                // (500ms => 12s), so slow notes can be given more time.
                if (headerIdToUse) {
                    const alignWindow = Math.max(12000, (this.settings.headerJumpRetryDelay || 500) * 24);
                    // Skip a re-navigation when the heading is already framed:
                    // each one is a full jump+re-render, so there is no reason to
                    // pay for it (or to disturb the view) when nothing is wrong.
                    const alreadyFramed = (): boolean => {
                        const el = findHeadingElement(document.body, headerIdToUse);
                        if (!el) return false;
                        const sc = findScrollableAncestor(el);
                        if (!sc) return false;
                        const r = el.getBoundingClientRect();
                        const sr = sc.getBoundingClientRect();
                        return r.top >= sr.top - 4 && r.bottom <= sr.bottom + 4;
                    };
                    if (clicked?.closest?.('.cm-editor')) {
                        // Clicking landed inside a CodeMirror editor. Do NOT
                        // scroll it ourselves: every synthetic scroll tried here
                        // (plain scrollTop, then requestMeasure, then dispatch)
                        // ended with CodeMirror restarting its measure loop until
                        // it stopped rendering this PDF-heavy note - and the
                        // positions it produced were wrong anyway, because the
                        // line positions it reports for unrendered regions are
                        // estimates.
                        //
                        // Re-issue the navigation instead, late: Obsidian scrolls
                        // the heading into view with its own machinery, so no
                        // synthetic scroll is involved at all. The drift this
                        // corrects (a PDF embed releasing its reserved height,
                        // pushing the heading out of view) happens seconds after
                        // the jump, so the re-navigation is simply repeated late.
                        const abort = new AbortController();
                        const stop = () => abort.abort();
                        window.addEventListener('wheel', stop, { capture: true, passive: true, signal: abort.signal });
                        window.addEventListener('mousedown', stop, { capture: true, signal: abort.signal });
                        window.addEventListener('keydown', stop, { capture: true, signal: abort.signal });
                        for (const delay of [3000, 8000]) {
                            if (delay > alignWindow) break;
                            window.setTimeout(() => {
                                if (abort.signal.aborted) return;
                                if (alreadyFramed()) return;
                                void this.plugin.app.workspace.openLinkText(fullPath, '', false, { active: true });
                            }, delay);
                        }
                    } else {
                        // Rendered surface (reading view, HTML popover): no
                        // CodeMirror editor involved, so the measured DOM
                        // alignment is both safe and accurate there.
                        keepScrolledHeadingAligned(scope, 'click', alignWindow, undefined, headerIdToUse);
                    }
                }

            }

            return false;
        };

        return link;
    }

    getLinkRootSpan(inTableCellEditor = false) {
        const span = activeDocument.createElement('span');
        span.classList.add('virtual-link', 'virtual-link-span');
        
        if (this.settings.applyDefaultLinkStyling) {
            span.classList.add('virtual-link-default');
        }

        // Add type-specific class for separate color support. Fuzzy matches get
        // their own class so they can be tinted with the fuzzy base color.
        if (this.isFuzzy) {
            span.classList.add(this.type === MatchType.Header
                ? 'virtual-link-type-fuzzy-header'
                : 'virtual-link-type-fuzzy-note');
        } else if (this.type === MatchType.Header) {
            span.classList.add('virtual-link-type-header');
        }

        // Add context-specific classes
        if (this.isBoldContext) {
            span.classList.add('virtual-link-in-bold');
        }
        if (this.isItalicContext) {
            span.classList.add('virtual-link-in-italic');
        }
        if (this.isHighlightContext) {
            span.classList.add('virtual-link-in-highlight');
        } else {
            let parent = span.parentElement;
            while (parent) {
                if (parent.tagName === 'MARK') {
                    span.classList.add('virtual-link-in-highlight');
                    break;
                }
                parent = parent.parentElement;
            }
        }
        if (this.isTripleStarContext) {
            span.classList.add('virtual-link-in-triple-star');
        }
        if (this.isStrikethroughContext) {
            span.classList.add('virtual-link-in-strikethrough');
        }

        // Set context menu based on table cell context
        if (inTableCellEditor === true) {
            span.classList.add('no-context-menu');
            
            // Ensure default right-click menu is disabled in table cells
            span.addEventListener('contextmenu', (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }, true);
            
            // Add additional mouse right-click event listeners to capture all possible right-click events
            span.addEventListener('mouseup', (e: MouseEvent) => {
                if (e.button === 2) { // Right mouse button
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            }, true);
        }
        
        return span;
    }

    getMultipleReferencesSpan(files?: TFile[], overflowCount: number = 0) {
        const spanReferences = activeDocument.createElement('span');
        if (!this.settings.alwaysShowMultipleReferences) {
            spanReferences.classList.add('multiple-files-references');
        }

        const fileList = files ?? this.files;

        if (!fileList || fileList.length === 0) {
            return spanReferences;
        }

        fileList.forEach((file, index) => {
            if (index === 0) {
                const bracket = activeDocument.createElement('span');
                bracket.textContent = '[';
                spanReferences.appendChild(bracket);
            }

            let linkText = ` ${index + 1} `;
            if (index < fileList.length - 1) {
                linkText += '|';
            }

            const linkHref = file.path;
            // Pass file parameter to use file-specific heading ID
            const link = this.getLinkAnchorElement(linkText, linkHref, file);
            spanReferences.appendChild(link);

            if (index == fileList.length - 1) {
                if (overflowCount > 0) {
                    const overflow = activeDocument.createElement('span');
                    overflow.textContent = '|...';
                    overflow.setAttribute('title', `${overflowCount} more reference(s)`);
                    spanReferences.appendChild(overflow);
                }
                const bracket = activeDocument.createElement('span');
                bracket.textContent = ']';
                spanReferences.appendChild(bracket);
            }
        });

        return spanReferences;
    }

    getMultipleReferencesIndicatorSpan() {
        const spanIndicator = activeDocument.createElement('span');
        spanIndicator.textContent = ' [...]';
        spanIndicator.classList.add('multiple-files-indicator');
        return spanIndicator;
    }

    getOverflowIndicatorSpan(hiddenCount: number) {
        const spanIndicator = activeDocument.createElement('span');
        spanIndicator.textContent = ' [...]';
        // Reuse the same class as the reference list so it shows/hides together
        // (visible on hover, or always visible when alwaysShowMultipleReferences
        // is enabled).
        if (!this.settings.alwaysShowMultipleReferences) {
            spanIndicator.classList.add('multiple-files-references');
        }
        spanIndicator.setAttribute('title', `${hiddenCount} more reference(s)`);
        return spanIndicator;
    }

    getIconSpan() {
        const suffix = this.isAlias ? this.settings.virtualLinkAliasSuffix : this.settings.virtualLinkSuffix;
        if ((suffix?.length ?? 0) > 0) {
            const icon = activeDocument.createElement('sup');
            icon.textContent = suffix;
            icon.classList.add('linker-suffix-icon');
            return icon;
        }
        return null;
    }

    /////////////////////////////////////////////////
    // Filter and sort methods
    /////////////////////////////////////////////////

    static compare(a: VirtualMatch, b: VirtualMatch): number {
        if (a.from === b.from) {
            // An exact match starting at the same position outranks a fuzzy
            // (similarity) match, even when the fuzzy one is longer. Without
            // this, "教育教学负" (fuzzy, 5 chars) would sort ahead of the exact
            // "教育教学" (4 chars) and — because filterOverlapping keeps the
            // first of an overlapping run — delete the exact match entirely.
            if (a.isFuzzy !== b.isFuzzy) {
                return a.isFuzzy ? 1 : -1;
            }
            if (b.to == a.to) {
                return b.files.length - a.files.length;
            }
            return b.to - a.to;
        }
        return a.from - b.from;
    }

    static sort(matches: VirtualMatch[]): VirtualMatch[] {
        return Array.from(matches).sort((a, b) => VirtualMatch.compare(a, b));
    }

    static filterAlreadyLinked(matches: VirtualMatch[], linkedFiles: Set<TFile>, mode: 'some' | 'every' = 'every'): VirtualMatch[] {
        return matches.filter((match) => {
            if (mode === 'every') {
                return !match.files.every((file) => linkedFiles.has(file));
            } else {
                return !match.files.some((file) => linkedFiles.has(file));
            }
        });
    }

    static filterOverlapping(matches: VirtualMatch[], onlyLinkOnce: boolean = true, excludedIntervalTree?: IntervalTree): VirtualMatch[] {
        const matchesToDelete: Map<number, boolean> = new Map();

        // Delete additions that overlap
        // Additions are sorted by from position and after that by length, we want to keep longer additions
        for (let i = 0; i < matches.length; i++) {
            const addition = matches[i];
            if (matchesToDelete.has(addition.id)) {
                continue;
            }

            // Check if the addition is inside an excluded block
            if (excludedIntervalTree) {
                const overlaps = excludedIntervalTree.search([addition.from, addition.to]);
                if (overlaps.length > 0) {
                    matchesToDelete.set(addition.id, true);
                    continue;
                }
            }

            // A fuzzy match must always yield to an exact match it overlaps.
            // The exact "苏霍姆林斯基" is only discovered when scanning reaches
            // "基", one char AFTER the fuzzy "被苏霍姆林斯" was produced — so the
            // fuzzy one starts a char earlier and, being first, would win here
            // and delete the exact match. Exact is what the user actually wrote,
            // so it must survive regardless of scanning order.
            if (addition.isFuzzy) {
                let yieldsToExact = false;
                for (let j = i + 1; j < matches.length; j++) {
                    const other = matches[j];
                    if (other.from >= addition.to) break;
                    if (!other.isFuzzy) { yieldsToExact = true; break; }
                }
                if (yieldsToExact) {
                    matchesToDelete.set(addition.id, true);
                    continue;
                }
            }

            // Set all overlapping additions to be deleted
            for (let j = i + 1; j < matches.length; j++) {
                const otherAddition = matches[j];
                if (otherAddition.from >= addition.to) {
                    break;
                }
                matchesToDelete.set(otherAddition.id, true);
            }

            // Set all additions that link to the same file to be deleted
            if (onlyLinkOnce) {
                for (let j = i + 1; j < matches.length; j++) {
                    const otherAddition = matches[j];
                    if (matchesToDelete.has(otherAddition.id)) {
                        continue;
                    }

                    if (otherAddition.files.every((f) => addition.files.contains(f))) {
                        matchesToDelete.set(otherAddition.id, true);
                    }
                }
            }
        }
        return matches.filter((match) => !matchesToDelete.has(match.id));
    }
}