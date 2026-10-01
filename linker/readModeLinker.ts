import { App, getLinkpath, MarkdownPostProcessorContext, MarkdownRenderChild, TFile } from 'obsidian';

import { LinkerPluginSettings } from '../main';
import { hasExcludedExtension, LinkerCache, MatchType, PrefixTree, scoreFuzzyWindow } from './linkerCache';
import { VirtualMatch, isLinkingDisabledInNote } from './virtualLinkDom';
import { parseInternalLinkSyntax } from './virtualLinkMatch';
import IntervalTree from '@flatten-js/interval-tree';

// Import LinkerPlugin type - using require to avoid circular dependency
type LinkerPluginType = import('../main').default;

export class GlossaryLinker extends MarkdownRenderChild {
    ctx: MarkdownPostProcessorContext;
    app: App;
    settings: LinkerPluginSettings;
    linkerCache: LinkerCache;

    /**
     * Read mode renders a note as several independent blocks, and this post
     * processor runs once per block with its own instance, so the "already
     * linked" bookkeeping used to restart for every block: `onlyLinkOnce`
     * linked the same note again in each paragraph, and real links collected
     * from an earlier block were forgotten by later ones.
     *
     * Sharing them per file fixes that. The window is short on purpose: the
     * blocks of one render arrive back to back, while a re-render minutes later
     * (an edit, a settings change) must start from scratch, otherwise a stale
     * "already linked" entry would keep new links from ever appearing.
     */
    private static readonly sharedTtlMs = 250;
    private static sharedSets = new Map<string, {
        at: number;
        linkedFiles: Set<TFile>;
        explicitlyLinkedFiles: Set<TFile>;
    }>();

    /** Returns the shared sets for this note, resetting them when stale. */
    private sharedFor(sourcePath: string) {
        const now = Date.now();
        for (const [key, entry] of GlossaryLinker.sharedSets) {
            if (now - entry.at > GlossaryLinker.sharedTtlMs) GlossaryLinker.sharedSets.delete(key);
        }
        const fresh = () => {
            const entry = {
                at: now,
                linkedFiles: new Set<TFile>(),
                explicitlyLinkedFiles: new Set<TFile>(),
            };
            GlossaryLinker.sharedSets.set(sourcePath, entry);
            return entry;
        };
        const existing = GlossaryLinker.sharedSets.get(sourcePath);
        if (!existing) return fresh();
        // Still inside the same render: keep going and extend the window.
        existing.at = now;
        return existing;
    }

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


    /**
     * Recognize bare internal-link syntax (e.g. "a#b", "a#^blockid") as virtual
     * links in read mode. Mirrors liveLinker.findInternalLinkSyntaxMatches, but
     * offsets are relative to the current text node (0-based).
     */
    findInternalLinkSyntaxMatches(text: string, currentFile: TFile, startId: number): VirtualMatch[] {
        const matches: VirtualMatch[] = [];
        let id = startId;
        // Token parsing is shared with liveLinker via parseInternalLinkSyntax;
        // only the offset base differs (read-mode offsets are relative to the
        // current text node).
        for (const tok of parseInternalLinkSyntax(this.app, text, currentFile)) {
            matches.push(
                new VirtualMatch(
                    id++,
                    tok.displayText,
                    tok.index + tok.prefixCut,
                    tok.index + tok.length,
                    [tok.dest],
                    MatchType.Header,
                    false,
                    this.settings,
                    this.plugin,
                    tok.headerId
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
    disambiguateFilesByContextReadMode(
        files: TFile[],
        textNode: Node,
        offset: number
    ): { files: TFile[]; distances: Map<string, number> } {
        // Carry the distance out too: when disambiguation does not narrow to one
        // candidate, [1|2|3] uses it to order within the same tier (the note
        // mentioned nearer in the body ranks first).
        const distances = new Map<string, number>();
        if (files.length <= 1 || !textNode) return { files, distances };

        // Context scope = the whole document (all text before the match position
        // within the current render container). It used to look only at the current
        // block element (P/LI/TD/TH); now it widens to the whole document under the
        // rule "whoever is mentioned in the article gets more weight".
        const context = this.getTextBeforeNode(this.containerEl, textNode, offset).toLowerCase();
        if (context.trim().length === 0) return { files, distances };

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

        for (const s of scored) {
            if (Number.isFinite(s.distance)) distances.set(s.file.path, s.distance);
        }

        const hits = scored.filter((s) => Number.isFinite(s.distance));
        if (hits.length === 0) return { files, distances };

        const minDist = Math.min(...hits.map((s) => s.distance));
        const winners = hits.filter((s) => s.distance === minDist);
        if (winners.length === 1) {
            return { files: [winners[0].file], distances };
        }
        return { files, distances };
    }

    /**
     * Read-mode disambiguation rebuilds the document text preceding a match by
     * walking the container's text nodes, i.e. O(document) per match - a long
     * note with many heading hits pays that walk once per hit. The DOM is not
     * mutated while a text node's matches are being collected (rendering
     * happens afterwards), so the walk result is identical for every match
     * inside the same text node: cache it keyed by node and pay the walk once
     * per node. Nodes are only queried during their own collection window and
     * are removed right after, so entries never go stale.
     */
    private contextPrefixCache = new Map<Node, { prefix: string; found: boolean }>();

    /**
     * Reconstruct the text content of a block element that precedes a given
     * text node position, by walking the block's text nodes in document order.
     */
    private getTextBeforeNode(blockEl: Element, targetNode: Node, targetOffset: number): string {
        let entry = this.contextPrefixCache.get(targetNode);
        if (!entry) {
            let prefix = '';
            let found = false;
            const walker = activeDocument.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
                if (node === targetNode) {
                    found = true;
                    break;
                }
                prefix += node.textContent || '';
            }
            entry = { prefix, found };
            this.contextPrefixCache.set(targetNode, entry);
        }
        if (!entry.found) return entry.prefix;
        return entry.prefix + (targetNode.textContent || '').slice(0, targetOffset);
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

        // Per-note disable: the note declares it renders no virtual link (a tag or
        // a frontmatter property - which one is decided by linkIgnoreMode).
        const ignoreFile = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
        if (ignoreFile instanceof TFile && isLinkingDisabledInNote(ignoreFile, this.app, this.settings)) {
            this.clearExistingLinks();
            return;
        }

        // The prefix tree is built asynchronously (in chunks); on first load
        // it is still empty when this post-processor runs, so nothing matches.
        // Wait for the initial build and re-render once it finishes — otherwise
        // paragraphs and table cells stay unlinked until the next edit.
        if (!this.linkerCache.cache.isReady) {
            void this.linkerCache.cache.readyPromise?.then(() => {
                this.clearExistingLinks();
                this.onload();
            });
            return;
        }

        const tags = ['p', 'li', 'td', 'th', 'span', 'em', 'strong', 'mark', 'del', 's'];
        if (this.settings.allowLinksInHeaders) {
            tags.push('h1', 'h2', 'h3', 'h4', 'h5', 'h6');
        }

        // Shared with the other blocks of this same note - see sharedFor(). The
        // blocks are processed one by one, so "already linked" has to survive
        // from one block to the next, or onlyLinkOnce would link the same note
        // again in every paragraph.
        const shared = this.sharedFor(this.ctx.sourcePath);
        const linkedFiles = shared.linkedFiles;
        const explicitlyLinkedFiles = shared.explicitlyLinkedFiles;

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
                        const text = childNode.textContent || '';
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
                            // Also look whenever a keyword ENDS here - see the
                            // matching comment in liveLinker: without this, a
                            // keyword followed by another letter (the normal case
                            // in CJK text) was never examined at all.
                            if (this.settings.matchAnyPartsOfWords || this.settings.matchBeginningOfWords || isWordBoundary
                                || this.linkerCache.cache.hasWordEnd()) {
                                const sourceFile = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
                                const currentFile =
                                    this.settings.excludeLinksToOwnNote && sourceFile instanceof TFile
                                        ? sourceFile
                                        : null;
                                const currentNodes = this.linkerCache.cache.getCurrentMatchNodes(
                                    i,
                                    currentFile,
                                    undefined,
                                    // The heading "must not link to its own note"
                                    // rule takes the note being rendered - the
                                    // active file is a different note whenever
                                    // one is previewing another.
                                    sourceFile instanceof TFile ? sourceFile : null
                                );
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

                                        // Several notes can share one keyword, and all of them are handed
                                        // to the VirtualMatch below: it picks the target for the link
                                        // itself and offers the rest through the references popover.
                                        // With context disambiguation on, the ordering above has already
                                        // sorted them by how close each is mentioned in the text.

                                        // Context-aware disambiguation in read mode.
                                        let files = Array.from(node.files).filter(file => {
                                            return !hasExcludedExtension(file.path, this.settings.excludedExtensions);
                                        });
                                        if (files.length === 0) return;
                                        let ctxDistances: Map<string, number> | undefined;
                                        if (
                                            this.settings.enableContextDisambiguation &&
                                            node.type === MatchType.Header &&
                                            files.length > 1
                                        ) {
                                            const ctx = this.disambiguateFilesByContextReadMode(files, childNode, nFrom);
                                            files = ctx.files;
                                            ctxDistances = ctx.distances;
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

                                            // Hand the context distance to the render layer:
                                            // targets in the same tier are ordered by
                                            // "mentioned nearer in the body first".
                                            if (ctxDistances) {
                                                for (const [p, d] of ctxDistances) match.setFileContextDistance(p, d);
                                            }

                                            // A hit on a keyword that only exists because it
                                            // was normalised (stemmed / function words /
                                            // heading number stripped) is an exact tree match
                                            // but not what the user wrote verbatim - colour it
                                            // as fuzzy.
                                            if (this.linkerCache.cache.isDerivedKeyword(name)) {
                                                match.isFuzzy = true;
                                            }

                                            // Add multi-file heading ID handling logic
                                            // When multiple files match the same keyword, get corresponding heading ID for each file
                                            if (node.files.size > 1) {
                                                node.files.forEach(file => {
                                                    // Prefer the per-file heading map (mirror of
                                                    // liveLinker): keyed by file path, so it can
                                                    // never return another file's heading.
                                                    const ownHeaderId = this.linkerCache.cache.getFileHeaderId(file, name);
                                                    if (ownHeaderId) {
                                                        match.setFileHeaderId(file, ownHeaderId);
                                                        return;
                                                    }
                                                    // renderedFile = null - heading id
                                                    // lookup, not a render decision.
                                                    const fileNodes = this.linkerCache.cache.getCurrentMatchNodes(
                                                        i,
                                                        null, // Do not exclude any files
                                                        file, // Only get nodes for specific file
                                                        null
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

                                    // Fuzzy fallback in read mode, mirroring liveLinker:
                                    // when no exact match was found, link the normalized word if its
                                    // similarity to a normalized keyword is above the threshold.
                                    if (currentNodes.length === 0 && this.settings.enableStemming) {
                                        // Skip leading whitespace once — base for the sliding window.
                                        let baseFrom = wordStart;
                                        while (baseFrom < i && /\s/.test(text[baseFrom])) baseFrom++;
                                        const rawWord = text.slice(baseFrom, i);
                                        if (rawWord.trim().length > 0) {
                                            // Sliding window: try the whole run first, then drop one
                                            // leading character at a time. Chinese has no spaces, so a
                                            // term is usually glued to the text before it and those extra
                                            // characters dilute the similarity below the threshold.
                                            const maxOffset = this.settings.fuzzySlidingWindow
                                                ? Math.min(rawWord.length - 1, this.settings.fuzzySlidingWindowMaxOffset)
                                                : 0;
                                            // Score EVERY window position first and keep the most
                                            // similar one. "Stop at the first hit" picks the LONGEST
                                            // candidate instead of the best one, e.g. "被苏霍姆林斯"
                                            // (71%) over "苏霍姆林斯" (83%), padding the link with
                                            // an unrelated leading character. The loop itself is
                                            // shared with liveLinker via scoreFuzzyWindow.
                                            const scored = scoreFuzzyWindow({
                                                cache: this.linkerCache.cache,
                                                settings: this.settings,
                                                text,
                                                baseFrom,
                                                endPos: i,
                                                rawWord,
                                                maxOffset,
                                                isWordBoundary,
                                                excludeFile: currentFile,
                                                renderedFile: sourceFile instanceof TFile ? sourceFile : null,
                                                isCovered: (checkFrom, checkTo) => {
                                                    // Read-mode matches use text-node-relative offsets.
                                                    for (let k = matches.length - 1; k >= 0; k--) {
                                                        const prev = matches[k];
                                                        if (prev.isFuzzy) continue;
                                                        if (prev.to <= checkFrom) break;
                                                        if (prev.from < checkTo) return true;
                                                    }
                                                    return false;
                                                },
                                            });
                                            const bestOffset = scored?.bestOffset ?? -1;
                                            const bestResults = scored?.bestResults ?? null;

                                            // Emit only for the winning window position. The
                                            // body runs at most once (the old for loop had a
                                            // one-shot condition plus an unconditional trailing
                                            // break); a labeled block keeps its inner
                                            // continue/break exits valid without pretending to
                                            // iterate.
                                            if (bestOffset >= 0) {
                                                emitWinner: {
                                                const offset = bestOffset;
                                                const rawCandidate = rawWord.slice(offset);
                                                // (Avoid String#trimStart: it needs ES2019, while the
                                                //  project's tsconfig lib only goes up to ES7.)
                                                const leadWs = rawCandidate.length - rawCandidate.replace(/^\s+/, '').length;
                                                const candidate = rawCandidate.trim();
                                                if (!candidate) break emitWinner;
                                                if (candidate.length < this.linkerCache.cache.minFuzzyKeywordLen - 2) break emitWinner;
                                                if (candidate.length > this.linkerCache.cache.maxFuzzyKeywordLen * 2 + 4) break emitWinner;
                                                // The winning offset was already normalized, length-checked
                                                // and matched by the scoring loop above (mirror of
                                                // liveLinker), so reuse those results instead of paying
                                                // for fuzzyNormalize plus a bucket scan a second time.
                                                const fuzzyResults = bestResults ?? [];
                                                if (fuzzyResults.length > 0) {
                                                    // Results are sorted best-first. Merge every candidate TIED at the
                                                    // top similarity into one multi-target link instead of arbitrarily
                                                    // picking one — e.g. "科目二冲刺带背" ties across "…带背1".."…带背7",
                                                    // all at 87.5%, so the user gets [1][2]…[7] to choose from.
                                                    const topSim = fuzzyResults[0].similarity;
                                                    const mergedFiles: TFile[] = [];
                                                    const seenPaths = new Set<string>();
                                                    // Remember each file's OWN heading id (mirror of
                                                    // liveLinker). The constructor stamps the top
                                                    // result's headerId onto every target, which makes
                                                    // later targets jump to an anchor absent from them.
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

                                                    const fFrom = baseFrom + offset + leadWs;
                                                    const fTo = i;
                                                    const fName = text.slice(fFrom, fTo);

                                                    // Mirror of liveLinker's guard: a fuzzy
                                                    // match must not cover a range an exact
                                                    // match already claimed, otherwise the
                                                    // exact "苏霍姆林斯基" gets swallowed by
                                                    // the longer fuzzy "被苏霍姆林斯基之女".
                                                    let coveredByExact = false;
                                                    for (let k = matches.length - 1; k >= 0; k--) {
                                                        const prev = matches[k];
                                                        if (prev.isFuzzy) continue;
                                                        if (prev.to <= fFrom) break;
                                                        if (prev.from < fTo) { coveredByExact = true; break; }
                                                    }
                                                    if (coveredByExact) break emitWinner;

                                                    const filteredFiles = mergedFiles.filter(file => {
                                                        return !hasExcludedExtension(file.path, this.settings.excludedExtensions);
                                                    });
                                                    if (filteredFiles.length > 0) {
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
                                                            fFrom,
                                                            fTo,
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
                                                                // Mirror of liveLinker: prefer this file's own
                                                                // fuzzy heading id, tree lookup only as fallback.
                                                                const ownHeaderId = fuzzyFileHeaderIds.get(file.path);
                                                                if (ownHeaderId) {
                                                                    virtualMatch.setFileHeaderId(file, ownHeaderId);
                                                                    return;
                                                                }
                                                                // renderedFile = null - heading id lookup, not a render decision.
                                                                const fileNodes = this.linkerCache.cache.getCurrentMatchNodes(i, null, file, null);
                                                                if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                                                                    virtualMatch.setFileHeaderId(file, fileNodes[0].headerId);
                                                                }
                                                            });
                                                        }

                                                        matches.push(virtualMatch);
                                                        break emitWinner;
                                                    }
                                                }
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
                                    // for(;;) rather than while(true) — the latter trips no-constant-condition.
                                    for (;;) {
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
                                // First hand the "files linked so far" snapshot to this
                                // sort (excluding its own batch, otherwise every
                                // candidate would think it is already linked), then
                                // render, and only then add itself to the set.
                                match.setAlreadyLinkedFiles(new Set(linkedFiles));

                                const span = match.getCompleteLinkElement();

                                match.files.forEach((f) => linkedFiles.add(f));

                                // > lastTo, not > 0: two adjacent matches leave an
                                // empty slice, and inserting it would add an empty
                                // text node into the DOM for no reason.
                                if (match.from > lastTo) {
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