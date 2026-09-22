import { App, Editor, EditorPosition, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './src/lang/helpers';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';
import { BatchConvertModal, BatchConvertFilesModal } from './src/batchConvert';
import { buildIndentBackground, clearContextLock, getHoveredHeadingId, keepScrolledHeadingAligned, patchDispatchClamp, resolveHeadingTarget } from './linker/virtualLinkDom';
import { convertVirtualLinkToReal } from './linker/convertLink';
import { LinkerSettingTab } from './src/settingsTab';

// 同一编辑器只允许一个居中循环在跑。调用方（keepAligned）会在每次 miss 超容差
// 时再请求一次；如果每次都新起一个循环，多个循环各自写滚动，表现就是"不停
// 滚动"——预览弹窗里尤其明显。
const activeCenterLoops = new WeakMap<EditorView, AbortController>();

// Obsidian compatible path utility functions
function dirname(filePath: string): string {
    const lastSlashIndex = filePath.lastIndexOf('/');
    return lastSlashIndex === -1 ? '' : filePath.substring(0, lastSlashIndex);
}

function basename(filePath: string): string {
    const lastSlashIndex = filePath.lastIndexOf('/');
    return lastSlashIndex === -1 ? filePath : filePath.substring(lastSlashIndex + 1);
}

function relative(from: string, to: string): string {
    // Simplified relative path calculation for Obsidian environment
    if (from === to) return '';
    
    const fromParts = from.split('/').filter(part => part !== '');
    const toParts = to.split('/').filter(part => part !== '');
    
    // Find common prefix
    let commonLength = 0;
    while (commonLength < fromParts.length && 
           commonLength < toParts.length && 
           fromParts[commonLength] === toParts[commonLength]) {
        commonLength++;
    }
    
    // Calculate number of parent directories to go up
    const upLevels = fromParts.length - commonLength;
    const downParts = toParts.slice(commonLength);
    
    // Construct relative path
    const upPath = upLevels > 0 ? '../'.repeat(upLevels) : './';
    const downPath = downParts.join('/');
    
    return downPath ? upPath + downPath : upPath.slice(0, -1); // Remove trailing '/'
}

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
    frontmatterExcludeProperty: string; // Frontmatter property for per-note opt-in (boolean)
    perNoteExcludeKeywords: boolean; // When enabled, excludedKeywords only apply to notes with the frontmatter property
    enableFrontmatterExcludeList: boolean; // When enabled, notes can define extra excluded keywords in frontmatter
    frontmatterExcludeListProperty: string; // Frontmatter property for per-note keyword list
    headerVirtualLinkColor: string; // Color for header virtual links
    noteVirtualLinkColor: string; // Color for note/alias virtual links
    fuzzyBaseColor: string; // Base color mixed into fuzzy-match link colors
    fuzzyColorMixRatio: number; // How much base color to mix in (0-100)
    headingAlignWatchSeconds: number; // How many seconds a jumped-to heading keeps being re-aligned
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
    backgroundLineOpacity: 10,
    cursorLineOpacity: 35,
    frontmatterExcludeProperty: 'fakelink-exclude',
    perNoteExcludeKeywords: false,
    enableFrontmatterExcludeList: false,
    frontmatterExcludeListProperty: 'fakelink-exclude-keywords',
    headerVirtualLinkColor: '#517ea0',
    noteVirtualLinkColor: '#c0392b',
    fuzzyBaseColor: '#8e44ad',
    fuzzyColorMixRatio: 50,
    headingAlignWatchSeconds: 12,
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
    async copyLineUri(file: TFile, lineZeroBased: number) {
        const line = lineZeroBased + 1;
        // Vault id is not part of the public API; fall back to the vault name
        // if getId is unavailable at runtime.
        const vaultId = (this.app.vault as unknown as { getId?: () => string }).getId?.()
            ?? this.app.vault.getName();
        let uri = `obsidian://adv-uri?vault=${encodeURIComponent(vaultId)}`
            + `&filepath=${encodeURIComponent(file.path)}`
            + `&line=${line}&column=1&openmode=true&view-mode=source`;
        // Self-heal: store the target line text so the jump can find it again
        // later even after edits shift the line numbers.
        if (this.settings.lineLinkSelfHeal) {
            const anchor = await this.getLineAnchor(file, lineZeroBased);
            if (anchor) {
                uri += `&anchor=${encodeURIComponent(anchor)}`;
            }
        }
        try {
            await navigator.clipboard.writeText(`[${line}](${uri})`);
            new Notice(t('Line link copied'));
        } catch {
            new Notice(t('Failed to copy line link'));
        }
    }

    // Read the text of `lineZeroBased` and return a short anchor used to
    // re-locate that line later if the file is edited and line numbers drift.
    private async getLineAnchor(file: TFile, lineZeroBased: number): Promise<string> {
        try {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split('\n');
            const text = (lines[lineZeroBased] ?? '').trim();
            const maxLen = 40;
            return text.length > maxLen ? text.slice(0, maxLen) : text;
        } catch {
            return '';
        }
    }

    // Return the line that currently holds `anchor`. Falls back to the recorded
    // `line` when self-healing is off, no anchor was stored, or the anchor text
    // can no longer be found (the line itself was edited away).
    private async resolveLineByAnchor(file: TFile, line: number, anchor?: string): Promise<number> {
        if (!this.settings.lineLinkSelfHeal || !anchor) return line;
        try {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split('\n');
            const idx = line - 1;
            // Recorded line still holds the text → nothing to fix.
            if (idx >= 0 && idx < lines.length && lines[idx].trim().startsWith(anchor)) {
                return line;
            }
            // Drifted: prefer an exact line-start match, then a looser contains match.
            const exact = lines.findIndex(l => l.trim().startsWith(anchor));
            if (exact >= 0) return exact + 1;
            const loose = lines.findIndex(l => l.trim().includes(anchor));
            if (loose >= 0) return loose + 1;
            return line;
        } catch {
            return line;
        }
    }

    // Wait until the target file's editor has rendered at least `targetLine`
    // lines, polling every 200ms until `timeoutMs` elapses.
    private async waitForEditor(view: MarkdownView, targetLine: number, timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (view.editor && view.editor.lineCount() >= targetLine) {
                return true;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 200));
        }
        return view.editor != null;
    }

    // Open the target file only (reuse its tab if already open, otherwise
    // open a new one) and return the leaf. Used both by the jump logic and by
    // the protocol handler when a URI carries no line (the "open file" step of
    // an external handler's two-step sequence), so the file gets opened early
    // and rendered before the line jump arrives.
    private async openFileOnly(file: TFile): Promise<WorkspaceLeaf | null> {
        const existing = this.app.workspace.getLeavesOfType('markdown')
            .find(l => (l.getViewState().state as { file?: string })?.file === file.path);

        let leaf: WorkspaceLeaf;
        if (existing) {
            this.app.workspace.setActiveLeaf(existing, { focus: true });
            leaf = existing;
        } else {
            leaf = this.settings.jumpOpenInNewTab
                ? this.app.workspace.getLeaf(true)
                : this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            // CodeMirror only mounts its real DOM for the active leaf, so make
            // sure the freshly opened leaf is active before scrolling.
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
        }
        return leaf;
    }

    // Open the target file (if needed) and, once rendered, move the cursor to
    // `line` and scroll it into view. `line` is 1-based (adv-uri format).
    async jumpToLine(filepath: string, line: number, anchor?: string) {
        const file = this.app.vault.getAbstractFileByPath(filepath);
        if (!(file instanceof TFile)) return;

        const wasAlreadyOpen = this.app.workspace.getLeavesOfType('markdown')
            .some(l => (l.getViewState().state as { file?: string })?.file === file.path);

        const leaf = await this.openFileOnly(file);
        if (!leaf) return;
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) return;

        // Self-heal: correct the line number when the recorded one has drifted.
        const targetLine = await this.resolveLineByAnchor(file, line, anchor);
        await this.waitForEditor(view, targetLine, this.settings.lineJumpWaitSeconds * 1000);

        if (!wasAlreadyOpen) {
            // Freshly opened file: wait a beat for CodeMirror's first layout
            // and any MathJax/images to finish reflowing, otherwise
            // scrollIntoView races the ongoing measurement and triggers the
            // "Measure loop restarted" warning (and a visible stutter).
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
        }

        const safeLine = Math.min(targetLine - 1, Math.max(0, view.editor.lineCount() - 1));
        view.editor.focus();
        view.editor.setCursor({ line: safeLine, ch: 0 });
        // Centering (center=true) cannot scroll to the very first lines of a
        // note - there is not half a viewport of content above them, so CM
        // refuses to move. For those top lines use center=false (scrolls them
        // to the top). For deeper lines use center=true so the target sits in
        // the middle of the screen instead of hugging the bottom edge (which
        // is what center=false's "nearest visible" does for lines below the
        // current viewport).
        const center = safeLine >= 15;
        view.editor.scrollIntoView({ from: { line: safeLine, ch: 0 }, to: { line: safeLine, ch: 0 } }, center);
        // scrollIntoView alone cannot frame a line taller than the viewport (an
        // image embed): center=true slices it and center=false only reveals its
        // lower edge. Top-align such lines instead.
        this.alignTallLine(view, safeLine);
    }

    // A line that renders as a tall block (an image embed, a wide table) cannot be
    // framed by scrollIntoView: its `center` flag only offers "middle of the screen"
    // or "nearest visible", so a line taller than the viewport ends up either
    // bottom-aligned (only its lower edge shows) or sliced in half. When the line is
    // taller than the viewport - or its head ended up above it - align the top edge
    // instead, which is what a jump should show. No-op for ordinary lines.
    //
    // Note: BlockInfo.top is in document coordinates and scroller.scrollTop is a
    // scroll offset; they share the same origin up to CodeMirror's content padding,
    // so the alignment can be off by a few pixels - invisible for "show me the head
    // of this line". Runs twice because images keep reflowing while they load.
    private alignTallLine(view: MarkdownView, line: number, pass = 0) {
        const cmEl = view.contentEl.querySelector('.cm-editor');
        const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
        if (!cm) return;                                  // 拿不到视图就保持原行为
        const scroller = cm.scrollDOM;
        try {
            const block = cm.lineBlockAt(cm.state.doc.line(line + 1).from);
            const tooTall = block.height > scroller.clientHeight * 0.8;
            const headHidden = block.top < scroller.scrollTop;
            if (!tooTall && !headHidden) return;           // 普通行：不干预
            scroller.scrollTop = block.top - 16;
        } catch {
            return;
        }
        if (pass < 1) window.setTimeout(() => this.alignTallLine(view, line, pass + 1), 250);
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
    public centerHeadingLine(view: MarkdownView, line: number, maxMs = 10000): void {
        const cmEl = view.contentEl.querySelector('.cm-editor');
        const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
        if (cm) this.centerCmLine(cm, line, maxMs);
    }

    /**
     * Centre the line a rendered heading element lives on, using the element's
     * OWN editor. This is what makes a hover popover work: Hover Editor hosts a
     * real view that is not part of the workspace's leaf list, so resolving the
     * view through the workspace fails there - but the element itself still
     * knows its editor (EditorView.findFromDOM) and its own position
     * (posAtDOM), which is exact and needs no metadata lookup at all.
     */
    public centerHeadingElement(el: HTMLElement, maxMs = 8000): boolean {
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
        activeCenterLoops.get(cm)?.abort();
        const controller = new AbortController();
        activeCenterLoops.set(cm, controller);
        const stop = () => controller.abort();
        window.addEventListener('wheel', stop, { capture: true, passive: true, signal: controller.signal });
        window.addEventListener('mousedown', stop, { capture: true, signal: controller.signal });
        window.addEventListener('keydown', stop, { capture: true, signal: controller.signal });

        const startedAt = Date.now();
        let passes = 0;
        const tick = () => {
            if (controller.signal.aborted) return;
            if (Date.now() - startedAt > maxMs || passes > 12) return;
            if (!el.isConnected) return;   // 元素被 CM 回收了，交给调用方重新找

            const r = el.getBoundingClientRect();
            const sr = scroller.getBoundingClientRect();
            const current = r.top - sr.top;
            const height = Math.max(1, r.height);
            const target = Math.max(6, Math.round((scroller.clientHeight - height) / 2));
            const delta = Math.round(current - target);
            if (Math.abs(delta) <= 6) return;   // 已居中，收工

            // 只在 CM 的 measure 周期里写，避免被它下一次 measure 覆盖。
            cm.requestMeasure({
                read: () => delta,
                write: (d, view) => {
                    view.scrollDOM.scrollTop = Math.max(0, view.scrollDOM.scrollTop + d);
                },
            });
            passes++;
            window.setTimeout(tick, 500);
        };
        window.setTimeout(tick, 200);
        return true;
    }

    private centerCmLine(cm: EditorView, line: number, maxMs: number): void {
        // 给这个视图的 dispatch 装保护（幂等）：Obsidian 偶尔会拿超界 selection
        // 去 dispatch，这里捕获后 clamp 到文档长度内重试，真正化解而不是隐藏。
        patchDispatchClamp(cm);

        // 后到的请求替换先前的循环：同一处反复请求时只保留最后一个，避免多个
        // 循环同时写滚动（预览里"不停滚动"就是它们互相打架）。
        activeCenterLoops.get(cm)?.abort();
        const controller = new AbortController();
        activeCenterLoops.set(cm, controller);

        const scroller = cm.scrollDOM;

        const stop = () => controller.abort();
        window.addEventListener('wheel', stop, { capture: true, passive: true, signal: controller.signal });
        window.addEventListener('mousedown', stop, { capture: true, signal: controller.signal });
        window.addEventListener('keydown', stop, { capture: true, signal: controller.signal });

        const startedAt = Date.now();
        let passes = 0;
        let lastCurrent = Number.NaN;
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
            if (Date.now() - startedAt > maxMs || passes > 24) return;
            const m = measure(cm);
            if (!m) {
                // 行号超界（跳转后 CM6 还在装载新文档、或行号来自旧状态）：
                // 继续重试到 maxMs，不要在这一步 return —— 那样整个居中循环会在
                // 第一次 tick 就悄悄停掉，标题就停在 Obsidian 默认的位置。
                window.setTimeout(tick, 700);
                return;
            }
            const target = Math.max(6, Math.round((scroller.clientHeight - m.height) / 2));
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
            const stillLoading = Array.from(scroller.querySelectorAll('img'))
                .some((img) => !img.complete);
            const settled = current === lastCurrent && !stillLoading;
            lastCurrent = current;
            const miss = Math.abs(current - target);
            // Safety valve: a surface that never settles (something animating
            // above) would otherwise never be corrected at all.
            const impatient = Date.now() - startedAt > 4000 && miss > 60;
            const shouldAct = miss > tolerance && (settled || impatient);
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
                                - Math.max(6, Math.round((view.scrollDOM.clientHeight - mm.height) / 2));
                            view.scrollDOM.scrollTop = Math.max(0, view.scrollDOM.scrollTop + delta);
                        },
                    });
                } catch { return; }
                passes++;
            }
            // Keep watching for the whole window even after the position looks
            // right: CodeMirror can STALL (its measure-restart limit), which
            // makes the page hold still while nothing is rendered - so "it looks
            // settled" is not proof that it is finished, and the position has to
            // be re-checked when rendering resumes.
            window.setTimeout(tick, 700);
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

        // The whole optional look lives under this one class
        // (setting: Appearance -> Background)
        if (this.settings.backgroundHighlight) {
            activeWindow.document.body.classList.add('virtual-link-bg');
        }

        // Slider-tunable alphas (defaults live in styles.css; apply the saved
        // values so they survive a reload).
        activeWindow.document.body.style.setProperty('--fakelink-line-alpha', String(this.settings.backgroundLineOpacity / 100));
        activeWindow.document.body.style.setProperty('--fakelink-cursor-line-alpha', String(this.settings.cursorLineOpacity / 100));

        // Always set link colors (header vs note)
        activeWindow.document.body.style.setProperty('--virtual-link-color', this.settings.noteVirtualLinkColor);
        activeWindow.document.body.style.setProperty('--virtual-link-header-color', this.settings.headerVirtualLinkColor);
        activeWindow.document.body.style.setProperty('--virtual-link-note-color', this.settings.noteVirtualLinkColor);
        // Fuzzy-match links: base color mixed into the header / note color.
        this.applyFuzzyColors();

        // Listen for view changes
        this.registerEvent(this.app.workspace.on('layout-change', () => { void this.handleLayoutChange(); }));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => { void this.handleLayoutChange(); }));

        // Set callback to update the cache when the settings are changed
        this.updateManager.registerCallback(() => {
            LinkerCache.getInstance(this.app, this.settings).clearCache();
        });

        // When auto-exclude (renamed duplicates) re-indexes asynchronously,
        // refresh the decorations so the newly excluded note stops linking.
        LinkerCache.getInstance(this.app, this.settings).onIndexChanged = () => this.updateManager.update();

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
        const scrollEditor = (el: HTMLElement, headingText: string): boolean => {
            // The element's own editor first: it works for a hover popover,
            // whose view is not in the workspace's leaf list at all.
            if (this.centerHeadingElement(el, 8000)) return true;
            // Otherwise resolve through the workspace + metadata cache.
            const target = resolveHeadingTarget(this.app, el, headingText, null);
            if (!target) return false;
            this.centerHeadingLine(target.view, target.line, 8000);
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
                // 用 hover 时记下的标题 id 精确定位目标（popover 打开时它可能在中部
                // 而非顶部，按顶部猜会捡到上面的小标题）。
                keepScrolledHeadingAligned(pop, 'popover', alignWindow(), scrollEditor, getHoveredHeadingId() ?? undefined);
            }
        });
        // Everything has registered by now, so start watching: starting earlier
        // would run an incomplete handler list for the first insertions.
        insertObserver.observe(document.body, { childList: true, subtree: true });

        // Rendered-DOM clicks (reading view, popovers rendered as HTML) have no
        // widget and therefore no onclick of their own - navigation is done by
        // Obsidian. Watch those surfaces the same way: no href parsing, nothing
        // prevented or stopped, only the alignment afterwards.
        this.registerDomEvent(document, 'click', (evt) => {
            const el = evt.target as HTMLElement | null;
            if (!el || el.closest('.cm-editor')) return;      // editor: the widget owns it
            if (!el.closest('.virtual-link, a.virtual-link-a')) return;
            const scope = el.closest<HTMLElement>('.hover-popover, .workspace-leaf');
            window.setTimeout(() => keepScrolledHeadingAligned(scope, 'dom-click', alignWindow(), scrollEditor), 60);
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
}
