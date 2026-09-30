import { App, Editor, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './src/lang/helpers';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { BatchConvertModal, BatchConvertFilesModal } from './src/batchConvert';
import { buildIndentBackground, createMathBusyWatcher, headingRowElement, patchDispatchClamp } from './linker/virtualLinkDom';
import { LinkerSettingTab } from './src/settingsTab';
import { WhatsNewModal, WHATS_NEW_VERSION } from './src/whatsNew';
import { copyLineUri, jumpToLine, openFileOnly } from './src/lineJump';
import { addContextMenuItem } from './src/contextMenu';
import { registerEmbedReservation } from './src/embedReserve';

// Only one centring loop may run per editor. The caller (keepAligned) requests
// again each time a miss exceeds the tolerance; if every request started a new
// loop, the loops would each write the scroll and the symptom is "keeps
// scrolling" - most visible in preview popovers.
const activeCenterLoops = new WeakMap<EditorView, AbortController>();

// A heading this close to where it belongs is left alone. Six pixels was the
// old floor and it was too tight: content that merely settled a little moved
// the heading ~10px and triggered a correction, which reads as the view being
// yanked for no reason. Correcting only a real miss is the point of the whole
// feature - not winning an argument about pixels.
const HEADING_EPSILON_PX = 24;

export interface LinkerPluginSettings {
    app?: App; // Add app instance reference
    autoToggleByMode: boolean;
    advancedSettings: boolean;
    linkerActivated: boolean;
    suppressSuffixForSubWords: boolean;
    excludedExtensions: string[];
    matchAnyPartsOfWords: boolean;
    matchEndOfWords: boolean;
    matchBeginningOfWords: boolean;
    includeAllFiles: boolean;
    linkerDirectories: string[];
    excludedDirectories: string[];
    excludedDirectoriesForLinking: string[];
    virtualLinkSuffix: string;
    virtualLinkAliasSuffix: string;
    useDefaultLinkStyleForConversion: boolean;
    defaultUseMarkdownLinks: boolean; // Otherwise wiki links
    defaultLinkFormat: 'shortest' | 'relative' | 'absolute';
    useMarkdownLinks: boolean;
    linkFormat: 'shortest' | 'relative' | 'absolute';
    applyDefaultLinkStyling: boolean;
    alternativeDisplayStyle: boolean;
    includeHeaders: boolean;
    headerMatchSymbols: boolean;
    headerMatchOnlyBetweenSymbols: boolean;
    headerMatchStartSymbol: string;
    headerMatchEndSymbol: string;
    matchCaseSensitive: boolean;
    capitalLetterProportionForAutomaticMatchCase: number;
    tagToIgnoreCase: string;
    tagToMatchCase: string;
    propertyNameToMatchCase: string;
    propertyNameToIgnoreCase: string;
    tagToExcludeFile: string;
    tagToIncludeFile: string;
    excludeLinksToOwnNote: boolean;
    fixIMEProblem: boolean;
    excludeLinksInCurrentLine: boolean;
    /**
     * While a table cell is open for editing, render no virtual links inside it,
     * so the text stays plain and can be typed into normally. The surrounding
     * cells keep their links.
     */
    tableLinkSuppression: boolean;
    /** Version this plugin last ran as, so "what is new" can be shown once. */
    lastSeenVersion: string;
    onlyLinkOnce: boolean;
    excludeLinksToRealLinkedFiles: boolean;
    includeAliases: boolean;
    maxReferenceCount: number; // Max number of references to show
    maxReferencesToHideLink: number; // Hide link when total references exceed this
    alwaysShowMultipleReferences: boolean;
    excludedKeywords: string[]; // Keywords to exclude from virtual linking
    headerAutoAppendSuffix: boolean; // Auto-append suffix to new headers
    headerAutoAppendSymbol: string; // Symbol to append to headers
    headingSymbolWhitelist: string[]; // Symbols stripped from heading keywords
    allowLinksInHeaders: boolean; // Allow virtual links in headers
    colorOnlyDisplay: boolean; // Use color-only display for virtual links
    disableVirtualLinkPreview: boolean; // Do not let virtual links trigger the page preview / Hover Editor popover
    // One switch for the whole "background" look: faint tint, list / Tab-indented
    // lines (and the line above them), tables, callouts, the cursor line, the
    // tab headers and a gentle mask while the window is unfocused.
    backgroundHighlight: boolean;
    backgroundLineOpacity: number;  // 0-100, alpha of the list / indent / table / callout tint
    cursorLineOpacity: number;      // 0-100, alpha of the cursor-line highlight
    // The look above used to be one all-or-nothing switch. These split it into
    // independently switchable parts (each maps to its own `<the class>-*`
    // body class and is checked by its own group of rules in styles.css):
    backgroundTint: boolean;        // overall app tint
    backgroundLines: boolean;       // list / indent / table / callout backgrounds
    backgroundCursorLine: boolean;  // cursor line highlight + caret colour
    backgroundTabAccent: boolean;      // active tab header styling
    backgroundUnfocusedMask: boolean;  // mask over the workspace while unfocused
    // Legacy field, kept ONLY as migration input. It is not part of the current
    // setting surface: it used to combine the accent and the mask into one
    // switch, and loadSettings is the one place allowed to read it (see there).
    // It can be deleted once nobody upgrades from 1.23.43 or earlier.
    backgroundTabs?: boolean;
    frontmatterExcludeProperty: string; // Frontmatter property for per-note opt-in (boolean)
    perNoteExcludeKeywords: boolean; // When enabled, excludedKeywords only apply to notes with the frontmatter property
    enableFrontmatterExcludeList: boolean; // When enabled, notes can define extra excluded keywords in frontmatter
    frontmatterExcludeListProperty: string; // Frontmatter property for per-note keyword list
    linkIgnoreMode: 'off' | 'tag' | 'property'; // How a single note opts out of all virtual links
    linkIgnoreTag: string;        // Tag name, used when linkIgnoreMode = 'tag'
    linkIgnoreProperty: string;   // Frontmatter property name, used when linkIgnoreMode = 'property'
    headerVirtualLinkColor: string; // Color for header virtual links
    noteVirtualLinkColor: string; // Color for note/alias virtual links
    fuzzyBaseColor: string; // Base color mixed into fuzzy-match link colors
    fuzzyColorMixRatio: number; // How much base color to mix in (0-100)
    headingAlignWatchSeconds: number;
    // After a jump, keep nudging the target heading back to the centre while the
    // note keeps changing height (late-loading PDFs, embeds, typeset math).
    // Off by default: Obsidian's own jump already centres the heading, and
    // clicking a REAL link proves it - nothing pushes it off. Turning this on
    // for notes that genuinely drift is what the extra machinery is for; on a
    // note that renders fine it can only fight the view.
    alignHeadingAfterJump: boolean; // How many seconds a jumped-to heading keeps being re-aligned
    enableStemming: boolean; // fuzzy meaning matching
    stemmingLanguage: string; // Language for fuzzy matching ('en' | 'zh' | 'auto')
    fuzzyMatchThreshold: number; // Minimum similarity (0-100) for fuzzy matching to create a link (only used when enableStemming is on)
    fuzzyMinLength: number; // Minimum normalized length of a title/note name to be considered for fuzzy matching (shorter ones are skipped)
    fuzzySlidingWindow: boolean; // Fuzzy matching also tries shorter suffixes, so terms embedded in Chinese text can match
    fuzzySlidingWindowMaxOffset: number; // Max chars stripped from the front of a text run by the fuzzy sliding window (lower = faster but misses terms buried behind a long prefix)
    skipMultipleTargets: boolean; // In batch conversion, skip virtual links pointing to multiple notes
    enableSymbolExclusion: boolean; // Exclude text between custom start/end symbols from virtual linking
    excludeSymbolStart: string; // Start symbol marking text to exclude from linking
    excludeSymbolEnd: string; // End symbol marking text to exclude from linking
    enableInternalLinkSyntax: boolean; // Recognize bare internal-link syntax like "a#b", "a#^block" as virtual links
    enableContextDisambiguation: boolean; // Limit a multi-file header match to the file named in the current paragraph
    jumpEnabled: boolean; // Intercept obsidian://adv-uri clicks to jump to a line directly
    lineJumpWaitSeconds: number; // How many seconds to wait for the target file to render before jumping to the line
    jumpOpenInNewTab: boolean; // When the target file is not open, open it in a new tab
    lineLinkSelfHeal: boolean; // Self-heal line links when target line numbers drift
    autoExcludeContainedCopies: boolean; // Auto-exclude a note whose name fully contains another note's name AND shares the same first sentence (e.g. a renamed duplicate)
    filenameAffixExclusions: string[]; // Notes whose file name starts or ends with any of these words/symbols are excluded
    // wordBoundaryRegex: string;
    // conversionFormat
}

const DEFAULT_SETTINGS: LinkerPluginSettings = {
    autoToggleByMode: false,
    advancedSettings: true,
    linkerActivated: true,
    matchAnyPartsOfWords: true,
    matchEndOfWords: true,
    matchBeginningOfWords: true,
    suppressSuffixForSubWords: false,
    includeAllFiles: true,
    linkerDirectories: ['Glossary'],
    excludedDirectories: [],
    excludedDirectoriesForLinking: [],
    virtualLinkSuffix: '',
    virtualLinkAliasSuffix: '',
    excludedExtensions: ['.mp4'],
    useMarkdownLinks: false,
    linkFormat: 'shortest',
    defaultUseMarkdownLinks: false,
    defaultLinkFormat: 'shortest',
    useDefaultLinkStyleForConversion: true,
    applyDefaultLinkStyling: true,
    alternativeDisplayStyle: true,
    includeHeaders: true,
    headerMatchSymbols: true,
    headerMatchOnlyBetweenSymbols: false,
    headerMatchStartSymbol: '⟦',
    headerMatchEndSymbol: '⟧',
    matchCaseSensitive: false,
    capitalLetterProportionForAutomaticMatchCase: 0.75,
    tagToIgnoreCase: 'linker-ignore-case',
    tagToMatchCase: 'linker-match-case',
    propertyNameToMatchCase: 'linker-match-case',
    propertyNameToIgnoreCase: 'linker-ignore-case',
    tagToExcludeFile: 'linker-exclude',
    tagToIncludeFile: 'linker-include',
    excludeLinksToOwnNote: false,
    fixIMEProblem: true,
    excludeLinksInCurrentLine: true,
    tableLinkSuppression: true,
    lastSeenVersion: '',
    onlyLinkOnce: false,
    excludeLinksToRealLinkedFiles: false,
    includeAliases: true,
    maxReferenceCount: 5,
    maxReferencesToHideLink: 10,
    alwaysShowMultipleReferences: false,
    excludedKeywords: [],
    headerAutoAppendSuffix: false,
    headerAutoAppendSymbol: '☱',
    headingSymbolWhitelist: [],
    allowLinksInHeaders: false,
    colorOnlyDisplay: true,
    disableVirtualLinkPreview: false,
    backgroundHighlight: false,
    // The parts default to on: they only take effect while the master switch is
    // on, so turning it on still gives the complete look (an existing user's
    // appearance is unchanged after upgrading).
    backgroundTint: true,
    backgroundLines: true,
    backgroundCursorLine: true,
    backgroundTabAccent: true,
    backgroundUnfocusedMask: true,
    backgroundTabs: true, // deprecated: migration source only, never read at runtime
    backgroundLineOpacity: 10,
    cursorLineOpacity: 35,
    frontmatterExcludeProperty: 'fakelink-exclude',
    perNoteExcludeKeywords: false,
    enableFrontmatterExcludeList: false,
    frontmatterExcludeListProperty: 'fakelink-exclude-keywords',
    linkIgnoreMode: 'tag',
    linkIgnoreTag: 'linker-ignore',
    // The property also uses the linker- prefix, consistent with linker-exclude /
    // linker-ignore-case / linker-match-case. The two mechanisms are mutually
    // exclusive (linkIgnoreMode), so the same name cannot collide.
    linkIgnoreProperty: 'linker-ignore',
    headerVirtualLinkColor: '#517ea0',
    noteVirtualLinkColor: '#c0392b',
    fuzzyBaseColor: '#8e44ad',
    fuzzyColorMixRatio: 50,
    headingAlignWatchSeconds: 12,
    alignHeadingAfterJump: false,
    enableStemming: false,
    stemmingLanguage: 'auto',
    fuzzyMatchThreshold: 80,
    fuzzyMinLength: 6,
    fuzzySlidingWindow: false,
    fuzzySlidingWindowMaxOffset: 10,
    skipMultipleTargets: true,
    enableSymbolExclusion: false,
    excludeSymbolStart: '{',
    excludeSymbolEnd: '}',
    enableInternalLinkSyntax: false,
    enableContextDisambiguation: false,
    jumpEnabled: true,
    lineJumpWaitSeconds: 8,
    jumpOpenInNewTab: true,
    lineLinkSelfHeal: false,
    autoExcludeContainedCopies: false,
    filenameAffixExclusions: [],
    // wordBoundaryRegex: '/[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u',
};

export default class LinkerPlugin extends Plugin {
    // Check if in Canvas view
    private isInCanvas(): boolean {
        // Only check if the current active view is Canvas
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.getViewType() === 'canvas') {
            return true;
        }

        return false;
    }

    public async handleLayoutChange() {
        if (!this.settings.autoToggleByMode) return;
        
        // Check if in Canvas view
        if (this.isInCanvas()) {
            // In Canvas view, if plugin is not activated, activate it
            if (!this.settings.linkerActivated) {
                await this.updateSettings({ linkerActivated: true });
            }
            return;
        }
        
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) return;
        
        const isPreviewMode = activeView.getMode() === 'preview';
        const isEditorMode = activeView.getMode() === 'source';
        
        // In read mode and plugin activated -> deactivate
        if (isPreviewMode && this.settings.linkerActivated) {
            await this.updateSettings({ linkerActivated: false });
        }
        // In edit mode and plugin not activated -> activate
        else if (isEditorMode && !this.settings.linkerActivated) {
            await this.updateSettings({ linkerActivated: true });
        }
    }

    // Copy a Markdown link for the current line, e.g.
    //   [33](obsidian://adv-uri?vault=<id>&filepath=<url-encoded path>&line=33&column=1&openmode=true&view-mode=source)
    // The full parameter set matches what Advanced URI generates, while the
    // [line-number](...) wrapper keeps the pasted checklist line clean.
    // Line jumping lives in src/lineJump.ts now - these are thin forwards so
    // the protocol handler and the commands keep working unchanged.
    async copyLineUri(file: TFile, lineZeroBased: number) {
        return copyLineUri(this.app, this.settings, file, lineZeroBased);
    }

    async jumpToLine(filepath: string, line: number, anchor?: string) {
        return jumpToLine(this.app, this.settings, filepath, line, anchor);
    }

    private async openFileOnly(file: TFile): Promise<WorkspaceLeaf | null> {
        return openFileOnly(this.app, this.settings, file);
    }

    /**
     * Start a centring loop for one CodeMirror view and return its controller.
     *
     * Every centring path needs the same scaffolding: replace whatever loop is
     * already running for that view (two loops writing the scroll position fight
     * each other, which read as the page scrolling on its own), and let the user
     * cancel by scrolling, clicking or typing. Kept in one place so the paths
     * cannot drift apart - this area has been adjusted more than once.
     */
    private startCentring(cm: EditorView): AbortController {
        activeCenterLoops.get(cm)?.abort();
        const controller = new AbortController();
        activeCenterLoops.set(cm, controller);
        const stop = () => controller.abort();
        window.addEventListener('wheel', stop, { capture: true, passive: true, signal: controller.signal });
        window.addEventListener('mousedown', stop, { capture: true, signal: controller.signal });
        window.addEventListener('keydown', stop, { capture: true, signal: controller.signal });
        return controller;
    }

    /**
     * Keep a heading centred in the editor showing it, while the content above
     * finishes laying out.
     *
     * Two things make this reliable where a one-shot scroll is not:
     *   - the loop MEASURES where the line actually is (lineBlockAt) and only
     *     acts on readings that hold still, so a "did it work" is known rather
     *     than assumed - and CodeMirror's estimates for not-yet-rendered regions
     *     are never chased;
     *   - the correction is a plain scrollTop write, NOT cm.dispatch(): a
     *     transaction goes through the view's update cycle and issuing one
     *     mid-measure makes CodeMirror restart its measure loop until it gives
     *     up rendering the document entirely.
     */
    public centerHeadingLine(view: MarkdownView, line: number, maxMs = 10000, targetViewport?: number): void {
        const cmEl = view.contentEl.querySelector('.cm-editor');
        const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
        if (cm) this.centerCmLine(cm, line, maxMs, targetViewport);
    }

    /**
     * Centre the line a rendered heading element lives on, using the element's
     * OWN editor. This is what makes a hover popover work: Hover Editor hosts a
     * real view that is not part of the workspace's leaf list, so resolving the
     * view through the workspace fails there - but the element itself still
     * knows its editor (EditorView.findFromDOM) and its own position
     * (posAtDOM), which is exact and needs no metadata lookup at all.
     */
    public centerHeadingElement(el: HTMLElement, maxMs = 8000, targetViewport?: number): boolean {
        const cmEl = el.closest('.cm-editor');
        const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
        if (!cm) return false;

        // Centre directly from the element's own measured DOM.
        // getBoundingClientRect is the rendered truth, and it is the same element
        // and the same coordinate space the outer keepAligned uses, so one delta
        // lands exactly; the previous coordsAtPos/lineBlockAt path differed by a
        // few pixels because the height estimates disagreed, showing up as "just
        // off-centre" or back-and-forth tugging. The properties panel height and
        // whether it is folded do not matter.
        const scroller = cm.scrollDOM;

        // A later request replaces the previous loop (only the last survives when
        // the same spot is requested repeatedly, avoiding several loops writing
        // the scroll at once).
        const controller = this.startCentring(cm);

        const startedAt = Date.now();
        let passes = 0;
        let lastTop = Number.NaN;
        // Scroll strategy: the measured write, and nothing else.
        //
        // An EditorView.scrollIntoView effect was measured on a math-heavy note
        // (scrollTop hook): Obsidian lands the jump EXACTLY via
        // setEphemeralState (0 -> 22749), then our effect moved it to 23666 and
        // every retry pushed it further (23615, 23142). Reason: scrollIntoView
        // centres a POSITION, and while display math keeps re-typesetting,
        // CodeMirror's idea of where that position sits on screen is an
        // estimate - so the "correction" itself was the drift.
        //
        // getBoundingClientRect() inside the measure cycle is the rendered
        // truth, so the write lands where the heading IS. The self-check stays:
        // if two writes in a row do not move the heading closer, stop - a loop
        // that cannot win must not tug at the view.
        let fails = 0;
        let lastMiss = Number.NaN;
        const measureWrite = () => {
            cm.requestMeasure({
                read: (view) => {
                    if (!el.isConnected) return null;
                    // Measure the ROW, not the inline heading span - see
                    // headingRowElement in virtualLinkDom.
                    const rr = headingRowElement(el).getBoundingClientRect();
                    const sr = view.scrollDOM.getBoundingClientRect();
                    const h = Math.max(1, rr.height);
                    const t = targetViewport ?? Math.max(12, Math.round((view.scrollDOM.clientHeight - h) / 2));
                    return Math.round((rr.top - sr.top) - t);
                },
                write: (d, view) => {
                    if (d === null) return;
                    // A centre can be PHYSICALLY out of reach - see the note in
                    // tick(). Clamp to the scrollable range and do nothing when
                    // that leaves no movement: the current position is then the
                    // closest the heading can get to the middle.
                    const dom = view.scrollDOM;
                    const maxTop = Math.max(0, dom.scrollHeight - dom.clientHeight);
                    const want = Math.min(Math.max(0, dom.scrollTop + d), maxTop);
                    if (Math.abs(want - dom.scrollTop) < 2) return;
                    dom.scrollTop = want;
                },
            });
        };
        const tick = () => {
            if (controller.signal.aborted) return;
            // Few writes, each one accurate. Every write makes CodeMirror measure
            // again, and while display math is still being typeset that means the
            // two keep taking the wheel from each other - which is what "it
            // centres and then gets pulled back" is. Writing is therefore capped,
            // and later height changes are handled by the caller instead:
            // keepAligned watches with a ResizeObserver and calls this again.
            if (Date.now() - startedAt > maxMs || passes > 6) return;
            if (!el.isConnected) return;   // element was reclaimed by CM, let the caller look it up again

            // The ROW, not the inline span (see headingRowElement): decorations
            // like Heading Decorator's padding live on the row, and the span-only
            // measurement aimed the centre a few dozen pixels off.
            const r = headingRowElement(el).getBoundingClientRect();
            const sr = scroller.getBoundingClientRect();
            const current = r.top - sr.top;
            const height = Math.max(1, r.height);
            // 12: the old ALIGN_MIN_GAP floor, used only when no jump baseline
            // exists (plain "centre this heading" usage).
            // The caller's target is where the JUMP left the heading (baseline):
            // drift protection aims there, not at a second guess of "centred".
            const target = targetViewport ?? Math.max(12, Math.round((scroller.clientHeight - height) / 2));
            const delta = Math.round(current - target);
            // Is the page still moving? MathJax typesets $$...$$ asynchronously,
            // so a note full of it shifts the heading every few hundred ms.
            // Writing into a moving page is what produces the tug-of-war, so wait
            // for it to hold still - but never for ever: after a few seconds the
            // current reading is acted on regardless, so a page that never quite
            // settles still ends up centred.
            const topNow = Math.round(current);
            const stable = Number.isNaN(lastTop) || Math.abs(topNow - lastTop) <= 2;
            lastTop = topNow;
            if (Math.abs(delta) <= HEADING_EPSILON_PX) return;   // close enough
            // Is the centre even reachable? A heading near the END of a short
            // note has too little content below it to sit in the middle, and one
            // near the start has too little above. Obsidian's own jump respects
            // that and leaves the heading at the closest reachable spot - which
            // is why it looks "almost centred". Writing without that check
            // scrolled into the edge and carried the heading away from the
            // middle: "it was basically centred and then something moved it".
            // Already at the limit => this IS the best position; stop touching it.
            const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            const wantTop = Math.min(Math.max(0, scroller.scrollTop + delta), maxTop);
            if (Math.abs(wantTop - scroller.scrollTop) < 2) return;
            // Self-check, but judge the result ONLY while the page is holding
            // still. While the layout keeps moving, "the heading is no closer"
            // just means it moved again - counting those as failures made the
            // loop give up after two passes on math-heavy notes, which is how a
            // heading ended up visibly off-centre with nothing left to fix it.
            if (stable) {
                if (!Number.isNaN(lastMiss) && Math.abs(delta) >= lastMiss - 2) fails++;
                else fails = 0;
                lastMiss = Math.abs(delta);
                if (fails >= 2) return;   // cannot win: stop, do not tug
            }
            // Waiting three seconds for the page to hold still was too long: the
            // caller only asks for alignment during its own window, and in a
            // math-heavy note the layout keeps shifting well past that, so the
            // write often never happened. Wait briefly, then act anyway.
            if (!stable && Date.now() - startedAt < 1200) {
                window.setTimeout(tick, 500);
                return;
            }

            measureWrite();
            passes++;
            window.setTimeout(tick, 500);
        };
        window.setTimeout(tick, 200);
        return true;
    }

    private centerCmLine(cm: EditorView, line: number, maxMs: number, targetViewport?: number): void {
        // Arm this view's dispatch guard (idempotent): Obsidian occasionally
        // dispatches an out-of-range selection, so catch it, clamp it into the
        // document length and retry - defusing the error rather than hiding it.
        patchDispatchClamp(cm);

        // A later request replaces the previous loop: only the last survives when
        // the same spot is requested repeatedly, avoiding several loops writing
        // the scroll at once (the preview "keeps scrolling" is them fighting).
        const controller = this.startCentring(cm);
        const scroller = cm.scrollDOM;

        const startedAt = Date.now();
        // The window can be extended: display math ($$...$$) is rendered
        // asynchronously by MathJax, and a note full of it keeps changing height
        // for well over ten seconds. Ending the loop on schedule there leaves
        // the heading exactly "a bit off" - the reported symptom.
        let deadline = startedAt + maxMs;
        let extensions = 0;
        let passes = 0;
        let lastCurrent = Number.NaN;
        // "Are there images still loading?" cannot rescan everything on every
        // check: such notes embed hundreds of images and this loop asks every
        // 700ms - a dozen rounds is thousands of queries. Re-read the list at
        // most every 1.5s, matching keepAligned's handling.
        let imgs: HTMLImageElement[] = [];
        let imgsAt = 0;
        const mathBusy = createMathBusyWatcher(scroller);
        const stillLoading = (): boolean => {
            const now = Date.now();
            if (now - imgsAt > 1500) {
                imgs = Array.from(scroller.querySelectorAll('img'));
                imgsAt = now;
            }
            return imgs.some((img) => !img.complete) || mathBusy();
        };
        // How many passes in a row the heading has sat inside the tolerance.
        // Once it holds, the loop only needs a slow backstop (see the end of
        // tick), not a check every 700ms.
        let settledPasses = 0;
        // Minimal intervention, because the experiment was unambiguous: without
        // this code the editor kept rendering but the heading was pushed out of
        // place, with it the view could stop rendering altogether. So: give the
        // view time to recover from the jump, wait for the page to stop moving,
        // and then write ONCE - never touching the scroll again afterwards.
        // 800ms (was 2000ms): the caller already waited a round of its own, and
        // making the user wait another 2s felt like "a long pause before it
        // finally jumps and straightens".
        const MIN_FIRST_WRITE_MS = 800;
        // The page can move more than once after the first correction: a PDF
        // embed releases its reserved height seconds later, which shrinks
        // everything above the heading and pushes it off the top. Each write
        // goes through requestMeasure (no transaction), so correcting again is
        // safe - the loop keeps the heading in place until the window ends.
        const MAX_WRITES = 24;

        // Measure the heading line's current viewport position (relative to the
        // .cm-scroller viewport top) and height. Use coordsAtPos (measured
        // coordinates of the rendered line) rather than lineBlockAt: the latter is
        // CodeMirror's content coordinate, offset from the .cm-scroller that owns
        // the scroll by the properties / inline-title height (355px in the logs).
        // Computing the delta in viewport coordinates needs no assumption about the
        // properties panel; only when the line is off-screen and has no coordinates
        // does it fall back to content coordinates plus a top offset to scroll
        // there first.
        const measure = (view: EditorView): { current: number; height: number } | null => {
            let pos: number;
            try {
                pos = view.state.doc.line(line + 1).from;
            } catch {
                return null;
            }
            const sr = view.scrollDOM.getBoundingClientRect();
            const coords = view.coordsAtPos(pos);
            if (coords) {
                return { current: coords.top - sr.top, height: Math.max(1, coords.bottom - coords.top) };
            }
            try {
                const b = view.lineBlockAt(pos);
                const ct = view.contentDOM.getBoundingClientRect().top;
                return {
                    current: b.top - view.scrollDOM.scrollTop
                        + (ct - sr.top + view.scrollDOM.scrollTop),
                    height: Math.max(1, b.height),
                };
            } catch {
                return null;
            }
        };

        const tick = () => {
            if (controller.signal.aborted) return;
            if (passes > 24) return;
            if (Date.now() > deadline) {
                // Readings still moving means content is still landing. Extend a
                // couple of times instead of giving up; once it holds still
                // (settledPasses > 0) there is nothing left to wait for.
                if (extensions < 2 && settledPasses === 0) {
                    extensions++;
                    deadline = Date.now() + 5000;
                } else {
                    return;
                }
            }
            const m = measure(cm);
            if (!m) {
                // Line number out of range (CM6 is still loading the new document
                // after a jump, or the number comes from a stale state): keep
                // retrying until maxMs rather than returning here - returning would
                // silently stop the whole centring loop on its first tick and leave
                // the heading at Obsidian's default position.
                window.setTimeout(tick, 700);
                return;
            }
            const target = targetViewport ?? Math.max(12, Math.round((scroller.clientHeight - m.height) / 2));
            const current = Math.round(m.current);
            // A tight tolerance, but only readings that HOLD STILL are acted on:
            // while CodeMirror is still measuring a region its line positions
            // are estimates that change from tick to tick (chasing those flung
            // the view thousands of pixels away), whereas a settled reading is
            // exact - and a settled offset of half a heading is exactly what
            // needs correcting. A generous tolerance simply declared that
            // half-heading offset "close enough" and left it alone.
            const tolerance = Math.max(6, Math.round(scroller.clientHeight * 0.04));
            const unreliable = current < -scroller.clientHeight;   // CM6 mid-remit
            // Requiring the two readings to be EXACTLY equal was too strict: a
            // sub-pixel wobble left "settled" false forever, so the only thing
            // that could still correct was the impatient valve (4s in, and only
            // past 60px) - which is exactly how an off-by-a-bit heading stayed
            // off by a bit. Two pixels of noise is not the page still moving.
            const settled = Math.abs(current - lastCurrent) <= 2 && !stillLoading();
            lastCurrent = current;
            const miss = Math.abs(current - target);
            // Safety valve: a surface that never settles (something animating
            // above) would otherwise never be corrected at all.
            // After four seconds the reading is trusted even if it never holds
            // perfectly still. It used to also demand miss > 60, so a heading
            // sitting 40px off - the "almost centred" case, typical of a note
            // whose math is still rendering - was never corrected at all.
            const impatient = Date.now() - startedAt > 4000;
            const shouldAct = miss > tolerance && (settled || impatient);
            if (settled && miss <= tolerance) settledPasses++;
            else settledPasses = 0;
            const oldEnough = Date.now() - startedAt >= MIN_FIRST_WRITE_MS;
            if (!unreliable && shouldAct && oldEnough && passes < MAX_WRITES) {
                // requestMeasure is CodeMirror's own hook for adjusting the
                // scroll from inside its measure cycle, and it is the only one
                // that works here:
                //   - a plain scrollTop write is re-applied-over by the view's
                //     next measure (the log showed the same offset again and
                //     again - the write simply did not stick);
                //   - a transaction (dispatch) does stick, but issuing one while
                //     the view is measuring makes it restart its measure loop
                //     until it gives up laying the document out.
                // requestMeasure does neither: it runs in the measure cycle, so
                // the position is applied after the view has decided its own.
                // Write the "measured - target" delta (the same viewport coordinate
                // space used above), so the properties panel height does not matter;
                // re-measure in the read phase to get the latest layout.
                try {
                    cm.requestMeasure({
                        read: (view) => measure(view),
                        write: (mm, view) => {
                            if (!mm) return;
                            const delta = mm.current
                                - (targetViewport ?? Math.max(12, Math.round((view.scrollDOM.clientHeight - mm.height) / 2)));
                            // Clamp to the scrollable range (see centerHeadingElement):
                            // the centre may be out of reach near either end of the note.
                            const dom = view.scrollDOM;
                            const maxTop = Math.max(0, dom.scrollHeight - dom.clientHeight);
                            const want = Math.min(Math.max(0, dom.scrollTop + delta), maxTop);
                            if (Math.abs(want - dom.scrollTop) < 2) return;
                            dom.scrollTop = want;
                        },
                    });
                } catch { return; }
                passes++;
            }
            // Keep watching for the whole window even after the position looks
            // right: CodeMirror can STALL (its measure-restart limit), which
            // makes the page hold still while nothing is rendered - so "it looks
            // settled" is not proof that it is finished, and the position has to
            // be re-checked when rendering resumes. Once it has held still for a
            // couple of passes that check runs at a slower cadence instead.
            window.setTimeout(tick, settledPasses >= 2 ? 2000 : 700);
        };
        window.setTimeout(tick, 400);
    }

    // Mix two hex colors in sRGB. `t` (0-1) is the weight given to `base`.
    private mixHexColors(base: string, target: string, t: number): string {
        const parse = (hex: string): [number, number, number] | null => {
            const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
            if (!m) return null;
            const n = parseInt(m[1], 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        };
        const a = parse(base);
        const b = parse(target);
        // Fall back to the plain target color when either is not a hex color.
        if (!a || !b) return target;
        const mix = (i: number) => Math.round(a[i] * t + b[i] * (1 - t));
        // (Avoid String#padStart: it needs ES2017, while the project's
        //  tsconfig lib only goes up to ES7.)
        const toHex = (v: number) => ('0' + v.toString(16)).slice(-2);
        return `#${toHex(mix(0))}${toHex(mix(1))}${toHex(mix(2))}`;
    }

    // Fuzzy-match links use the base color mixed into the header / note color,
    // so they read as "same family but fuzzier" instead of an unrelated 4th color.
    applyFuzzyColors() {
        const t = Math.min(100, Math.max(0, this.settings.fuzzyColorMixRatio ?? 50)) / 100;
        const base = this.settings.fuzzyBaseColor;
        activeWindow.document.body.style.setProperty(
            '--virtual-link-fuzzy-header-color',
            this.mixHexColors(base, this.settings.headerVirtualLinkColor, t)
        );
        activeWindow.document.body.style.setProperty(
            '--virtual-link-fuzzy-note-color',
            this.mixHexColors(base, this.settings.noteVirtualLinkColor, t)
        );
    }

    settings: LinkerPluginSettings;
    updateManager = new ExternalUpdateManager();

    async onload() {
        await this.loadSettings();

        this.applyStartupAppearance();
        this.registerWorkspaceEvents();
        this.registerIndexWatchers();
        this.registerLinkers();

        this.registerIndentBackground();
        this.registerCommentSpaceTrim();

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new LinkerSettingTab(this.app, this));

        this.registerAdvUriLinkClicks();

        registerEmbedReservation(this);

        this.registerAdvUriProtocol();
        this.registerContextMenus();
        this.registerCommands();
    }

    private registerIndentBackground(): void {
        // A line indented with a Tab has NO class of its own in Obsidian, so a
        // CSS snippet cannot style it (or the line above it) at all. Mark those
        // lines here; styles.css does the painting, and only while the
        // "Background" setting is on (body.virtual-link-bg).
        this.registerEditorExtension(
            ViewPlugin.fromClass(
                class {
                    decorations: DecorationSet;
                    constructor(view: EditorView) {
                        this.decorations = buildIndentBackground(view);
                    }
                    update(update: ViewUpdate) {
                        if (update.docChanged || update.viewportChanged) {
                            this.decorations = buildIndentBackground(update.view);
                        }
                    }
                },
                { decorations: (v) => v.decorations }
            )
        );
    }

    private registerCommentSpaceTrim(): void {
        // Auto-trim spaces inside %% comments when alternative display style is enabled
        this.registerEditorExtension(
            EditorView.updateListener.of((update) => {
                if (!this.settings.alternativeDisplayStyle || !update.docChanged) return;
                
                // Find the affected range, expand to full lines
                let minFrom = Infinity;
                let maxTo = -Infinity;
                update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
                    if (fromB < minFrom) minFrom = fromB;
                    if (toB > maxTo) maxTo = toB;
                });
                if (minFrom === Infinity) return;
                
                const doc = update.state.doc;
                const startLine = doc.lineAt(minFrom);
                const endLine = doc.lineAt(maxTo - 1 > 0 ? maxTo - 1 : maxTo);
                
                // Scan each affected line for %% text %% patterns
                const changes: { from: number; to: number; insert: string }[] = [];
                for (let i = startLine.number; i <= endLine.number; i++) {
                    const line = doc.line(i);
                    let text = line.text;
                    if (!text.includes('%%') || !/\S/.test(text)) continue;
                    
                    // Fix %% text %% -> %%text%% (precise range replacement)
                    let searchFrom = 0;
                    while (searchFrom < text.length) {
                        const startIdx = text.indexOf('%%', searchFrom);
                        if (startIdx === -1) break;
                        
                        // Find content after %%
                        const contentStart = startIdx + 2;
                        // Find the closing %%
                        const endIdx = text.indexOf('%%', contentStart);
                        if (endIdx === -1) {
                            searchFrom = contentStart;
                            continue;
                        }
                        
                        // Extract content between %% markers and trim
                        const inner = text.slice(contentStart, endIdx);
                        const trimmed = inner.trim();
                        
                        if (trimmed !== inner) {
                            const fullFrom = line.from + startIdx;
                            const fullTo = line.from + endIdx + 2;
                            changes.push({
                                from: fullFrom,
                                to: fullTo,
                                insert: `%%${trimmed}%%`
                            });
                            // Adjust text for subsequent searches on this line
                            const before = text.slice(0, startIdx);
                            const after = text.slice(endIdx + 2);
                            text = before + `%%${trimmed}%%` + after;
                            searchFrom = startIdx + trimmed.length + 4;
                        } else {
                            searchFrom = endIdx + 2;
                        }
                    }
                }
                
                if (changes.length > 0) {
                    // Preserve selection, excluding %% markers
                    // When there is exactly one %% pair, set selection to content only
                    if (changes.length === 1) {
                        const ch = changes[0];
                        const anchor = ch.from + 2;
                        const head = ch.from + ch.insert.length - 2;
                        update.view.dispatch({ 
                            changes, 
                            selection: EditorSelection.single(anchor, head) 
                        });
                    } else {
                        update.view.dispatch({ changes });
                    }
                }
            })
        );

        // Auto-insert symbol at front of new/changed headers
        this.registerEditorExtension(
            EditorView.updateListener.of((update) => {
                if (!this.settings.headerAutoAppendSuffix || !update.docChanged) return;
                const symbol = this.settings.headerAutoAppendSymbol;
                if (!symbol) return;
                
                const doc = update.state.doc;
                let minFrom = Infinity, maxTo = -Infinity;
                update.changes.iterChanges((_a, _b, fromB, toB) => {
                    if (fromB < minFrom) minFrom = fromB;
                    if (toB > maxTo) maxTo = toB;
                });
                if (minFrom === Infinity) return;
                
                const startLine = doc.lineAt(minFrom);
                const endLine = doc.lineAt(Math.max(0, maxTo - 1));
                const changes: { from: number; to: number; insert: string }[] = [];
                
                for (let i = startLine.number; i <= endLine.number; i++) {
                    const line = doc.line(i);
                    const text = line.text;
                    // Match header with content: "# Title", "## Subtitle"
                    const match = text.match(/^(#{1,6}\s+)(\S.*)$/);
                    if (!match) continue;
                    const prefix = match[1];      // e.g., "# " or "## "
                    const content = match[2];      // e.g., "概念"
                    // Skip if symbol already present at front of content
                    if (content.startsWith(symbol)) continue;
                    // Insert symbol after prefix, before content
                    changes.push({
                        from: line.from + prefix.length,
                        to: line.from + prefix.length,
                        insert: symbol
                    });
                }
                
                if (changes.length > 0) {
                    update.view.dispatch({ changes });
                }
            })
        );
    }

    private registerAdvUriLinkClicks(): void {
        // Intercept obsidian://adv-uri link clicks (DOM level) to jump to a
        // line directly. FakeLink does NOT register the protocol handler, so
        // the Advanced URI plugin stays fully functional. This handler only
        // catches links rendered as real <a> elements.
        //
        this.registerDomEvent(this.app.workspace.containerEl, 'click', (evt) => {
            if (!this.settings.jumpEnabled) return;
            const a = (evt.target as HTMLElement).closest('a');
            if (!a) return;
            const href = a.getAttribute('href') || '';
            if (!href.startsWith('obsidian://adv-uri')) return;
            const p = new URLSearchParams(href.slice('obsidian://adv-uri?'.length));
            const line = parseInt(p.get('line') || '', 10);
            if (!line || line < 1) return;
            const filepath = p.get('filepath') || '';
            const anchor = p.get('anchor') || undefined;
            evt.preventDefault();
            evt.stopImmediatePropagation();
            void this.jumpToLine(filepath, line, anchor);
        }, true);
    }

    /** Body classes (display style, background), the link colors and the what-is-new notice. */
    private applyStartupAppearance(): void {
        // Apply alternative display style body class based on settings
        if (this.settings.alternativeDisplayStyle) {
            activeWindow.document.body.classList.add('virtual-linker-alt-style');
        }

        // Apply color-only display mode
        if (this.settings.colorOnlyDisplay) {
            activeWindow.document.body.classList.add('virtual-link-color-only');
        }

        // The optional look lives under these classes (settings: Appearance ->
        // Background). One helper applies them everywhere, so it can also be
        // re-run later for windows that did not exist yet at startup.
        this.applyBackgroundStyles();

        // Show "what is new" once, right after an update - never on a fresh
        // install, where notes about past releases are of no use to anyone.
        // Delayed a moment so it does not compete with Obsidian's own startup,
        // and only when the notes really belong to this version, so a release
        // that forgot to update them stays quiet instead of showing stale text.
        const currentVersion = this.manifest.version;
        if (this.settings.lastSeenVersion && this.settings.lastSeenVersion !== currentVersion
            && WHATS_NEW_VERSION === currentVersion) {
            window.setTimeout(() => new WhatsNewModal(this.app, currentVersion).open(), 1500);
        }
        if (this.settings.lastSeenVersion !== currentVersion) {
            this.settings.lastSeenVersion = currentVersion;
            void this.saveData(this.settings);
        }

        // Always set link colors (header vs note)
        activeWindow.document.body.style.setProperty('--virtual-link-color', this.settings.noteVirtualLinkColor);
        activeWindow.document.body.style.setProperty('--virtual-link-header-color', this.settings.headerVirtualLinkColor);
        activeWindow.document.body.style.setProperty('--virtual-link-note-color', this.settings.noteVirtualLinkColor);
        // Fuzzy-match links: base color mixed into the header / note color.
        this.applyFuzzyColors();
    }

    private registerWorkspaceEvents(): void {
        // Listen for view changes
        this.registerEvent(this.app.workspace.on('layout-change', () => {
            void this.handleLayoutChange();
            // A window opened after startup missed the startup application, so
            // its <body> carries none of these classes.
            this.scheduleBackgroundSync();
        }));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => { void this.handleLayoutChange(); }));
    }

    private registerIndexWatchers(): void {
        // Set callback to update the cache when the settings are changed
        this.updateManager.registerCallback(() => {
            LinkerCache.getInstance(this.app, this.settings).clearCache();
        });

        // When auto-exclude (renamed duplicates) re-indexes asynchronously,
        // refresh the decorations so the newly excluded note stops linking.
        LinkerCache.getInstance(this.app, this.settings).onIndexChanged = () => this.updateManager.update();

        // Keep the index in step with the vault: a note that is created, deleted
        // or renamed changes which terms can be linked, and without this the
        // change only showed up after switching notes or restarting.
        //
        // Only these three events are watched, deliberately NOT 'modify': a save
        // happens every few seconds while typing, and each refresh rebuilds the
        // index, which would stutter on a large vault. Creation, deletion and
        // renaming are rare enough that even a full rebuild goes unnoticed, and
        // a burst of them (a folder dropped in) is coalesced into one refresh.
        let indexRefreshTimer: number | null = null;
        const scheduleIndexRefresh = (): void => {
            if (indexRefreshTimer !== null) window.clearTimeout(indexRefreshTimer);
            indexRefreshTimer = window.setTimeout(() => {
                indexRefreshTimer = null;
                this.updateManager.update();
            }, 800);
        };
        // Attachments and folders cannot become link targets, so they are
        // ignored: dropping a folder of images must not trigger a rebuild.
        const isNote = (file: TAbstractFile): boolean =>
            file instanceof TFile && file.extension === 'md';
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (isNote(file)) scheduleIndexRefresh();
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (isNote(file)) scheduleIndexRefresh();
        }));
        this.registerEvent(this.app.vault.on('rename', (file) => {
            if (isNote(file)) scheduleIndexRefresh();
        }));
    }

    private registerLinkers(): void {
        // Register the glossary linker for the read mode
        this.registerMarkdownPostProcessor((element, context) => {
            context.addChild(new GlossaryLinker(this.app, this.settings, context, element, this));
        });

        // Register the live linker for the live edit mode
        this.registerEditorExtension(liveLinkerPlugin(this.app, this.settings, this.updateManager, this));
    }

    // Take over the obsidian://adv-uri protocol so line links (fired from an
    // external browser/handler too) are jumped by FakeLink itself.
    private registerAdvUriProtocol(): void {

        // Take over the obsidian://adv-uri protocol so line links (including
        // those fired from an external browser/handler) are jumped by FakeLink.
        // Obsidian allows only ONE handler per protocol action, so we give way
        // when the Advanced URI plugin is enabled (it registers the same
        // action); when AU is disabled, FakeLink owns it and uses
        // scrollIntoView(center=false), which also fixes the "top few lines
        // won't scroll" bug that Advanced URI's centered scroll has.
        window.setTimeout(() => {
            const advancedUriLoaded = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
                .plugins?.plugins?.['obsidian-advanced-uri'] != null;
            if (advancedUriLoaded) {
                console.warn('[fakelink] Advanced URI is enabled - not registering adv-uri protocol to avoid conflict. Disable Advanced URI to let FakeLink handle line jumping.');
                return;
            }
            if (!this.settings.jumpEnabled) return;
            this.registerObsidianProtocolHandler('adv-uri', (data) => {
                if (!this.settings.jumpEnabled) return;
                const d = data as Record<string, string>;
                const filepath = d['filepath'] || '';
                const line = parseInt(d['line'] || '', 10);
                const anchor = d['anchor'] || undefined;
                if (!filepath) return;
                if (!line || line < 1) {
                    // No line: this is the "open the file" step of an external
                    // handler's two-step sequence. Open it now (so it renders
                    // early) and do nothing else.
                    const file = this.app.vault.getAbstractFileByPath(filepath);
                    if (file instanceof TFile) void this.openFileOnly(file);
                    return;
                }
                void this.jumpToLine(filepath, line, anchor);
            });
        }, 500);
    }

    private registerContextMenus(): void {
        // Right-click context menu: copy an obsidian://adv-uri link pointing at
        // the line where the cursor is. This lets users generate line links
        // without the Advanced URI plugin (whose "Copy URI" this replaces).
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, info) => {
                const file = info.file;
                if (!file) return;
                menu.addItem((item) =>
                    item
                        .setTitle(t('Copy line link (adv-uri)'))
                        .setIcon('link')
                        .onClick(() => this.copyLineUri(file, editor.getCursor().line))
                );
            })
        );

        // Context menu item to convert virtual links to real links
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file, source) => this.addContextMenuItem(menu, file, source)));
    }

    private registerCommands(): void {
        this.addCommand({
            id: 'toggle-virtual-linker',
            name: 'Toggle virtual linker',
            callback: () => {
                void this.updateSettings({ linkerActivated: !this.settings.linkerActivated });
                this.updateManager.update();
            }
        });

        this.addCommand({
            id: 'toggle-header-marker',
            name: 'Toggle header marker symbol',
            callback: () => {
                void this.updateSettings({ headerAutoAppendSuffix: !this.settings.headerAutoAppendSuffix });
            }
        });

        this.addCommand({
            id: 'convert-selected-virtual-links',
            name: 'Convert all virtual links in selection to real links',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                if (!editor.somethingSelected()) {
                    new Notice(t('Select some text first, then run this command.'));
                    return;
                }
                if (!this.settings.linkerActivated) {
                    new Notice(t('Virtual links are currently disabled. Enable them in the settings first.'));
                    return;
                }
                const fromPos = editor.getCursor('from');
                const toPos = editor.getCursor('to');
                const rangeFrom = editor.posToOffset(fromPos);
                const rangeTo = editor.posToOffset(toPos);
                const modal = new BatchConvertModal(
                    this.app,
                    this.settings,
                    this,
                    [rangeFrom, rangeTo]
                );
                modal.open();
            }
        });


        // Convert ALL virtual links in the current note to real links, with a
        // preview list so the user can uncheck any they want to keep virtual.
        this.addCommand({
            id: 'convert-all-virtual-links-preview',
            name: 'Convert all virtual links in note to real links (preview)',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                const modal = new BatchConvertModal(this.app, this.settings, this);
                modal.open();
            }
        });

        // Convert virtual links across MULTIPLE notes, chosen by the user.
        this.addCommand({
            id: 'convert-multiple-files-virtual-links',
            name: 'Convert all virtual links in multiple notes to real links',
            callback: () => {
                const modal = new BatchConvertFilesModal(this.app, this.settings, this);
                modal.open();
            }
        });
    }

    // The context menu lives in src/contextMenu.ts now - thin forward so the
    // workspace event registration below keeps working unchanged.
    addContextMenuItem(menu: Menu, file: TAbstractFile, _source: string) {
        addContextMenuItem(this, menu, file, _source);
    }

    private cleanupVirtualLinks() {
        // Restore virtual links to original text
        const virtualLinks = activeDocument.querySelectorAll('.virtual-link, .virtual-link-span, .virtual-link-a');
        virtualLinks.forEach(link => {
            // Get original text: try origin-text attribute first, otherwise use link text content
            const anchor = link.classList.contains('virtual-link-a') ? link : link.querySelector('.virtual-link-a');
            const originalText = anchor?.getAttribute('origin-text') || anchor?.textContent || '';
            if (originalText) {
                // Replace virtual link element with text node
                const textNode = activeDocument.createTextNode(originalText);
                link.replaceWith(textNode);
            } else {
                // Delete if no text found
                link.remove();
            }
        });
        
        // Clear possible multiple reference indicators (these don't contain main text, delete directly)
        const multipleRefs = activeDocument.querySelectorAll('.multiple-files-references, .multiple-files-indicator');
        multipleRefs.forEach(ref => ref.remove());
    }

    // Reserves the final height of PDF++ cropped page embeds (see onload).
    private pdfReserveObserver: MutationObserver | null = null;
    // Image embeds: reserve their real size before they load, so they stop
    // reflowing everything below them. Dimensions come from the file header and
    // are cached per path, so each image is read at most once.
    private imageReserveObserver: MutationObserver | null = null;
    public imageSizes = new Map<string, { w: number; h: number }>();
    public imageSizeInflight = new Map<string, Promise<{ w: number; h: number } | null>>();
    // Markdown embeds (block references, whole-note embeds): their height cannot
    // be derived from the file - it depends on the container width and on the
    // rendering - but it can be REMEMBERED: measure once, reserve on every later
    // render. Keyed by src + width, since the same block differs per container.
    public pdfHeights = new Map<string, { w: number; h: number }[]>();
    // Last measured PDF embed height per container width. Embeds of one article
    // share the width, and in most vaults they also share the crop shape, so one
    // measurement can reserve all of them - including the ones not seen yet.
    public pdfWidthHeights = new Map<number, { h: number; r: number }>();
    // Learned px-per-point scale per container width: the rendered height is
    // assumed to be scale × cropHeight, which is independent of the crop SHAPE,
    // so it can predict a crop that has never been rendered. Only trusted once
    // at least two samples agree - a full-width render (where height also
    // depends on the crop width) scatters those ratios and disables the model.
    public pdfScaleSamples = new Map<number, { c: number; h: number }[]>();
    private embedReserveObserver: MutationObserver | null = null;
    public embedHeights = new Map<string, { w: number; h: number }[]>();
    onunload() {
        this.pdfReserveObserver?.disconnect();
        this.imageReserveObserver?.disconnect();
        this.embedReserveObserver?.disconnect();
        this.cleanupVirtualLinks();
    }

    async loadSettings() {
        // A fresh install has no data.json at all, so loadData() returns null,
        // and a damaged one can make it throw. Neither may abort onload: this
        // runs before the settings tab is registered, so throwing here leaves
        // the plugin completely dead - no settings to fix it with either.
        let stored: Partial<LinkerPluginSettings>
            & { headerJumpRetryDelay?: number; jumpDelayMs?: number } = {};
        try {
            stored = (await this.loadData() ?? {}) as typeof stored;
        } catch (error) {
            console.error('[fakelink] failed to read data.json - falling back to the defaults', error);
        }
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
        // Migration - "Tabs" used to be one switch for both the accent and the
        // unfocused mask. Anyone who had it off loses both parts again; carrying
        // this over is what keeps their appearance unchanged.
        // Reading the legacy backgroundTabs here is deliberate, not stale usage:
        // settings saved by 1.23.43 and earlier contain nothing else.
        if (typeof stored.backgroundTabs === 'boolean') {
            if (stored.backgroundTabAccent == null) {
                this.settings.backgroundTabAccent = stored.backgroundTabs;
            }
            if (stored.backgroundUnfocusedMask == null) {
                this.settings.backgroundUnfocusedMask = stored.backgroundTabs;
            }
        }
        // The watch window used to be stored in milliseconds and multiplied by
        // 24; it is now stored directly in seconds. Carry an existing value over
        // so the behaviour of anyone who had tuned it does not change.
        if (stored.headingAlignWatchSeconds == null && typeof stored.headerJumpRetryDelay === 'number') {
            const migrated = Math.round((stored.headerJumpRetryDelay * 24) / 1000);
            this.settings.headingAlignWatchSeconds =
                Math.min(120, Math.max(3, migrated || DEFAULT_SETTINGS.headingAlignWatchSeconds));
        }
        // Same for the line-link wait: it was stored in milliseconds, it is now
        // stored in seconds.
        if (stored.lineJumpWaitSeconds == null && typeof stored.jumpDelayMs === 'number') {
            this.settings.lineJumpWaitSeconds =
                Math.min(60, Math.max(0, Math.round(stored.jumpDelayMs / 1000)));
        }

        // Load markdown links from obsidian settings
        // At the moment obsidian does not provide a clean way to get the settings through an API
        // So we read the app.json settings file directly
        // We also Cannot use the vault API because it only reads the vault files not the .obsidian folder
        try {
            const fileContent = await this.app.vault.adapter.read(this.app.vault.configDir + '/app.json');
            const appSettings = JSON.parse(fileContent) as { useMarkdownLinks?: boolean; newLinkFormat?: string };
            this.settings.defaultUseMarkdownLinks = appSettings.useMarkdownLinks ?? false;
            this.settings.defaultLinkFormat = (appSettings.newLinkFormat ?? 'shortest') as 'shortest' | 'relative' | 'absolute';
        } catch {
            // Set default values
            this.settings.defaultUseMarkdownLinks = false;
            this.settings.defaultLinkFormat = 'shortest';
        }
    }

    /** Update plugin settings. */
    async updateSettings(settings: Partial<LinkerPluginSettings> = {}) {
        Object.assign(this.settings, settings);
        
        // Create a settings object copy without circular references
        const settingsToSave = {...this.settings};
        // Remove properties that should not be serialized
        delete settingsToSave.app;
        // delete settingsToSave.appMenuBarManager;
        
        try {
            await this.saveData(settingsToSave);
        } catch {
            // A failed save leaves in-memory settings ahead of the file; retry
            // once, then surface it instead of failing silently.
            try {
                await this.saveData(settingsToSave);
            } catch {
                new Notice(t('Failed to save settings. The change may be lost when Obsidian reloads.'));
            }
        }
        
        this.updateManager.update();
        
        // Keep the appearance in step no matter which code path changed a
        // setting (settings tab, command, context menu item).
        this.applyBackgroundStyles();

        // If plugin is disabled, clear all virtual links
        if (!this.settings.linkerActivated) {
            this.cleanupVirtualLinks();
        }
        
        // Force refresh all views to ensure settings changes take effect immediately
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const view = leaf.view;
            if (view instanceof MarkdownView && view.previewMode) {
                view.previewMode.rerender(true);
            }
        });
    }

    private bgSyncTimer: number | null = null;

    /**
     * Write the "Background" look to the <body> of every window.
     *
     * styles.css hangs the entire optional look on these classes, and the two
     * alpha variables are the strength sliders. This used to target whichever
     * window was active at startup, which left every later window - and any
     * window other than the one hosting the settings tab - unstyled until a
     * reload. Each <body> gets the full set so switching a part off removes it.
     */
    applyBackgroundStyles(): void {
        const s = this.settings;
        const wanted: string[] = [];
        if (s.backgroundHighlight) {
            wanted.push('virtual-link-bg');
            if (s.backgroundTint) wanted.push('virtual-link-bg-tint');
            if (s.backgroundLines) wanted.push('virtual-link-bg-lines');
            if (s.backgroundCursorLine) wanted.push('virtual-link-bg-cursor');
            if (s.backgroundTabAccent) wanted.push('virtual-link-bg-tab-accent');
            if (s.backgroundUnfocusedMask) wanted.push('virtual-link-bg-unfocused-mask');
        }
        const known = [
            'virtual-link-bg', 'virtual-link-bg-tint', 'virtual-link-bg-lines',
            'virtual-link-bg-cursor', 'virtual-link-bg-tab-accent', 'virtual-link-bg-unfocused-mask',
        ];
        const vars: [string, string][] = [
            ['--fakelink-line-alpha', String(s.backgroundLineOpacity / 100)],
            ['--fakelink-cursor-line-alpha', String(s.cursorLineOpacity / 100)],
        ];

        const seen = new Set<Document>();
        const visit = (ownerDoc: Document) => {
            if (seen.has(ownerDoc)) return;
            seen.add(ownerDoc);
            const body = ownerDoc.body;
            if (!body) return;
            for (const cls of known) body.classList.toggle(cls, wanted.indexOf(cls) !== -1);
            for (const [name, value] of vars) body.style.setProperty(name, value);
        };
        visit(activeWindow.document);
        this.app.workspace.iterateAllLeaves((leaf) => {
            const el = leaf.view?.containerEl;
            if (el) visit(el.ownerDocument);
        });
    }

    /** Layout changes arrive in bursts; touch the windows once when it settles. */
    private scheduleBackgroundSync(): void {
        if (this.bgSyncTimer !== null) return;
        this.bgSyncTimer = window.setTimeout(() => {
            this.bgSyncTimer = null;
            this.applyBackgroundStyles();
        }, 200);
    }
}
