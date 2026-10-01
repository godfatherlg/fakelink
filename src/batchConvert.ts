import { App, MarkdownView, Modal, Notice, Setting, TFile, FuzzySuggestModal } from 'obsidian';
import { LinkerPluginSettings } from '../main';
import { LinkerCache, PrefixTree, MatchType, hasExcludedExtension, scoreFuzzyWindow } from '../linker/linkerCache';
import { VirtualMatch } from '../linker/virtualLinkDom';
import IntervalTree from '@flatten-js/interval-tree';
import { t } from './lang/helpers';

type LinkerPluginType = import('../main').default;

function dirname(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
}

function basename(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

// relative() comes from linker/convertLink so both conversion paths compute
// relative paths with one implementation (and so it is covered by tests).
import { relative } from '../linker/convertLink';

export interface BatchLinkItem {
    from: number;
    to: number;
    displayText: string;
    replacement: string;
    multipleTargets: boolean;
}

/**
 * Scan text (the full content of a note) through LinkerCache — the same trie
 * logic the live linker uses — so we get every virtual link regardless of what
 * is currently rendered in the viewport. This avoids the CodeMirror lazy widget
 * rendering problem. An optional [rangeFrom, rangeTo] restricts results to a
 * selection. Returns items already sorted descending by position.
 */
export function scanVirtualLinks(
    app: App,
    settings: LinkerPluginSettings,
    plugin: LinkerPluginType | null,
    text: string,
    sourcePath: string,
    rangeFrom?: number,
    rangeTo?: number
): BatchLinkItem[] {
    const cache = LinkerCache.getInstance(app, settings);
    const cacheTree = cache.cache;

    const excludedExtensions = settings.excludedExtensions;
    // The note being scanned. It is the "rendered" note for the match calls
    // below, so per-note exclusion (frontmatter opt-in / exclude list) is
    // evaluated against IT.
    //
    // ownNote is a different thing: it is only what self-links are filtered
    // against, and stays null unless that setting is on. Passing ownNote as the
    // rendered file made both exclusions no-op whenever that setting was off,
    // so a scan could list links the editor never shows.
    const sourceNote = app.vault.getAbstractFileByPath(sourcePath) as TFile | null;
    const ownNote = settings.excludeLinksToOwnNote ? sourceNote : null;

    cache.reset();
    // Pre-build the regions to skip so a match is rejected with one interval
    // lookup instead of the old O(n) back-scan per candidate.
    const excludedIntervals = buildExcludedIntervals(text);
    const matches: VirtualMatch[] = [];
    let id = 0;
    let wordStart = 0; // start offset of the current document word

    // Iterate over UTF-16 code units so the resulting `from`/`to` offsets match
    // Obsidian's editor offsets (editor.offsetToPos / getRange use code units).
    // Mixing code-point counting with editor code-unit offsets was the root
    // cause of partial conversions and "links not found on second run".
    for (let i = 0; i <= text.length; i++) {
        const char = i < text.length ? text[i] : '\n';
        const isWordBoundary = PrefixTree.checkWordBoundary(char);

        if (settings.matchAnyPartsOfWords || settings.matchBeginningOfWords || isWordBoundary || cacheTree.hasWordEnd()) {
            const currentNodes = cacheTree.getCurrentMatchNodes(i, ownNote, undefined, sourceNote);

            for (const node of currentNodes) {
                if (!settings.matchAnyPartsOfWords) {
                    if (
                        (settings.matchBeginningOfWords && !node.startsAtWordBoundary) &&
                        (settings.matchEndOfWords && !isWordBoundary)
                    ) {
                        continue;
                    }
                }

                let nFrom = node.start;
                let nTo = node.end;
                let name = text.slice(nFrom, nTo);

                // When the match came from a stemmed keyword (e.g. the note
                // "Project" matched the inflected word "projected"), the trie
                // only captured the stem fragment. Expand the range to cover the
                // whole document word so the entire token becomes the link
                // ([[Project]] instead of [[Project]]ed).
                if (node.canonicalKeyword) {
                    let s = nFrom;
                    let e = nTo;
                    while (s > 0 && /[A-Za-z]/.test(text[s - 1])) s--;
                    while (e < text.length && /[A-Za-z]/.test(text[e])) e++;
                    if (e > s) {
                        name = text.slice(s, e);
                        nFrom = s;
                        nTo = e;
                    }
                }

                // Skip matches inside code blocks, frontmatter, inline code, math
                // and existing links (one interval lookup).
                if (excludedIntervals.search([nFrom, nTo]).length > 0) continue;

                // Skip anything that lives inside a table row — converting
                // virtual links in tables is unreliable and often mis-positions
                // the result, so batch conversion leaves tables untouched.
                if (isInTableRow(text, nFrom)) continue;

                if (rangeFrom !== undefined && rangeTo !== undefined) {
                    if (nTo <= rangeFrom || nFrom >= rangeTo) continue;
                }

                const filteredFiles = Array.from(node.files).filter((file: TFile) => {
                    return !hasExcludedExtension(file.path, excludedExtensions);
                });

                if (filteredFiles.length === 0) continue;

                const vm = new VirtualMatch(
                    id++,
                    name,
                    nFrom,
                    nTo,
                    filteredFiles,
                    node.type,
                    !isWordBoundary,
                    settings,
                    plugin!,
                    node.headerId
                );

                // Resolve the correct headerId for EACH target file individually.
                // Passing `node.headerId` to the constructor would wrongly tag every
                // file with the first match's header; instead we look up each file's
                // own header so the generated link points to the right place.
                filteredFiles.forEach((file: TFile) => {
                    // renderedFile = null - heading id lookup, not a render decision.
                    const fileNodes = cacheTree.getCurrentMatchNodes(i, null, file, null);
                    if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                        vm.setFileHeaderId(file, fileNodes[0].headerId);
                    } else {
                        vm.setFileHeaderId(file, '');
                    }
                });

                matches.push(vm);
            }

            // Fuzzy fallback: if no exact match was found and fuzzy matching is
            // enabled, run the same shared sliding-window scorer the live and
            // read linkers use, so the batch preview matches what is rendered
            // in the editor. The old normalize-the-whole-word scan could never
            // produce fuzzySlidingWindow matches inside longer runs (e.g. a
            // Chinese term embedded in a longer sentence), which made the
            // preview disagree with the live view.
            if (currentNodes.length === 0 && settings.enableStemming) {
                // Skip leading whitespace once - it is the base for the
                // sliding window below.
                let baseFrom = wordStart;
                while (baseFrom < i && /\s/.test(text[baseFrom])) baseFrom++;
                const rawWord = text.slice(baseFrom, i);
                if (rawWord.trim().length > 0) {
                    const maxOffset = settings.fuzzySlidingWindow
                        ? Math.min(rawWord.length - 1, settings.fuzzySlidingWindowMaxOffset)
                        : 0;
                    const scored = scoreFuzzyWindow({
                        cache: cacheTree,
                        settings,
                        text,
                        baseFrom,
                        endPos: i,
                        rawWord,
                        maxOffset,
                        isWordBoundary,
                        excludeFile: ownNote,
                        renderedFile: sourceNote,
                        // Batch offsets are absolute (full document), and a
                        // candidate must also be skipped when it lives in an
                        // excluded region, in a table, or outside the
                        // requested selection.
                        isCovered: (checkFrom, checkTo) => {
                            if (excludedIntervals.search([checkFrom, checkTo]).length > 0) return true;
                            if (isInTableRow(text, checkFrom)) return true;
                            if (rangeFrom !== undefined && rangeTo !== undefined) {
                                if (checkTo <= rangeFrom || checkFrom >= rangeTo) return true;
                            }
                            return false;
                        },
                    });
                    const bestOffset = scored?.bestOffset ?? -1;
                    const bestResults = scored?.bestResults ?? null;

                    if (bestOffset >= 0) {
                        emitWinner: {
                        const offset = bestOffset;

                        const rawCandidate = rawWord.slice(offset);
                        const leadWs = rawCandidate.length - rawCandidate.replace(/^\s+/, '').length;
                        const candidate = rawCandidate.trim();
                        if (!candidate) break emitWinner;
                        if (candidate.length < cacheTree.minFuzzyKeywordLen - 2) break emitWinner;
                        if (candidate.length > cacheTree.maxFuzzyKeywordLen * 2 + 4) break emitWinner;

                        const fuzzyResults = bestResults ?? [];
                        if (fuzzyResults.length > 0) {
                            // Tied top results (same similarity) are merged into
                            // one multi-target link, mirroring the live linker.
                            const topSim = fuzzyResults[0].similarity;
                            const mergedFiles: TFile[] = [];
                            const seenPaths = new Set<string>();
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

                            const filteredFiles = mergedFiles.filter((file: TFile) => {
                                return !hasExcludedExtension(file.path, excludedExtensions);
                            });
                            if (filteredFiles.length > 0) {
                                const topFr = fuzzyResults[0];
                                let fuzzyMatchType = MatchType.Note;
                                if (topFr.headerId) {
                                    fuzzyMatchType = MatchType.Header;
                                } else if (topFr.canonical) {
                                    const hasNoteMatch = filteredFiles.some((f) =>
                                        f.basename.toLowerCase() === topFr.canonical!.toLowerCase()
                                    );
                                    if (!hasNoteMatch) fuzzyMatchType = MatchType.Alias;
                                }

                                const vm = new VirtualMatch(
                                    id++,
                                    fName,
                                    fFrom,
                                    fTo,
                                    filteredFiles,
                                    fuzzyMatchType,
                                    false,
                                    settings,
                                    plugin!,
                                    topFr.headerId
                                );
                                vm.isFuzzy = true;

                                // Resolve the correct headerId for EACH target
                                // file individually, same as the exact path.
                                filteredFiles.forEach((file: TFile, index: number) => {
                                    if (index === 0) return;
                                    const ownHeaderId = fuzzyFileHeaderIds.get(file.path);
                                    if (ownHeaderId) {
                                        vm.setFileHeaderId(file, ownHeaderId);
                                        return;
                                    }
                                    // renderedFile = null - heading id lookup, not a render decision.
                                    const fileNodes = cacheTree.getCurrentMatchNodes(i, null, file, null);
                                    if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                                        vm.setFileHeaderId(file, fileNodes[0].headerId);
                                    } else {
                                        vm.setFileHeaderId(file, '');
                                    }
                                });

                                matches.push(vm);
                                break emitWinner;
                            }
                        }
                        }
                    }
                }
            }
        }

        if (isWordBoundary) wordStart = i;
        cacheTree.pushChar(char);
    }

    let sorted = VirtualMatch.sort(matches);
    sorted = VirtualMatch.filterOverlapping(sorted, settings.onlyLinkOnce);

    const items: BatchLinkItem[] = sorted.map((m) => {
        const multipleTargets = m.files.length > 1;
        const replacement = buildReplacement(app, settings, m, sourcePath);
        return {
            from: m.from,
            to: m.to,
            displayText: m.originText,
            replacement,
            multipleTargets,
        };
    });

    items.sort((a, b) => b.from - a.from);
    return items;
}

function buildReplacement(
    app: App,
    settings: LinkerPluginSettings,
    match: VirtualMatch,
    sourcePath: string
): string {
    // Display order, not trie Set order: with several targets the user sees [1]
    // first, and that is the one the link must point at.
    const targetFile = match.sortedFiles()[0] ?? match.files[0];
    if (!targetFile) return match.originText;

    const text = match.originText;
    // Only use the headerId resolved for THIS specific target file. Falling back
    // to match.headerId (the first match's header) produced wrong links for
    // multi-target virtual links.
    const headerId = match.getFileHeaderId(targetFile) ?? '';

    const useMarkdownLinks = settings.useDefaultLinkStyleForConversion
        ? settings.defaultUseMarkdownLinks
        : settings.useMarkdownLinks;
    const linkFormat = settings.useDefaultLinkStyleForConversion
        ? settings.defaultLinkFormat
        : settings.linkFormat;

    let absolutePath = targetFile.path;
    // Relative to the source note's directory AND pointing at the target's own
    // directory. It used to be dirname(source) + basename(target), which dropped
    // the target's directory entirely (a/b.md -> c/t.md gave "a/t.md" instead of
    // "../c/t.md") and produced a leading "/" when the source sat in the root.
    const relDir = relative(dirname(sourcePath), dirname(targetFile.path));
    let relativePath = (relDir ? relDir + '/' : '') + basename(targetFile.path);
    relativePath = relativePath.replace(/\\/g, '/');

    const replacementPath = app.metadataCache.fileToLinktext(targetFile, sourcePath);
    const lastPart = replacementPath.split('/').pop() ?? '';
    const shortestFile = app.metadataCache.getFirstLinkpathDest(lastPart, '');
    let shortestPath = shortestFile?.path === targetFile.path ? lastPart : absolutePath;

    // Strip a redundant .md, but ALWAYS append the heading anchor. It used to be
    // appended only inside the branch below, so when fileToLinktext returned a
    // link text ending in .md the anchor was silently dropped and the converted
    // link pointed at the top of the note instead of the heading.
    const pathSuffix = headerId ? `#${headerId}` : '';
    if (!replacementPath.endsWith('.md')) {
        if (absolutePath.endsWith('.md')) absolutePath = absolutePath.slice(0, -3);
        if (shortestPath && shortestPath.endsWith('.md')) shortestPath = shortestPath.slice(0, -3);
        if (relativePath.endsWith('.md')) relativePath = relativePath.slice(0, -3);
    }
    absolutePath += pathSuffix;
    shortestPath += pathSuffix;
    relativePath += pathSuffix;

    const createLink = (replacementTarget: string, linkText: string, markdownStyle: boolean) => {
        if (markdownStyle) {
            return `[${linkText}](${replacementTarget})`;
        }
        const tableCell = isInTableText(text);
        if (tableCell) {
            const escapedText = linkText.replace(/[\\|]/g, '\\$&');
            return `[[${replacementTarget}\\|${escapedText}]]`;
        }
        return `[[${replacementTarget}|${linkText}]]`;
    };

    if (replacementPath === text && linkFormat === 'shortest') {
        // Same-named note and heading: link without a display name, but keep the
        // heading anchor and honour the link style (this used to hardcode [[...]]
        // and drop the anchor, so it pointed at the top of the note).
        const target = replacementPath + pathSuffix;
        return useMarkdownLinks
            ? `[${text}](${target})`
            : `[[${target}]]`;
    }
    if (linkFormat === 'shortest') {
        return createLink(shortestPath || absolutePath, text, useMarkdownLinks);
    } else if (linkFormat === 'relative') {
        return createLink(relativePath, text, useMarkdownLinks);
    } else {
        return createLink(absolutePath, text, useMarkdownLinks);
    }
}

/** Heuristic: a link text containing an unescaped pipe likely lives in a table. */
function isInTableText(linkText: string): boolean {
    return /(?<!\\)\|/.test(linkText);
}

function getLineRange(text: string, index: number): [number, number] {
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    let lineEnd = text.indexOf('\n', index);
    if (lineEnd === -1) lineEnd = text.length;
    return [lineStart, lineEnd];
}

/** One pass over the whole text, marking regions batch conversion must not touch:
 *  frontmatter, fenced code blocks, inline code, math (block and inline),
 *  existing wikilinks/embeds and Markdown links.
 *
 *  Replaces the old per-candidate linear back-scan (lastIndexOf('[[')), which was
 *  O(n) per match and O(n²) overall, and also made conversion rewrite code blocks,
 *  YAML frontmatter and math - corrupting those regions. */
function buildExcludedIntervals(text: string): IntervalTree {
    const tree = new IntervalTree();
    const n = text.length;
    const add = (from: number, to: number) => { if (to > from) tree.insert([from, to]); };

    // Frontmatter: a leading "---" ... "---" (or "...") block. Both YAML
    // terminators are handled; the old code only found "---", so a "..."-closed
    // frontmatter still had its contents converted.
    if (text.startsWith('---')) {
        const endDashes = text.indexOf('\n---', 3);
        const endDots = text.indexOf('\n...', 3);
        let end = -1;
        if (endDashes !== -1 && (endDots === -1 || endDashes < endDots)) {
            end = endDashes;
        } else if (endDots !== -1) {
            end = endDots;
        }
        if (end !== -1) {
            const lineEnd = text.indexOf('\n', end + 1);
            add(0, lineEnd === -1 ? n : lineEnd + 1);
        }
    }

    for (let i = 0; i < n;) {
        const ch = text[i];

        // Fenced code block: a run of >=3 ` or ~ that STARTS the line (possibly
        // indented). A run elsewhere is inline code, handled below - the old
        // code treated any mid-line ``` as a fence opener, and when no closing
        // fence existed it excluded everything to the end of the document,
        // silently dropping every link in the rest of the note.
        if (ch === '`' || ch === '~') {
            let j = i;
            while (j < n && text[j] === ch) j++;
            const fenceLen = j - i;
            const lineStart = text.lastIndexOf('\n', i - 1) + 1;
            const atLineStart = !/\S/.test(text.slice(lineStart, i));
            if (fenceLen >= 3 && atLineStart) {
                const close = findClosingFence(text, j, ch, fenceLen);
                if (close !== -1) {
                    const lineEnd = text.indexOf('\n', close);
                    add(i, lineEnd === -1 ? n : lineEnd + 1);
                    i = lineEnd === -1 ? n : lineEnd + 1;
                    continue;
                }
                // Unclosed fence: everything from here on is code.
                add(i, n);
                break;
            }
        }

        // Inline code span: a backtick run closed by a run of the SAME length
        // (CommonMark pairing). The old single-backtick search closed a ``-span
        // at the first backtick of the opening run's twin, leaking the rest of
        // the span into the conversion scan.
        if (ch === '`') {
            let j = i;
            while (j < n && text[j] === '`') j++;
            const openLen = j - i;
            let p = j;
            let closed = false;
            while (p < n && !closed) {
                const idx = text.indexOf('`', p);
                if (idx === -1) break;
                let q = idx;
                while (q < n && text[q] === '`') q++;
                if (q - idx === openLen) {
                    add(i, q);
                    i = q;
                    closed = true;
                } else {
                    p = q;
                }
            }
            if (closed) continue;
        }

        // Math: $$...$$ block, or $...$ inline.
        if (ch === '$') {
            if (text[i + 1] === '$') {
                const close = text.indexOf('$$', i + 2);
                if (close !== -1) { add(i, close + 2); i = close + 2; continue; }
            } else {
                const close = text.indexOf('$', i + 1);
                if (close !== -1 && close > i + 1) { add(i, close + 1); i = close + 1; continue; }
            }
        }

        // Existing wikilink / embed: [[...]] or ![[...]].
        if (text.startsWith('[[', i) || text.startsWith('![[', i)) {
            const open = i + (text[i] === '!' ? 3 : 2);
            const close = text.indexOf(']]', open);
            if (close !== -1) { add(i, close + 2); i = close + 2; continue; }
        }

        // Markdown link [text](url).
        if (ch === '[') {
            const closeBracket = text.indexOf(']', i + 1);
            if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
                const closeParen = text.indexOf(')', closeBracket + 2);
                if (closeParen !== -1) { add(i, closeParen + 1); i = closeParen + 1; continue; }
            }
        }

        i++;
    }
    return tree;
}

/** Find the line start of a closing fence (>=minLen of the same char). */
function findClosingFence(text: string, from: number, ch: string, minLen: number): number {
    let i = from;
    while (i < text.length) {
        const lineStart = text.lastIndexOf('\n', i - 1) + 1;
        let j = lineStart;
        while (j < text.length && text[j] === ch) j++;
        if (j - lineStart >= minLen) return lineStart;
        const next = text.indexOf('\n', i);
        if (next === -1) return -1;
        i = next + 1;
    }
    return -1;
}

/** True when the matched word lies on a Markdown table row. Tables are prone
 *  to mis-positioned conversions, so batch conversion skips them entirely. */
function isInTableRow(text: string, index: number): boolean {
    const [lineStart, lineEnd] = getLineRange(text, index);
    const line = text.slice(lineStart, lineEnd);
    // Inside a fenced code block? leave it alone.
    if (/^\s*(```|~~~)/.test(line)) return false;
    // A table row is a line that contains an unescaped pipe.
    return /(?<!\\)\|/.test(line);
}

/** Apply replacements to a plain string (used for files not currently open in an editor). */
export function applyReplacementsToString(text: string, items: BatchLinkItem[]): string {
    // Single ascending pass. The old version re-sliced the whole string for every
    // item (O(n·m)); items arrive in descending `from` order, so sort ascending
    // first and build the result by walking the text once.
    const sorted = [...items].sort((a, b) => a.from - b.from);
    let result = '';
    let pos = 0;
    for (const item of sorted) {
        if (item.from < pos) continue; // overlapping/out-of-order item
        result += text.slice(pos, item.from) + item.replacement;
        pos = item.to;
    }
    result += text.slice(pos);
    return result;
}

export class BatchConvertModal extends Modal {
    private items: BatchLinkItem[] = [];
    private enabled: boolean[] = [];
    private text = '';
    private sourcePath = '';
    /** Optional [from, to] character range (code units) to restrict the scan to. */
    private range: [number, number] | null = null;
    private readonly settings: LinkerPluginSettings;
    private readonly plugin: LinkerPluginType | null;
    /** The pane the command was invoked in. */
    private readonly view: MarkdownView | null;

    constructor(
        app: App,
        settings: LinkerPluginSettings,
        plugin?: LinkerPluginType | null,
        range?: [number, number] | null,
        // Without this every lookup fell back to workspace.getActiveViewOfType(),
        // i.e. the FOCUSED pane - so switching tabs while the dialog was open
        // applied the scanned offsets to a different note.
        view?: MarkdownView | null
    ) {
        super(app);
        this.settings = settings;
        this.plugin = plugin ?? null;
        this.range = range ?? null;
        this.view = view ?? null;
    }

    onOpen() {
        const { contentEl } = this;
        // Prefer the pane the command came from: getActiveViewOfType() is the
        // focused pane, which is a different note in a split layout.
        const view = this.view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor ?? null;

        if (!editor) {
            contentEl.createEl('p', { text: t('Open a Markdown note first, then run this command.') });
            return;
        }
        if (!this.settings.linkerActivated) {
            contentEl.createEl('p', { text: t('Virtual links are currently disabled. Enable them in the settings before running the batch conversion.') });
            return;
        }

        this.text = editor.getValue();
        // Taken from the same view as `text`. getActiveFile() can name a different
        // note (for example when the focused pane is a Canvas), which made every
        // generated relative/absolute path point at the wrong place.
        this.sourcePath = view?.file?.path ?? '';

        if (this.range) {
            const [from, to] = this.range;
            if (from >= to) {
                contentEl.createEl('p', { text: t('Select some text first, then run this command.') });
                return;
            }
        }

        this.renderList(contentEl);
    }

    onClose() {
        this.items = [];
        this.enabled = [];
        this.text = '';
        this.sourcePath = '';
        this.contentEl.empty();
    }

    private renderList(contentEl: HTMLElement) {
        contentEl.empty();
        const [rangeFrom, rangeTo] = this.range ?? [undefined, undefined];
        this.items = scanVirtualLinks(
            this.app,
            this.settings,
            this.plugin,
            this.text,
            this.sourcePath,
            rangeFrom,
            rangeTo
        );
        this.enabled = this.items.map(() => true);

        const scopeLabel = this.range ? t('in the selection') : t('in this note');
        contentEl.createEl('h2', { text: t('Convert virtual links to real links') });
        contentEl.createEl('p', {
            text: t('Found {n} virtual links {scope}. Check the ones to convert, then click "Convert".')
                .replace('{n}', String(this.items.length))
                .replace('{scope}', scopeLabel),
        });

        if (this.items.length === 0) {
            contentEl.createEl('p', { text: t('No convertible virtual links found.') });
            return;
        }

        const listEl = contentEl.createEl('div', { cls: 'batch-convert-list' });

        this.items.forEach((item, idx) => {
            const row = listEl.createEl('div', { cls: 'batch-convert-row' });

            const toggle = new Setting(row)
                .setName(item.displayText)
                .setDesc(
                    item.multipleTargets
                        ? t('Multiple targets - will convert to the first target')
                        : item.replacement
                );
            const defaultOn = !(item.multipleTargets && this.settings.skipMultipleTargets);
            toggle.addToggle((tc) =>
                tc.setValue(defaultOn).onChange((v) => {
                    this.enabled[idx] = v;
                })
            );
            this.enabled[idx] = defaultOn;
        });

        const buttonBar = contentEl.createEl('div', { cls: 'batch-convert-buttons' });

        const convertBtn = buttonBar.createEl('button', { text: t('Convert'), cls: 'mod-cta' });
        convertBtn.onclick = () => this.convert();

        const cancelBtn = buttonBar.createEl('button', { text: t('Cancel') });
        cancelBtn.onclick = () => this.close();
    }

    private convert() {
        // The pane that was scanned. Re-resolving the active view here applied the
        // offsets to whatever note had focus by then.
        const view = this.view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor ?? null;
        if (!editor) return;
        if (view?.file && this.sourcePath && view.file.path !== this.sourcePath) {
            new Notice(t('The note changed while the dialog was open. Please run the command again.'));
            return;
        }

        let applied = 0;
        for (let idx = 0; idx < this.items.length; idx++) {
            if (!this.enabled[idx]) continue;
            const item = this.items[idx];
            const currentText = editor.getRange(
                editor.offsetToPos(item.from),
                editor.offsetToPos(item.to)
            );
            if (currentText !== item.displayText) continue;

            editor.replaceRange(
                item.replacement,
                editor.offsetToPos(item.from),
                editor.offsetToPos(item.to)
            );
            applied++;
        }

        new Notice(t('Converted {n} virtual links to real links.').replace('{n}', String(applied)));
        this.close();
    }
}

/**
 * Modal that lets the user pick multiple notes from the vault, then converts
 * every virtual link in each of them to a real link (with a preview count).
 */
export class BatchConvertFilesModal extends Modal {
    private selectedFiles: TFile[] = [];
    private readonly settings: LinkerPluginSettings;
    private readonly plugin: LinkerPluginType | null;

    constructor(app: App, settings: LinkerPluginSettings, plugin?: LinkerPluginType | null) {
        super(app);
        this.settings = settings;
        this.plugin = plugin ?? null;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: t('Convert virtual links in multiple notes') });
        contentEl.createEl('p', {
            text: t('Steps: 1) click "Choose notes..."; 2) click each note to process in the search box (you can pick several - the chosen ones are listed below); 3) click "Scan and convert" to convert every virtual link in each note (links inside tables are not processed).'),
        });

        const pickerBar = contentEl.createEl('div', { cls: 'batch-convert-buttons' });

        const pickBtn = pickerBar.createEl('button', { text: t('Choose notes...'), cls: 'mod-cta' });
        pickBtn.onclick = () => {
            const picker = new FileMultiSuggestModal(this.app);
            picker.onChoose((files) => {
                this.selectedFiles = files;
                this.renderSelected(contentEl);
            });
            picker.open();
        };

        const scanBtn = pickerBar.createEl('button', { text: t('Scan and convert') });
        scanBtn.onclick = () => this.scanAndConvert();
    }

    private renderSelected(contentEl: HTMLElement) {
        const existing = contentEl.querySelector('.batch-selected-files');
        if (existing) existing.remove();

        const box = contentEl.createEl('div', { cls: 'batch-selected-files' });
        box.createEl('p', { text: t('Selected {n} notes:').replace('{n}', String(this.selectedFiles.length)) });
        const list = box.createEl('ul');
        for (const f of this.selectedFiles) {
            list.createEl('li', { text: f.path });
        }
    }

    private async scanAndConvert() {
        if (this.selectedFiles.length === 0) {
            new Notice(t('Select at least one note first.'));
            return;
        }
        if (!this.settings.linkerActivated) {
            new Notice(t('Virtual links are currently disabled. Enable them in the settings first.'));
            return;
        }

        let totalApplied = 0;
        const errors: string[] = [];

        for (const file of this.selectedFiles) {
            try {
                const content = await this.app.vault.read(file);
                const items = scanVirtualLinks(
                    this.app,
                    this.settings,
                    this.plugin,
                    content,
                    file.path
                );
                // Apply "skip multiple targets" default: drop them
                const activeItems = items.filter(
                    (it) => !(it.multipleTargets && this.settings.skipMultipleTargets)
                );

                if (activeItems.length === 0) continue;

                const newContent = applyReplacementsToString(content, activeItems);

                // If the file is currently open in an editor, update it live
                const openView = this.app.workspace.getLeavesOfType('markdown')
                    .map((l) => l.view)
                    .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);

                if (openView && openView.editor) {
                    const editor = openView.editor;
                    // Re-apply through editor in reverse order to keep offsets valid
                    for (const item of activeItems) {
                        const cur = editor.getRange(editor.offsetToPos(item.from), editor.offsetToPos(item.to));
                        if (cur === item.displayText) {
                            editor.replaceRange(item.replacement, editor.offsetToPos(item.from), editor.offsetToPos(item.to));
                            totalApplied++;
                        }
                    }
                } else {
                    await this.app.vault.modify(file, newContent);
                    totalApplied += activeItems.length;
                }
            } catch (e) {
                errors.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        if (errors.length > 0) {
            new Notice(t('Done. {n} links converted ({errors} files failed, see the console).')
                .replace('{n}', String(totalApplied))
                .replace('{errors}', String(errors.length)));
            console.error('Batch convert files errors:', errors);
        } else {
            new Notice(t('Done. Converted {n} virtual links across {files} notes.')
                .replace('{n}', String(totalApplied))
                .replace('{files}', String(this.selectedFiles.length)));
        }
        this.close();
    }

    onClose() {
        this.selectedFiles = [];
        this.contentEl.empty();
    }
}

/** Multi-select file picker using Obsidian's fuzzy suggest. */
class FileMultiSuggestModal extends FuzzySuggestModal<TFile> {
    private chosen: TFile[] = [];
    private cb: (files: TFile[]) => void = () => {};

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles();
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    onChoose(cb: (files: TFile[]) => void) {
        this.cb = cb;
    }

    onChooseItem(file: TFile): void {
        if (!this.chosen.includes(file)) this.chosen.push(file);
        new Notice(t('Added: {path} ({n} total)').replace('{path}', file.path).replace('{n}', String(this.chosen.length)));
        this.cb([...this.chosen]);
    }
}
