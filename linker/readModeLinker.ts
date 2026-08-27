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
        const regex = /(?:^|(?<![[\w]))((?:(?!\[\[)[^\s[\]#])+)(#(?:[^\s[\]]+)?)+/g;
        let m: RegExpExecArray | null;
        let id = startId;
        while ((m = regex.exec(text)) !== null) {
            const full = m[0];
            if (full.startsWith('[[')) continue;

            const hashIdx = full.indexOf('#');
            if (hashIdx <= 0) continue;
            const notePart = full.slice(0, hashIdx);
            const anchorPart = full.slice(hashIdx + 1);

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
                    full,
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
     * Simplified context-aware disambiguation for read mode. When a heading
     * exists in multiple notes, prefer the note whose file name (or alias)
     * appears in the current block-level element (p/li/td). Read mode processes
     * DOM text nodes, so we approximate "current paragraph" with the nearest
     * block element's text content.
     */
    disambiguateFilesByContextReadMode(files: TFile[], startEl: Element | null): TFile[] {
        if (files.length <= 1 || !startEl) return files;

        let blockEl: Element | null = startEl;
        while (blockEl && !['P', 'LI', 'TD', 'TH'].includes(blockEl.tagName)) {
            blockEl = blockEl.parentElement;
        }
        const context = (blockEl?.textContent || '').toLowerCase();
        if (context.trim().length === 0) return files;

        const appearing = files.filter((file) => {
            const names = [file.basename];
            const cache = this.app.metadataCache.getFileCache(file);
            const rawAliases: unknown = cache?.frontmatter?.aliases;
            const aliases: unknown[] = Array.isArray(rawAliases) ? rawAliases : [];
            for (const alias of aliases) {
                if (typeof alias === 'string') names.push(alias);
            }
            return names.some((n) => n.length >= 2 && context.includes(n.toLowerCase()));
        });

        return appearing.length === 1 ? [appearing[0]] : files;
    }

    onload() {
        if (!this.settings.linkerActivated) {
            this.clearExistingLinks();
            return;
        }

        const tags = ['p', 'li', 'td', 'th', 'span', 'em', 'strong', 'mark', 'del', 's'];

        // TODO: Onload is called on the divs separately, so these sets are not stored between divs.
        // Since divs can be rendered in arbitrary order, storing information about already linked files is not easy.
        const linkedFiles = new Set<TFile>();
        const explicitlyLinkedFiles = new Set<TFile>();

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

                for (let childNodeIndex = 0; childNodeIndex < item.childNodes.length; childNodeIndex++) {
                    const childNode = item.childNodes[childNodeIndex];

                    if (childNode.nodeType === Node.TEXT_NODE) {
                        let text = childNode.textContent || '';
                        if (text.length === 0) continue;

                        this.linkerCache.reset();
                        let matches: VirtualMatch[] = [];

                        let id = 0;

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
                                        let files = Array.from(node.files);
                                        if (
                                            this.settings.enableContextDisambiguation &&
                                            node.type === MatchType.Header &&
                                            files.length > 1
                                        ) {
                                            files = this.disambiguateFilesByContextReadMode(files, childNode.parentElement);
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
                                }

                                // Push the char to get the next nodes in the prefix tree
                                this.linkerCache.cache.pushChar(char);
                                i += char.length;
                            }

                            // Recognize bare internal-link syntax in read mode.
                            if (this.settings.enableInternalLinkSyntax) {
                                const sourceFile = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
                                if (sourceFile instanceof TFile) {
                                    const internalMatches = this.findInternalLinkSyntaxMatches(text, sourceFile, id);
                                    if (internalMatches.length > 0) {
                                        matches = matches.concat(internalMatches);
                                        id += internalMatches.length;
                                    }
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

                            const parent = childNode.parentElement;
                            let lastTo = 0;
                            // console.log("Parent: ", parent);


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
                            childNodeIndex += 1;
                        }
                    }
                }
            }
        }
}