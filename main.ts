import { App, Editor, EditorPosition, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './src/lang/helpers';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';
import { BatchConvertModal, BatchConvertFilesModal } from './src/batchConvert';
import { buildIndentBackground, clearContextLock, createMathBusyWatcher, getHoveredHeadingId, headingElementByLine, headingRowElement, keepScrolledHeadingAligned, markSelfInflictedLayout, patchDispatchClamp, resolveHeadingTarget } from './linker/virtualLinkDom';
import { convertVirtualLinkToReal } from './linker/convertLink';
import { LinkerSettingTab } from './src/settingsTab';
import { WhatsNewModal, WHATS_NEW_VERSION } from './src/whatsNew';
import { copyLineUri, jumpToLine, openFileOnly } from './src/lineJump';

// 同一编辑器只允许一个居中循环在跑。调用方（keepAligned）会在每次 miss 超容差
// 时再请求一次；如果每次都新起一个循环，多个循环各自写滚动，表现就是"不停
// 滚动"——预览弹窗里尤其明显。
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
    // One switch for the whole "背景" look: faint tint, list / Tab-indented
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
    enableStemming: boolean; // 词义模糊匹配 (fuzzy meaning matching)
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
    // 属性也用 linker- 前缀，和 linker-exclude / linker-ignore-case / linker-match-case
    // 保持一致。两种方式是二选一（linkIgnoreMode），所以同名不会冲突。
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

        // 直接按元素自身的 DOM 实测居中。getBoundingClientRect 是渲染后的真相，
        // 与外层 keepAligned 用的是同一个元素、同一套坐标，所以一次 delta 就能
        // 写到位；之前走 coordsAtPos/lineBlockAt 会因高度估算不一致差出几像素，
        // 表现为"差一点不居中"或反复拉扯。属性面板多高、是否折叠都不影响。
        const scroller = cm.scrollDOM;

        // 后到的请求替换先前的循环（同一处反复请求时只保留最后一个，避免多个
        // 循环同时写滚动）。
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
            if (!el.isConnected) return;   // 元素被 CM 回收了，交给调用方重新找

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
        // 给这个视图的 dispatch 装保护（幂等）：Obsidian 偶尔会拿超界 selection
        // 去 dispatch，这里捕获后 clamp 到文档长度内重试，真正化解而不是隐藏。
        patchDispatchClamp(cm);

        // 后到的请求替换先前的循环：同一处反复请求时只保留最后一个，避免多个
        // 循环同时写滚动（预览里"不停滚动"就是它们互相打架）。
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
        // "还有图片没加载完吗"不能每次检查都全量扫一遍：这类笔记里嵌着几百张
        // 图，而这个循环每 700ms 就要问一次 —— 十来轮下来是几千次查询。列表
        // 最多每 1.5 秒重读一次，和 keepAligned 里的处理保持一致。
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
        // 800ms（原 2000ms）：调用方已经先等了它自己的一轮，再让用户多等 2 秒
        // 才动手，观感就是"好久才跳一下拉正"。
        const MIN_FIRST_WRITE_MS = 800;
        // The page can move more than once after the first correction: a PDF
        // embed releases its reserved height seconds later, which shrinks
        // everything above the heading and pushes it off the top. Each write
        // goes through requestMeasure (no transaction), so correcting again is
        // safe - the loop keeps the heading in place until the window ends.
        const MAX_WRITES = 24;

        // 测标题行当前的视口位置（相对 .cm-scroller 视口顶部）与高度。用
        // coordsAtPos（基于已渲染行的实测坐标）而不是 lineBlockAt：后者是 CM 的
        // 内容坐标，和滚动所在的 .cm-scroller 差着 properties / inline title 的
        // 高度（日志里 355px）。视口坐标里直接算差值，属性面板有几行、是否折叠
        // 都不需要额外假设；行在视口外拿不到坐标时，才退回内容坐标 + 上方偏移，
        // 先把视口滚过去。
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
                // 行号超界（跳转后 CM6 还在装载新文档、或行号来自旧状态）：
                // 继续重试到 maxMs，不要在这一步 return —— 那样整个居中循环会在
                // 第一次 tick 就悄悄停掉，标题就停在 Obsidian 默认的位置。
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
                // 写入用"实测位置 - 目标位置"的差值（与上面判断同一套视口坐标），
                // 属性面板多高、是否折叠都不影响；read 阶段重新测一次拿最新布局。
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

        // Listen for view changes
        this.registerEvent(this.app.workspace.on('layout-change', () => {
            void this.handleLayoutChange();
            // A window opened after startup missed the startup application, so
            // its <body> carries none of these classes.
            this.scheduleBackgroundSync();
        }));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => { void this.handleLayoutChange(); }));

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

        // Register the glossary linker for the read mode
        this.registerMarkdownPostProcessor((element, context) => {
            context.addChild(new GlossaryLinker(this.app, this.settings, context, element, this));
        });

        // Register the live linker for the live edit mode
        this.registerEditorExtension(liveLinkerPlugin(this.app, this.settings, this.updateManager, this));

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

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new LinkerSettingTab(this.app, this));

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


        // ------------------------------------------------------------------
        // Persist the measured sizes. Without this every session starts cold:
        // the first render of each note re-reads every image header (Obsidian
        // has no partial-read API, so that is a full file read each) and
        // re-measures every block embed - which is the "takes a while before it
        // settles, previews do not even open" behaviour. With it, the work is
        // done once ever and later sessions (including the very first preview
        // after a restart) hit the cache straight away.
        // ------------------------------------------------------------------
        // Bumped once: every height learned before the measure-after-release fix
        // may be a reservation (a guess) rather than a measurement, so those
        // values are dropped and learned again correctly.
        const CACHE_KEY = '__fakelinkSizeCache2';
        const SIZE_CACHE_LIMIT = 1500;
        let sizeCacheSaveTimer: number | null = null;
        const persistSizeCache = () => {
            if (sizeCacheSaveTimer !== null) window.clearTimeout(sizeCacheSaveTimer);
            sizeCacheSaveTimer = window.setTimeout(() => {
                sizeCacheSaveTimer = null;
                void (async () => {
                    try {
                        const loaded: unknown = await this.loadData();
                        const stored = (loaded ?? {}) as Record<string, unknown>;
                        const capMap = <V>(m: Map<string, V>, n: number): Record<string, V> => {
                            const out: Record<string, V> = {};
                            for (const [k, v] of Array.from(m.entries()).slice(-n)) out[k] = v;
                            return out;
                        };
                        const tailMap = <V>(m: Map<number, V>, n: number): Record<string, V> => {
                            const out: Record<string, V> = {};
                            for (const [k, v] of Array.from(m.entries()).slice(-n)) out[String(k)] = v;
                            return out;
                        };
                        stored[CACHE_KEY] = {
                            images: capMap(this.imageSizes, SIZE_CACHE_LIMIT),
                            pdf: capMap(this.pdfHeights, 300),
                            embeds: capMap(this.embedHeights, 300),
                            widths: tailMap(this.pdfWidthHeights, 50),
                            scales: tailMap(this.pdfScaleSamples, 50),
                        };
                        await this.saveData(stored);
                    } catch { /* cache persistence is best-effort */ }
                })();
            }, 3000);
        };
        void (async () => {
            try {
                const loaded: unknown = await this.loadData();
                const stored = (loaded ?? {}) as Record<string, unknown>;
                const c = stored[CACHE_KEY] as
                    | {
                        images?: Record<string, { w: number; h: number }>;
                        pdf?: Record<string, { w: number; h: number }[]>;
                        embeds?: Record<string, { w: number; h: number }[]>;
                        widths?: Record<string, unknown>;
                        scales?: Record<string, unknown>;
                    }
                    | undefined;
                if (!c) return;
                const asList = <T>(v: unknown): T[] | null => (Array.isArray(v) ? (v as T[]) : null);
                const images = c.images ?? {};
                for (const k of Object.keys(images)) {
                    const v = images[k];
                    if (v && v.w > 0) this.imageSizes.set(k, v);
                }
                const pdf = c.pdf ?? {};
                for (const k of Object.keys(pdf)) {
                    const list = asList<{ w: number; h: number }>(pdf[k]);
                    if (list) this.pdfHeights.set(k, list);
                }
                const embeds = c.embeds ?? {};
                for (const k of Object.keys(embeds)) {
                    const list = asList<{ w: number; h: number }>(embeds[k]);
                    if (list) this.embedHeights.set(k, list);
                }
                const scales = c.scales ?? {};
                for (const k of Object.keys(scales)) {
                    const list = asList<{ c: number; h: number }>(scales[k]);
                    if (list) this.pdfScaleSamples.set(Number(k), list);
                }
                const widths = c.widths ?? {};
                for (const k of Object.keys(widths)) {
                    const e = widths[k] as { h?: number; r?: number } | null;
                    // Older cache entries were a bare number (no ratio) - skip
                    // them, since they cannot prove the crop shapes match.
                    if (e && typeof e.h === 'number' && e.h > 0 && typeof e.r === 'number' && e.r > 0) {
                        this.pdfWidthHeights.set(Number(k), { h: e.h, r: e.r });
                    }
                }
            } catch { /* a missing/broken cache is not fatal */ }
        })();

        // PDF++ cropped page embeds are created as an EMPTY box and grow to the
        // real page size seconds later (PDF.js renders them), reflowing every-
        // thing below them. That is why a hover preview loses the heading it
        // just jumped to. Reserve the final size up front, from the rect= in the
        // embed's own src, so the layout never changes in the first place - this
        // fixes hover previews, the reading view and embeds alike.
        const pdfBucket = (w: number): number => (w > 0 ? Math.round(w / 20) * 20 : 0);
        const rememberPdfHeight = (src: string, width: number, height: number) => {
            const bucket = pdfBucket(width);
            if (bucket <= 0) return;
            const list = this.pdfHeights.get(src) ?? [];
            const found = list.find((e) => e.w === bucket);
            if (found) found.h = height; else list.push({ w: bucket, h: height });
            while (list.length > 4) list.shift();
            this.pdfHeights.set(src, list);
            persistSizeCache();
        };
        // The shared-height shortcut is only valid for embeds whose crop has the
        // same SHAPE: the stored crop ratio is compared with the requested one,
        // so a differently cropped PDF in the same article is not handed the
        // wrong height (it falls back to its own ratio instead).
        const rememberPdfFallback = (width: number, height: number, ratio: number) => {
            const bucket = pdfBucket(width);
            if (bucket > 0) this.pdfWidthHeights.set(bucket, { h: height, r: ratio });
        };
        const recallPdfFallback = (width: number, ratio: number): number | null => {
            const bucket = pdfBucket(width);
            if (bucket <= 0) return null;
            const entry = this.pdfWidthHeights.get(bucket);
            if (!entry || !(entry.r > 0) || !(ratio > 0)) return null;
            return Math.abs(entry.r - ratio) / ratio <= 0.06 ? entry.h : null;
        };
        const SCALE_SAMPLES_MAX = 8;
        const rememberPdfSample = (width: number, cropHeightPt: number, renderedHeight: number) => {
            const bucket = pdfBucket(width);
            if (bucket <= 0 || !(cropHeightPt > 0) || !(renderedHeight > 0)) return;
            const list = this.pdfScaleSamples.get(bucket) ?? [];
            list.push({ c: Math.round(cropHeightPt), h: renderedHeight });
            while (list.length > SCALE_SAMPLES_MAX) list.shift();
            this.pdfScaleSamples.set(bucket, list);
            persistSizeCache();
        };
        const learnedPdfScale = (width: number): number | null => {
            const bucket = pdfBucket(width);
            const list = bucket > 0 ? this.pdfScaleSamples.get(bucket) : undefined;
            if (!list || list.length < 2) return null;
            const scales = list.filter((s) => s.c > 0).map((s) => s.h / s.c).sort((a, b) => a - b);
            if (scales.length < 2) return null;
            const median = scales[Math.floor(scales.length / 2)];
            const spread = scales[scales.length - 1] - scales[0];
            // Samples must agree, otherwise the model does not describe how
            // PDF++ renders here and must not be used for predictions.
            return spread <= median * 0.12 ? median : null;
        };
        const predictPdfHeight = (width: number, cropHeightPt: number): number | null => {
            const scale = learnedPdfScale(width);
            if (!scale || !(cropHeightPt > 0)) return null;
            return Math.round(scale * cropHeightPt);
        };
        const recallPdfHeight = (src: string, width: number): number | null => {
            const list = this.pdfHeights.get(src);
            if (!list || list.length === 0) return null;
            const bucket = pdfBucket(width);
            if (bucket <= 0) return list[list.length - 1].h;
            let best = list[0];
            for (const e of list) {
                if (Math.abs(e.w - bucket) < Math.abs(best.w - bucket)) best = e;
            }
            return Math.abs(best.w - bucket) <= 80 ? best.h : null;
        };
        const reserveEmbedHeight = (el: HTMLElement) => {
            if (el.dataset.fkReserved) return;
            const src = el.getAttribute('src') || '';
            const m = /rect=([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)/.exec(src);
            if (!m) return;
            const w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
            const h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
            if (!(w > 0 && h > 0)) return;
            el.dataset.fkReserved = '1';
            const apply = () => {
                if (!el.isConnected) return;
                // Prefer this embed's own measured height, then any PDF measured
                // at the same width (embeds in one article share it), and only
                // fall back to the crop's ratio when nothing has been measured.
                const width = el.getBoundingClientRect().width;
                const cropRatio = w / h;
                const known = recallPdfHeight(src, width)
                    ?? predictPdfHeight(width, h)
                    ?? recallPdfFallback(width, cropRatio);
                if (known) el.setCssStyles({ minHeight: known + 'px' });
                else el.setCssStyles({ aspectRatio: w + ' / ' + h });
            };
            apply();
            window.requestAnimationFrame(apply);
            // Release as soon as the render settles. Keeping the ratio-based guess
            // forever left the box taller than the real crop, which is what pushed
            // adjacent PDF embeds far apart - the guess is only meant to cover the
            // pre-render window.
            const release = () => {
                el.setCssStyles({ aspectRatio: '', minHeight: '' });
                delete el.dataset.fkReserved;
            };
            let timer: number | null = null;
            // Measure ONLY while no reservation is applied. While it is applied the
            // element's height is the reserved guess, so remembering it would store
            // the guess as if it were the rendered height - and every later visit
            // would then reserve that same wrong value and release it again, which
            // is what pushed the content under the embed (a heading right below it)
            // out of place on every single visit.
            const measureReal = () => {
                if (!el.isConnected || el.dataset.fkReserved) return;
                const rect = el.getBoundingClientRect();
                if (rect.height > 0) {
                    rememberPdfHeight(src, rect.width, Math.round(rect.height));
                    rememberPdfFallback(rect.width, Math.round(rect.height), w / h);
                    rememberPdfSample(rect.width, h, Math.round(rect.height));
                }
            };
            const ro = new ResizeObserver(() => {
                if (timer !== null) window.clearTimeout(timer);
                timer = window.setTimeout(() => {
                    timer = null;
                    if (el.dataset.fkReserved) {
                        // Drop the reservation first: the release resizes the box to
                        // its real height, and that resize is what gets measured. If
                        // nothing resized, the reserved height was already correct and
                        // there is nothing new to learn.
                        release();
                        return;
                    }
                    measureReal();
                    ro.disconnect();
                }, 700);
            });
            ro.observe(el);
            // Hard cap in case the element never resizes at all.
            window.setTimeout(release, 6000);
        };
        // One observer serves everything that has to react to inserted nodes.
        // Four separate ones (PDF crops, images, note embeds, hover popovers)
        // would run four callbacks for every DOM change anywhere in the app -
        // the only always-on cost this plugin has - so they share one instead.
        const onInsert: ((node: HTMLElement) => void)[] = [];
        const insertObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (!node.instanceOf(HTMLElement)) continue;
                    for (const handler of onInsert) handler(node);
                }
            }
        });
        this.register(() => insertObserver.disconnect());

        const RESERVE_SEL = '.internal-embed[src*="rect="]';
        onInsert.push((node) => {
            if (node.matches(RESERVE_SEL)) reserveEmbedHeight(node);
            for (const el of Array.from(node.querySelectorAll<HTMLElement>(RESERVE_SEL))) {
                reserveEmbedHeight(el);
            }
        });
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(RESERVE_SEL))) {
            reserveEmbedHeight(el);
        }

        // Image embeds: unlike PDF++ crops there is no rect= to read, so the real
        // dimensions are parsed straight out of the file header (PNG / JPEG /
        // GIF / WebP) and cached per path. Reserving the aspect ratio up front
        // stops an image from reflowing everything below it. The reservation is
        // dropped again as soon as the image has loaded, so a mis-parsed header
        // can never distort anything - the worst case is simply "no help".
        // ------------------------------------------------------------------
        const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

        // EXIF orientation (JPEG APP1). Orientations 5..8 rotate the image when
        // the browser renders it, so the ratio that will actually be shown is the
        // parsed one with its axes swapped.
        const readExifOrientation = (d: DataView, u: Uint8Array, start: number, len: number): number => {
            if (len < 14) return 0;
            if (!(u[start] === 0x45 && u[start + 1] === 0x78 && u[start + 2] === 0x69 && u[start + 3] === 0x66)) return 0;
            const tiff = start + 6;
            const le = u[tiff] === 0x49 && u[tiff + 1] === 0x49;
            const rd16 = (p: number) => (le ? d.getUint16(p, true) : d.getUint16(p, false));
            const rd32 = (p: number) => (le ? d.getUint32(p, true) : d.getUint32(p, false));
            const ifd = tiff + rd32(tiff + 4);
            if (ifd + 2 > start + len) return 0;
            const count = rd16(ifd);
            for (let i = 0; i < count; i++) {
                const e = ifd + 2 + i * 12;
                if (e + 12 > start + len) return 0;
                if (rd16(e) === 0x0112) return rd16(e + 8);
            }
            return 0;
        };

        // SVG: real size from width/height, otherwise the viewBox ratio.
        const parseSvgSize = (text: string): { w: number; h: number } | null => {
            const head = text.slice(0, 4000);
            const attr = (name: string) => {
                const m = new RegExp('\\s' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(head);
                return m ? parseFloat(m[1]) : NaN;
            };
            const w = attr('width');
            const h = attr('height');
            if (w > 0 && h > 0) return { w, h };
            const vb = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(head);
            if (vb) {
                const p = vb[1].trim().split(/[\s,]+/).map(parseFloat);
                if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
            }
            return null;
        };

        const parseImageSize = (buf: ArrayBuffer): { w: number; h: number } | null => {
            if (buf.byteLength < 32) return null;
            const d = new DataView(buf);
            const u = new Uint8Array(buf);
            if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) {           // PNG
                return { w: d.getUint32(16, false), h: d.getUint32(20, false) };
            }
            if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) {                            // GIF
                return { w: d.getUint16(6, true), h: d.getUint16(8, true) };
            }
            if (u[0] === 0xff && u[1] === 0xd8) {                                            // JPEG
                let o = 2;
                let exifOrientation = 0;
                while (o + 9 < buf.byteLength) {
                    if (u[o] !== 0xff) { o++; continue; }
                    const marker = u[o + 1];
                    const len = d.getUint16(o + 2, false);
                    if (len < 2) return null;
                    if (marker === 0xe1) {
                        exifOrientation = readExifOrientation(d, u, o + 4, len - 2);
                    }
                    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                        const w = d.getUint16(o + 7, false);
                        const h = d.getUint16(o + 5, false);
                        return exifOrientation >= 5 ? { w: h, h: w } : { w, h };
                    }
                    o += 2 + len;
                }
                return null;
            }
            if (u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) {         // WebP
                const fourcc = String.fromCharCode(u[12], u[13], u[14], u[15]);
                if (fourcc === 'VP8X') {
                    return {
                        w: (u[24] | (u[25] << 8) | (u[26] << 16)) + 1,
                        h: (u[27] | (u[28] << 8) | (u[29] << 16)) + 1,
                    };
                }
                if (fourcc === 'VP8 ') {
                    return { w: d.getUint16(26, true) & 0x3fff, h: d.getUint16(28, true) & 0x3fff };
                }
            }
            return null;
        };

        const vaultPathOfImage = (img: HTMLImageElement): string | null => {
            // Wiki embeds wrap the img: <span class="internal-embed" src="a.png">
            const wrapper = img.closest('.internal-embed');
            const raw = wrapper?.getAttribute('src') || '';
            if (raw) return raw.split('#')[0].split('|')[0];
            // Markdown embeds render a bare <img src="app://<id>/<vault path>">
            const src = img.getAttribute('src') || '';
            const m = /^app:\/\/[^/]+\/(.+)$/.exec(src);
            if (!m) return null;
            try { return decodeURIComponent(m[1]); } catch { return m[1]; }
        };

        const applyImageSize = (img: HTMLImageElement, dim: { w: number; h: number }) => {
            if (img.dataset.fkSized) return;
            img.dataset.fkSized = '1';
            img.setCssStyles({ aspectRatio: dim.w + ' / ' + dim.h });
            // Hand the element back to its natural ratio once it has loaded.
            img.addEventListener('load', () => { img.setCssStyles({ aspectRatio: '' }); }, { once: true });
        };

        const reserveImage = (img: HTMLImageElement) => {
            if (img.dataset.fkSized) return;
            if (img.complete && img.naturalWidth > 0) return;      // already laid out
            const path = vaultPathOfImage(img);
            if (!path) return;
            const ext = path.split('.').pop()?.toLowerCase() ?? '';
            if (!IMG_EXT.includes(ext)) return;
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return;
            // Keyed by mtime too, so editing/replacing an image re-reads it.
            const key = path + '\u0000' + file.stat.mtime;
            const known = this.imageSizes.get(key);
            if (known) { applyImageSize(img, known); return; }
            const pending = this.imageSizeInflight.get(key);
            if (pending) { void pending.then((dim) => { if (dim) applyImageSize(img, dim); }); return; }
            const read = (ext === 'svg'
                ? this.app.vault.adapter.read(path).then((text) => parseSvgSize(text))
                : this.app.vault.adapter.readBinary(path).then((buf) => parseImageSize(buf)))
                .then((dim) => {
                    if (dim) { this.imageSizes.set(key, dim); persistSizeCache(); }
                    return dim;
                })
                .catch(() => null)
                .then((dim) => { this.imageSizeInflight.delete(key); return dim; });
            this.imageSizeInflight.set(key, read);
            void read.then((dim) => { if (dim) applyImageSize(img, dim); });
        };

        onInsert.push((node) => {
            if (node.instanceOf(HTMLImageElement)) reserveImage(node);
            for (const img of Array.from(node.querySelectorAll('img'))) {
                reserveImage(img);
            }
        });
        for (const img of Array.from(document.querySelectorAll('img'))) {
            reserveImage(img);
        }

        // ------------------------------------------------------------------
        // Markdown embeds (![[note#^block]] and ![[note]]) render EMPTY first and
        // fill in afterwards, so anything below them - e.g. the heading a hover
        // preview just jumped to - gets pushed down by their whole height.
        // Their height cannot be read from the file (it depends on the container
        // width and on the rendering), but it CAN be remembered: measure once,
        // then reserve that height on every later render. The first render of a
        // given block still shifts; everything after it does not.
        // ------------------------------------------------------------------
        const EMBED_SEL = '.internal-embed.markdown-embed';
        // Width matters: the same block is taller in a narrow hover preview than
        // in a wide pane. Heights are therefore stored per width bucket and
        // looked up by NEAREST bucket - an exact key could never work, because
        // right after insertion the element has no width yet (0), while the
        // value was measured later at the real width.
        const WIDTH_BUCKET = 20;
        const bucketOf = (w: number): number => (w > 0 ? Math.round(w / WIDTH_BUCKET) * WIDTH_BUCKET : 0);
        const rememberEmbedHeight = (src: string, width: number, height: number) => {
            const bucket = bucketOf(width);
            if (bucket <= 0) return;
            const list = this.embedHeights.get(src) ?? [];
            const found = list.find((e) => e.w === bucket);
            if (found) found.h = height; else list.push({ w: bucket, h: height });
            while (list.length > 6) list.shift();
            this.embedHeights.set(src, list);
            persistSizeCache();
        };
        const recallEmbedHeight = (src: string, width: number): number | null => {
            const list = this.embedHeights.get(src);
            if (!list || list.length === 0) return null;
            const bucket = bucketOf(width);
            // Width not measured yet: the most recent value is the best guess.
            if (bucket <= 0) return list[list.length - 1].h;
            let best = list[0];
            for (const e of list) {
                if (Math.abs(e.w - bucket) < Math.abs(best.w - bucket)) best = e;
            }
            return Math.abs(best.w - bucket) <= 80 ? best.h : null;
        };
        const reserveEmbed = (el: HTMLElement) => {
            if (el.dataset.fkEmbedSeen) return;
            el.dataset.fkEmbedSeen = '1';
            const src = el.getAttribute('src');
            const apply = () => {
                if (!src || !el.isConnected) return;
                if (el.dataset.fkEmbedReserved) return;
                const known = recallEmbedHeight(src, el.getBoundingClientRect().width);
                if (known && known > 0) {
                    el.setCssStyles({ minHeight: known + 'px' });
                    el.dataset.fkEmbedReserved = '1';
                    // Our own write changes the layout - do not let the heading
                    // watcher read it as content landing and "correct" for it.
                    markSelfInflictedLayout();
                }
            };
            apply();
            // Try again next frame: at insertion time the width is still 0, so the
            // lookup above can only fall back to the last known value.
            window.requestAnimationFrame(apply);
            // Measure once the height has stopped changing, then hand the size
            // back to the real content so a stale value can never leave a gap.
            let timer: number | null = null;
            let waited = 0;
            const measure = () => {
                timer = null;
                const rect = el.getBoundingClientRect();
                if (!el.isConnected || rect.height <= 0) { ro.disconnect(); return; }
                // Do not trust a measurement taken while the embed is still
                // filling in: blocks with nested content keep growing, and a
                // partial height poisons the cache (the same block was being
                // remembered as 1641px, then 1341px, then 1305px).
                if (!el.classList.contains('is-loaded') && waited < 4000) {
                    waited += 400;
                    timer = window.setTimeout(measure, 400);
                    return;
                }
                // Hand the size back to the real content BEFORE measuring: while a
                // reservation is applied the height we would read is our own
                // reserved value, and remembering that stores a guess as if it had
                // been measured - so every later visit reserves the same wrong
                // value and releases it again, pushing the content below the embed
                // (a heading right under it, for instance) out of place.
                if (el.dataset.fkEmbedReserved) {
                    el.setCssStyles({ minHeight: '' });
                    delete el.dataset.fkEmbedReserved;
                    // Same reason as above: releasing the reservation is our own
                    // layout change, not content arriving.
                    markSelfInflictedLayout();
                    timer = window.setTimeout(measure, 400);
                    return;
                }
                if (src) rememberEmbedHeight(src, rect.width, Math.round(rect.height));
                ro.disconnect();
            };
            const ro = new ResizeObserver(() => {
                if (timer !== null) window.clearTimeout(timer);
                timer = window.setTimeout(measure, 400);
            });
            ro.observe(el);
        };
        onInsert.push((node) => {
            if (node.matches(EMBED_SEL)) reserveEmbed(node);
            for (const el of Array.from(node.querySelectorAll<HTMLElement>(EMBED_SEL))) {
                reserveEmbed(el);
            }
        });
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(EMBED_SEL))) {
            reserveEmbed(el);
        }


        // The alignment watch window, in ms. The setting is stored in SECONDS -
        // the number the user types IS the number of seconds - so this is the
        // only conversion point in the plugin (no base value, no multiplier).
        const alignWindow = () =>
            Math.max(3000, (this.settings.headingAlignWatchSeconds || 12) * 1000);

        // Inside a CodeMirror editor the view owns the scroll position, so the
        // move is handed to the editor itself - resolved to a line through the
        // metadata cache and then kept centred by MEASURING it (the same
        // treatment as a click on a heading link). Writing scrollTop into a
        // cm-scroller instead gets overwritten by the view's next measurement,
        // which is what left a preview popover showing half a heading.
        const scrollEditor = (el: HTMLElement, headingText: string, targetViewport?: number): boolean => {
            // The element's own editor first: it works for a hover popover,
            // whose view is not in the workspace's leaf list at all.
            if (this.centerHeadingElement(el, 8000, targetViewport)) return true;
            // Otherwise resolve through the workspace + metadata cache.
            const target = resolveHeadingTarget(this.app, el, headingText, null);
            if (!target) return false;
            this.centerHeadingLine(target.view, target.line, 8000, targetViewport);
            return true;
        };

        // Hover previews (Ctrl+hover a virtual link) open a popover that is
        // already scrolled to the link's heading. There is no click and no
        // workspace leaf involved, so nothing about that navigation can be
        // hooked - attach to the POPOVER instead. The alignment then works off
        // the DOM state alone (whichever heading sits at the top), which needs
        // no Obsidian event name and no link parsing, and therefore cannot
        // silently do nothing.
        onInsert.push((node) => {
            const pops = node.matches('.hover-popover')
                ? [node]
                : Array.from(node.querySelectorAll<HTMLElement>('.hover-popover'));
            // 有编辑器（Hover Editor）的 popover 走 scrollEditor（编辑器 API）；
            // 纯 HTML 的核心 Page Preview 没有编辑器，keepAligned 会自动走"直接
            // 滚动内部 scroller"（.markdown-preview-view）——只滚内部、不滚外层
            // .hover-popover，所以不会像早先那样把预览滚没/滚跳。
            for (const pop of pops) {
                // Opt-in, exactly like the click path: one setting covers both
                // the jump and the hover preview. (It used to run unconditionally
                // here, so turning the setting off changed nothing on previews.)
                if (!this.settings.alignHeadingAfterJump) continue;
                // 用 hover 时记下的标题 id 精确定位目标（popover 打开时它可能在中部
                // 而非顶部，按顶部猜会捡到上面的小标题）。
                //
                // Deliberately NO baseline here, unlike the click path: a jump
                // lands on a centred heading that is worth holding, whereas a
                // popover opens at whatever position Obsidian chose for the LINK
                // - often with the heading nowhere near the middle. Holding that
                // would only preserve a wrong position, so this path CENTRES.
                const startPopoverAlign = (): void => {
                    // The popover may already be gone by the time this runs.
                    if (!pop.isConnected) return;
                    keepScrolledHeadingAligned(
                        pop, 'popover', alignWindow(),
                        scrollEditor,
                        getHoveredHeadingId() ?? undefined,
                        undefined,
                        'centre',
                        // Same line-number fallback as the click paths: a decorated
                        // row in a Hover Editor popover does not match by text.
                        (id) => headingElementByLine(this.app, pop, id),
                    );
                };
                // The index is built asynchronously (in chunks), so right after
                // startup the popover's content is not rendered yet and the
                // heading cannot be found - the first preview of a session then
                // silently ended up uncentred, while later ones were fine. Wait
                // for the index before starting to align.
                const cache = LinkerCache.getInstance(this.app, this.settings);
                if (cache.cache.isReady) {
                    startPopoverAlign();
                } else {
                    void cache.cache.readyPromise.then(startPopoverAlign);
                }
            }
        });
        // Everything has registered by now, so start watching: starting earlier
        // would run an incomplete handler list for the first insertions.
        insertObserver.observe(document.body, { childList: true, subtree: true });

        // Rendered-DOM clicks outside the editor (reading view, popovers
        // rendered as HTML). A link built by this plugin carries its own
        // onclick (getLinkAnchorElement): that handler navigates AND aligns,
        // and it knows which heading the link points at.
        //
        // This watcher used to start a SECOND alignment for the same click -
        // one with no heading name, so keepAligned falls back to "whichever
        // heading sits nearest the top". Right after a jump the linked heading
        // is not that one (it is being centred, so a neighbouring heading is
        // still at the top), so the second loop centred a NEIGHBOURING heading
        // instead: that is the "it centres and then lands somewhere wrong"
        // symptom. Two loops writing one scroller also fight each other - one
        // writes, the other pulls back - which is the jumping. So step in only
        // when the anchor has no handler of its own, e.g. a node that was
        // cloned (cloneNode copies attributes, but not the onclick property).
        this.registerDomEvent(document, 'click', (evt) => {
            const el = evt.target as HTMLElement | null;
            if (!el || el.closest('.cm-editor')) return;      // editor: the widget owns it
            if (!el.closest('.virtual-link, a.virtual-link-a')) return;
            const anchor = el.closest<HTMLAnchorElement>('a.virtual-link-a');
            if (anchor?.onclick) return;                      // it navigates and aligns itself
            const scope = el.closest<HTMLElement>('.hover-popover, .workspace-leaf');
            // Same opt-in as the editor path: an unmodified Obsidian jump already
            // centres the heading, and a real link proves it stays there.
            if (!this.settings.alignHeadingAfterJump) return;
            let domTarget: number | undefined;
            window.setTimeout(() => keepScrolledHeadingAligned(
                scope, 'dom-click', alignWindow(),
                (el, h) => scrollEditor(el, h, domTarget),
                undefined,
                (o) => { domTarget = o; },
                'centre',
            ), 60);
        }, true);


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
                    new Notice('请先选择一段文本，再运行此命令。');
                    return;
                }
                if (!this.settings.linkerActivated) {
                    new Notice('虚拟链接功能当前已关闭，请先在设置中启用。');
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

    private isInTableEnvironment(editor: MarkdownView['editor'], _fromOffset: number, _toOffset: number): boolean {
        try {
            const fromPos = editor.offsetToPos(_fromOffset);
            // Check for table syntax: lines starting with | or containing | characters
            const line = editor.getLine(fromPos.line);
            const isTableLine = line.trim().startsWith('|') || line.includes('|');
            
            if (isTableLine) {
                return true;
            }
            
            // Additional check: look for table markers in surrounding lines
            const contextLines = 3;
            for (let i = Math.max(0, fromPos.line - contextLines); i <= Math.min(editor.lineCount() - 1, fromPos.line + contextLines); i++) {
                const contextLine = editor.getLine(i);
                if (contextLine.trim().startsWith('|') || contextLine.includes('|')) {
                    return true;
                }
            }
            
            return false;
        } catch {
            return false;
        }
    }

    private isPosWithinRange(
        linkFrom: EditorPosition,
        linkTo: EditorPosition,
        selectionFrom: EditorPosition,
        selectionTo: EditorPosition
    ): boolean {
        return (
            (linkFrom.line > selectionFrom.line ||
             (linkFrom.line === selectionFrom.line && linkFrom.ch >= selectionFrom.ch)) &&
            (linkTo.line < selectionTo.line ||
             (linkTo.line === selectionTo.line && linkTo.ch <= selectionTo.ch))
        );
    }

    addContextMenuItem(menu: Menu, file: TAbstractFile, _source: string) {

        if (!file) {
            return;
        }

        const app: App = this.app;
        const updateManager = this.updateManager;
        const settings = this.settings;

        const fetcher = new LinkerMetaInfoFetcher(app, settings);
        // Check, if the file has the linker-included tag

        const isDirectory = app.vault.getAbstractFileByPath(file.path) instanceof TFolder;

        if (!isDirectory) {
            const metaInfo = fetcher.getMetaInfo(file);

            const contextMenuHandler = (event: MouseEvent) => {
                // Access the element that triggered the context menu
                const targetElement = event.target;

                if (!targetElement || !(targetElement instanceof HTMLElement)) {
                    return;
                }

                // Check if clicked on multiple references indicator
                const isMultipleReferences = targetElement.classList.contains('multiple-files-references') || 
                                            targetElement.closest('.multiple-files-references') !== null;
                
                // If clicked on multiple references indicator, find the containing virtual link element
                if (isMultipleReferences) {
                    const virtualLinkSpan = targetElement.closest('.virtual-link-span') || 
                                           targetElement.closest('.virtual-link');
                    
                    if (virtualLinkSpan) {
                        // Add temporary lock class to prevent collapse
                        virtualLinkSpan.classList.add('virtual-link-hover-lock');
                        const spanEl = virtualLinkSpan as HTMLElement;
                        spanEl.dataset.fkContextLock = '1';

                        // 菜单关闭时才解锁：去掉 10s 定时（那是"10 秒后收起"的
                        // 来源），改成 menu.onHide —— 菜单开着列表就一直展开，
                        // 用户选完（或按 Esc / 点别处）菜单一关才收起。
                        menu.onHide(() => {
                            virtualLinkSpan.classList.remove('virtual-link-hover-lock');
                            delete spanEl.dataset.fkContextLock;
                            // 同时清掉右键锁定集里的 key：getLinkRootSpan 的 mousedown
                            // 在右键时加了 key，这里不删的话，之后同名链接一重建
                            // 就会恢复 lock，[1|2|3] 一直不收。
                            const key = virtualLinkSpan.querySelector('.virtual-link-a')?.getAttribute('origin-text') || '';
                            if (key) clearContextLock(key);
                        });
                    }
                }

                // Check, if we are clicking on a virtual link inside a note or a note in the file explorer
                // Use closest to find the virtual link element even when clicking on child elements
                const virtualLinkElement = targetElement.closest('.virtual-link-a');
                const isVirtualLink = virtualLinkElement !== null;

                // Use the virtual link element for attribute access if found
                const linkElement = virtualLinkElement || targetElement;
                const from = parseInt(linkElement.getAttribute('from') || '-1');
                const to = parseInt(linkElement.getAttribute('to') || '-1');

                if (from === -1 || to === -1) {
                    menu.addItem((item) => {
                        // Item to convert a virtual link to a real link
                        item.setTitle(
                            'Converting link is not here'
                        ).setIcon('link');
                    });
                }
                // Check, if the element has the "virtual-link" class
                else if (isVirtualLink) {
                    // Always show "Add to excluded keywords" option for virtual links
                    menu.addItem((item) => {
                        // Item to add virtual link text to excluded keywords
                        item.setTitle('Add to excluded keywords')
                            .setIcon('ban')
                            .onClick(async () => {
                                const text = linkElement.getAttribute('origin-text') || '';
                                if (text) {
                                    const newExcludedKeywords = [...new Set([...settings.excludedKeywords, text])];
                                    await this.updateSettings({ excludedKeywords: newExcludedKeywords });
                                    updateManager.update();
                                }
                            });
                    });

                    // Show intelligent conversion options based on context
                    // Regular context - show standard conversion
                    menu.addItem((item) => {
                        // Item to convert a virtual link to a real link
                        item.setTitle('Convert to real link')
                            .setIcon('link')
                            .onClick(() => {
                                convertVirtualLinkToReal(linkElement, file, app, settings);
                            });
                    });
                }

                // Remove the listener to prevent multiple triggers
                activeDocument.removeEventListener('contextmenu', contextMenuHandler);
            }

            if (!metaInfo.excludeFile && (metaInfo.includeAllFiles || metaInfo.includeFile || metaInfo.isInIncludedDir)) {
                // Item to exclude a virtual link from the linker
                // This action adds the settings.tagToExcludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('Exclude this file')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter ?? {};

                            const tag = settings.tagToExcludeFile;
                            let tags: string[] | string = frontmatter['tags'] as string[] | string;

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter: Record<string, unknown> & { tags?: string[] | Set<string> }) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set<string>();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove include tag if it exists
                                    const includeTag = settings.tagToIncludeFile;
                                    if (frontMatter.tags instanceof Set && frontMatter.tags.has(includeTag)) {
                                        frontMatter.tags.delete(includeTag);
                                    }
                                }).catch(() => {});

                                updateManager.update();
                            }
                        });
                });
            } else if (!metaInfo.includeFile && (!metaInfo.includeAllFiles || metaInfo.excludeFile || metaInfo.isInExcludedDir)) {
                //Item to include a virtual link from the linker
                // This action adds the settings.tagToIncludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('Include this file')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter ?? {};

                            const tag = settings.tagToIncludeFile;
                            let tags: string[] | string = frontmatter['tags'] as string[] | string;

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter: Record<string, unknown> & { tags?: string[] | Set<string> }) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set<string>();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove exclude tag if it exists
                                    const excludeTag = settings.tagToExcludeFile;
                                    if (frontMatter.tags instanceof Set && frontMatter.tags.has(excludeTag)) {
                                        frontMatter.tags.delete(excludeTag);
                                    }
                                }).catch(() => {});

                                updateManager.update();
                            }
                        });
                });
            }

            // Capture the MouseEvent when the context menu is triggered
            activeDocument.addEventListener('contextmenu', contextMenuHandler, { once: true });
        } else {
            // Check if the directory is in the linker directories
            const path = file.path + '/';
            const isInIncludedDir = fetcher.includeDirPattern.test(path);
            const isInExcludedDir = fetcher.excludeDirPattern.test(path);

            // If the directory is in the linker directories, add the option to exclude it
            if ((fetcher.includeAllFiles && !isInExcludedDir) || isInIncludedDir) {
                menu.addItem((item) => {
                    item.setTitle('Exclude this directory')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path);

                            if (!targetFolder || !(targetFolder instanceof TFolder)) {
                                return;
                            }

                            const newExcludedDirs = Array.from(new Set([...settings.excludedDirectories, targetFolder.name]));
                            const newIncludedDirs = settings.linkerDirectories.filter((dir) => dir !== targetFolder.name);
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs }).catch(() => {});

                            updateManager.update();
                        });
                });
            } else if ((!fetcher.includeAllFiles && !isInIncludedDir) || isInExcludedDir) {
                // If the directory is in the excluded directories, add the option to include it
                menu.addItem((item) => {
                    item.setTitle('Include this directory')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path);

                            if (!targetFolder || !(targetFolder instanceof TFolder)) {
                                return;
                            }

                            const newExcludedDirs = settings.excludedDirectories.filter((dir) => dir !== targetFolder.name);
                            const newIncludedDirs = Array.from(new Set([...settings.linkerDirectories, targetFolder.name]));
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs }).catch(() => {});

                            updateManager.update();
                        });
                });
            }
        }
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
    private imageSizes = new Map<string, { w: number; h: number }>();
    private imageSizeInflight = new Map<string, Promise<{ w: number; h: number } | null>>();
    // Markdown embeds (block references, whole-note embeds): their height cannot
    // be derived from the file - it depends on the container width and on the
    // rendering - but it can be REMEMBERED: measure once, reserve on every later
    // render. Keyed by src + width, since the same block differs per container.
    private pdfHeights = new Map<string, { w: number; h: number }[]>();
    // Last measured PDF embed height per container width. Embeds of one article
    // share the width, and in most vaults they also share the crop shape, so one
    // measurement can reserve all of them - including the ones not seen yet.
    private pdfWidthHeights = new Map<number, { h: number; r: number }>();
    // Learned px-per-point scale per container width: the rendered height is
    // assumed to be scale × cropHeight, which is independent of the crop SHAPE,
    // so it can predict a crop that has never been rendered. Only trusted once
    // at least two samples agree - a full-width render (where height also
    // depends on the crop width) scatters those ratios and disables the model.
    private pdfScaleSamples = new Map<number, { c: number; h: number }[]>();
    private embedReserveObserver: MutationObserver | null = null;
    private embedHeights = new Map<string, { w: number; h: number }[]>();
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
