import IntervalTree from '@flatten-js/interval-tree';
import { LinkerPluginSettings } from 'main';
import { App, MarkdownView, TFile, getLinkpath } from 'obsidian';
import { MatchType, PrefixTree } from './linkerCache';
import { t } from '../src/lang/helpers';
import {
    attachTableCellContextMenu,
    contextLockedLinks,
    findHeadingElement,
    findScrollableAncestor,
    headingElementByLine,
    hoverUnlockTimers,
    keepScrolledHeadingAligned,
    MULTI_REFERENCE_HOVER_GRACE_MS,
    patchAllEditorsDispatchClamp,
    resolveHeadingTarget,
    setHoveredHeadingId,
} from './virtualLinkDom';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('main').default;

// ---------------------------------------------------------------------------
// Why the elements built here use `activeDocument.createElement` rather than
// Obsidian's `createEl` helper (which `obsidianmd/prefer-create-el` flags):
//
// They are DETACHED on purpose - a virtual-link span is handed to CodeMirror
// after being built (and the numbered [1|2|3] anchors are appended to that
// still-detached span). `createEl` appends the new element to its receiver
// immediately, so it would place the element in the document before CodeMirror
// could; and plugins that replace that helper (Media Extended) make the call
// throw "HierarchyRequestError: Only one element on document allowed".
//
// `activeDocument` rather than `document` for the same reason the rest of the
// plugin uses it: a hover preview can live in a second window, and an element
// forged on the wrong document does not belong to the DOM it is inserted into.
// ---------------------------------------------------------------------------

/**
 * A bare internal-link token found by parseInternalLinkSyntax, ready to be
 * wrapped in a VirtualMatch by the caller (which adds its own offset base).
 */
export interface InternalLinkSyntaxToken {
    dest: TFile;
    displayText: string;
    headerId: string;
    index: number;
    prefixCut: number;
    length: number;
}

/**
 * Recognize bare internal-link syntax, e.g.:
 *   a#b            -> heading "b" in note "a"
 *   a#b#c          -> sub-heading "c" under "b" in note "a"
 *   a#b#c^h6d8e3   -> block "h6d8e3" under heading "c" in note "a"
 *   a#^h6d8e3      -> block "h6d8e3" in note "a"
 *
 * Shared by liveLinker and readModeLinker, whose copies of this parsing used
 * to be near-identical; only the offset base differs, which the caller adds
 * when building VirtualMatches.
 */
export function parseInternalLinkSyntax(app: App, text: string, currentFile: TFile): InternalLinkSyntaxToken[] {
    const tokens: InternalLinkSyntaxToken[] = [];
    // Match a non-whitespace, non-bracket token containing at least one '#'
    // but exclude tokens already wrapped in [[...]] (those are real links and
    // are handled/excluded elsewhere).
    const regex = /(?:^|(?<![[\w]))((?:(?!\[\[)[^\s[\]|#\p{P}])+)(#(?:[^\s[\]|\p{P}]+)?)+(?:\|([^\s[\]|\p{P}]+))?/gu;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        const full = m[0];
        // Skip if it starts with "[[" — a real internal link.
        if (full.startsWith('[[')) continue;

        // Split optional display alias: `a#b|别名` → target "a#b", display
        // "别名". The link covers the whole token (from..to), but note/anchor
        // resolution uses only the part before the pipe.
        let targetPart = full;
        let aliasPart: string | undefined;
        const pipeIdx = full.indexOf('|');
        if (pipeIdx > 0) {
            targetPart = full.slice(0, pipeIdx);
            const alias = full.slice(pipeIdx + 1);
            if (alias) aliasPart = alias;
        }

        const hashIdx = targetPart.indexOf('#');
        if (hashIdx <= 0) continue;
        let notePart = targetPart.slice(0, hashIdx);
        const anchorPart = targetPart.slice(hashIdx + 1); // e.g. "b", "b#c", "^h6d8e3", "b#c^h6d8e3"

        // Resolve the note part to a file. The note capture may have greedily
        // absorbed preceding letters/digits (e.g. "abc王鸽" when only "王鸽"
        // is the note). If the full part doesn't resolve, try shorter suffixes
        // (right-to-left) to find the longest resolvable note name.
        let dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(notePart), currentFile.path);
        let prefixCut = 0;
        if (!dest && notePart.length > 1) {
            for (let cut = 1; cut < notePart.length; cut++) {
                const candidate = notePart.slice(cut);
                const d = app.metadataCache.getFirstLinkpathDest(getLinkpath(candidate), currentFile.path);
                if (d) {
                    dest = d;
                    notePart = candidate;
                    prefixCut = cut;
                    break;
                }
            }
        }
        if (!dest) continue;

        // Display text: alias if given, otherwise the (possibly trimmed) target.
        const displayText = aliasPart || (notePart + '#' + anchorPart);

        // The anchor can be a heading path and/or a block id.
        const blockIdx = anchorPart.indexOf('^');
        const headingPath = blockIdx === -1 ? anchorPart : anchorPart.slice(0, blockIdx);
        const blockId = blockIdx === -1 ? undefined : anchorPart.slice(blockIdx + 1);

        // Determine the final anchor to jump to. Obsidian link format:
        //   heading        -> "#heading"
        //   block          -> "#^blockid"
        //   heading^block  -> "#^blockid"  (block wins)
        //
        // A block reference (^blockid) always takes precedence over a
        // heading, so both "a#heading^blockid" and "a#^blockid" resolve
        // to the block anchor. We link the whole token as-is instead of
        // degrading to a file-name or heading-only link.
        let headerId: string | undefined;
        const headings = app.metadataCache.getFileCache(dest)?.headings ?? [];

        if (blockId) {
            headerId = '^' + blockId;
        } else if (headingPath && headings.length > 0) {
            // headingPath may be "b" or "b#c". Match the LAST segment.
            const segments = headingPath.split('#');
            const lastSegment = segments[segments.length - 1].trim();
            const heading = headings.find(
                (h) => h.heading.trim().toLowerCase() === lastSegment.toLowerCase()
            );
            if (heading) {
                headerId = heading.heading.trim();
            } else {
                continue;
            }
        } else {
            continue;
        }

        tokens.push({ dest, displayText, headerId, index: m.index, prefixCut, length: full.length });
    }
    return tokens;
}

export class VirtualMatch {
    private fileHeaderIds: Map<string, string> = new Map();

    // Context distance: how close this file (name or alias) appears in the body
    // to this match; smaller is nearer. Set only when context-aware heading
    // disambiguation is on and produced a distance; used to reorder matches
    // within the same tier (e.g. both "exact heading") so the note mentioned
    // nearest in the body ranks first.
    private fileContextDistances: Map<string, number> = new Map();

    setFileContextDistance(path: string, distance: number) {
        this.fileContextDistances.set(path, distance);
    }

    getFileContextDistance(path: string): number | undefined {
        return this.fileContextDistances.get(path);
    }

    // Files already linked earlier in this document (exact and fuzzy matches
    // both count). This outranks the tier when sorting: an earlier link to a
    // note means it is strongly related to the current context.
    private alreadyLinkedFiles: Set<TFile> | undefined;

    setAlreadyLinkedFiles(files: Set<TFile>) {
        this.alreadyLinkedFiles = files;
    }

    // Whether the body has already "mentioned" this note: either an earlier link
    // points to it (exact or fuzzy - the fuzzy kind cannot be caught by string
    // comparison), or its file name / alias appeared in the text
    // (fileContextDistances is filled by the disambiguation stage).
    private isMentioned(file: TFile): boolean {
        if (this.alreadyLinkedFiles?.has(file)) return true;
        return this.fileContextDistances.has(file.path);
    }

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
    getLockKey(): string {
        // Use originText only: after a cell editor blurs and commits, the link
        // switches from editing back to rendered, and from/to change (cell offset
        // -> text-node offset), so an offset-bearing key goes stale. Same-name
        // links get locked together, which is harmless (they stay expanded a
        // moment longer and collapse when the menu closes).
        return this.originText;
    }

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
        // The context distance affects the [1|2|3] order too, so it must be part
        // of the signature; otherwise eq() thinks the DOM is reusable and does
        // not repaint when the order changes.
        const ctxDistances = this.files
            .map((f) => `${f.path}=${this.fileContextDistances.get(f.path) ?? ''}`)
            .sort()
            .join('\u0001');
        // "Linked earlier" affects the [1|2|3] order as well, so it must be in the signature too.
        const linkedFlags = this.files
            .map((f) => `${f.path}=${this.alreadyLinkedFiles?.has(f) ? 1 : 0}`)
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
            ctxDistances,
            linkedFlags,
            // Settings used by the render methods / the anchor's handlers.
            s.maxReferencesToHideLink,        // hides the link entirely
            s.maxReferenceCount,              // truncates the [1|2|3] list
            s.suppressSuffixForSubWords ? 1 : 0,
            s.applyDefaultLinkStyling ? 1 : 0,
            s.disableVirtualLinkPreview ? 1 : 0,  // hover preview on/off
            s.alwaysShowMultipleReferences ? 1 : 0,
            s.virtualLinkSuffix ?? '',
            s.virtualLinkAliasSuffix ?? '',
            s.headingAlignWatchSeconds,            // alignment watch window (seconds)
        ].join('\u0002');
    }

    /**
     * Files in DISPLAY order - the exact ranking the link element renders, so a
     * caller that needs "the first target" (batch conversion writing a real link)
     * picks the note the user actually sees as [1]. `files` comes straight out of
     * the trie Set and is in arbitrary order.
     */
    sortedFiles(): TFile[] {
        return [...this.files].sort((a, b) => this.compareFiles(a, b));
    }

    compareFiles(a: TFile, b: TFile): number {
        // Three-level sort:
        //   1) tier: exact file name -> file name contains -> alias -> heading
        //      text equals -> heading equals after the chapter number is stripped
        //      -> heading merely contains;
        //   2) context distance: the nearer the note name is mentioned to the
        //      match, the higher it ranks;
        //   3) recency fallback: the newer the mtime the higher it ranks. A new
        //      note's mtime equals its ctime, so "just created" and "later edited"
        //      both count as new; renaming updates neither timestamp, so renames
        //      are not detected.
        // 0) already mentioned in the body (a link, or the name appeared) outranks
        //    the tier
        const mentionedA = this.isMentioned(a);
        const mentionedB = this.isMentioned(b);
        if (mentionedA !== mentionedB) return mentionedA ? -1 : 1;

        const byType = this.getFileTypeOrder(a) - this.getFileTypeOrder(b);
        if (byType !== 0) return byType;

        const da = this.fileContextDistances.get(a.path);
        const db = this.fileContextDistances.get(b.path);
        if (da !== undefined && db !== undefined) {
            if (da !== db) return da - db;
        } else if (da !== undefined) {
            return -1;
        } else if (db !== undefined) {
            return 1;
        }

        return (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0);
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

        const sortedFiles = this.sortedFiles();

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

    // Order of the target files inside a multi-reference link ([1|2|3]); the more
    // precise, the earlier:
    //   0 file name equals the keyword exactly   ┐ article match
    //   1 file name contains the keyword         ┘
    //   2 alias match
    //   3 the heading IS the keyword ("# 牙痛")              ┐
    //   4 the heading equals the keyword only after the      │ heading match
    //     chapter number is stripped ("（六）牙痛")            │
    //   5 the heading merely contains the keyword            ┘
    // Three points:
    //   - Check "file name matches" before "has a heading id". The old code
    //     checked fileHeaderIds.has() first, so a file whose name equals the
    //     keyword AND has a heading match was treated as a Header and sorted last.
    //   - Heading matches are tiered by "how close to the original text": exact
    //     text > equals after chapter number stripped > merely contains. The old
    //     code collapsed these into one value, so ties fell back to the index's
    //     original order and "（六）牙痛" could sort before "牙痛".
    //   - Strip the marker symbols (start/end) wrapping the heading before
    //     comparing: the index keyword carries no symbols while the heading text
    //     does, and without stripping an exact hit is misjudged as "merely
    //     contains".
    private getFileTypeOrder(file: TFile): number {
        const key = this.originText.toLowerCase();
        const base = file.basename.toLowerCase();
        if (base === key) return 0;                 // file name exact
        if (base.includes(key)) return 1;           // file name contains

        const headerId = this.fileHeaderIds.get(file.path);
        if (headerId) {
            // Strip the marker symbols wrapping the heading before comparing.
            let hk = headerId.trim();
            const ss = this.settings.headerMatchStartSymbol;
            const es = this.settings.headerMatchEndSymbol;
            if (ss && es && hk.startsWith(ss) && hk.endsWith(es)) {
                const inner = hk.slice(ss.length, hk.length - es.length).trim();
                if (inner) hk = inner;
            }
            hk = hk.toLowerCase();

            // The heading equals the keyword ("# 牙痛") -> most precise.
            if (hk === key) return 3;
            // The heading equals the keyword after its chapter-number prefix is stripped ("（六）牙痛") -> next.
            if (PrefixTree.stripHeadingNumber(hk).trim().toLowerCase() === key) return 4;
            // The heading merely contains the keyword -> last.
            return 5;
        }
        return 2;                                   // alias
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
        // The href ATTRIBUTE gets serialized by the browser (spaces and
        // non-ASCII characters become %20 / %E4..., which the vault path
        // resolver cannot reverse). Keep the raw path alongside - the same
        // trick Obsidian uses for its own internal links - so the context
        // menu and table-menu converters can resolve the true target even
        // for paths with spaces or non-ASCII characters.
        link.setAttribute('data-href', href);
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

            // While a cell is open for editing (cell editor active), navigating
            // directly makes the cell editor's focus restore (setCellFocus) throw
            // "Selection points outside of document". Blur the cell editor first,
            // then delay the navigation until it has committed and exited.
            const active = activeDocument.activeElement as HTMLElement | null;
            const inCellEditor = Boolean(active && active.closest('.table-cell-wrapper'));

            const doNav = () => {
                if (this.plugin && this.plugin.app) {
                // The surface the click happened in: a hover popover hosts its
                // own editor (Hover Editor), i.e. it is NOT a workspace leaf,
                // while openLinkText() can only ever scroll a workspace leaf -
                // which is why the retries below cannot fix a popover.
                const clicked = event.target as HTMLElement | null;
                const scope = (clicked?.closest?.('.hover-popover') as HTMLElement | null)
                    ?? (clicked?.closest?.('.workspace-leaf') as HTMLElement | null);

                // Arm the dispatch guard on every editor before jumping: in a big
                // table / PDF-heavy note, the post-jump scrolling and re-render
                // makes Obsidian dispatch an out-of-range selection and throw
                // "Selection points outside of document" (a position Obsidian
                // mis-computes internally - the plugin cannot fix the source, only
                // catch it here and clamp to a legal range before retrying).
                patchAllEditorsDispatchClamp();

                void this.plugin.app.workspace.openLinkText(fullPath, '', false, { active: true });

                // Align the surface that was actually navigated, until its
                // layout settles: a heading jump is only exact at the instant
                // it happens, and content above the heading keeps changing
                // height afterwards. The heading is detected from the DOM
                // (whichever one sits at the top), so this still works when the
                // link's #fragment cannot be read back. The watch window comes
                // from the existing "Header jump retry delay" setting
                // (12 seconds by default), so slow notes can be given more time.
                if (headerIdToUse) {
                    const alignWindow = Math.max(3000, (this.settings.headingAlignWatchSeconds || 12) * 1000);
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
                        // Re-navigation alone is not enough: it only fires while the
                        // heading is NOT visible, and it stops after 8 seconds - so a
                        // heading that a slowly rendering image pushed DOWN (still
                        // visible, just in the wrong place) was never corrected, and
                        // nothing checked at all after the last re-navigation.
                        //
                        // The measured alignment is therefore run here as well, for
                        // the whole watch window (the "Heading align watch window"
                        // setting), and it moves the view through the editor's own
                        // API - never through a synthetic scroll, which is what made
                        // CodeMirror give up rendering a PDF-heavy note.
                        // Set once the running alignment actually reaches the
                        // heading. The late re-navigation below must not fire
                        // then: it is a full jump + re-render that lands on
                        // Obsidian's own position, which is exactly the "it
                        // centres and then gets pulled back" symptom.
                        let alignmentWorking = false;
                        let targetViewport: number | undefined;
                        const editorScroll = (el: HTMLElement, headingText: string): boolean => {
                            alignmentWorking = true;
                            if (this.plugin?.centerHeadingElement?.(el, alignWindow, targetViewport)) return true;
                            const target = resolveHeadingTarget(this.plugin.app, el, headingText, null);
                            if (!target) return false;
                            this.plugin.centerHeadingLine(target.view, target.line, alignWindow, targetViewport);
                            return true;
                        };
                        // A real [[link]] lands centred and stays there, so the
                        // whole correction pass is opt-in (see the
                        // "Align heading after jump" setting).
                        if (this.settings.alignHeadingAfterJump) {
                            keepScrolledHeadingAligned(
                                scope, 'click-editor', alignWindow, editorScroll, headerIdToUse,
                                (o) => { targetViewport = o; },
                                // openLinkText lands on the ROW, not necessarily
                                // centred (a real link's internal navigation is
                                // the one that centres). Centre it ourselves.
                                'centre',
                                // A decorated row (heading decorator icon, a
                                // virtual-link suffix) does not carry the heading
                                // text, so the text lookup can fail here - the
                                // line number cannot.
                                (id) => (this.plugin ? headingElementByLine(this.plugin.app, scope, id) : null),
                            );
                        }

                        const abort = new AbortController();
                        const stop = () => abort.abort();
                        window.addEventListener('wheel', stop, { capture: true, passive: true, signal: abort.signal });
                        window.addEventListener('mousedown', stop, { capture: true, signal: abort.signal });
                        window.addEventListener('keydown', stop, { capture: true, signal: abort.signal });
                        for (const delay of [3000, 8000]) {
                            if (delay > alignWindow) break;
                            window.setTimeout(() => {
                                if (abort.signal.aborted) return;
                                // Same opt-in as the alignment above: a late
                                // re-navigation is a full jump of its own.
                                if (!this.settings.alignHeadingAfterJump) return;
                                if (alreadyFramed()) return;
                                // The measured alignment is already running. If it
                                // can find the heading it will correct the position,
                                // so a re-navigation would only re-render the whole
                                // note and fight it. Re-navigate only when the
                                // alignment has nothing to work with.
                                //
                                // Ask the alignment itself whether that is so,
                                // rather than looking the heading up again here:
                                // findHeadingElement() misses it in notes whose
                                // DOM keeps being rebuilt (MathJax typesetting a
                                // page of display math), and every miss turned
                                // into a re-navigation that yanked the view back
                                // to Obsidian's own position.
                                if (alignmentWorking) return;
                                if (findHeadingElement(document.body, headerIdToUse)) return;
                                void this.plugin.app.workspace.openLinkText(fullPath, '', false, { active: true });
                            }, delay);
                        }
                    } else {
                        // Rendered surface (reading view, HTML popover): no
                        // CodeMirror editor involved, so the measured DOM
                        // alignment is both safe and accurate there.
                        if (this.settings.alignHeadingAfterJump) {
                            keepScrolledHeadingAligned(
                                scope, 'click', alignWindow, undefined, headerIdToUse, undefined, 'centre',
                                // Same line-number fallback as the editor path.
                                (id) => (this.plugin ? headingElementByLine(this.plugin.app, scope, id) : null),
                            );
                        }
                    }
                }
                }
            };

            if (inCellEditor) {
                active!.blur();
                // Return focus to the main editor so the cell editor fully exits,
                // avoiding the post-navigation error when Obsidian restores the
                // cell editor's focus (setCellFocus) with a stale selection.
                this.plugin?.app.workspace.getActiveViewOfType(MarkdownView)?.editor.focus();
                window.setTimeout(doNav, 250);
            } else {
                doNav();
            }

            return false;
        };

        return link;
    }

    // NOTE: the span / anchor / sup elements below are created DETACHED - they
    // are appended by CodeMirror afterwards - so they must be built with
    // createElement, not with Obsidian's createEl helper. Some plugins (Media
    // Extended) replace that helper, and when it is called on a Document the
    // element ends up appended to the document itself, which throws
    // "HierarchyRequestError: Only one element on document allowed".
    getLinkRootSpan(inTableCellEditor = false) {
        const span = activeDocument.createElement('span');
        span.classList.add('virtual-link', 'virtual-link-span');

        // Restore the lock when this link is being right-click-locked (menu open).
        // CodeMirror may rebuild the widget wholesale after a right-click, and
        // these classes do not carry over by themselves.
        if (contextLockedLinks.has(this.getLockKey())) {
            span.classList.add('virtual-link-hover-lock');
            span.dataset.fkContextLock = '1';
        }

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

        // 'virtual-link-hover-lock' is the existing "do not collapse" switch
        // (the click path sets it too). Arm it on hover and release it a moment
        // after the pointer leaves, so travelling to "1|2|3" never loses them.
        span.addEventListener('mouseenter', () => {
            const pending = hoverUnlockTimers.get(span);
            if (pending !== undefined) {
                window.clearTimeout(pending);
                hoverUnlockTimers.delete(span);
            }
            span.classList.add('virtual-link-hover-lock');
            // Remember which heading the hovered link points at, so the preview
            // popover can locate it exactly instead of guessing by "top of the
            // viewport" (which guesses wrong when the h1 is centred mid-view).
            // Clear as well as set: a link with no heading must not leave the
            // PREVIOUS hovered heading behind, or the next popover gets aligned
            // to a heading the user never hovered (previews that "centre" the
            // wrong heading entirely).
            const anchor = span.querySelector('.virtual-link-a');
            const hid = anchor?.getAttribute('data-heading-id');
            setHoveredHeadingId(hid ?? null);
        });
        span.addEventListener('mouseleave', () => {
            const pending = hoverUnlockTimers.get(span);
            if (pending !== undefined) window.clearTimeout(pending);
            // Do not unlock while the context menu is open: moving the mouse to a
            // menu item leaves this span, and unlocking would collapse [1|2|3]
            // immediately, taking the menu down with it.
            if (span.dataset.fkContextLock) return;
            hoverUnlockTimers.set(span, window.setTimeout(() => {
                hoverUnlockTimers.delete(span);
                span.classList.remove('virtual-link-hover-lock');
            }, MULTI_REFERENCE_HOVER_GRACE_MS));
        });
        // On right-click, stop CodeMirror from moving the cursor to the click
        // point: as soon as the cursor enters a virtual link, CodeMirror replaces
        // the whole link with plain text and the [1|2|3] list vanishes, so you
        // could not right-click "on a number". Only right-click is intercepted
        // (button===2); left and middle click are untouched.
        span.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 2) return;
            // Add to the lock set: CodeMirror rebuilds the widget after a
            // right-click, and the new span restores its lock from this set so
            // [1|2|3] does not collapse. Removed when the menu closes (unlock).
            contextLockedLinks.add(this.getLockKey());
            e.preventDefault();
            e.stopPropagation();
        }, true);

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

        // ===== NEW implementation =====
        // In an editor-mode table cell Obsidian runs BOTH of its context-menu
        // pipelines (the cell editor's and the main editor's), so file-menu
        // fires twice and every plugin's menu items - ours included - end up in
        // the menu twice. Neither stopPropagation nor preventDefault can
        // suppress just one of the two pipelines, so the plugin takes over
        // completely here: both pipelines are blocked and our own menu with
        // just the virtual-link actions is shown instead.
        if (inTableCellEditor) {
            attachTableCellContextMenu(span, this);
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

            if (index === fileList.length - 1) {
                if (overflowCount > 0) {
                    const overflow = activeDocument.createElement('span');
                    overflow.textContent = '|...';
                    overflow.setAttribute('title', t('{count} more reference(s)').replace('{count}', String(overflowCount)));
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
        spanIndicator.setAttribute('title', t('{count} more reference(s)').replace('{count}', String(hiddenCount)));
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
            if (b.to === a.to) {
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
        // For the onlyLinkOnce pass: ids of surviving matches per target-file
        // path. A match is covered (and deleted) when an earlier surviving
        // match already links to every file it links to; intersecting the
        // per-file survivor sets answers that in O(files) instead of the old
        // loop that rescanned every later match per survivor - O(matches²)
        // per rebuild on long index pages with hundreds of matches.
        const survivorIdsByFile = new Map<string, Set<number>>();

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

            // Set all additions that link to the same file to be deleted.
            // Only survivors claim their files, so the sets below only hold
            // matches that were not deleted earlier - which mirrors the old
            // scan exactly: a match is deleted when an EARLIER surviving match
            // already covers every file it links to, never the other way round.
            if (onlyLinkOnce) {
                const paths = addition.files.map((f) => f.path);
                let covered = false;
                if (paths.length > 0) {
                    const survivorSets = paths.map((p) => survivorIdsByFile.get(p));
                    if (survivorSets.every((s) => s !== undefined)) {
                        // Intersect the smallest set with the rest; a candidate
                        // present for every file links to all of addition's
                        // files, so it covers addition. Existence is enough.
                        const first = survivorSets[0];
                        const rest = survivorSets.slice(1);
                        for (const id of first) {
                            if (rest.every((s) => s.has(id))) { covered = true; break; }
                        }
                    }
                }
                if (covered) {
                    matchesToDelete.set(addition.id, true);
                    continue;
                }
                for (const p of paths) {
                    let s = survivorIdsByFile.get(p);
                    if (!s) { s = new Set<number>(); survivorIdsByFile.set(p, s); }
                    s.add(addition.id);
                }
            }
        }
        return matches.filter((match) => !matchesToDelete.has(match.id));
    }
}

/**
 * Resolve the raw (unencoded) vault path recorded on a virtual-link anchor.
 * The href ATTRIBUTE is browser-serialized (spaces and non-ASCII characters
 * become %20 / %E4...), which getAbstractFileByPath cannot resolve - reading
 * it made "convert to real link" silently produce a self-link (context menu)
 * or vanish entirely (table menu) for such paths. data-href holds the path
 * exactly as written; the decodeURIComponent fallback covers anchors rendered
 * before that attribute existed.
 */
export function getVirtualLinkRawPath(anchor: Element | null | undefined): string {
    if (!anchor) return '';
    const raw = anchor.getAttribute('data-href');
    if (raw) return raw;
    try {
        return decodeURIComponent(anchor.getAttribute('href') || '');
    } catch {
        return anchor.getAttribute('href') || '';
    }
}
