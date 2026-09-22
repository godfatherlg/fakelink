import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, PluginSpec, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { App, MarkdownView, TFile, Vault, getLinkpath } from 'obsidian';

import IntervalTree from '@flatten-js/interval-tree';
import { LinkerPluginSettings } from 'main';
import { ExternalUpdateManager, LinkerCache, PrefixTree, MatchType } from './linkerCache';
import { VirtualMatch, isInTableCellEditor, attachTableCellContextMenu, isLinkingDisabledInNote } from './virtualLinkDom';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('main').default;

function isDescendant(parent: HTMLElement, child: HTMLElement, maxDepth: number = 10) {
    let node = child.parentNode;
    let depth = 0;
    while (node != null && depth < maxDepth) {
        if (node === parent) {
            return true;
        }
        node = node.parentNode;
        depth++;
    }
    return false;
}

export class VirtualLinkWidget extends WidgetType {
    constructor(public match: VirtualMatch) {
        super();
    }
    
    toDOM(view: EditorView): HTMLElement {
        // Create the link element without the cell-editor menu. The span is
        // detached right now, so it has no .table-cell-wrapper ancestor yet and
        // isInTableCellEditor() reads false during the cell editor's first build;
        // the eager check against view.dom flaked in large documents with many
        // tables. The menu is attached lazily below, after the span is inserted.
        const element = this.match.getCompleteLinkElement(false);

        // Attach the table-cell context menu once the span is actually in the DOM.
        window.requestAnimationFrame(() => {
            if (isInTableCellEditor(element)) {
                attachTableCellContextMenu(element, this.match);
            }
        });
        
        // Format context flags were pre-computed in buildDecorations from a single
        // syntax-tree walk, so no per-widget walk is needed here.
        // Add corresponding CSS classes
        if (this.match.isBoldContext) {
            element.classList.add('cm-strong');
        }
        if (this.match.isItalicContext) {
            element.classList.add('cm-em');
        }
        if (this.match.isHighlightContext) {
            element.classList.add('cm-highlight');
        }
        if (this.match.isStrikethroughContext) {
            element.classList.add('cm-strikethrough');
        }
        if (this.match.isCommentContext) {
            element.classList.add('virtual-link-in-comment');
        }
        if (this.match.isInHeaderContext) {
            element.classList.add('virtual-link-in-header');
        }
        if (this.match.isTripleStarContext) {
            element.classList.add('cm-strong', 'cm-em');
        }
        
        return element;
    }

    // CodeMirror calls eq() to decide whether an existing widget's DOM may be
    // reused, and its default implementation returns false — so every decoration
    // rebuild used to destroy and recreate every virtual link's DOM.
    //
    // That is what made hover previews lag and fail: the widget set is rebuilt on
    // every cursor move, scroll and doc change, so the <a> under the pointer kept
    // being replaced. Obsidian's "require Mod key" hover path remembers the
    // hovered element when the hover starts, then refuses to show the preview once
    // that element has left the document (`body.contains(el)` is false) — so
    // pressing Ctrl after a rebuild did nothing at all.
    //
    // Comparing render signatures keeps the DOM alive whenever the rendered result
    // would be identical, which is the common case.
    eq(other: WidgetType): boolean {
        if (!(other instanceof VirtualLinkWidget)) return false;
        return other.match.renderKey() === this.match.renderKey();
    }

    // Whether CodeMirror should ignore events inside this widget:
    //   true  → editor ignores it, so the <a> onclick runs and the link opens
    //           (but no caret is placed)
    //   false → editor handles it, so the caret IS placed (but the click is
    //           consumed and the link does NOT open)
    // A plain click opens the link. The only exception is a widget that renders
    // no link at all (too many matches): there the editor must handle the click
    // so the caret can still be placed.
    ignoreEvent(event: Event): boolean {
        const isMouse = event.type === 'mousedown' || event.type === 'mouseup'
            || event.type === 'click' || event.type === 'dblclick';
        if (!isMouse) return true;

        // Too many matches → no link rendered, this widget is plain text. Let the
        // editor handle the click so the caret can be placed there; there is no
        // link to open anyway.
        if (this.match.isHiddenByReferenceLimit) return false;

        return true;
    }
}

/**
 * True when the element lives inside a hover preview popover.
 * Hover Editor opens a REAL MarkdownView in its popover (and auto-focuses it), so it
 * shows up in workspace.getActiveViewOfType(MarkdownView) as well; core page preview
 * renders plain HTML and never reaches the editor plugin below.
 */
function isInHoverPopover(el: HTMLElement | null | undefined): boolean {
    return Boolean(el?.closest('.hover-popover'));
}

class AutoLinkerPlugin implements PluginValue {
    decorations: DecorationSet;
    app: App;
    vault: Vault;
    linkerCache: LinkerCache;

    settings: LinkerPluginSettings;
    plugin: LinkerPluginType;

    private lastCursorPos: number = 0;
    private lastActiveFile: string = '';
    private lastViewUpdate: ViewUpdate | null = null;
    // Debounce state for pure scrolling: hold off rebuilding until scrolling stops,
    // so links appear "a bit later" once instead of being rebuilt on every scroll
    // tick (which is what caused the jitter).
    private scrollDebounceTimer: number | null = null;
    private pendingScrollBuild: { view: EditorView; viewIsActive: boolean } | null = null;

    // Cache the active Markdown view so we don't call getActiveViewOfType()
    // on every cursor move. Invalidated on active-leaf-change.
    private cachedActiveView: MarkdownView | null | undefined = undefined;

    // Last MarkdownView that was active AND is not inside a hover popover. A popover
    // stealing focus must not demote it to "inactive": that flipped every gate in
    // update()/buildDecorations, rebuilt all links of the editor underneath (visible
    // flash) and lost its mappedFile — which also made the popover close itself.
    private lastRealActiveView: MarkdownView | null = null;

    viewUpdateDomToFileMap: Map<HTMLElement, TFile | undefined | null> = new Map();

    constructor(view: EditorView, app: App, settings: LinkerPluginSettings, updateManager: ExternalUpdateManager, plugin: LinkerPluginType) {
        this.app = app;
        this.plugin = plugin; // Store plugin reference
        this.settings = settings;

        const { vault } = this.app;
        this.vault = vault;

        this.linkerCache = LinkerCache.getInstance(app, this.settings);

        // Invalidate the cached active view whenever the active leaf changes
        // (switching panes/files). This avoids calling getActiveViewOfType()
        // on every cursor move, which other plugins may wrap and which adds
        // measurable overhead during plain navigation.
        this.plugin.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.cachedActiveView = undefined;
            })
        );

        this.decorations = this.buildDecorations(view);

        // The prefix tree is built asynchronously (in chunks), so on load the
        // tree is still empty when this constructor runs and buildDecorations
        // above finds no matches. Refresh once the initial build finishes so
        // links appear without needing a scroll/click first.
        void this.linkerCache.cache.readyPromise?.then(() => {
            // Right after load the view may not have measured yet, so
            // visibleRanges is empty and buildDecorations has nothing to scan.
            // Wait a frame at a time (bounded) until a viewport exists.
            let tries = 0;
            const attempt = () => {
                if (view.visibleRanges.length > 0 || ++tries > 30) {
                    this.decorations = this.buildDecorations(view, true);
                    view.dispatch({});
                } else {
                    window.requestAnimationFrame(attempt);
                }
            };
            attempt();
        });

        updateManager.registerCallback(() => {
            if (this.lastViewUpdate) {
                this.update(this.lastViewUpdate, true);
            }
        });
    }

    update(update: ViewUpdate, force: boolean = false) {
        if (this.cachedActiveView === undefined) {
            const v = this.app.workspace.getActiveViewOfType(MarkdownView) ?? null;
            this.cachedActiveView = v;
            // Remember the last non-popover view: hover popovers host a real
            // MarkdownView and auto-focus it, and they must not demote the real one.
            if (v && !isInHoverPopover(v.containerEl)) {
                this.lastRealActiveView = v;
            }
        }
        const activeView = this.cachedActiveView;



        // Check if the update is on the active view. We only need to check this, if one of the following settings is enabled
        // - fixIMEProblem
        // - excludeLinksToOwnNote
        // - excludeLinksInCurrentLine
        let updateIsOnActiveView = false;
        if (this.settings.fixIMEProblem || this.settings.excludeLinksInCurrentLine || this.settings.excludeLinksToOwnNote) {
            const domFromUpdate = update.view.dom;
            const domFromWorkspace = activeView?.contentEl;
            updateIsOnActiveView = domFromWorkspace ? isDescendant(domFromWorkspace, domFromUpdate, 3) : false;

            // The active view is a hover popover: it keeps normal preview behaviour for
            // itself, but the editor underneath must stay "active" as well. Otherwise
            // every gate below flips off there, all of its links get rebuilt (visible
            // flash) and its mappedFile is lost — the DOM churn that also made the
            // popover close on its own.
            let activeViewForUpdate = activeView;
            if (!updateIsOnActiveView && activeView && isInHoverPopover(activeView.containerEl) && this.lastRealActiveView) {
                updateIsOnActiveView = isDescendant(this.lastRealActiveView.contentEl, domFromUpdate, 3);
                if (updateIsOnActiveView) activeViewForUpdate = this.lastRealActiveView;
            }
            

            


            // We store this information to be able to map the view updates to a obsidian file
            if (updateIsOnActiveView) {
                this.viewUpdateDomToFileMap.set(domFromUpdate, activeViewForUpdate?.file);
            }
        }

        const cursorPos = update.view.state.selection.main.from;
        // Prefer the last real (non-popover) view's file: a hover popover taking focus
        // changes workspace.getActiveFile() and would otherwise force a rebuild here.
        const activeFile = (this.lastRealActiveView?.file ?? this.app.workspace.getActiveFile())?.path;
        const fileChanged = activeFile != this.lastActiveFile;

        // Also rebuild when the syntax tree itself changed. The format classes
        // (bold / italic / highlight / strikethrough / comment / header) are
        // read from the tree, and Markdown parses asynchronously: right after
        // the plugin loads the tree is still empty, so a link inside ==...==
        // was built without .cm-highlight and only got its highlight background
        // once something else forced a rebuild (a click moved the cursor).
        const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);

        if (force || this.lastCursorPos != cursorPos || update.docChanged || fileChanged || update.viewportChanged || treeChanged) {
            // Pure scroll (viewport change with no doc/cursor/file change): debounce
            // so the rebuild happens once after scrolling stops, not on every tick.
            // Links then appear "a bit later" but without the per-tick DOM churn that
            // read as jitter.
            const isPureScroll = update.viewportChanged && !update.docChanged && !fileChanged && !force
                && this.lastCursorPos === cursorPos;
            if (isPureScroll) {
                this.pendingScrollBuild = { view: update.view, viewIsActive: updateIsOnActiveView };
                this.lastViewUpdate = update;
                if (this.scrollDebounceTimer !== null) {
                    window.clearTimeout(this.scrollDebounceTimer);
                }
                this.scrollDebounceTimer = window.setTimeout(() => {
                    this.scrollDebounceTimer = null;
                    const pending = this.pendingScrollBuild;
                    this.pendingScrollBuild = null;
                    if (pending) {
                        this.linkerCache.updateCache(force);
                        this.decorations = this.buildDecorations(pending.view, pending.viewIsActive);
                        // Dispatch an empty transaction so CodeMirror re-reads the
                        // decorations. requestMeasure() alone does NOT recalc plugin
                        // decorations, which is why the new links needed a cursor
                        // click (a real update) before they appeared.
                        pending.view.dispatch({});
                    }
                }, 150);
                return;
            }

            // Non-scroll change: cancel any pending scroll build, then rebuild now.
            if (this.scrollDebounceTimer !== null) {
                window.clearTimeout(this.scrollDebounceTimer);
                this.scrollDebounceTimer = null;
                this.pendingScrollBuild = null;
            }
            this.lastCursorPos = cursorPos;
            this.linkerCache.updateCache(force);
            this.decorations = this.buildDecorations(update.view, updateIsOnActiveView);
            this.lastActiveFile = activeFile ?? '';
        }

        this.lastViewUpdate = update;
    }

    destroy() {
        if (this.scrollDebounceTimer !== null) {
            window.clearTimeout(this.scrollDebounceTimer);
            this.scrollDebounceTimer = null;
            this.pendingScrollBuild = null;
        }
    }

    /**
     * Get information about parent elements for debugging
     */
    getParentElementInfo(element: Element, maxDepth: number = 5): Array<{tag: string, classes: string}> {
        const parents: Array<{tag: string, classes: string}> = [];
        let current = element.parentElement;
        let depth = 0;
        
        while (current && depth < maxDepth) {
            parents.push({
                tag: current.tagName,
                classes: Array.from(current.classList).join(' ')
            });
            current = current.parentElement;
            depth++;
        }
        
        return parents;
    }


    /**
     * Context-aware disambiguation: when a heading name exists in multiple notes,
     * narrow the candidate files to the one whose file name (or an alias) appears
     * CLOSEST to the current match in the current paragraph. Proximity is the
     * signal — a name mentioned right before the heading is far more likely to be
     * the intended target than one buried further up the paragraph.
     */
    disambiguateFilesByContext(
        files: TFile[],
        docPos: number,
        view: EditorView
    ): { files: TFile[]; distances: Map<string, number> } {
        // 距离也要带出去：消歧没能缩小到唯一候选时，[1|2|3] 会用它在同一档位内部
        // 排序（正文里提得更近的那篇排前面）。
        const distances = new Map<string, number>();
        if (files.length <= 1) return { files, distances };

        const doc = view.state.doc;
        // 上下文范围 = 整篇（文档开头到当前匹配位置）。原来只看"当前段落"，
        // 但需求是"文章里提到过谁，谁就更受重视"—— 整篇更稳定，也不受段落
        // 怎么划分的影响。
        const context = doc.sliceString(0, docPos).toLowerCase();
        if (context.trim().length === 0) return { files, distances };

        // Score each candidate by the proximity of its most recent name/alias
        // mention: distance = chars from the end of that mention to the match.
        const scored = files.map((file) => {
            let closestDistance = Number.POSITIVE_INFINITY;
            const names = [file.basename];
            const cache = this.app.metadataCache.getFileCache(file);
            const rawAliases: unknown = cache?.frontmatter?.aliases;
            const aliases: unknown[] = Array.isArray(rawAliases) ? rawAliases : [];
            for (const alias of aliases) {
                if (typeof alias === 'string') names.push(alias);
            }
            for (const name of names) {
                const lower = name.toLowerCase();
                if (lower.length < 2) continue; // ignore single-char names (too noisy)
                const idx = context.lastIndexOf(lower);
                if (idx === -1) continue;
                const distance = context.length - (idx + lower.length);
                if (distance < closestDistance) closestDistance = distance;
            }
            return { file, distance: closestDistance };
        });

        for (const s of scored) {
            if (Number.isFinite(s.distance)) distances.set(s.file.path, s.distance);
        }

        // Keep only candidates that actually appeared in the context.
        const hits = scored.filter((s) => Number.isFinite(s.distance));
        if (hits.length === 0) return { files, distances };

        // Only narrow down when exactly one file is clearly the closest.
        const minDist = Math.min(...hits.map((s) => s.distance));
        const winners = hits.filter((s) => s.distance === minDist);
        if (winners.length === 1) {
            return { files: [winners[0].file], distances };
        }
        return { files, distances };
    }

    /**
     * Recognize bare internal-link syntax as virtual links, e.g.:
     *   a#b            -> heading "b" in note "a"
     *   a#b#c          -> sub-heading "c" under "b" in note "a"
     *   a#b#c^h6d8e3   -> block "h6d8e3" under heading "c" in note "a"
     *   a#^h6d8e3      -> block "h6d8e3" in note "a"
     *
     * Returns VirtualMatch objects covering the whole "a#b..." token. The leading
     * part "a" is resolved against the note path (like Obsidian's internal links).
     */
    findInternalLinkSyntaxMatches(text: string, rangeFrom: number, currentFile: TFile, startId: number = 0): VirtualMatch[] {
        const matches: VirtualMatch[] = [];
        // Match a non-whitespace, non-bracket token containing at least one '#'
        // but exclude tokens already wrapped in [[...]] (those are real links and
        // are handled/excluded elsewhere).
        const regex = /(?:^|(?<![[\w]))((?:(?!\[\[)[^\s[\]|#\p{P}])+)(#(?:[^\s[\]|\p{P}]+)?)+(?:\|([^\s[\]|\p{P}]+))?/gu;
        let m: RegExpExecArray | null;
        let id = startId;
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
            let dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(notePart), currentFile.path);
            let prefixCut = 0;
            if (!dest && notePart.length > 1) {
                for (let cut = 1; cut < notePart.length; cut++) {
                    const candidate = notePart.slice(cut);
                    const d = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(candidate), currentFile.path);
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
            const headings = this.app.metadataCache.getFileCache(dest)?.headings ?? [];

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

            const aFrom = rangeFrom + m.index + prefixCut;
            const aTo = rangeFrom + m.index + full.length;
            matches.push(
                new VirtualMatch(
                    id++,
                    displayText,
                    aFrom,
                    aTo,
                    [dest],
                    MatchType.Header,
                    false,
                    this.settings,
                    this.plugin,
                    headerId
                )
            );
        }
        return matches;
    }

    buildDecorations(view: EditorView, viewIsActive: boolean = true): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();

        if (!this.settings.linkerActivated) {
            return builder.finish();
        }

        const dom = view.dom;
        const mappedFile = this.viewUpdateDomToFileMap.get(dom);

        // Check if the file is inside excluded folders
        const excludedFolders = this.settings.excludedDirectoriesForLinking;
        if (excludedFolders.length > 0) {
            const path = mappedFile?.parent?.path ?? this.app.workspace.getActiveFile()?.parent?.path;
            if (excludedFolders.includes(path ?? '')) return builder.finish();
        }

        // 单篇禁用：笔记自己声明了不渲染任何虚拟链接（标签或 frontmatter 属性，
        // 用哪种由 linkIgnoreMode 决定）
        const ignoreFile = mappedFile ?? this.app.workspace.getActiveFile();
        if (isLinkingDisabledInNote(ignoreFile, this.app, this.settings)) return builder.finish();

        // Set to exclude files that are explicitly linked
        const explicitlyLinkedFiles = new Set<TFile>();

        // Set to exclude files that are already linked by a virtual link
        const alreadyLinkedFiles = new Set<TFile>();

        for (const { from, to } of view.visibleRanges) {
            this.linkerCache.reset();
            const text = view.state.doc.sliceString(from, to);

            // For every glossary file and its aliases we now search the text for occurrences
            // const additions: { id: number; files: TFile[]; from: number; to: number; widget: WidgetType }[] = [];
            let matches: VirtualMatch[] = [];
            let id = 0;
            let wordStartRel = 0; // start offset (relative to `text`) of the current document word
            // Iterate over every char in the text
            for (let i = 0; i <= text.length; i) {
                // Do this to get unicode characters as whole chars and not only half of them
                const codePoint = text.codePointAt(i)!;
                const char = i < text.length ? String.fromCodePoint(codePoint) : '\n';

                // If we are at a word boundary, get the current fitting files
                const isWordBoundary = PrefixTree.checkWordBoundary(char); // , this.settings.wordBoundaryRegex
                let currentNodes: ReturnType<typeof this.linkerCache.cache.getCurrentMatchNodes> = [];
                if (this.settings.matchAnyPartsOfWords || this.settings.matchBeginningOfWords || isWordBoundary) {
                    currentNodes = this.linkerCache.cache.getCurrentMatchNodes(
                        i,
                        this.settings.excludeLinksToOwnNote ? mappedFile : null
                    );

                    if (currentNodes.length > 0) {
                        for (const node of currentNodes) {
                            // Check if we want to include this note based on the settings
                            if (!this.settings.matchAnyPartsOfWords) {
                                if (
                                    (this.settings.matchBeginningOfWords && !node.startsAtWordBoundary) &&
                                    (this.settings.matchEndOfWords && !isWordBoundary)
                                ) {
                                    continue;
                                }
                            }

                            const nFrom = node.start;
                            const nTo = node.end;
                            let name = text.slice(nFrom, nTo);

                            // Fix: if the match range starts at a newline (can happen
                            // when the prefix tree's depth counting includes a boundary
                            // char), trim leading newlines so the decoration doesn't
                            // span a line break (which crashes CodeMirror).
                            let actualFrom = nFrom;
                            while (actualFrom < nTo && text[actualFrom] === '\n') {
                                actualFrom++;
                            }
                            if (actualFrom > nFrom) {
                                name = text.slice(actualFrom, nTo);
                            }
                            const aFrom = from + actualFrom;
                            const aTo = from + nTo;

                            // Filter out files with excluded extensions
                            let filteredFiles = Array.from(node.files).filter(file => {
                                return !this.settings.excludedExtensions.some(ext => 
                                    file.path.toLowerCase().endsWith(ext.toLowerCase())
                                );
                            });

                            // Context-aware disambiguation: when a heading exists in
                            // multiple notes, prefer the note whose file name (or alias)
                            // appears earlier in the current paragraph. This keeps the
                            // link pointing at the most relevant note.
                            let ctxDistances: Map<string, number> | undefined;
                            if (
                                this.settings.enableContextDisambiguation &&
                                node.type === MatchType.Header &&
                                filteredFiles.length > 1
                            ) {
                                const ctx = this.disambiguateFilesByContext(filteredFiles, from + actualFrom, view);
                                filteredFiles = ctx.files;
                                ctxDistances = ctx.distances;
                            }
                            
                            // getCurrentMatchNodes already handles excluded keywords (including per-note)
                            if (filteredFiles.length > 0) {
                                const virtualMatch = new VirtualMatch(
                                    id++,
                                    name,
                                    aFrom,
                                    aTo,
                                    filteredFiles,
                                    node.type,
                                    !isWordBoundary,
                                    this.settings,
                                    this.plugin, // Add plugin parameter
                                    node.headerId
                                );

                                // 把上下文距离交给渲染层：同一档位的目标按"正文里提得
                                // 更近的在前"排序。
                                if (ctxDistances) {
                                    for (const [p, d] of ctxDistances) virtualMatch.setFileContextDistance(p, d);
                                }

                                // A hit on a keyword that only exists because it was
                                // normalised (stemmed / function words / heading number
                                // stripped) is an exact tree match but not what the user
                                // wrote verbatim - colour it as fuzzy.
                                if (this.linkerCache.cache.isDerivedKeyword(name)) {
                                    virtualMatch.isFuzzy = true;
                                }

                                // If there are multiple files, get corresponding heading ID for each file
                                if (filteredFiles.length > 1) {
                                    filteredFiles.forEach((file, index) => {
                                        if (index === 0) return;

                                        // Prefer the per-file heading map: it is keyed by
                                        // file path, so it can never hand back another file's
                                        // heading. The trie lookup below only sees whatever
                                        // node happens to come first at this scan position.
                                        const ownHeaderId = this.linkerCache.cache.getFileHeaderId(file, name);
                                        if (ownHeaderId) {
                                            virtualMatch.setFileHeaderId(file, ownHeaderId);
                                            return;
                                        }

                                        const fileNodes = this.linkerCache.cache.getCurrentMatchNodes(
                                            i,
                                            null,
                                            file
                                        );
                                        if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                                            virtualMatch.setFileHeaderId(file, fileNodes[0].headerId);
                                        }
                                    });
                                }

                                matches.push(virtualMatch);
                            }
                        }
                    }

                    // Fuzzy (词义模糊) fallback: if no exact match was found and
                    // fuzzy matching is enabled, normalize the current document
                    // word and link it when similarity >= the configured threshold.
                    if (currentNodes.length === 0 && this.settings.enableStemming) {
                        // Skip leading whitespace once — it is the base for the
                        // sliding window below. A leading space (e.g. after a list
                        // marker "1. ") must not become part of the link text.
                        let baseFrom = wordStartRel;
                        while (baseFrom < i && /\s/.test(text[baseFrom])) {
                            baseFrom++;
                        }
                        const rawWord = text.slice(baseFrom, i);
                        if (rawWord.trim().length > 0) {
                            // Sliding window: try the whole run first, then drop one
                            // leading character at a time. Chinese has no spaces, so a
                            // term is usually glued to the text before it (e.g. "参见
                            // 科目冲刺带背3"), and those extra characters dilute the
                            // similarity below the threshold. Stop at the first hit.
                            const maxOffset = this.settings.fuzzySlidingWindow
                                ? Math.min(rawWord.length - 1, this.settings.fuzzySlidingWindowMaxOffset)
                                : 0;
                            // Score EVERY window position first and keep the most similar
                            // one. "Stop at the first hit" used to pick the LONGEST
                            // candidate (offset 0) rather than the best one: "被苏霍姆
                            // 林斯" (71%) would win over "苏霍姆林斯" (83%), padding the
                            // link with an unrelated leading character.
                            let bestOffset = -1;
                            let bestSim = -1;
                            for (let offset = 0; offset <= maxOffset; offset++) {
                                const rawCandidate = rawWord.slice(offset);
                                const candidate = rawCandidate.trim();
                                if (!candidate) continue;
                                if (candidate.length < this.linkerCache.cache.minFuzzyKeywordLen - 2) continue;
                                // Right-side short-circuit: a candidate more than 2x the
                                // longest indexed keyword can never shrink enough (via
                                // stopword stripping) to match. Skips the fuzzyNormalize
                                // cost on long-paragraph candidates.
                                if (candidate.length > this.linkerCache.cache.maxFuzzyKeywordLen * 2 + 4) continue;
                                const normWord = this.linkerCache.cache.fuzzyNormalize(candidate, this.settings.stemmingLanguage);
                                if (!normWord) continue;
                                // Length short-circuit: a query whose normalized length
                                // is >2 away from every indexed fuzzy keyword can never
                                // reach the >=80% threshold. Skipping here avoids the
                                // bucket scan + edit-distance cost of findFuzzyMatches.
                                if (!this.linkerCache.cache.couldMatchFuzzyLength(normWord.length)) continue;
                                const fuzzyResults = this.linkerCache.cache.findFuzzyMatches(normWord, this.settings.fuzzyMatchThreshold, this.settings.excludeLinksToOwnNote ? mappedFile : null);
                                if (fuzzyResults.length > 0) {
                                    const sim = fuzzyResults[0].similarity;
                                    if (sim > bestSim) {
                                        bestSim = sim;
                                        bestOffset = offset;
                                        // Already perfect — a shorter window cannot beat it.
                                        if (sim >= 0.9999) break;
                                    }
                                }
                            }

                            // Emit only for the winning window position.
                            let handled = false;
                            for (let offset = bestOffset; bestOffset >= 0 && offset <= bestOffset && !handled; offset++) {
                                const rawCandidate = rawWord.slice(offset);
                                // Keep the link range aligned with the trimmed text.
                                // (Avoid String#trimStart: it needs ES2019, while the
                                //  project's tsconfig lib only goes up to ES7.)
                                const leadWs = rawCandidate.length - rawCandidate.replace(/^\s+/, '').length;
                                const candidate = rawCandidate.trim();
                                if (!candidate) continue;
                                if (candidate.length < this.linkerCache.cache.minFuzzyKeywordLen - 2) continue;
                                // Right-side short-circuit: a candidate more than 2x the
                                // longest indexed keyword can never shrink enough (via
                                // stopword stripping) to match. Skips the fuzzyNormalize
                                // cost on long-paragraph candidates.
                                if (candidate.length > this.linkerCache.cache.maxFuzzyKeywordLen * 2 + 4) continue;
                                const normWord = this.linkerCache.cache.fuzzyNormalize(candidate, this.settings.stemmingLanguage);
                                if (!normWord) continue;
                                // Length short-circuit: a query whose normalized length
                                // is >2 away from every indexed fuzzy keyword can never
                                // reach the >=80% threshold. Skipping here avoids the
                                // bucket scan + edit-distance cost of findFuzzyMatches.
                                if (!this.linkerCache.cache.couldMatchFuzzyLength(normWord.length)) continue;
                                const fuzzyResults = this.linkerCache.cache.findFuzzyMatches(normWord, this.settings.fuzzyMatchThreshold, this.settings.excludeLinksToOwnNote ? mappedFile : null);
                                if (fuzzyResults.length > 0) {
                                    // Results are sorted best-first. Merge every candidate TIED at the
                                    // top similarity into one multi-target link instead of arbitrarily
                                    // picking one — e.g. "科目二冲刺带背" ties across "…带背1".."…带背7",
                                    // all at 87.5%, so the user gets [1][2]…[7] to choose from.
                                    const topSim = fuzzyResults[0].similarity;
                                    const mergedFiles: TFile[] = [];
                                    const seenPaths = new Set<string>();
                                    // Remember each file's OWN heading id. VirtualMatch's
                                    // constructor stamps the top result's headerId onto every
                                    // target, so without this the 2nd target inherits the 1st
                                    // one's heading and its link points at an anchor that does
                                    // not exist in that file — opening the note but scrolling
                                    // nowhere.
                                    const fuzzyFileHeaderIds = new Map<string, string>();
                                    for (const fr of fuzzyResults) {
                                        if (fr.similarity < topSim) break;
                                        for (const f of fr.files) {
                                            if (seenPaths.has(f.path)) continue;
                                            seenPaths.add(f.path);
                                            mergedFiles.push(f);
                                            if (fr.headerId) fuzzyFileHeaderIds.set(f.path, fr.headerId);
                                        }
                                    }

                                    const fFromRel = baseFrom + offset + leadWs;
                                    const fToRel = i;
                                    const fName = text.slice(fFromRel, fToRel);
                                    const aFrom = from + fFromRel;
                                    const aTo = from + fToRel;

                                    // A fuzzy match must not cover a range an exact match
                                    // already claimed. "被苏霍姆林斯基之女" (fuzzy) starts
                                    // one char before the exact "苏霍姆林斯基", so
                                    // filterOverlapping — which keeps whichever match
                                    // starts first — would delete the exact match.
                                    let coveredByExact = false;
                                    for (let k = matches.length - 1; k >= 0; k--) {
                                        const prev = matches[k];
                                        if (prev.isFuzzy) continue;
                                        if (prev.to <= aFrom) break;
                                        if (prev.from < aTo) { coveredByExact = true; break; }
                                    }
                                    if (coveredByExact) continue;

                                    const filteredFiles = mergedFiles.filter(file => {
                                        return !this.settings.excludedExtensions.some(ext =>
                                            file.path.toLowerCase().endsWith(ext.toLowerCase())
                                        );
                                    });
                                    if (filteredFiles.length > 0) {
                                        // Determine match type from the top result:
                                        // - if the entry has a headerId, it's a Header match
                                        // - else if the canonical keyword matches a file basename, it's a Note
                                        // - otherwise it's an Alias
                                        const topFr = fuzzyResults[0];
                                        let fuzzyMatchType = MatchType.Note;
                                        if (topFr.headerId) {
                                            fuzzyMatchType = MatchType.Header;
                                        } else if (topFr.canonical) {
                                            const hasNoteMatch = filteredFiles.some(f => f.basename.toLowerCase() === topFr.canonical!.toLowerCase());
                                            if (!hasNoteMatch) fuzzyMatchType = MatchType.Alias;
                                        }

                                        const virtualMatch = new VirtualMatch(
                                            id++,
                                            fName,
                                            aFrom,
                                            aTo,
                                            filteredFiles,
                                            fuzzyMatchType,
                                            false,
                                            this.settings,
                                            this.plugin,
                                            topFr.headerId
                                        );
                                        // Mark as fuzzy so it can be tinted with the fuzzy base color.
                                        virtualMatch.isFuzzy = true;

                                        if (filteredFiles.length > 1) {
                                            filteredFiles.forEach((file, index) => {
                                                if (index === 0) return;
                                                // Prefer the heading id that came with this file's own
                                                // fuzzy index entry. Fall back to the prefix tree only
                                                // when that entry had none — a fuzzy hit is usually
                                                // not reachable in the tree at this scan position, so
                                                // the tree lookup silently fails and the file keeps
                                                // the first target's (wrong) heading.
                                                const ownHeaderId = fuzzyFileHeaderIds.get(file.path);
                                                if (ownHeaderId) {
                                                    virtualMatch.setFileHeaderId(file, ownHeaderId);
                                                    return;
                                                }
                                                const fileNodes = this.linkerCache.cache.getCurrentMatchNodes(i, null, file);
                                                if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                                                    virtualMatch.setFileHeaderId(file, fileNodes[0].headerId);
                                                }
                                            });
                                        }

                                        matches.push(virtualMatch);
                                        handled = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                if (isWordBoundary) wordStartRel = i;

                // Push the char to get the next nodes in the prefix tree
                this.linkerCache.cache.pushChar(char);

                i += char.length;
            }

            // Recognize bare internal-link syntax like "a#b", "a#b#c",
            // "a#b#c^h6d8e3" or "a#^h6d8e3" as virtual links, so users can write
            // plain-text references (e.g. in footnotes) without polluting the graph
            // with real links. Only active when enableInternalLinkSyntax is on.
            // These matches are kept separate: their ranges are added to the
            // exclusion tree (so they fully replace any partial prefix-tree match),
            // but they themselves bypass filterOverlapping (which would otherwise
            // delete them since their own range is in the tree).
            let internalMatches: VirtualMatch[] = [];
            if (this.settings.enableInternalLinkSyntax && mappedFile) {
                internalMatches = this.findInternalLinkSyntaxMatches(text, from, mappedFile, id);
                id += internalMatches.length;
            }

            // Sort additions by position and files length
            matches = VirtualMatch.sort(matches);

            // We want to exclude some syntax nodes from being decorated,
            // such as code blocks and manually added links
            const excludedIntervalTree = new IntervalTree();
            const excludedTypes = ['codeblock', 'code-block', 'inline-code', 'internal-link', 'link', 'url', 'hashtag'];
            if (!this.settings.allowLinksInHeaders) {
                excludedTypes.push('header-');
            }

            // We also want to exclude links to files that are already linked by a real link
            const app = this.app;
            // Collect format-node ranges (bold/italic/highlight/strikethrough/
            // comment/header) in this single walk, so links can read pre-computed
            // flags instead of re-walking the tree per widget — the main source of
            // scroll lag / flicker.
            const formatRanges: { from: number; to: number; kind: string }[] = [];
            syntaxTree(view.state).iterate({
                from,
                to,
                enter(node) {
                    const type = node.type.name;
                    const types = type.split('_');

                    for (const excludedType of excludedTypes) {
                        if (type.contains(excludedType)) {
                            excludedIntervalTree.insert([node.from, node.to]);

                            // Types can be combined, e.g. internal-link_link-has-alias
                            // These combined types are separated by underscores
                            const isLinkIfHavingTypes = [['string', 'url'], 'hmd-internal-link', 'internal-link'];

                            isLinkIfHavingTypes.forEach((t) => {
                                const tList = Array.isArray(t) ? t : [t];

                                if (tList.every((tt) => types.includes(tt))) {
                                    const text = view.state.doc.sliceString(node.from, node.to);
                                    const linkedFile = app.metadataCache.getFirstLinkpathDest(text, mappedFile?.path ?? '');
                                    if (linkedFile) {
                                        explicitlyLinkedFiles.add(linkedFile);
                                    }
                                }
                            });
                        }
                    }

                    // Format context: record ranges so links inside them get the
                    // right CSS class without a per-widget syntax walk. NOTE: use
                    // independent ifs (not else-if) — a node can carry several
                    // combined marks (e.g. strong + highlight), and each must be
                    // recorded so their CSS classes coexist.
                    const ft = node.type.name;
                    if (ft.includes('strong')) formatRanges.push({ from: node.from, to: node.to, kind: 'strong' });
                    if (ft.includes('em')) formatRanges.push({ from: node.from, to: node.to, kind: 'em' });
                    if (ft.includes('highlight') || ft.includes('mark')) formatRanges.push({ from: node.from, to: node.to, kind: 'highlight' });
                    if (ft.includes('strikethrough') || ft.includes('strike') || ft.includes('del')) formatRanges.push({ from: node.from, to: node.to, kind: 'strikethrough' });
                    if (ft.includes('comment')) formatRanges.push({ from: node.from, to: node.to, kind: 'comment' });
                    if (ft.includes('header')) formatRanges.push({ from: node.from, to: node.to, kind: 'header' });
                },
            });

            // Exclude text between custom start/end symbols (e.g. { ... }) from
            // virtual linking. We insert the ranges into the same interval tree
            // used for syntax nodes, so filterOverlapping drops any match inside.
            // Multiple symbol pairs are supported by comma-separating the start and
            // end lists (e.g. start "{,（" end "},）").
            if (this.settings.enableSymbolExclusion) {
                const startSyms = (this.settings.excludeSymbolStart || '').split(',').map(s => s.trim()).filter(Boolean);
                const endSyms = (this.settings.excludeSymbolEnd || '').split(',').map(s => s.trim()).filter(Boolean);
                const pairCount = Math.min(startSyms.length, endSyms.length);
                for (let p = 0; p < pairCount; p++) {
                    const startSym = startSyms[p];
                    const endSym = endSyms[p];
                    if (!startSym || !endSym || startSym === endSym) continue;
                    let searchFrom = 0;
                    // for(;;) rather than while(true) — the latter trips no-constant-condition.
                    for (;;) {
                        const startIdx = text.indexOf(startSym, searchFrom);
                        if (startIdx === -1) break;
                        const endIdx = text.indexOf(endSym, startIdx + startSym.length);
                        // Unclosed start symbol excludes the rest of the visible range.
                        const rangeEnd = endIdx === -1 ? text.length : endIdx + endSym.length;
                        excludedIntervalTree.insert([from + startIdx, from + rangeEnd]);
                        searchFrom = startIdx + startSym.length;
                    }
                }
            }

            // Exclude successfully-parsed internal-link syntax ranges from
            // prefix-tree matching, so "note#heading" fully replaces a partial
            // "note" match instead of competing with it in filterOverlapping.
            for (const im of internalMatches) {
                excludedIntervalTree.insert([im.from, im.to]);
            }

            // Delete additions that links to already linked files
            if (this.settings.excludeLinksToRealLinkedFiles) {
                matches = VirtualMatch.filterAlreadyLinked(matches, explicitlyLinkedFiles);
            }

            // Delete additions that links to already linked files
            if (this.settings.onlyLinkOnce) {
                matches = VirtualMatch.filterAlreadyLinked(matches, alreadyLinkedFiles);
            }


            // Delete additions that overlap
            // Additions are sorted by from position and after that by length, we want to keep longer additions
            matches = VirtualMatch.filterOverlapping(matches, this.settings.onlyLinkOnce, excludedIntervalTree);

            // Re-join the internal-link syntax matches now that prefix-tree matches
            // inside their ranges have been dropped. They are re-sorted so the
            // RangeSetBuilder below receives them in ascending order.
            if (internalMatches.length > 0) {
                matches = matches.concat(internalMatches);
                matches = VirtualMatch.sort(matches);
            }

            // 按位置顺序，给每个匹配打一份"在它之前已经链接过的文件"快照，然后
            // 才把它自己加进集合。排序时用这份快照判断"文章里是否已经指向过这篇
            // 笔记"（含精准和模糊匹配）—— 快照必须在它自己之前取，否则同一组
            // 候选会互相把对方算成"已链接"，加权就失效了。
            matches.forEach((addition) => {
                addition.setAlreadyLinkedFiles(new Set(alreadyLinkedFiles));
                addition.files.forEach((f) => alreadyLinkedFiles.add(f));
            });

            // Get the cursor position
            const cursorPos = view.state.selection.main.from;

            // Settings if we want to adapt links in the current line / fix IME problem
            const excludeLine = viewIsActive && this.settings.excludeLinksInCurrentLine;
            const fixIMEProblem = viewIsActive && this.settings.fixIMEProblem;
            let needImeFix = false;
            


            
            // Debug logging


            // Get the line start and end positions
            let lineStart: number, lineEnd: number;
            
                // Regular text: use standard line detection

                const line = view.state.doc.lineAt(cursorPos);
                lineStart = line.from;
                lineEnd = line.to;
            


            // Decoration.replace cannot span a line break; skip any match whose
            // range crosses one. Otherwise CodeMirror throws
            // "Decorations that replace line breaks may not be specified via plugins"
            // and the whole plugin crashes (no links render at all).
            // We check for a literal '\n' in the sliced text (more reliable than
            // comparing line numbers, which can misbehave at line boundaries).
            matches = matches.filter((addition) => {
                if (addition.from > addition.to) return false;
                const slice = view.state.sliceDoc(addition.from, addition.to);
                if (slice.includes('\n')) return false;
                const line = view.state.doc.lineAt(addition.from);
                const isHeaderLine = /^#{1,6}\s/.test(line.text);
                if (isHeaderLine) {
                    if (!this.settings.allowLinksInHeaders) return false;
                    // A heading must never link to the note it belongs to (self-link):
                    // the decoration widget would replace the heading text and, when the
                    // cursor is elsewhere, the heading disappears entirely.
                    const currentFile = mappedFile ?? this.app.workspace.getActiveFile();
                    if (currentFile && addition.files.some((f) => f.path === currentFile.path)) {
                        return false;
                    }
                }
                return true;
            });
            // RangeSetBuilder requires decorations to be added in ascending order.
            matches.sort((a, b) => a.from - b.from || a.to - b.to);

            matches.forEach((addition) => {
                const [from, to] = [addition.from, addition.to];
                const cursorNearby = cursorPos >= from - 0 && cursorPos <= to + 0;

                const additionIsInCurrentLine = from >= lineStart && to <= lineEnd;

                // Format context: apply the ranges collected in the single syntax
                // walk above, instead of re-walking the tree per link.
                for (const fr of formatRanges) {
                    if (from >= fr.from && to <= fr.to) {
                        if (fr.kind === 'strong') addition.isBoldContext = true;
                        else if (fr.kind === 'em') addition.isItalicContext = true;
                        else if (fr.kind === 'highlight') addition.isHighlightContext = true;
                        else if (fr.kind === 'strikethrough') addition.isStrikethroughContext = true;
                        else if (fr.kind === 'comment') addition.isCommentContext = true;
                        else if (fr.kind === 'header') addition.isInHeaderContext = true;
                    }
                }
                addition.isTripleStarContext = addition.isBoldContext && addition.isItalicContext;

                // Whether the addition sits inside a comment node (used below to
                // exempt it from the "exclude current line" rule, as before).
                let additionIsInComment = false;
                if (additionIsInCurrentLine) {
                    for (const fr of formatRanges) {
                        if (fr.kind === 'comment' && from < fr.to && fr.from < to) {
                            additionIsInComment = true;
                            break;
                        }
                    }
                }
                


                if (fixIMEProblem) {
                    needImeFix = true;
                    if (additionIsInCurrentLine && cursorPos > to) {
                        const gapString = view.state.sliceDoc(to, cursorPos);
                        const strBeforeAdd = view.state.sliceDoc(lineStart, from);

                        // Regex to check if a part of a word is at the line start, because IME problem only occurs at line start
                        // Regex matches parts that:
                        // - are completely empty or contain only whitespace.
                        // - start with a hyphen followed by one or more spaces.
                        // - start with 1 to 6 hash symbols followed by a space.
                        // - start with one or more greater-than signs followed by optional whitespace.
                        // - start with a hyphen followed by one or more spaces, then 1 to 6 hash symbols, and then one or more spaces.
                        // - start with a greater-than sign followed by a space, an exclamation mark within square brackets containing word characters or hyphens, an optional plus or minus sign, and one or more spaces.
                        const regAddInLineStart =
                            /(^\s*$)|(^\s*- +$)|(^\s*#{1,6} $)|(^\s*>+ *$)|(^\s*- +#{1,6} +$)|(^\s*> \[![\w-]+\][+-]? +$)/;

                        // check add is at line start
                        if (!regAddInLineStart.test(strBeforeAdd)) {
                            needImeFix = false;
                        }
                        // check the string between addition and cursorPos, check if it might be IME on.
                        else {
                            const regStrMayIMEon = /^[a-zA-Z]+[a-zA-Z' ]*[a-zA-Z]$|^[a-zA-Z]$/;
                            if (!regStrMayIMEon.test(gapString) || /[' ]{2}/.test(gapString)) {
                                needImeFix = false;
                            }
                        }
                    } else {
                        needImeFix = false;
                    }
                }



                if (!cursorNearby && !needImeFix && !(excludeLine && additionIsInCurrentLine && !additionIsInComment)) {
                    builder.add(
                        from,
                        to,
                        Decoration.replace({
                            // widget: addition.widget,
                            widget: new VirtualLinkWidget(addition),
                        })
                    );
                }
            });
        }

        return builder.finish();
    }
}

const pluginSpec: PluginSpec<AutoLinkerPlugin> = {
    decorations: (value: AutoLinkerPlugin) => value.decorations,
};

export const liveLinkerPlugin = (app: App, settings: LinkerPluginSettings, updateManager: ExternalUpdateManager, plugin: LinkerPluginType) => {
    return ViewPlugin.define((editorView: EditorView) => {
        return new AutoLinkerPlugin(editorView, app, settings, updateManager, plugin);
    }, pluginSpec);
};