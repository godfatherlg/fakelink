import { App, getAllTags, TFile, Vault } from 'obsidian';

import { LinkerPluginSettings } from 'main';
import { LinkerMetaInfoFetcher } from './linkerInfo';
import { stem } from './stemmer';

// Irregular English verbs: map inflected forms to their base/infinitive so that
// Porter stemming (which cannot handle irregular verbs) still aligns them.
// e.g. ran -> run, went -> go, was -> be. Used by fuzzy (词义模糊) matching.
const FUZZY_IRREGULAR_VERBS: Record<string, string> = {
    // be
    am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
    // have
    has: 'have', had: 'have', having: 'have',
    // do
    does: 'do', did: 'do', done: 'do', doing: 'do',
    // go
    goes: 'go', went: 'go', gone: 'go', going: 'go',
    // run
    ran: 'run', runs: 'run', running: 'run',
    // say
    says: 'say', said: 'say', saying: 'say',
    // see
    sees: 'see', saw: 'see', seen: 'see', seeing: 'see',
    // take
    takes: 'take', took: 'take', taken: 'take', taking: 'take',
    // come
    comes: 'come', came: 'come', coming: 'come',
    // give
    gives: 'give', gave: 'give', given: 'give', giving: 'give',
    // get
    gets: 'get', got: 'get', gotten: 'get', getting: 'get',
    // make
    makes: 'make', made: 'make', making: 'make',
    // know
    knows: 'know', knew: 'know', known: 'know', knowing: 'know',
    // think
    thinks: 'think', thought: 'think', thinking: 'think',
    // become
    becomes: 'become', became: 'become', becoming: 'become',
    // begin
    begins: 'begin', began: 'begin', begun: 'begin', beginning: 'begin',
    // eat
    eats: 'eat', ate: 'eat', eaten: 'eat', eating: 'eat',
    // write
    writes: 'write', wrote: 'write', written: 'write', writing: 'write',
    // speak
    speaks: 'speak', spoke: 'speak', spoken: 'speak', speaking: 'speak',
    // drive
    drives: 'drive', drove: 'drive', driven: 'drive', driving: 'drive',
    // ride
    rides: 'ride', rode: 'ride', ridden: 'ride', riding: 'ride',
    // fly
    flies: 'fly', flew: 'fly', flown: 'fly', flying: 'fly',
    // buy
    buys: 'buy', bought: 'buy', buying: 'buy',
    // bring
    brings: 'bring', brought: 'bring', bringing: 'bring',
    // teach
    teaches: 'teach', taught: 'teach', teaching: 'teach',
    // catch
    catches: 'catch', caught: 'catch', catching: 'catch',
    // fight
    fights: 'fight', fought: 'fight', fighting: 'fight',
    // find
    finds: 'find', found: 'find', finding: 'find',
    // hold
    holds: 'hold', held: 'hold', holding: 'hold',
    // keep
    keeps: 'keep', kept: 'keep', keeping: 'keep',
    // lead
    leads: 'lead', led: 'lead', leading: 'lead',
    // leave
    leaves: 'leave', left: 'leave', leaving: 'leave',
    // lose
    loses: 'lose', lost: 'lose', losing: 'lose',
    // mean
    means: 'mean', meant: 'mean', meaning: 'mean',
    // meet
    meets: 'meet', met: 'meet', meeting: 'meet',
    // pay
    pays: 'pay', paid: 'pay', paying: 'pay',
    // read
    reads: 'read', read: 'read', reading: 'read',
    // send
    sends: 'send', sent: 'send', sending: 'send',
    // shoot
    shoots: 'shoot', shot: 'shoot', shooting: 'shoot',
    // sit
    sits: 'sit', sat: 'sit', sitting: 'sit',
    // spend
    spends: 'spend', spent: 'spend', spending: 'spend',
    // stand
    stands: 'stand', stood: 'stand', standing: 'stand',
    // tell
    tells: 'tell', told: 'tell', telling: 'tell',
    // win
    wins: 'win', won: 'win', winning: 'win',
    // build
    builds: 'build', built: 'build', building: 'build',
    // feel
    feels: 'feel', felt: 'feel', feeling: 'feel',
    // break
    breaks: 'break', broke: 'break', broken: 'break', breaking: 'break',
    // choose
    chooses: 'choose', chose: 'choose', chosen: 'choose', choosing: 'choose',
    // draw
    draws: 'draw', drew: 'draw', drawn: 'draw', drawing: 'draw',
    // fall
    falls: 'fall', fell: 'fall', fallen: 'fall', falling: 'fall',
    // grow
    grows: 'grow', grew: 'grow', grown: 'grow', growing: 'grow',
    // show
    shows: 'show', showed: 'show', shown: 'show', showing: 'show',
    // throw
    throws: 'throw', threw: 'throw', thrown: 'throw', throwing: 'throw',
    // wear
    wears: 'wear', wore: 'wear', worn: 'wear', wearing: 'wear',
};

// Chinese function words / particles to strip for fuzzy (词义模糊) matching.
const FUZZY_ZH_STOPWORDS: string[] = [
    '的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '嘛', '罢',
    '和', '与', '及', '跟', '同', '或', '而', '但', '却',
    '在', '于', '从', '向', '往', '对', '为', '给', '被', '把', '让', '由',
    '我', '你', '他', '她', '它', '我们', '你们', '他们', '它们',
    '这', '那', '这个', '那个', '这些', '那些',
    '是', '有', '要', '会', '能', '可以', '不', '没', '没有', '也', '都', '就', '才', '还', '很', '太', '更',
    '一个', '一些', '这种', '那种', '之', '等', '上', '下', '中', '里', '外', '内',
    '我们', '你们', '他们', '自己', '什么', '怎么', '怎样', '如何', '为何', '因为', '所以', '如果', '虽然',
];

export class ExternalUpdateManager {
    private static readonly UPDATE_DELAY_MS = 50;
    registeredCallbacks: Set<() => void> = new Set();

    constructor() {}

    registerCallback(callback: () => void) {
        this.registeredCallbacks.add(callback);
    }

    update() {
        // Timeout to make sure the cache is updated
        window.setTimeout(() => {
            for (const callback of this.registeredCallbacks) {
                callback();
            }
        }, ExternalUpdateManager.UPDATE_DELAY_MS);
    }
}

export class PrefixNode {
    parent: PrefixNode | undefined;
    children: Map<string, PrefixNode> = new Map();
    files: Set<TFile> = new Set();
    charValue: string = '';
    depth: number = 0;
    requiresCaseMatch: boolean = false;
    // When this node was created from a stemmed keyword, the original
    // (unstemmed) keyword and its header id are stored here so the link can
    // still point to the real note/heading while the displayed text is the
    // matched inflected form found in the document.
    canonicalKeyword: string | undefined;
    canonicalHeaderId: string | undefined;
}

export class VisitedPrefixNode {
    node: PrefixNode;
    caseIsMatched: boolean;
    startedAtWordBeginning: boolean;
    formattingDelta: number = 0;
    constructor(node: PrefixNode, caseIsMatched: boolean = true, startedAtWordBeginning: boolean = false) {
        this.node = node;
        this.caseIsMatched = caseIsMatched;
        this.startedAtWordBeginning = startedAtWordBeginning;
    }
}

export enum MatchType {
    Note,    // Points to note name
    Alias,   // Points to alias
    Header   // Points to heading
}

export class MatchNode {
    start: number = 0;
    length: number = 0;
    files: Set<TFile> = new Set();
    value: string = '';
    type: MatchType = MatchType.Note;
    caseIsMatched: boolean = true;
    startsAtWordBoundary: boolean = false;
    requiresCaseMatch: boolean = false;
    headerId?: string;  // Only used for Header type
    canonicalKeyword?: string;  // Set when the match came from a stemmed keyword
    canonicalHeaderId?: string;  // Original header id for a stemmed header match

    get end(): number {
        return this.start + this.length;
    }

    get isAlias(): boolean {
        return this.type === MatchType.Alias;
    }
}

export class PrefixTree {
    root: PrefixNode = new PrefixNode();
    fetcher: LinkerMetaInfoFetcher;

    _currentNodes: VisitedPrefixNode[] = [];

    setIndexedFilePaths: Set<string> = new Set();
    mapIndexedFilePathsToUpdateTime: Map<string, number> = new Map();
    mapFilePathToLeaveNodes: Map<string, PrefixNode[]> = new Map();
    mapFileHeaderIds: Map<string, Map<string, string>> = new Map();

    // Fuzzy-match index: normalized keyword (lowercased) -> candidate entries.
    // Built alongside the prefix tree when fuzzy (词义模糊) matching is enabled.
    fuzzyKeywordMap: Map<string, { files: Set<TFile>; headerId?: string; canonical?: string }[]> = new Map();
    // First-char bucket index: bucket key (first char of normalized keyword) -> list
    // of normalized keywords. Lets findFuzzyMatches only scan the relevant bucket
    // instead of the entire map (the main source of the earlier performance lag).
    private fuzzyBuckets: Map<string, string[]> = new Map();
    // Minimum length (characters) of a normalized keyword to be indexed for fuzzy
    // matching. Shorter titles/notes are skipped — fuzzy-matching them is useless
    // and error-prone. Set from settings.fuzzyMinLength at tree build time.
    public fuzzyMinLength = 0;

    private static readonly SUPPORTED_EXTENSIONS = [
        'md', 'png', 'jpg', 'jpeg', 'gif', 'svg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx',
        'mp3', 'wav', 'ogg',
        'mp4', 'mov', 'avi', 'webm'
    ];

    constructor(public app: App, public settings: LinkerPluginSettings) {
        this.fetcher = new LinkerMetaInfoFetcher(this.app, this.settings);
        this.fuzzyMinLength = settings.fuzzyMinLength ?? 4;
        this.updateTree();
    }

    clear() {
        this.root = new PrefixNode();
        this._currentNodes = [];
        this.setIndexedFilePaths.clear();
        this.mapIndexedFilePathsToUpdateTime.clear();
        this.mapFilePathToLeaveNodes.clear();
        this.fuzzyKeywordMap.clear();
        this.fuzzyBuckets.clear();
    }

    // Levenshtein edit distance between two strings.
    private static editDistance(a: string, b: string): number {
        const m = a.length;
        const n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        let prev = new Array<number>(n + 1);
        let curr = new Array<number>(n + 1);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            curr[0] = i;
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            }
            [prev, curr] = [curr, prev];
        }
        return prev[n];
    }

    // Similarity ratio (0-1) based on edit distance, normalized by the longer
    // string length. 1 = identical, 0 = completely different.
    private static similarity(a: string, b: string): number {
        const maxLen = Math.max(a.length, b.length);
        if (maxLen === 0) return 1;
        return 1 - this.editDistance(a, b) / maxLen;
    }

    // Find fuzzy-match candidates for a normalized word. Returns entries whose
    // normalized keyword is at least `threshold` (0-100) similar to `word`.
    // `word` must already be normalized (lowercased) by the caller.
    // Performance: only the first-char bucket matching `word` is scanned, and a
    // length-difference > 2 short-circuits (such pairs can never reach >=80%
    // similarity for our shortest indexed keywords). This replaced the earlier
    // full-map scan that caused Obsidian to lag on large vaults.
    findFuzzyMatches(word: string, threshold: number): { files: Set<TFile>; headerId?: string; canonical?: string; similarity: number }[] {
        const w = word.toLowerCase();
        if (!w || !this.settings.enableStemming) return [];
        // Skip short query words: fuzzy-matching a too-short document word
        // (e.g. a single char like "关" or "骨") against the index is
        // error-prone and produces false virtual links. The same minimum
        // length used for indexing is applied to queries so only words longer
        // than fuzzyMinLength ever reach similarity comparison.
        const minQueryLen = this.fuzzyMinLength ?? 0;
        if (w.length <= minQueryLen) return [];
        const bucketKey = w[0] ?? '';
        const bucket = this.fuzzyBuckets.get(bucketKey);
        if (!bucket || bucket.length === 0) return [];
        const minSim = threshold / 100;
        // For threshold >= 80%, any pair with length difference > 2 is impossible
        // to reach the threshold once the shorter string is at least 3 chars.
        const maxLenDiff = threshold >= 80 ? 2 : Math.max(1, Math.ceil(w.length * (1 - minSim)));
        const results: { files: Set<TFile>; headerId?: string; canonical?: string; similarity: number }[] = [];
        for (const key of bucket) {
            if (Math.abs(key.length - w.length) > maxLenDiff) continue;
            const sim = PrefixTree.similarity(w, key);
            if (sim >= minSim) {
                const entries = this.fuzzyKeywordMap.get(key)!;
                for (const e of entries) {
                    results.push({ files: e.files, headerId: e.headerId, canonical: e.canonical, similarity: sim });
                }
            }
        }
        return results;
    }

    private isExcluded(value: string): boolean {
        const valueLower = value.toLowerCase();
        // If per-note mode is enabled, only apply exclusion to notes with the frontmatter property
        if (this.settings.perNoteExcludeKeywords) {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) return false;
            const metadata = this.app.metadataCache.getFileCache(activeFile);
            const propValue: unknown = metadata?.frontmatter?.[this.settings.frontmatterExcludeProperty];
            // Only exclude if the note has the property set to true/truthy
            if (!propValue) return false;
        }
        return this.settings.excludedKeywords.some(kw => kw.toLowerCase() === valueLower);
    }

    // Global-only exclusion check (used when building the trie, not per-note)
    private isGloballyExcluded(value: string): boolean {
        // When per-note mode is enabled, don't filter from the trie
        // (filtering happens at match time in getCurrentMatchNodes)
        if (this.settings.perNoteExcludeKeywords) return false;
        const valueLower = value.toLowerCase();
        return this.settings.excludedKeywords.some(kw => kw.toLowerCase() === valueLower);
    }

    // Collect extra per-note excluded keywords from a file's frontmatter list property
    private getFrontmatterExcludeListForFile(file: TFile): Set<string> {
        const excluded = new Set<string>();
        if (!this.settings.enableFrontmatterExcludeList) return excluded;

        const metadata = this.app.metadataCache.getFileCache(file);
        const propValue: unknown = metadata?.frontmatter?.[this.settings.frontmatterExcludeListProperty];
        // Accepts: a real YAML array, a "[a, b]" string, or a plain "a, b" string
        if (Array.isArray(propValue)) {
            for (const item of propValue) {
                if (typeof item === 'string' && item.trim().length > 0) {
                    excluded.add(item.trim().toLowerCase());
                }
            }
        } else if (typeof propValue === 'string') {
            const inner = propValue.trim();
            // Strip surrounding brackets if present, then split by comma
            const listBody = inner.startsWith('[') && inner.endsWith(']') ? inner.slice(1, -1) : inner;
            for (const item of listBody.split(',')) {
                const kw = item.trim();
                if (kw.length > 0) {
                    excluded.add(kw.toLowerCase());
                }
            }
        }
        return excluded;
    }

    // Collect extra per-note excluded keywords:
    // 1) from the active file (exclude words while reading that note)
    // 2) from every matched target file (a note can opt its own name/keywords out of being linked anywhere)
    private getFrontmatterExcludeList(): Set<string> {
        const excluded = new Set<string>();
        if (!this.settings.enableFrontmatterExcludeList) return excluded;

        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            for (const kw of this.getFrontmatterExcludeListForFile(activeFile)) {
                excluded.add(kw);
            }
        }
        return excluded;
    }

    getCurrentMatchNodes(index: number, excludedNote?: TFile | null, specificFile?: TFile): MatchNode[] {
        const matchNodes: MatchNode[] = [];
        // Track total unique files across all match types for early exit
        const allFiles = new Set<TFile>();

        if (excludedNote === undefined && this.settings.excludeLinksToOwnNote) {
            excludedNote = this.app.workspace.getActiveFile();
        }

        // Get per-note extra excluded keywords from frontmatter
        const frontmatterExcluded = this.getFrontmatterExcludeList();

        for (const node of this._currentNodes) {
            const valueString = this.getNodeValue(node.node);
            if (node.node.files.size === 0 || this.isExcluded(valueString)) {
                continue;
            }
            // Also check per-note frontmatter extra exclusions from the active file's list
            if (frontmatterExcluded.size > 0 && frontmatterExcluded.has(valueString.toLowerCase())) {
                continue;
            }
            // Also check each matched target file's own exclude list
            // (a note can opt its own name/keywords out of being linked from anywhere)
            if (this.settings.enableFrontmatterExcludeList) {
                const lower = valueString.toLowerCase();
                let targetExcluded = false;
                for (const file of node.node.files) {
                    const fileList = this.getFrontmatterExcludeListForFile(file);
                    if (fileList.has(lower)) {
                        targetExcluded = true;
                        break;
                    }
                }
                if (targetExcluded) {
                    continue;
                }
            }
            const matchNode = new MatchNode();
            matchNode.length = node.node.depth + node.formattingDelta;
            matchNode.start = index - matchNode.length;
            // If a specific file is specified, only include that file
            if (specificFile) {
                matchNode.files = new Set(Array.from(node.node.files).filter((file) => file.path === specificFile.path));
            } else {
                matchNode.files = new Set(Array.from(node.node.files).filter((file) => !excludedNote || file.path !== excludedNote.path));
            }
            // Early exit: if total files from all types exceed threshold, skip this keyword entirely
            matchNode.files.forEach(f => allFiles.add(f));
            if (this.settings.maxReferencesToHideLink > 0 && allFiles.size > this.settings.maxReferencesToHideLink) {
                return [];
            }
            matchNode.value = valueString;
            matchNode.requiresCaseMatch = node.node.requiresCaseMatch;

            // When this node came from a stemmed keyword, resolve the real
            // keyword/heading so the link points to the correct note.
            const resolvedKeyword = node.node.canonicalKeyword ?? valueString;
            matchNode.canonicalKeyword = node.node.canonicalKeyword;
            matchNode.canonicalHeaderId = node.node.canonicalHeaderId;

            // Determine match type
            const fileNames = Array.from(matchNode.files).map((file) => file.basename);
            const nodeValue = resolvedKeyword;
            
            if (fileNames.map((n) => n.toLowerCase()).includes(nodeValue.toLowerCase())) {
                matchNode.type = MatchType.Note;  // Matches note name
            } else {
                // Check ALL files for heading match (not just the first one)
                let headingMatch = null;
                for (const file of matchNode.files) {
                    const metadata = this.app.metadataCache.getFileCache(file);
                    if (metadata?.headings) {
                        if (this.settings.headerMatchSymbols && this.settings.headerMatchStartSymbol && this.settings.headerMatchEndSymbol && this.settings.headerMatchStartSymbol !== this.settings.headerMatchEndSymbol) {
                            // Try matching keywords between symbols first
                            for (const h of metadata.headings) {
                                const headingText = h.heading;
                                const startSymbol = this.settings.headerMatchStartSymbol;
                                const endSymbol = this.settings.headerMatchEndSymbol;
                                let searchStartIndex = 0;
                                
                                while (searchStartIndex < headingText.length) {
                                    const startIndex = headingText.indexOf(startSymbol, searchStartIndex);
                                    if (startIndex === -1) break;
                                    
                                    const afterStartIndex = startIndex + startSymbol.length;
                                    const endIndex = headingText.indexOf(endSymbol, afterStartIndex);
                                    if (endIndex === -1) break;
                                    
                                    if (startIndex < endIndex) {
                                        const keyword = headingText.substring(startIndex + startSymbol.length, endIndex).trim();
                                        if (keyword.toLowerCase() === nodeValue.toLowerCase()) {
                                            headingMatch = h;
                                            break;
                                        }
                                        searchStartIndex = endIndex + endSymbol.length;
                                    } else {
                                        searchStartIndex = afterStartIndex;
                                    }
                                }
                                if (headingMatch) break;
                            }
                            // If not restricted, also try plain header match
                            if (!headingMatch && !this.settings.headerMatchOnlyBetweenSymbols) {
                                headingMatch = metadata.headings.find(h => 
                                    h.heading.toLowerCase() === nodeValue.toLowerCase()
                                );
                            }
                        } else {
                            headingMatch = metadata.headings.find(h => 
                                h.heading.toLowerCase() === nodeValue.toLowerCase()
                            );
                        }
                    }
                    if (headingMatch) break;
                }
                
                if (headingMatch) {
                    matchNode.type = MatchType.Header;
                    matchNode.headerId = headingMatch.heading.trim();
                } else {
                    matchNode.type = MatchType.Alias;
                }
            }

            // Check if the case is matched
            let currentNode: PrefixNode | undefined = node.node;
            while (currentNode) {
                if (!node.caseIsMatched) {
                    matchNode.caseIsMatched = false;
                    break;
                }
                currentNode = currentNode.parent;
            }

            // Check if the match starts at a word boundary
            matchNode.startsAtWordBoundary = node.startedAtWordBeginning;

            if (matchNode.requiresCaseMatch && !matchNode.caseIsMatched) {
                continue;
            }

            if (matchNode.files.size > 0) {
                // Never allow headers to link to their own file
                if (matchNode.type === MatchType.Header) {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile) {
                        matchNode.files = new Set(
                            Array.from(matchNode.files).filter(f => f.path !== activeFile.path)
                        );
                    }
                }
                if (matchNode.files.size > 0) {
                    // Fill headerId for heading matches from mapFileHeaderIds
                    if (matchNode.type === MatchType.Header && !matchNode.headerId) {
                        for (const f of matchNode.files) {
                            const headerId = this.getFileHeaderId(f, nodeValue);
                            if (headerId) {
                                matchNode.headerId = headerId;
                                break;
                            }
                        }
                    }
                    matchNodes.push(matchNode);
                }
            }
        }

        // Sort nodes by length
        matchNodes.sort((a, b) => b.length - a.length);

        return matchNodes;
    }

    private addFileWithName(name: string, file: TFile, matchCase: boolean, headerId?: string, canonicalKeyword?: string, canonicalHeaderId?: string) {
        // Skip single-character keywords: they produce spurious virtual links
        // (e.g. "关" matching "下关" or "带" matching "带下") and are never
        // intended by the user as glossary entries.
        if (name.length < 2) return;

        let node = this.root;

        // For each character in the name, add a node to the trie
        for (let char of name) {
            // char = char.toLowerCase();
            let child = node.children.get(char);
            if (!child) {
                child = new PrefixNode();
                child.parent = node;
                child.charValue = char;
                // depth is measured in UTF-16 code units (char.length), so it
                // stays aligned with the scan-side index (which advances by
                // char.length too). This keeps emoji / surrogate-pair keywords
                // from producing misaligned slices.
                child.depth = node.depth + char.length;
                node.children.set(char, child);
            }
            node = child;
        }

        // The last node is a leaf node, add the file to the node
        node.files.add(file);
        node.requiresCaseMatch = matchCase;

        // Store the original keyword/header id when this node was created from
        // a stemmed form, so matches resolve to the real note/heading.
        if (canonicalKeyword) {
            node.canonicalKeyword = canonicalKeyword;
        }
        if (canonicalHeaderId) {
            node.canonicalHeaderId = canonicalHeaderId;
        }

        // Store headerId if present — used for heading highlight on jump
        if (headerId) {
            const existingIds = this.mapFileHeaderIds.get(file.path) ?? new Map<string, string>();
            existingIds.set(name, headerId);
            this.mapFileHeaderIds.set(file.path, existingIds);
        }

        // Register fuzzy (词义模糊) normalized keywords so that words with
        // similarity >= threshold can still link. Only normalized keywords
        // (those created from fuzzyNormalize, identified by a canonicalKeyword
        // that differs from the normalized name) are indexed here.
        // Short keywords are skipped: fuzzy-matching them is both useless and
        // error-prone (e.g. 的 -> 地). When the index grows past the fuse limit
        // we also stop indexing to protect performance on large vaults.
        if (canonicalKeyword && canonicalKeyword !== name) {
            const key = name.toLowerCase();
            // Only index keywords with at least 2 chars: single-char titles are
            // skipped (fuzzy-matching them is error-prone and useless). Longer
            // titles (including the long Chinese titles the user cares about) are
            // always indexed so that dropping one character still matches.
            if (key.length >= 2) {
                const entry = { files: node.files, headerId, canonical: canonicalKeyword };
                const list = this.fuzzyKeywordMap.get(key);
                if (list) {
                    list.push(entry);
                } else {
                    this.fuzzyKeywordMap.set(key, [entry]);
                    // Maintain first-char bucket index for cheap lookup at match time.
                    const bucketKey = key[0] ?? '';
                    const bucket = this.fuzzyBuckets.get(bucketKey) ?? [];
                    bucket.push(key);
                    this.fuzzyBuckets.set(bucketKey, bucket);
                }
            }
        }

        // Store the leaf node for the file to be able to remove it later
        const path = file.path;
        this.mapFilePathToLeaveNodes.set(path, [node, ...(this.mapFilePathToLeaveNodes.get(path) ?? [])]);
        // console.log("Adding file", file, name);
    }

    // Get the header ID for a file and keyword, used for heading highlight on jump
    getFileHeaderId(file: TFile, keyword: string): string | undefined {
        return this.mapFileHeaderIds.get(file.path)?.get(keyword);
    }

    // Reconstruct full string by walking parent chain — replaces stored node.value
    private getNodeValue(node: PrefixNode): string {
        const chars: string[] = [];
        let current: PrefixNode | undefined = node;
        while (current && current !== this.root) {
            if (current.charValue) chars.push(current.charValue);
            current = current.parent;
        }
        return chars.reverse().join('');
    }

    private static isNoneEmptyString(this: void, value: string | null | undefined): value is string {
        return value !== null && value !== undefined && typeof value === 'string' && value.trim().length > 0;
    }

    private static isUpperCaseString(this: void, value: string | null | undefined, upperCasePart = 0.75) {
        if (!PrefixTree.isNoneEmptyString(value)) {
            return false;
        }

        const length = value.length;
        const upperCaseChars = [...value].filter(
            (char) => char.toLowerCase() !== char.toUpperCase() && char === char.toUpperCase()
        ).length;

        return upperCaseChars / length >= upperCasePart;
    }

    private addFileToTree(file: TFile) {
        const path = file.path;

        if (!file || !path) {
            return;
        }

        // Check if file extension is excluded
        if (this.settings.excludedExtensions.some(ext => 
            path.toLowerCase().endsWith(ext.toLowerCase())
        )) {
            return;
        }

        // Remove the old nodes of the file
        this.removeFileFromTree(file);

        // Add the file to the set of indexed files
        this.setIndexedFilePaths.add(path);
        this.mapIndexedFilePathsToUpdateTime.set(path, file.stat.mtime);

        // Get the virtual linker related metadata of the file
        const metaInfo = this.fetcher.getMetaInfo(file);

        // Get the tags of the file
        // and normalize them by removing the # in front of tags
        const fileCache = this.app.metadataCache.getFileCache(file);
        const tagsArray: string[] | null = fileCache ? getAllTags(fileCache) : null;
        const tags = (tagsArray ?? []).filter(s => PrefixTree.isNoneEmptyString(s))
            .map((tag) => (tag.startsWith('#') ? tag.slice(1) : tag));

        const includeFile = metaInfo.includeFile;
        const excludeFile = metaInfo.excludeFile;

        const isInIncludedDir = metaInfo.isInIncludedDir;
        const isInExcludedDir = metaInfo.isInExcludedDir;

        if (excludeFile || (isInExcludedDir && !includeFile)) {
            return;
        }

        // Skip files that are not in the linker directories
        if (!includeFile && !isInIncludedDir && !metaInfo.includeAllFiles) {
            return;
        }

        const metadata = this.app.metadataCache.getFileCache(file);
        let aliases: string[] = (metadata?.frontmatter?.aliases as string[]) ?? [];
        
        // Get headers from metadata cache — store as {keyword, headerId} pairs
        let headerEntries: { keyword: string; headerId?: string }[] = [];
        if (this.settings.includeHeaders && metadata?.headings) {
            const canMatchSymbols = this.settings.headerMatchSymbols
                && this.settings.headerMatchStartSymbol
                && this.settings.headerMatchEndSymbol
                && this.settings.headerMatchStartSymbol !== this.settings.headerMatchEndSymbol;
            
            if (canMatchSymbols) {
                const symbolKeywords = new Set<string>();
                // Extract keywords between symbols
                for (const h of metadata.headings) {
                    const headingText = h.heading;
                    const startSymbol = this.settings.headerMatchStartSymbol;
                    const endSymbol = this.settings.headerMatchEndSymbol;
                    let searchStartIndex = 0;
                    
                    while (searchStartIndex < headingText.length) {
                        const startIndex = headingText.indexOf(startSymbol, searchStartIndex);
                        if (startIndex === -1) break;
                        
                        const afterStartIndex = startIndex + startSymbol.length;
                        const endIndex = headingText.indexOf(endSymbol, afterStartIndex);
                        if (endIndex === -1) break;
                        
                        if (startIndex < endIndex) {
                            const keyword = headingText.substring(startIndex + startSymbol.length, endIndex).trim();
                            if (keyword) {
                                headerEntries.push({ keyword, headerId: h.heading.replace(/\s+/g, '-').toLowerCase() });
                                symbolKeywords.add(keyword);
                            }
                            searchStartIndex = endIndex + endSymbol.length;
                        } else {
                            searchStartIndex = afterStartIndex;
                        }
                    }
                }
                // If not restricted to only symbol-keywords, also add plain headers (non-duplicate with symbol-extracted ones)
                if (!this.settings.headerMatchOnlyBetweenSymbols) {
                    for (const h of metadata.headings) {
                        if (!symbolKeywords.has(h.heading)) {
                            headerEntries.push({ keyword: h.heading, headerId: h.heading.replace(/\s+/g, '-').toLowerCase() });
                        }
                    }
                }
            } else {
                headerEntries = metadata.headings.map(h => ({ keyword: h.heading, headerId: h.heading.replace(/\s+/g, '-').toLowerCase() }));
            }
        }

        let aliasesWithMatchCase: Set<string> = new Set((metadata?.frontmatter?.[this.settings.propertyNameToMatchCase] as string[]) ?? []);
        let aliasesWithIgnoreCase: Set<string> = new Set((metadata?.frontmatter?.[this.settings.propertyNameToIgnoreCase] as string[]) ?? []);

        // If aliases is not an array, convert it to an array
        if (!Array.isArray(aliases)) {
            aliases = [aliases];
        }

        // Filter out empty aliases
        try {
            aliases = aliases.filter(s => PrefixTree.isNoneEmptyString(s));
        } catch {
            // Error filtering aliases
        }

        let names = [file.basename];
        if (aliases && this.settings.includeAliases) {
            names.push(...aliases);
        }
        if (headerEntries.length > 0 && this.settings.includeHeaders) {
            names.push(...headerEntries.map(e => e.keyword));
        }

        names = names.filter(s => PrefixTree.isNoneEmptyString(s));

        let namesWithCaseIgnore = new Array<string>();
        let namesWithCaseMatch = new Array<string>();

        // Check if the file should match case sensitive
        if (this.settings.matchCaseSensitive) {
            let lowerCaseNames = new Array<string>();
            if (tags.includes(this.settings.tagToIgnoreCase)) {
                namesWithCaseIgnore = [...names];
            } else {
                namesWithCaseMatch = [...names];
            }
            lowerCaseNames = lowerCaseNames.map((name) => name.toLowerCase());
            names.push(...lowerCaseNames);
        } else {
            if (tags.includes(this.settings.tagToMatchCase)) {
                namesWithCaseMatch = [...names];
            } else {
                const prop = this.settings.capitalLetterProportionForAutomaticMatchCase;
                namesWithCaseMatch = [...names].filter(
                    (name) => PrefixTree.isUpperCaseString(name, prop) && !aliasesWithIgnoreCase.has(name)
                );
                namesWithCaseIgnore = [...names].filter((name) => !namesWithCaseMatch.includes(name));
            }
        }

        const namesToMoveFromIgnoreToMatch = namesWithCaseIgnore.filter((name) => aliasesWithMatchCase.has(name));
        const namesToMoveFromMatchToIgnore = namesWithCaseMatch.filter((name) => aliasesWithIgnoreCase.has(name));

        namesWithCaseIgnore = namesWithCaseIgnore.filter((name) => !namesToMoveFromIgnoreToMatch.includes(name));
        namesWithCaseMatch = namesWithCaseMatch.filter((name) => !namesToMoveFromMatchToIgnore.includes(name));
        namesWithCaseIgnore.push(...namesToMoveFromMatchToIgnore);
        namesWithCaseMatch.push(...namesToMoveFromIgnoreToMatch);

        namesWithCaseIgnore.push(...namesWithCaseIgnore.map((name) => name.toLowerCase()));

        // Filter out excluded keywords before adding to tree
        namesWithCaseIgnore = namesWithCaseIgnore.filter(name => !this.isGloballyExcluded(name));
        namesWithCaseMatch = namesWithCaseMatch.filter(name => !this.isGloballyExcluded(name));

        namesWithCaseIgnore.forEach((name) => {
            this.addFileWithName(name, file, false);
        });

        namesWithCaseMatch.forEach((name) => {
            this.addFileWithName(name, file, true);
        });

        // Stemming: add stemmed variants so inflected forms match the same note
        // or heading. Stem entries are always case-insensitive (inflection is
        // about word form, not case) and only added when stemming actually
        // changes the keyword.
        if (this.settings.enableStemming) {
            const lang = this.settings.stemmingLanguage;
            const addStem = (name: string) => {
                // "词义模糊匹配" (fuzzy match): reduce a keyword to a normalized
                // form so that inflected forms / function words link to the same
                // note or heading.
                //   - English: stem each word individually + apply an irregular
                //     verb table so e.g. "He ran to the store" matches "he runs".
                //   - Chinese: strip common function words (的, 了, 吗, 在, 和 ...)
                //     so e.g. "我的项目计划" matches "项目计划".
                // Only enable fuzzy matching when it actually changes the keyword,
                // and never when the result becomes empty.
                const fuzzy = this.fuzzyNormalize(name, lang);
                // Skip single-character remnants: stripping stopwords can
                // leave a 1-char residue (e.g. '下关' → '关', '带下' → '带')
                // that would enter the exact-match prefix tree and cause
                // spurious links everywhere that single char appears.
                if (!fuzzy || fuzzy.length < 2 || fuzzy === name.toLowerCase() || fuzzy === name) {
                    return;
                }
                const headerEntry = headerEntries.find((e) => e.keyword === name);
                this.addFileWithName(
                    fuzzy,
                    file,
                    false,
                    headerEntry?.headerId,
                    name,
                    headerEntry?.headerId
                );
            };
            namesWithCaseIgnore.forEach(addStem);
            namesWithCaseMatch.forEach(addStem);
        }

        // After adding, store headerId mappings for this file
        for (const entry of headerEntries) {
            if (entry.headerId) {
                const existingIds = this.mapFileHeaderIds.get(file.path) ?? new Map<string, string>();
                existingIds.set(entry.keyword, entry.headerId);
                this.mapFileHeaderIds.set(file.path, existingIds);
            }
        }
    }

    // Irregular English verbs: see FUZZY_IRREGULAR_VERBS (module-level) for the
    // full table. Maps inflected forms to their base so Porter stemming (which
    // cannot handle irregular verbs) still aligns them.
    private static IRREGULAR_VERBS = FUZZY_IRREGULAR_VERBS;

    // Chinese function words / particles to strip for fuzzy matching.
    // See FUZZY_ZH_STOPWORDS (module-level) for the full list.
    private static ZH_STOPWORDS = FUZZY_ZH_STOPWORDS;

    // Normalize a keyword into its fuzzy-match form.
    // Returns '' when normalization is not applicable / produces nothing.
    // Made public so the scan side (batch convert / live linker) can normalize
    // document words the same way before fuzzy-similarity comparison.
    fuzzyNormalize(name: string, lang: string): string {
        if (!name || name.length < 2) return '';

        const hasLatin = /[A-Za-z]/.test(name);
        const hasCJK = /[一-鿿]/.test(name);

        // Respect the chosen language. "auto" applies English to Latin-only
        // keywords and Chinese to CJK-only keywords. "en" / "zh" force one side.
        const wantEn = lang !== 'zh';
        const wantZh = lang !== 'en';

        // Pure English keyword (possibly a phrase): stem each word, applying the
        // irregular-verb table first so whole phrases like "He ran to the store"
        // reduce to "he run to the store" and match "he runs to the store".
        if (wantEn && hasLatin && !hasCJK) {
            if (name.length < 3 || !/^[A-Za-z][A-Za-z -]*$/.test(name)) {
                return '';
            }
            const words = name.split(/\s+/);
            const normWords = words.map((w) => {
                const lower = w.toLowerCase();
                const irregular = FUZZY_IRREGULAR_VERBS[lower];
                const base = irregular ?? lower;
                return stem(base, lang === 'zh' ? 'en' : lang);
            });
            const norm = normWords.join(' ').trim();
            return norm || '';
        }

        // Pure Chinese keyword: strip common function words / particles.
        if (wantZh && hasCJK && !hasLatin) {
            let s = name;
            for (const sw of FUZZY_ZH_STOPWORDS) {
                s = s.split(sw).join('');
            }
            s = s.trim();
            return s || '';
        }

        // Mixed scripts or language mismatch: not supported for fuzzy matching.
        return '';
    }

    private removeFileFromTree(file: TFile | string) {
        const path = typeof file === 'string' ? file : file.path;

        // Get the leaf nodes of the file
        const nodes = this.mapFilePathToLeaveNodes.get(path) ?? [];
        for (const node of nodes) {
            // Remove the file from the node
            node.files = new Set([...node.files].filter((f) => f.path !== path));
        }

        // If the nodes have no files or children, remove them from the tree
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            let currentNode = node;
            while (currentNode.files.size === 0 && currentNode.children.size === 0) {
                const parent = currentNode.parent;
                if (!parent || parent === this.root) {
                    break;
                }
                parent.children.delete(currentNode.charValue);
                currentNode = parent;
            }
        }

        // Remove the file from the set of indexed files
        this.setIndexedFilePaths.delete(path);
        this.mapFilePathToLeaveNodes.delete(path);
        this.mapFileHeaderIds.delete(path);

        // Remove the update time of the file
        this.mapIndexedFilePathsToUpdateTime.delete(path);
    }

    private fileIsUpToDate(file: TFile) {
        const mtime = file.stat.mtime;
        const path = file.path;
        return this.mapIndexedFilePathsToUpdateTime.has(path) && this.mapIndexedFilePathsToUpdateTime.get(path) === mtime;
    }

    updateTree(updateFiles?: (string | undefined)[]) {
        this.fetcher.refreshSettings();

        const currentVaultFiles = new Set<string>();
        let files = new Array<TFile>();

        // Get all files and filter for supported types
        const allFiles = this.app.vault.getFiles().filter((file): file is TFile => {
            const ext = file.extension.toLowerCase();
            return PrefixTree.SUPPORTED_EXTENSIONS.includes(ext);
        });

        allFiles.forEach((f) => currentVaultFiles.add(f.path));

        // If the number of files has changed, update all files
        if (allFiles.length !== this.setIndexedFilePaths.size || !updateFiles?.length) {
            files = allFiles;
        } else {
            // If files are provided, only update the provided files
            files = updateFiles
                .map((f) => f ? this.app.vault.getAbstractFileByPath(f) : null)
                .filter((f): f is TFile => f instanceof TFile);
        }

        for (const file of files) {
            // Check if the file has been updated
            if (this.fileIsUpToDate(file)) {
                continue;
            }

            // Otherwise, add the file to the tree
            try {
                this.addFileToTree(file);
            } catch {
                // Error adding file to tree
            }
        }

        // Remove files that are no longer in the vault
        const filesToRemove = [...this.setIndexedFilePaths].filter((f) => !currentVaultFiles.has(f));
        filesToRemove.forEach((f) => this.removeFileFromTree(f));

        // console.log(`[FakeLink] indexed ${this.setIndexedFilePaths.size} files`);
    }

    findFiles(prefix: string): Set<TFile> {
        let node: PrefixNode | undefined = this.root;
        for (const char of prefix) {
            node = node.children.get(char.toLowerCase());
            if (!node) {
                return new Set();
            }
        }
        return node.files;
    }

    resetSearch() {
        // this._current = this.root;
        this._currentNodes = [new VisitedPrefixNode(this.root)];
    }

    pushChar(char: string) {
        const newNodes: VisitedPrefixNode[] = [];
        const chars = [char, char.toLowerCase()];

        chars.forEach((c) => {
            const isBoundary = PrefixTree.checkWordBoundary(c);
            if (this.settings.matchAnyPartsOfWords || isBoundary || this.settings.matchEndOfWords) {
                newNodes.push(new VisitedPrefixNode(this.root, true, isBoundary));
            }

            for (const node of this._currentNodes) {
                const child = node.node.children.get(c);
                const startedAtBoundary = node.startedAtWordBeginning;
                if (child) {
                    const newPrefixNodes = newNodes.map((n) => n.node);
                    if (!newPrefixNodes.includes(child)) {
                        const newVisited = new VisitedPrefixNode(child, char == c, startedAtBoundary);
                        newVisited.formattingDelta = node.formattingDelta;
                        newNodes.push(newVisited);
                    }
                }
            }
        });
        this._currentNodes = newNodes;
    }

    static checkWordBoundary(char: string): boolean {
        // \p{L}: Any kind of letter from any language.
        let pattern = /[^\p{L}]/u;
        return pattern.test(char);
    }

    static isFormattingChar(char: string): boolean {
        const pattern = /[^\p{L}\p{N}]/u;
        return pattern.test(char);
    }
}

export class CachedFile {
    constructor(public mtime: number, public file: TFile, public aliases: string[], public tags: string[]) {}
}

export class LinkerCache {
    static instance: LinkerCache;

    activeFilePath?: string;
    // files: Map<string, CachedFile> = new Map();
    // linkEntries: Map<string, CachedFile[]> = new Map();
    vault: Vault;
    cache: PrefixTree;

    constructor(public app: App, public settings: LinkerPluginSettings) {
        const { vault } = app;
        this.vault = vault;
        this.cache = new PrefixTree(app, settings);
        this.updateCache(true);
    }

    static getInstance(app: App, settings: LinkerPluginSettings) {
        if (!LinkerCache.instance) {
            LinkerCache.instance = new LinkerCache(app, settings);
        }
        return LinkerCache.instance;
    }

    clearCache() {
        this.cache.clear();
    }

    reset() {
        this.cache.resetSearch();
    }

    updateCache(force = false) {
        // Skip update if plugin is not activated
        if (!this.settings.linkerActivated) return;

        if (!this.app?.workspace?.getActiveFile()) {
            return;
        }

        // We only need to update cache if the active file has changed
        const activeFile = this.app.workspace.getActiveFile()?.path;
        if (activeFile === this.activeFilePath && !force) {
            return;
        }

        this.cache.updateTree(force ? undefined : [activeFile, this.activeFilePath]);

        this.activeFilePath = activeFile;
    }
}