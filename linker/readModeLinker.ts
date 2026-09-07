import { App, getLinkpath, MarkdownPostProcessorContext, MarkdownRenderChild, TFile } from 'obsidian';

import { LinkerPluginSettings } from '../main';
import { LinkerCache, MatchType, PrefixTree } from './linkerCache';
import { VirtualMatch } from './virtualLinkDom';
import IntervalTree from '@flatten-js/interval-tree';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('../main').default;

export class GlossaryLinker extends MarkdownRenderChild {
    ctx: MarkdownPostProcessorContext;
    app: App;
    settings: LinkerPluginSettings;
    linkerCache: LinkerCache;

    private clearExistingLinks() {
        // Restore virtual links to original text
        const virtualLinks = this.containerEl.querySelectorAll('.virtual-link');
        virtualLinks.forEach(link => {
            // Get original text: first try origin-text attribute, otherwise use link's text content
            const anchor = link.querySelector('.virtual-link-a');
            const originalText = anchor?.getAttribute('origin-text') || anchor?.textContent || '';
            if (originalText) {
                // Replace virtual link element with text node
                const textNode = activeDocument.createTextNode(originalText);
                link.replaceWith(textNode);
            } else {
                // If no text found, directly delete
                link.remove();
            }
        });
    }

    constructor(app: App, settings: LinkerPluginSettings, context: MarkdownPostProcessorContext, containerEl: HTMLElement, public plugin: LinkerPluginType) {
        super(containerEl);
        this.settings = settings;
        this.app = app;
        this.ctx = context;

        this.linkerCache = LinkerCache.getInstance(app, settings);

        this.load();
    }

    getClosestLinkPath(glossaryName: string): TFile | null {
        const destName = this.ctx.sourcePath.replace(/(.*).md/, '$1');
        let currentDestName = destName;

        let currentPath = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(glossaryName), currentDestName);

        if (currentPath == null) return null;

        while (currentDestName.includes('/')) {
            currentDestName = currentDestName.replace(/\/[^/]*?$/, '');

            const newPath = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(glossaryName), currentDestName);

            if ((newPath?.path?.length || 0) > currentPath?.path?.length) {
                currentPath = newPath;
                break;
            }
        }

        return currentPath;
    }

    /**
     * Recognize bare internal-link syntax (e.g. "a#b", "a#^blockid") as virtual
     * links in read mode. Mirrors liveLinker.findInternalLinkSyntaxMatches, but
     * offsets are relative to the current text node (0-based).
     */
    findInternalLinkSyntaxMatches(text: string, currentFile: TFile, startId: number): VirtualMatch[] {
        const matches: VirtualMatch[] = [];
        const regex = /(?:^|(?<![[\w]))((?:(?!\[\[)[^\s[\]|#])+)(#(?:[^\s[\]|]+)?)+(?:\|([^\s[\]|]+))?/g;
        let m: RegExpExecArray | null;
        let id = startId;
        while ((m = regex.exec(text)) !== null) {
            const full = m[0];
            if (full.startsWith('[[')) continue;

            // Split optional display alias: `a#b|别名` → target "a#b", display "别名".
            let targetPart = full;
            let displayText = full;
            const pipeIdx = full.indexOf('|');
            if (pipeIdx > 0) {
                targetPart = full.slice(0, pipeIdx);
                const alias = full.slice(pipeIdx + 1);
                if (alias) displayText = alias;
            }

            const hashIdx = targetPart.indexOf('#');
            if (hashIdx <= 0) continue;
            const notePart = targetPart.slice(0, hashIdx);
            const anchorPart = targetPart.slice(hashIdx + 1);

            const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(notePart), currentFile.path);
            if (!dest) continue;

            const blockIdx = anchorPart.indexOf('^');
            const headingPath = blockIdx === -1 ? anchorPart : anchorPart.slice(0, blockIdx);
            const blockId = blockIdx === -1 ? undefined : anchorPart.slice(blockIdx + 1);

            let headerId: string | undefined;
            const headings = this.app.metadataCache.getFileCache(dest)?.headings ?? [];

            if (blockId) {
                headerId = '^' + blockId;
            } else if (headingPath && headings.length > 0) {
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

            matches.push(
                new VirtualMatch(
                    id++,
                    displayText,
                    m.index,
                    m.index + full.length,
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

    /**
     * Context-aware disambiguation for read mode, matching liveLinker's
     * "nearest mention" algorithm. When a heading exists in multiple notes,
     * prefer the note whose file name (or alias) appears closest to the match
     * within the current block element (p/li/td/th). Read mode operates on DOM
     * text nodes, so we walk the block's text nodes to reconstruct the text
     * that precedes the match position.
     */
    disambiguateFilesByContextReadMode(files: TFile[], textNode: Node, offset: number): TFile[] {
        if (files.length <= 1 || !textNode) return files;

        let blockEl: Element | null = textNode.parentElement;
        while (blockEl && !['P', 'LI', 'TD', 'TH'].includes(blockEl.tagName)) {
            blockEl = blockEl.parentElement;
        }
        if (!blockEl) return files;

        const context = this.getTextBeforeNode(blockEl, textNode, offset).toLowerCase();
        if (context.trim().length === 0) return files;

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
                if (lower.length < 2) continue;
                const idx = context.lastIndexOf(lower);
                if (idx === -1) continue;
                const distance = context.length - (idx + lower.length);
                if (distance < closestDistance) closestDistance = distance;
            }
            return { file, distance: closestDistance };
        });

        const hits = scored.filter((s) => Number.isFinite(s.distance));
        if (hits.length === 0) return files;

        const minDist = Math.min(...hits.map((s) => s.distance));
        const winners = hits.filter((s) => s.distance === minDist);
        if (winners.length === 1) {
            return [winners[0].file];
        }
        return files;
    }

    /**
     * Reconstruct the text content of a block element that precedes a given
     * text node position, by walking the block's text nodes in document order.
     */
    private getTextBeforeNode(blockEl: Element, targetNode: Node, targetOffset: number): string {
        let result = '';
        const walker = activeDocument.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
            if (node === targetNode) {
                result += (node.textContent || '').slice(0, targetOffset);
                break;
            }
            result += node.textContent || '';
        }
        return result;
    }

    onload() {
        if (!this.settings.linkerActivated) {
            this.clearExistingLinks();
            return;
        }

        // Skip files whose folder is in "excluded directories for generating
        // virtual links" (source-side exclusion), mirroring liveLinker.
        const excludedFolders = this.settings.excludedDirectoriesForLinking;
        if (excludedFolders.length > 0) {
            const sourceFile = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
            const parentPath = sourceFile?.parent?.path ?? '';
            if (excludedFolders.includes(parentPath)) {
                this.clearExistingLinks();
                return;
            }
        }

        const tags = ['p', 'li', 'td', 'th', 'span', 'em', 'strong', 'mark', 'del', 's'];
        if (this.settings.allowLinksInHeaders) {
            tags.push('h1', 'h2', 'h3', 'h4', 'h5', 'h6');
        }

        // TODO: Onload is called on the divs separately, so these sets are not stored between divs.
        // Since divs can be rendered in arbitrary order, storing information about already linked files is not easy.
        const linkedFiles = new Set<TFile>();
        const explicitlyLinkedFiles = new Set<TFile>();

        // Collect files already linked by real [[...]] links so excludeLinksToRealLinkedFiles
        // works in read mode. Live mode parses these from the syntax tree; read mode parses
        // the rendered <a class="internal-link"> elements instead (before we insert any
        // virtual links below).
        const realLinks = this.containerEl.querySelectorAll('a.internal-link');
        realLinks.forEach((a) => {
            const href = a.getAttribute('href') || '';
            if (!href) return;
            const target = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(href), this.ctx.sourcePath);
            if (target) explicitlyLinkedFiles.add(target);
        });

        for (const tag of tags) {
            // Snapshot the live HTMLCollection before mutating the DOM. As we
            // process text nodes we insert new <span> elements (virtual links);
            // without a snapshot those would keep growing the collection and
            // cause an infinite loop (see issue #13).
            const nodeList = Array.from(this.containerEl.getElementsByTagName(tag));
            for (let index = 0; index <= nodeList.length; index++) {
                const item: Element | null = index === nodeList.length ? this.containerEl : (nodeList[index] ?? null);

                // Skip elements already wrapped inside a generated virtual link,
                // otherwise we would re-process the text we just linked.
                if (!item || item.closest('.virtual-link')) {
                    continue;
                }

                // When header links are disabled, skip any element inside a heading
                // (span/em/strong within h1-h6) so headers are fully excluded,
                // matching liveLinker's allowLinksInHeaders behavior.
                if (!this.settings.allowLinksInHeaders && item.closest('h1,h2,h3,h4,h5,h6')) {
                    continue;
                }

                // Snapshot the direct child nodes too. During processing we
                // insert replacement spans/text before each text node and then
                // remove the original, which would otherwise mutate the live
                // NodeList mid-iteration (same class of bug as issue #13).
                const childNodes = Array.from(item.childNodes);
                for (let childNodeIndex = 0; childNodeIndex < childNodes.length; childNodeIndex++) {
                    const childNode = childNodes[childNodeIndex];

                    if (childNode.nodeType === Node.TEXT_NODE) {
                        let text = childNode.textContent || '';
                        if (text.length === 0) continue;

                        this.linkerCache.reset();
                        let matches: VirtualMatch[] = [];

                        let id = 0;
                        let wordStart = 0; // start offset of the current document word

                        // Iterate over every char in the text
                        for (let i = 0; i <= text.length; i) {
                            // Do this to get unicode characters as whole chars and not only half of them
                            const codePoint = text.codePointAt(i)!;
                            const char = i < text.length ? String.fromCodePoint(codePoint) : '\n';

                            // If we are at a word boundary, get the current fitting files
                            const isWordBoundary = PrefixTree.checkWordBoundary(char); // , this.settings.wordBoundaryRegex
                            if (this.settings.matchAnyPartsOfWords || this.settings.matchBeginningOfWords || isWordBoundary) {
                                const sourceFile = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
                                const currentFile =
                                    this.settings.excludeLinksToOwnNote && sourceFile instanceof TFile
                                        ? sourceFile
                                        : null;
                                const currentNodes = this.linkerCache.cache.getCurrentMatchNodes(i, currentFile);
                                if (currentNodes.length > 0) {
                                    currentNodes.forEach((node) => {
                                        // Check if we want to include this note based on the settings
                                        if (!this.settings.matchAnyPartsOfWords) {
                                            if (
                                                this.settings.matchBeginningOfWords &&
                                                !node.startsAtWordBoundary &&
                                                this.settings.matchEndOfWords &&
                                                !isWordBoundary
                                            ) {
                                                return;
                                            }
                                        }

                                        const nFrom = node.start;
                                        const nTo = node.end;
                                        const name = text.slice(nFrom, nTo);

                                        // TODO: Handle multiple files

                                        // Context-aware disambiguation in read mode.
                                        let files = Array.from(node.files).filter(file => {
                                            return !this.settings.excludedExtensions.some(ext =>
                                                file.path.toLowerCase().endsWith(ext.toLowerCase())
                                            );
                                        });
                                        if (files.length === 0) return;
                                        if (
                                            this.settings.enableContextDisambiguation &&
                                            node.type === MatchType.Header &&
                                            files.length > 1
                                        ) {
                                            files = this.disambiguateFilesByContextReadMode(files, childNode, nFrom);
                                        }

                                        // Ensure headerId is correctly passed when matching headings
                                        const headerId = node.type === MatchType.Header 
                                            ? node.headerId
                                            : undefined;
                                            const match = new VirtualMatch(
                                                id++,
                                                name,
                                                nFrom,
                                                nTo,
                                                files,
                                                node.type,
                                                !isWordBoundary,
                                                this.settings,
                                                this.plugin, // Add plugin parameter
                                                headerId
                                            );

                                            // Add multi-file heading ID handling logic
                                            // When multiple files match the same keyword, get corresponding heading ID for each file
                                            if (node.files.size > 1) {
                                                node.files.forEach(file => {
                                                    const fileNodes = this.linkerCache.cache.getCurrentMatchNodes(
                                                        i,
                                                        null, // Do not exclude any files
                                                        file  // Only get nodes for specific file
                                                    );
                                                    if (fileNodes.length > 0 && fileNodes[0].headerId) {
                                                        match.setFileHeaderId(file, fileNodes[0].headerId);
                                                    }
                                                });
                                            }
                                        
                                            // Check parent elements for format context
                                            const parentEl = childNode.parentElement;
                                            if (parentEl) {
                                                const hasSelector = (selector: string) => {
                                                    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Native DOM methods trigger false positive
                                                    return parentEl.matches(selector) || parentEl.closest(selector) !== null;
                                                };
                                                match.isBoldContext = hasSelector('strong');
                                                match.isItalicContext = hasSelector('em');
                                                match.isHighlightContext = hasSelector('mark');
                                                match.isStrikethroughContext = hasSelector('del') || hasSelector('s');
                                                match.isCommentContext = hasSelector('.cm-comment');
                                                match.isTripleStarContext = match.isBoldContext && 
                                                    match.isItalicContext;
                                            }
                                        
                                            matches.push(match);
                                        });
                                    }

                                    // Fuzzy (词义模糊) fallback in read mode, mirroring liveLinker:
                                    // when no exact match was found, link the normalized word if its
                                    // similarity to a normalized keyword is above the threshold.
                                    if (currentNodes.length === 0 && this.settings.enableStemming) {
                                        const rawWord = text.slice(wordStart, i).trim();
                                        if (rawWord.length > 0) {
                                            const normWord = this.linkerCache.cache.fuzzyNormalize(rawWord, this.settings.stemmingLanguage);
                                            if (normWord) {
                                                const fuzzyResults = this.linkerCache.cache.findFuzzyMatches(normWord, this.settings.fuzzyMatchThreshold, currentFile);
                                                for (const fr of fuzzyResults) {
                                                    let fFrom = wordStart;
                                                    const fTo = i;
                                                    while (fFrom < fTo && /\s/.test(text[fFrom])) fFrom++;
                                                    const fName = text.slice(fFrom, fTo);

                                                    const filteredFiles = Array.from(fr.files).filter(file => {
                                                        return !this.settings.excludedExtensions.some(ext =>
                                                            file.path.toLowerCase().endsWith(ext.toLowerCase())
                                                        );
                                                    });
                                                    if (filteredFiles.length === 0) continue;

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
                                                        fFrom,
                                                        fTo,
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

                                // Push the char to get the next nodes in the prefix tree
                                if (isWordBoundary) wordStart = i;
                                this.linkerCache.cache.pushChar(char);
                                i += char.length;
                            }

                            // Recognize bare internal-link syntax in read mode. These
                            // matches are collected separately and re-joined after
                            // filterOverlapping, mirroring liveLinker: their ranges are
                            // added to the exclusion tree so a prefix-tree partial match
                            // inside them is dropped instead of competing.
                            let internalMatches: VirtualMatch[] = [];
                            if (this.settings.enableInternalLinkSyntax) {
                                const sourceFile = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
                                if (sourceFile instanceof TFile) {
                                    internalMatches = this.findInternalLinkSyntaxMatches(text, sourceFile, id);
                                    id += internalMatches.length;
                                }
                            }

                            // Sort additions by from position
                            matches = VirtualMatch.sort(matches);

                            // Exclude text between custom start/end symbols (e.g. { ... })
                            // from virtual linking in read mode, mirroring live preview.
                            // Offsets here are relative to this text node, the same
                            // coordinate space as each VirtualMatch's from/to.
                            let excludedIntervalTree: IntervalTree | undefined;
                            if (this.settings.enableSymbolExclusion) {
                                excludedIntervalTree = new IntervalTree();
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
                                        const rangeEnd = endIdx === -1 ? text.length : endIdx + endSym.length;
                                        excludedIntervalTree.insert([startIdx, rangeEnd]);
                                        searchFrom = startIdx + startSym.length;
                                    }
                                }
                            }

                            // Exclude successfully-parsed internal-link syntax ranges from
                            // prefix-tree matching (same as liveLinker), so "note#heading"
                            // fully replaces a partial "note" match.
                            for (const im of internalMatches) {
                                if (!excludedIntervalTree) excludedIntervalTree = new IntervalTree();
                                excludedIntervalTree.insert([im.from, im.to]);
                            }

                            // Delete additions that links to already linked files
                            if (this.settings.excludeLinksToRealLinkedFiles) {
                                matches = VirtualMatch.filterAlreadyLinked(matches, explicitlyLinkedFiles);
                            }

                            // Delete additions that links to already linked files
                            if (this.settings.onlyLinkOnce) {
                                matches = VirtualMatch.filterAlreadyLinked(matches, linkedFiles);
                            }
                            // Delete additions that overlap
                            // Additions are sorted by from position and after that by length, we want to keep longer additions
                            matches = VirtualMatch.filterOverlapping(matches, this.settings.onlyLinkOnce, excludedIntervalTree);

                            // Re-join the internal-link syntax matches now that prefix-tree
                            // matches inside their ranges have been dropped.
                            if (internalMatches.length > 0) {
                                matches = matches.concat(internalMatches);
                                matches = VirtualMatch.sort(matches);
                            }

                            const parent = childNode.parentElement;
                            let lastTo = 0;

                            matches.forEach((match) => {
                                match.files.forEach((f) => linkedFiles.add(f));

                                const span = match.getCompleteLinkElement();

                                if (match.from > 0) {
                                    parent?.insertBefore(activeDocument.createTextNode(text.slice(lastTo, match.from)), childNode);
                                }

                                parent?.insertBefore(span, childNode);

                                // Check if span is under <mark>, if so add highlight class
                                let markParent = span.parentElement;
                                while (markParent) {
                                    if (markParent.tagName === 'MARK') {
                                        span.classList.add('virtual-link-in-highlight');
                                        break;
                                    }
                                    markParent = markParent.parentElement;
                                }

                                lastTo = match.to;
                            });

                            const textLength = text.length;
                            if (lastTo < textLength) {
                                parent?.insertBefore(activeDocument.createTextNode(text.slice(lastTo)), childNode);
                            }
                            parent?.removeChild(childNode);
                        }
                    }
                }
            }
        }
}