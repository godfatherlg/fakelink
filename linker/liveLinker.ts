import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, PluginSpec, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { App, MarkdownView, TFile, Vault, getLinkpath } from 'obsidian';

import IntervalTree from '@flatten-js/interval-tree';
import { LinkerPluginSettings } from 'main';
import { ExternalUpdateManager, LinkerCache, PrefixTree, MatchType } from './linkerCache';
import { VirtualMatch } from './virtualLinkDom';

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
        // Improved table cell detection logic
        const cmTableWidget = view.dom.closest('.cm-table-widget');
        const tableWrapper = view.dom.closest('.table-cell-wrapper');
        const inTableCellEditor = Boolean(cmTableWidget && tableWrapper);
        
        // Create link element
        const element = this.match.getCompleteLinkElement(inTableCellEditor);
        
        // Check current format context with precise range checking
        let inBoldContext = false;
        let inItalicContext = false;
        let inHighlightContext = false;
        let inStrikethroughContext = false;
        let inCommentContext = false;
        let inHeaderContext = false;
        
        // Get the exact text range of the virtual link
        const linkRange = { from: this.match.from, to: this.match.to };
        
        // Expand the search range to capture format nodes that may contain the virtual link
        // Format markers like ==, **, ~~ are typically 2 characters on each side
        const expandRange = 10;
        const searchFrom = Math.max(0, this.match.from - expandRange);
        const searchTo = Math.min(view.state.doc.length, this.match.to + expandRange);
        
        syntaxTree(view.state).iterate({
            from: searchFrom,
            to: searchTo,
            enter(node) {
                const type = node.type.name;
                const nodeRange = { from: node.from, to: node.to };
                
                // Only set context if virtual link is fully contained within the format node
                if (linkRange.from >= nodeRange.from && linkRange.to <= nodeRange.to) {
                    if (type.includes('strong')) {
                        inBoldContext = true;
                    }
                    if (type.includes('em')) {
                        inItalicContext = true;
                    }
                    // Support both 'highlight' and 'mark' as highlight node type names
                    if (type.includes('highlight') || type.includes('mark')) {
                        inHighlightContext = true;
                    }
                    if (type.includes('strikethrough') || type.includes('strike') || type.includes('del')) {
                        inStrikethroughContext = true;
                    }
                    if (type.includes('comment')) {
                        inCommentContext = true;
                    }
                    if (type.includes('header')) {
                        inHeaderContext = true;
                    }
                }
            }
        });
        
        // Set context flags on the match
        this.match.isBoldContext = inBoldContext || this.match.isBoldContext;
        this.match.isItalicContext = inItalicContext;
        this.match.isHighlightContext = inHighlightContext;
        this.match.isStrikethroughContext = inStrikethroughContext;
        this.match.isCommentContext = inCommentContext;
        this.match.isTripleStarContext = inBoldContext && inItalicContext;
        
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
        if (inHeaderContext) {
            element.classList.add('virtual-link-in-header');
        }
        if (this.match.isTripleStarContext) {
            element.classList.add('cm-strong', 'cm-em');
        }
        
        return element;
    }
    
    // Set higher decoration priority
    get estimatedHeight(): number {
        return -1;
    }
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

    // Cache the active Markdown view so we don't call getActiveViewOfType()
    // on every cursor move. Invalidated on active-leaf-change.
    private cachedActiveView: MarkdownView | null | undefined = undefined;

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

        updateManager.registerCallback(() => {
            if (this.lastViewUpdate) {
                this.update(this.lastViewUpdate, true);
            }
        });
    }

    update(update: ViewUpdate, force: boolean = false) {
        if (this.cachedActiveView === undefined) {
            this.cachedActiveView = this.app.workspace.getActiveViewOfType(MarkdownView) ?? null;
        }
        const activeView = this.cachedActiveView;

        // Pre-detect table environment for active view checking
        const cmTableWidget = update.view.dom.closest('.cm-table-widget');
        const tableWrapper = update.view.dom.closest('.table-cell-wrapper');
        const inTableCellEditor = Boolean(cmTableWidget && tableWrapper);

        // Check if the update is on the active view. We only need to check this, if one of the following settings is enabled
        // - fixIMEProblem
        // - excludeLinksToOwnNote
        // - excludeLinksInCurrentLine
        let updateIsOnActiveView = false;
        if (this.settings.fixIMEProblem || this.settings.excludeLinksInCurrentLine || this.settings.excludeLinksToOwnNote) {
            const domFromUpdate = update.view.dom;
            const domFromWorkspace = activeView?.contentEl;
            updateIsOnActiveView = domFromWorkspace ? isDescendant(domFromWorkspace, domFromUpdate, 3) : false;
            
            // Additional check for table environments - pragmatic approach
            if (!updateIsOnActiveView && inTableCellEditor) {
                // If we're in a table cell editor, assume it's the active view
                // This solves the complex DOM hierarchy detection issue
                updateIsOnActiveView = true;
            }
            


            // We store this information to be able to map the view updates to a obsidian file
            if (updateIsOnActiveView) {
                this.viewUpdateDomToFileMap.set(domFromUpdate, activeView?.file);
            }
        }

        const cursorPos = update.view.state.selection.main.from;
        const activeFile = this.app.workspace.getActiveFile()?.path;
        const fileChanged = activeFile != this.lastActiveFile;

        if (force || this.lastCursorPos != cursorPos || update.docChanged || fileChanged || update.viewportChanged) {
            this.lastCursorPos = cursorPos;
            this.linkerCache.updateCache(force);
            this.decorations = this.buildDecorations(update.view, updateIsOnActiveView);
            this.lastActiveFile = activeFile ?? '';
        }

        this.lastViewUpdate = update;
    }

    destroy() {}

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
     * Find the boundary of the current line within a table cell
     * @param view The editor view
     * @param cursorPos Current cursor position
     * @param findStart Whether to find the start boundary (true) or end boundary (false)
     * @returns The position of the line boundary
     */
    findTableCellLineBoundary(view: EditorView, cursorPos: number, findStart: boolean): number {
        const doc = view.state.doc;
        

        
        // Additional debugging

        
        if (findStart) {
            // Look backwards for newline or start of document
            for (let pos = cursorPos; pos >= 0; pos--) {
                if (pos === 0) {

                    return 0;
                }
                const char = doc.sliceString(pos - 1, pos);
                if (char === '\n') {

                    return pos;
                }
            }

            return 0;
        } else {
            // Look forwards for newline or end of document
            for (let pos = cursorPos; pos <= doc.length; pos++) {
                if (pos === doc.length) {

                    return doc.length;
                }
                const char = doc.sliceString(pos, pos + 1);
                if (char === '\n') {

                    return pos;
                }
            }

            return doc.length;
        }
    }

    /**
     * Context-aware disambiguation: when a heading name exists in multiple notes,
     * narrow the candidate files to the one whose file name (or an alias) appears
     * CLOSEST to the current match in the current paragraph. Proximity is the
     * signal — a name mentioned right before the heading is far more likely to be
     * the intended target than one buried further up the paragraph.
     */
    disambiguateFilesByContext(files: TFile[], docPos: number, view: EditorView): TFile[] {
        if (files.length <= 1) return files;

        const doc = view.state.doc;
        // Find the start of the current paragraph (preceded by a blank line).
        let paraStart = 0;
        const line = doc.lineAt(docPos);
        paraStart = line.from;
        let prevLine = line;
        // Walk backwards over consecutive non-blank lines to the paragraph start.
        for (let l = line.number - 1; l >= 1; l--) {
            const candidate = doc.line(l);
            if (candidate.text.trim().length === 0) {
                paraStart = prevLine.from;
                break;
            }
            paraStart = candidate.from;
            prevLine = candidate;
        }

        // Only the text before the current match position counts as "context".
        const context = doc.sliceString(paraStart, docPos).toLowerCase();
        if (context.trim().length === 0) return files;

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

        // Keep only candidates that actually appeared in the context.
        const hits = scored.filter((s) => Number.isFinite(s.distance));
        if (hits.length === 0) return files;

        // Only narrow down when exactly one file is clearly the closest.
        const minDist = Math.min(...hits.map((s) => s.distance));
        const winners = hits.filter((s) => s.distance === minDist);
        if (winners.length === 1) {
            return [winners[0].file];
        }
        return files;
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
        const regex = /(?:^|(?<![[\w]))((?:(?!\[\[)[^\s[\]#])+)(#(?:[^\s[\]]+)?)+/g;
        let m: RegExpExecArray | null;
        let id = startId;
        while ((m = regex.exec(text)) !== null) {
            const full = m[0];
            // Skip if it starts with "[[" — a real internal link.
            if (full.startsWith('[[')) continue;

            const hashIdx = full.indexOf('#');
            if (hashIdx <= 0) continue;
            const notePart = full.slice(0, hashIdx);
            const anchorPart = full.slice(hashIdx + 1); // e.g. "b", "b#c", "^h6d8e3", "b#c^h6d8e3"

            // Resolve the note part to a file.
            const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(notePart), currentFile.path);
            if (!dest) continue;

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

            const aFrom = rangeFrom + m.index;
            const aTo = rangeFrom + m.index + full.length;
            matches.push(
                new VirtualMatch(
                    id++,
                    full,
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

        // Set to exclude files that are explicitly linked
        const explicitlyLinkedFiles = new Set<TFile>();

        // Set to exclude files that are already linked by a virtual link
        const alreadyLinkedFiles = new Set<TFile>();

        for (let { from, to } of view.visibleRanges) {
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
                            if (
                                this.settings.enableContextDisambiguation &&
                                node.type === MatchType.Header &&
                                filteredFiles.length > 1
                            ) {
                                filteredFiles = this.disambiguateFilesByContext(filteredFiles, from + actualFrom, view);
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

                                // If there are multiple files, get corresponding heading ID for each file
                                if (filteredFiles.length > 1) {
                                    filteredFiles.forEach((file, index) => {
                                        if (index === 0) return;

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
                        const rawWord = text.slice(wordStartRel, i).trim();
                        if (rawWord.length > 0) {
                            const normWord = this.linkerCache.cache.fuzzyNormalize(rawWord, this.settings.stemmingLanguage);
                            if (normWord) {
                                const fuzzyResults = this.linkerCache.cache.findFuzzyMatches(normWord, this.settings.fuzzyMatchThreshold);
                                for (const fr of fuzzyResults) {
                                    let fFromRel = wordStartRel;
                                    const fToRel = i;
                                    // Trim leading newlines to avoid cross-line decorations
                                    while (fFromRel < fToRel && text[fFromRel] === '\n') {
                                        fFromRel++;
                                    }
                                    const fName = text.slice(fFromRel, fToRel);
                                    const aFrom = from + fFromRel;
                                    const aTo = from + fToRel;

                                    const filteredFiles = Array.from(fr.files).filter(file => {
                                        return !this.settings.excludedExtensions.some(ext =>
                                            file.path.toLowerCase().endsWith(ext.toLowerCase())
                                        );
                                    });
                                    if (filteredFiles.length === 0) continue;

                                    // Determine match type from the fuzzy result:
                                    // - if the entry has a headerId, it's a Header match
                                    // - else if the canonical keyword matches a file basename, it's a Note
                                    // - otherwise it's an Alias
                                    let fuzzyMatchType = MatchType.Note;
                                    if (fr.headerId) {
                                        fuzzyMatchType = MatchType.Header;
                                    } else if (fr.canonical) {
                                        const hasNoteMatch = filteredFiles.some(f => f.basename.toLowerCase() === fr.canonical!.toLowerCase());
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
                                        fr.headerId
                                    );

                                    if (filteredFiles.length > 1) {
                                        filteredFiles.forEach((file, index) => {
                                            if (index === 0) return;
                                            const fileNodes = this.linkerCache.cache.getCurrentMatchNodes(i, null, file);
                                            if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                                                virtualMatch.setFileHeaderId(file, fileNodes[0].headerId);
                                            }
                                        });
                                    }

                                    matches.push(virtualMatch);
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
            let excludedTypes = ['codeblock', 'code-block', 'inline-code', 'internal-link', 'link', 'url', 'hashtag'];
            if (!this.settings.allowLinksInHeaders) {
                excludedTypes.push('header-');
            }

            // We also want to exclude links to files that are already linked by a real link
            const app = this.app;
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
                    while (true) {
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

            // Store the files that are linked by a virtual link
            matches.forEach((addition) => addition.files.forEach((f) => alreadyLinkedFiles.add(f)));

            // Get the cursor position
            const cursorPos = view.state.selection.main.from;

            // Settings if we want to adapt links in the current line / fix IME problem
            const excludeLine = viewIsActive && this.settings.excludeLinksInCurrentLine;
            const fixIMEProblem = viewIsActive && this.settings.fixIMEProblem;
            let needImeFix = false;
            


            // Check if we're in a table environment - improved detection logic
            // Look for any table-related indicators in the DOM hierarchy
            let inTableCellEditor = false;
            
            // Check various table indicators
            const tableIndicators = [
                '.cm-table-widget',
                '.table-cell-wrapper', 
                '.cm-table',
                '.cm-table-cell',
                '[class*="table"]', // Any class containing "table"
                '[class*="cell"]',   // Any class containing "cell"
                '.markdown-table',
                '.markdown-table-cell'
            ];
            
            // Check if any table indicator exists in the DOM path
            for (const indicator of tableIndicators) {
                if (view.dom.closest(indicator)) {
                    inTableCellEditor = true;
                    break;
                }
            }
            
            // Special case: if we're in a contentEditable element within a table structure
            if (!inTableCellEditor) {
                let parent = view.dom.parentElement;
                while (parent && parent !== activeDocument.body) {
                    const parentClasses = Array.from(parent.classList);
                    if (parentClasses.some(cls => cls.includes('table') || cls.includes('cell'))) {
                        inTableCellEditor = true;
                        break;
                    }
                    parent = parent.parentElement;
                }
            }
            
            // Debug logging


            // Get the line start and end positions
            let lineStart: number, lineEnd: number;
            
            if (inTableCellEditor) {
                // In table cell: find the boundaries of the current line within the cell

                lineStart = this.findTableCellLineBoundary(view, cursorPos, true);
                lineEnd = this.findTableCellLineBoundary(view, cursorPos, false);
            } else {
                // Regular text: use standard line detection

                const line = view.state.doc.lineAt(cursorPos);
                lineStart = line.from;
                lineEnd = line.to;
            }
            


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

                // Check if the addition is inside a comment node
                let additionIsInComment = false;
                if (additionIsInCurrentLine) {
                    syntaxTree(view.state).iterate({
                        from: from,
                        to: to,
                        enter(node) {
                            if (node.name.contains('comment')) {
                                additionIsInComment = true;
                            }
                        }
                    });
                }
                


                if (fixIMEProblem) {
                    needImeFix = true;
                    if (additionIsInCurrentLine && cursorPos > to) {
                        let gapString = view.state.sliceDoc(to, cursorPos);
                        let strBeforeAdd = view.state.sliceDoc(lineStart, from);

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