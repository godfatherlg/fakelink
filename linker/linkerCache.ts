import { App, getAllTags, TFile, Vault } from 'obsidian';

import { LinkerPluginSettings } from 'main';
import { LinkerMetaInfoFetcher } from './linkerInfo';
import { stem } from './stemmer';

// Irregular English verbs: map inflected forms to their base/infinitive so that
// Porter stemming (which cannot handle irregular verbs) still aligns them.
// e.g. ran -> run, went -> go, was -> be. Used by fuzzy matching.
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

// Chinese function words / particles to strip for fuzzy matching.
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

// Pre-built regex testing whether a string contains ANY Chinese stopword. Used
// as a fast path in fuzzyNormalize: most candidates contain no stopword, so the
// per-stopword split/join loop is skipped entirely when this test is negative.
const FUZZY_ZH_STOPWORD_TEST = new RegExp(
    FUZZY_ZH_STOPWORDS.map((sw) => sw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
);

export class ExternalUpdateManager {
    private static readonly UPDATE_DELAY_MS = 50;
    registeredCallbacks: Set<(rebuildIndex: boolean) => void> = new Set();
    // A burst of changes should rebuild everything once, not once per change.
    private pendingTimer: number | null = null;
    // Whether a full index rebuild was requested while the timer is pending.
    // Appearance-only setting changes pass false: they still refresh the open
    // views, but re-indexing the whole vault for a colour tweak is wasted work.
    private pendingIndexRebuild = false;

    constructor() {}

    /**
     * @returns a function that removes the callback again. Every caller owns a
     * lifetime that is shorter than the plugin's (a CodeMirror ViewPlugin is
     * destroyed with its view), so keeping anonymous callbacks alive here meant
     * repainting views that no longer exist.
     */
    registerCallback(callback: (rebuildIndex: boolean) => void): () => void {
        this.registeredCallbacks.add(callback);
        return () => this.unregisterCallback(callback);
    }

    unregisterCallback(callback: (rebuildIndex: boolean) => void) {
        this.registeredCallbacks.delete(callback);
    }

    /**
     * @param rebuildIndex false when the change cannot affect the index (a pure
     * appearance tweak): the pending update then only refreshes the views. Any
     * caller that asks for a rebuild while one is pending wins, so a mixed
     * burst coalesces into a single full update.
     */
    update(rebuildIndex = true) {
        // Timeout to make sure the cache is updated. Restarting the timer makes
        // the whole burst coalesce: dragging a slider used to queue one rebuild
        // per step, each of them throwing the index away and repainting every
        // open note.
        this.pendingIndexRebuild = this.pendingIndexRebuild || rebuildIndex;
        if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
        this.pendingTimer = window.setTimeout(() => {
            this.pendingTimer = null;
            const rebuild = this.pendingIndexRebuild;
            this.pendingIndexRebuild = false;
            for (const callback of this.registeredCallbacks) {
                callback(rebuild);
            }
        }, ExternalUpdateManager.UPDATE_DELAY_MS);
    }

    /** Release the pending timer and callbacks when the plugin unloads; otherwise
     *  a queued update fires after unload and triggers a full index rebuild. */
    dispose() {
        if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
        this.pendingIndexRebuild = false;
        this.registeredCallbacks.clear();
    }
}

export class PrefixNode {
    parent: PrefixNode | undefined;
    children: Map<string, PrefixNode> = new Map();
    files: Set<TFile> = new Set();
    charValue: string = '';
    depth: number = 0;
    requiresCaseMatch: boolean = false;
    // Lazily cached full keyword (the parent chain joined). charValue and parent
    // are set exactly once at creation and never mutated (removals only prune the
    // children map or drop files), so the cached string can never go stale.
    fullValue?: string;
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

    // Auto-exclude renamed duplicates: paths of notes that are automatically
    // treated as excluded (longer-named note whose name contains another note's
    // name and shares the same first sentence). Consulted by shouldExcludeFile.
    autoExcludedPaths: Set<string> = new Set();
    // Cache of each file's first sentence (keyed by path, invalidated by mtime).
    private firstSentenceCache: Map<string, { mtime: number; sentence: string }> = new Map();
    // Auto-exclude scan state. The NAME signature only changes on rename/
    // create/delete, so the O(n^2) containment pair discovery is cached behind
    // it; a normal content edit reuses the pairs and only re-verifies first
    // sentences. The CONTENT signature (path+mtime) gates the re-verification.
    private autoExcludePairs: { shorterPath: string; longerPath: string }[] = [];
    private autoExcludeNameSig: string = '';
    private autoExcludeContentSig: string = '';

    // Fuzzy-match index: normalized keyword (lowercased) -> candidate entries.
    // Built alongside the prefix tree when fuzzy matching is enabled.
    fuzzyKeywordMap: Map<string, { files: Set<TFile>; headerId?: string; canonical?: string }[]> = new Map();

    // Keywords that exist in the exact-match tree ONLY because something was
    // normalized away: a stemmed / stopword-stripped variant or a
    // heading keyword whose leading number was stripped. A hit on one of these
    // is already an exact tree match, but it is not what the user wrote
    // verbatim - so it is reported as a FUZZY match and gets the fuzzy colour
    // instead of the exact colour. Matching itself is unchanged.
    derivedKeywords: Set<string> = new Set();
    // First-char bucket index: bucket key (first char of normalized keyword) -> list
    // of normalized keywords. Lets findFuzzyMatches only scan the relevant bucket
    // instead of the entire map (the main source of the earlier performance lag).
    private fuzzyBuckets: Map<string, string[]> = new Map();
    // Distinct lengths of every normalized keyword in the fuzzy index. Used to
    // short-circuit the sliding window: a query whose length is more than 2 away
    // from every indexed length can never reach the >=80% similarity threshold,
    // so it can be skipped without running fuzzyNormalize / similarity at all.
    private fuzzyKeywordLengths: Set<number> = new Set();
    // Minimum normalized length among indexed fuzzy keywords. Exposed so the
    // sliding window can skip candidates shorter than this minus the max length
    // diff (2) without even running fuzzyNormalize.
    public minFuzzyKeywordLen = Infinity;
    // Maximum normalized length among indexed fuzzy keywords. Exposed so the
    // sliding window can skip overly long candidates (e.g. inside long paragraphs)
    // without running fuzzyNormalize. Since normalization only strips stopwords
    // (never grows), a candidate more than 2x this length cannot shrink enough to
    // match.
    public maxFuzzyKeywordLen = 0;
    // Minimum length (characters) of a normalized keyword to be indexed for fuzzy
    // matching. Shorter titles/notes are skipped — fuzzy-matching them is useless
    // and error-prone. Set from settings.fuzzyMinLength at tree build time.
    public fuzzyMinLength = 0;

    // Guards against concurrent index builds; see updateTree().
    private treeUpdateInFlight: Promise<void> | null = null;
    private treeUpdateInFlightKey = '';
    // Bumped by clear() so an in-flight build against the OLD index is never
    // reused once the index was thrown away: its '*' key would otherwise collide
    // with a new full rebuild, which would then join a build whose already-
    // processed files no longer exist - truncating the index.
    private generation = 0;

    // Per-path cache for frontmatter exclude lists; see
    // getFrontmatterExcludeListForFile().
    private frontmatterExcludeCache: Map<string, { mtime: number; excluded: Set<string> }> = new Map();

    private static readonly SUPPORTED_EXTENSIONS = [
        'md', 'png', 'jpg', 'jpeg', 'gif', 'svg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx',
        'mp3', 'wav', 'ogg',
        'mp4', 'mov', 'avi', 'webm'
    ];

    // Resolves once the initial (asynchronous) index build has finished. The
    // tree is built in chunks so a huge vault never blocks the UI, which means
    // the tree is still empty while the plugin is loading - editors that render
    // at that moment find no links. They await this promise to refresh.
    public isReady = false;
    public readyPromise: Promise<void>;
    private readyResolve: (() => void) | null = null;

    constructor(public app: App, public settings: LinkerPluginSettings) {
        this.fetcher = new LinkerMetaInfoFetcher(this.app, this.settings);
        this.fuzzyMinLength = settings.fuzzyMinLength ?? 4;
        // The tree is NOT built here: doing so raced with the updateCache(true)
        // call that follows, so two builds ran at once and "ready" fired while
        // the tree was still half-built. Builds are driven solely by updateCache
        // now, which calls markReady() once a build actually completes.
        this.readyPromise = new Promise((resolve) => { this.readyResolve = resolve; });
    }

    markReady() {
        if (!this.isReady) {
            this.isReady = true;
            this.readyResolve?.();
        }
    }

    /** The index was thrown away, so anything waiting on readyPromise has to wait
     *  for the rebuild instead of proceeding against an empty index. */
    resetReady() {
        this.isReady = false;
        this.readyPromise = new Promise((resolve) => { this.readyResolve = resolve; });
    }

    clear() {
        this.generation++;
        this.root = new PrefixNode();
        this._currentNodes = [];
        this.setIndexedFilePaths.clear();
        this.mapIndexedFilePathsToUpdateTime.clear();
        this.mapFilePathToLeaveNodes.clear();
        this.mapFileHeaderIds.clear();
        this.fuzzyKeywordMap.clear();
        this.frontmatterExcludeCache.clear();
        this.fuzzyBuckets.clear();
        this.fuzzyKeywordLengths.clear();
        this.derivedKeywords.clear();
        this.minFuzzyKeywordLen = Infinity;
        this.maxFuzzyKeywordLen = 0;
        // NOTE: autoExcludedPaths / firstSentenceCache / autoExcludePairs are
        // intentionally NOT cleared here. clearCache() is called on every
        // updateManager.update() (including the onIndexChanged refresh triggered
        // by auto-exclude itself). Clearing them would re-index the just-excluded
        // note and re-trigger onIndexChanged forever. Stale auto-exclusions are
        // instead lifted inside computeAutoExclude when a pair's first sentence
        // diverges (or the pair file disappears); turning the setting off simply
        // stops shouldExcludeFile from consulting them.
    }

    // Reusable row buffers for editDistance: the fuzzy scan calls it for every
    // candidate keyword, so allocating two arrays per comparison produced a
    // steady stream of garbage on every keystroke. The method is synchronous
    // and never re-entrant, so one shared pair of rows (grown on demand) is
    // safe.
    private static editRowA: number[] = [];
    private static editRowB: number[] = [];

    // Levenshtein edit distance between two strings.
    private static editDistance(a: string, b: string): number {
        const m = a.length;
        const n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        let prev = PrefixTree.editRowA;
        let curr = PrefixTree.editRowB;
        if (prev.length < n + 1) prev = PrefixTree.editRowA = new Array<number>(n + 1);
        if (curr.length < n + 1) curr = PrefixTree.editRowB = new Array<number>(n + 1);
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
    findFuzzyMatches(word: string, threshold: number, excludeFile?: TFile | null, renderedFile?: TFile | null): { files: Set<TFile>; headerId?: string; canonical?: string; similarity: number }[] {
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
        // Keyword exclusion has to be consulted below; skip the call entirely
        // when the list is empty (the common case).
        const hasExcludedKeywords = this.settings.excludedKeywords.length > 0;
        // Same for the per-note frontmatter lists: getCurrentMatchNodes consults
        // both the rendered note's list and every target file's own list.
        const activeExcludeList = this.settings.enableFrontmatterExcludeList
            ? this.getFrontmatterExcludeList(renderedFile)
            : null;
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
                    // Keyword exclusion applies here too. getCurrentMatchNodes
                    // drops an excluded keyword from the EXACT matches, and
                    // without this the same keyword came straight back through
                    // the fuzzy path - so a keyword the user excluded (globally,
                    // or for the note being viewed under per-note mode)
                    // reappeared as a fuzzy match. That is the "exact match
                    // turned fuzzy" symptom, and it varied with which note was
                    // open because per-note mode reads the ACTIVE file.
                    if (hasExcludedKeywords
                        && ((e.canonical !== undefined && this.isExcluded(e.canonical, renderedFile)) || this.isExcluded(key, renderedFile))) {
                        continue;
                    }
                    // The per-note frontmatter lists are consulted on the exact
                    // side too (the active note's list and each target file's own
                    // list), so mirror them here as well.
                    if (activeExcludeList) {
                        const lowerKey = key.toLowerCase();
                        const lowerCanonical = e.canonical?.toLowerCase();
                        const hit = (list: Set<string>): boolean =>
                            list.has(lowerKey) || (lowerCanonical !== undefined && list.has(lowerCanonical));
                        if (hit(activeExcludeList)) continue;
                        let excludedByTarget = false;
                        for (const f of e.files) {
                            if (hit(this.getFrontmatterExcludeListForFile(f))) { excludedByTarget = true; break; }
                        }
                        if (excludedByTarget) continue;
                    }

                    // Respect excludeLinksToOwnNote: drop the current note from
                    // fuzzy results, mirroring getCurrentMatchNodes' excludedNote.
                    let files = e.files;
                    if (excludeFile) {
                        files = new Set([...e.files].filter((f) => f.path !== excludeFile.path));
                        if (files.size === 0) continue;
                    }
                    // Final gate: re-apply the unified exclusion check (extension /
                    // directory / includeAllFiles) so a stale index entry can never
                    // leak a fuzzy link to an excluded file (e.g. excludedDirectories
                    // changed but the tree hasn't been re-indexed yet).
                    files = new Set([...files].filter((f) => !this.shouldExcludeFile(f)));
                    if (files.size === 0) continue;
                    results.push({ files, headerId: e.headerId, canonical: e.canonical, similarity: sim });
                }
            }
        }
        // Best match first. Callers take the top result, and without sorting they
        // would get whichever entry happened to be indexed first — possibly a
        // worse match than one further down. Ties keep their relative order so
        // callers can group them into a single multi-target link.
        return results.sort((a, b) => b.similarity - a.similarity);
    }

    // Lowercased excludedKeywords, cached so the match hot path does not
    // re-lowercase the whole list for every candidate at every position.
    // Invalidated by array identity: every code path that changes the list
    // assigns a fresh array to the (Object.assign-ed) settings object.
    private cachedExcludedKeywordsRef: string[] | null = null;
    private cachedExcludedKeywordsSet: Set<string> = new Set();

    private getExcludedKeywordSet(): Set<string> {
        if (this.cachedExcludedKeywordsRef !== this.settings.excludedKeywords) {
            this.cachedExcludedKeywordsRef = this.settings.excludedKeywords;
            this.cachedExcludedKeywordsSet = new Set(
                this.settings.excludedKeywords.map(kw => kw.toLowerCase())
            );
        }
        return this.cachedExcludedKeywordsSet;
    }

    private isExcluded(value: string, renderedFile?: TFile | null): boolean {
        const valueLower = value.toLowerCase();
        // If per-note mode is enabled, only apply exclusion to notes with the frontmatter property
        if (this.settings.perNoteExcludeKeywords) {
            // The opt-in property is read from the note being RENDERED, not the
            // focused one: previewing B while A is active must consult B's
            // frontmatter, the same way the heading rule uses the rendered note.
            const target = renderedFile === undefined
                ? this.app.workspace.getActiveFile()
                : renderedFile;
            if (!target) return false;
            const metadata = this.app.metadataCache.getFileCache(target);
            const propValue: unknown = metadata?.frontmatter?.[this.settings.frontmatterExcludeProperty];
            // Only exclude if the note has the property set to true/truthy
            if (!propValue) return false;
        }
        return this.getExcludedKeywordSet().has(valueLower);
    }

    // Global-only exclusion check (used when building the trie, not per-note)
    private isGloballyExcluded(value: string): boolean {
        // When per-note mode is enabled, don't filter from the trie
        // (filtering happens at match time in getCurrentMatchNodes)
        if (this.settings.perNoteExcludeKeywords) return false;
        const valueLower = value.toLowerCase();
        return this.getExcludedKeywordSet().has(valueLower);
    }

    // Collect extra per-note excluded keywords from a file's frontmatter list property
    private getFrontmatterExcludeListForFile(file: TFile): Set<string> {
        const excluded = new Set<string>();
        if (!this.settings.enableFrontmatterExcludeList) return excluded;

        // Cache by path + list-property name + mtime. getCurrentMatchNodes calls
        // this for the note being rendered and again for every matched target
        // file, and it runs at nearly every character position - so each call
        // used to re-read and re-parse the note's frontmatter. The property
        // name is part of the key: changing the setting must not serve lists
        // that were parsed under the old property.
        const mtime = file.stat?.mtime ?? 0;
        const cacheKey = file.path + '|' + this.settings.frontmatterExcludeListProperty;
        const cached = this.frontmatterExcludeCache.get(cacheKey);
        if (cached && cached.mtime === mtime) return cached.excluded;

        const metadata = this.app.metadataCache.getFileCache(file);
        // metadata is null while the cache is still resolving. Do NOT cache that
        // empty result: it would be pinned to this mtime and the note's exclude
        // list would stay empty until its next edit (addFileToTree bails out for
        // the same reason instead of indexing a half-known file).
        if (!metadata) return excluded;
        const propValue: unknown = metadata.frontmatter?.[this.settings.frontmatterExcludeListProperty];
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
        this.frontmatterExcludeCache.set(cacheKey, { mtime, excluded });
        return excluded;
    }

    // Collect extra per-note excluded keywords:
    // 1) from the note being rendered (exclude words while reading that note)
    // 2) from every matched target file (a note can opt its own name/keywords out of being linked anywhere)
    private getFrontmatterExcludeList(renderedFile?: TFile | null): Set<string> {
        const excluded = new Set<string>();
        if (!this.settings.enableFrontmatterExcludeList) return excluded;

        // Read the list from the note being RENDERED, not the focused one:
        // previewing B while A is active must use B's list.
        const target = renderedFile === undefined
            ? this.app.workspace.getActiveFile()
            : renderedFile;
        if (target) {
            for (const kw of this.getFrontmatterExcludeListForFile(target)) {
                excluded.add(kw);
            }
        }
        return excluded;
    }

    /**
     * @param excludedNote  Note whose own matches are dropped (the note being
     *                      rendered, when excludeLinksToOwnNote is on).
     * @param specificFile  Restrict the result to this one file.
     * @param renderedFile  The note being rendered, for the "a heading must not
     *                      link to its own note" rule. Pass null when the call
     *                      is not a render decision (headerId lookups) so the
     *                      rule stays out of the way; omit it to fall back to
     *                      the active file.
     */
    getCurrentMatchNodes(index: number, excludedNote?: TFile | null, specificFile?: TFile, renderedFile?: TFile | null): MatchNode[] {
        const matchNodes: MatchNode[] = [];

        if (excludedNote === undefined && this.settings.excludeLinksToOwnNote) {
            excludedNote = this.app.workspace.getActiveFile();
        }

        // Get per-note extra excluded keywords from frontmatter
        const frontmatterExcluded = this.getFrontmatterExcludeList(renderedFile);

        for (const node of this._currentNodes) {
            const valueString = this.getNodeValue(node.node);
            if (node.node.files.size === 0 || this.isExcluded(valueString, renderedFile)) {
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
                                    this.headingKeyword(h.heading).toLowerCase() === nodeValue.toLowerCase()
                                );
                            }
                        } else {
                            headingMatch = metadata.headings.find(h => 
                                this.headingKeyword(h.heading).toLowerCase() === nodeValue.toLowerCase()
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

            // Check if the case is matched. The old parent-chain walk here
            // evaluated node.caseIsMatched once per node it visited, so it
            // collapsed to this single assignment (MatchNode starts matched).
            matchNode.caseIsMatched = node.caseIsMatched;

            // Check if the match starts at a word boundary
            matchNode.startsAtWordBoundary = node.startedAtWordBeginning;

            if (matchNode.requiresCaseMatch && !matchNode.caseIsMatched) {
                continue;
            }

            if (matchNode.files.size > 0) {
                // Never allow headers to link to their own file.
                //
                // "Their own file" means the note being RENDERED, not the one
                // the workspace has focused. Previewing note B while note A is
                // active must still link B's text to A's headings - testing the
                // active file here emptied those matches, and the fuzzy path,
                // which carries no such rule, then took over: the exact match
                // appeared in the fuzzy colour. Same symptom the mappedFile
                // comment in liveLinker describes for hover popovers.
                if (matchNode.type === MatchType.Header) {
                    const ownFile = renderedFile === undefined
                        ? this.app.workspace.getActiveFile()
                        : renderedFile;
                    if (ownFile) {
                        matchNode.files = new Set(
                            Array.from(matchNode.files).filter(f => f.path !== ownFile.path)
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

    /** True when this keyword only exists because something was normalized away
     *  (stemming / stripped function words / stripped heading number). Callers
     *  use it to show such a match with the fuzzy colour. Case-insensitive. */
    isDerivedKeyword(name: string): boolean {
        return this.derivedKeywords.has(name.toLowerCase());
    }

    private addFileWithName(name: string, file: TFile, matchCase: boolean, headerId?: string, canonicalKeyword?: string, canonicalHeaderId?: string) {
        // Skip single-character keywords: they produce spurious virtual links
        // (e.g. "关" matching "下关" or "带" matching "带下") and are never
        // intended by the user as glossary entries.
        if (name.length < 2) return;

        // A variant of another keyword (canonicalKeyword differs from what is
        // being inserted) is derived, not written by the user.
        if (canonicalKeyword && canonicalKeyword.toLowerCase() !== name.toLowerCase()) {
            this.derivedKeywords.add(name.toLowerCase());
        }

        let node = this.root;

        // For each character in the name, add a node to the trie
        for (const char of name) {
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
        // OR, not assign: the trie node is shared across notes, and the last file
        // to index a given keyword used to overwrite the case rule for every other
        // file on that node. Take the stricter value so a case-sensitive note is
        // never silently relaxed by a later case-insensitive one.
        node.requiresCaseMatch = node.requiresCaseMatch || matchCase;

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

        // Register fuzzy keywords so that words with similarity >=
        // threshold can still link. Every keyword reaching this point is indexed,
        // including ones that normalization left unchanged (e.g. "科目二冲刺带背3"
        // has no function words to strip). Indexing only the "changed" ones meant
        // any keyword without a function word could never be fuzzy-matched at
        // all — which excluded most Chinese titles.
        // Short keywords are skipped: fuzzy-matching them is both useless and
        // error-prone (e.g. 的 -> 地).
        if (canonicalKeyword) {
            const key = name.toLowerCase();
            // Index from 2 chars up. Deliberately NOT gated on fuzzyMinLength:
            // gating it there made the index agree with the query side, but with
            // the default fuzzyMinLength of 6 it dropped nearly every keyword
            // (English stems are usually < 7 chars, and common Chinese entries are
            // 3-6), which silently removed fuzzy links for existing users. The
            // query side still enforces fuzzyMinLength.
            if (key.length >= 2) {
                this.fuzzyKeywordLengths.add(key.length);
                if (key.length < this.minFuzzyKeywordLen) this.minFuzzyKeywordLen = key.length;
                if (key.length > this.maxFuzzyKeywordLen) this.maxFuzzyKeywordLen = key.length;
                const entry = { files: node.files, headerId, canonical: canonicalKeyword };
                const list = this.fuzzyKeywordMap.get(key);
                if (list) {
                    // Replace any entry pointing at this very node, and drop ones
                    // whose file set removeFileFromTree emptied.
                    //
                    // Filtering only on "empty" was not enough: when several notes
                    // share a keyword (same title, same heading - very common),
                    // removing one leaves the shared Set non-empty, so the old
                    // entry survived and a duplicate was appended on every
                    // rebuild. The list then grew for the whole session and every
                    // fuzzy lookup had to walk all of it.
                    const kept = list.filter((e) =>
                        e.files.size > 0
                        && !(e.files === node.files && e.headerId === headerId && e.canonical === canonicalKeyword));
                    kept.push(entry);
                    this.fuzzyKeywordMap.set(key, kept);
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
    }

    // Get the header ID for a file and keyword, used for heading highlight on jump
    getFileHeaderId(file: TFile, keyword: string): string | undefined {
        return this.mapFileHeaderIds.get(file.path)?.get(keyword);
    }

    // True when a query of the given normalized length could possibly reach the
    // similarity threshold against some indexed fuzzy keyword. The threshold is
    // always >= 80 (see fuzzyMatchThreshold slider), so the maximum length
    // difference that can still hit is 2. This is a pure short-circuit: calling
    // it never changes which keywords get matched, it only skips work.
    couldMatchFuzzyLength(length: number): boolean {
        for (const len of this.fuzzyKeywordLengths) {
            if (Math.abs(len - length) <= 2) return true;
        }
        return false;
    }

    // Reconstruct full string by walking parent chain — replaces stored node.value
    private getNodeValue(node: PrefixNode): string {
        // This used to rebuild the string on every call, and it runs once per
        // live node per scan position in getCurrentMatchNodes - a constant GC
        // churn on large vaults. The chain is immutable after creation, so cache
        // the result on the node.
        if (node.fullValue !== undefined) return node.fullValue;
        const chars: string[] = [];
        let current: PrefixNode | undefined = node;
        while (current && current !== this.root) {
            if (current.charValue) chars.push(current.charValue);
            current = current.parent;
        }
        const value = chars.reverse().join('');
        node.fullValue = value;
        return value;
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

    /**
     * Unified check for whether a file should be excluded from being a virtual
     * link target. Both the exact-match index (prefix tree) and the fuzzy-match
     * index (fuzzyKeywordMap) share this, so both obey the exact same exclusion
     * rules (extension / directory / includeAllFiles).
     */
    // Public mirror of shouldExcludeFile for UI decisions (e.g. the context
    // menu choosing between "Exclude this file" and "Include this file").
    isFileExcluded(file: TFile): boolean {
        return this.shouldExcludeFile(file);
    }

    private shouldExcludeFile(file: TFile): boolean {
        const path = file.path;

        // Auto-excluded renamed duplicate (longer-named note sharing the first
        // sentence of a shorter-named note). Equivalent to a linker-exclude tag.
        if (this.settings.autoExcludeContainedCopies && this.autoExcludedPaths.has(path)) {
            return true;
        }

        // Exclude notes whose file name starts or ends with a configured
        // word/symbol (e.g. a "副本" suffix or a "_" prefix on draft notes).
        const affixes = this.settings.filenameAffixExclusions;
        if (affixes && affixes.length > 0) {
            const name = file.basename;
            if (affixes.some((a) => a && (name.startsWith(a) || name.endsWith(a)))) {
                return true;
            }
        }

        // Check if file extension is excluded
        if (hasExcludedExtension(path, this.settings.excludedExtensions)) {
            return true;
        }

        const metaInfo = this.fetcher.getMetaInfo(file);
        const includeFile = metaInfo.includeFile;
        const excludeFile = metaInfo.excludeFile;
        const isInIncludedDir = metaInfo.isInIncludedDir;
        const isInExcludedDir = metaInfo.isInExcludedDir;

        if (excludeFile || (isInExcludedDir && !includeFile)) {
            return true;
        }
        if (!includeFile && !isInIncludedDir && !metaInfo.includeAllFiles) {
            return true;
        }
        return false;
    }

    private addFileToTree(file: TFile) {
        const path = file.path;

        if (!file || !path) {
            return;
        }

        // Unified exclusion check, hoisted before any indexing bookkeeping so an
        // excluded file is never registered in the index metadata.
        if (this.shouldExcludeFile(file)) {
            // It may have been indexed before it became excluded (a tag was added,
            // a directory excluded, auto-exclude kicked in). Remove its entries,
            // otherwise the exact-match path keeps linking to it (the fuzzy path
            // already hides it via shouldExcludeFile) - the mirror of the
            // "exact becomes fuzzy" symptom.
            this.removeFileFromTree(file);
            return;
        }

        // NOTE: the tree is deliberately NOT touched yet. Everything that can
        // throw (reading the metadata cache, computing keywords) runs first, so
        // a failure leaves the file's existing entries in place - see the
        // comment next to removeFileFromTree further down.

        // Get the tags of the file
        // and normalize them by removing the # in front of tags
        const fileCache = this.app.metadataCache.getFileCache(file);
        const tagsArray: string[] | null = fileCache ? getAllTags(fileCache) : null;
        const tags = (tagsArray ?? []).filter(s => PrefixTree.isNoneEmptyString(s))
            .map((tag) => (tag.startsWith('#') ? tag.slice(1) : tag));

        const metadata = this.app.metadataCache.getFileCache(file);
        // Obsidian has NOT parsed this file's metadata yet - getFileCache
        // returns null until it has. Indexing it now would register the file
        // with no headings and no aliases, and because the mtime is recorded as
        // indexed it would never be retried: every link pointing at the file
        // would silently degrade to fuzzy matching, heading ids and all. That
        // is exactly the "opened note's exact matches turn fuzzy" symptom -
        // previewing or opening a note can re-index it while its metadata is
        // still being resolved.
        //
        // Bail out without touching the tree: previous entries (if any) stay,
        // and nothing is marked as indexed, so the next updateTree() call -
        // triggered by the metadataCache 'changed' listener - retries.
        if (!metadata) return;

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
                                // The heading id must be the heading TEXT, exactly as
                                // Obsidian uses it in "[[note#heading]]" links. It used
                                // to be slugified (lowercased, spaces => dashes), which
                                // Obsidian cannot resolve back to a heading - the jump
                                // missed, and the alignment then centred a neighbour.
                                headerEntries.push({ keyword, headerId: h.heading });
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
                            headerEntries.push({ keyword: this.headingKeyword(h.heading), headerId: h.heading });
                        }
                    }
                }
            } else {
                headerEntries = metadata.headings.map(h => ({ keyword: this.headingKeyword(h.heading), headerId: h.heading }));
            }
        }

        const aliasesWithMatchCase: Set<string> = new Set((metadata?.frontmatter?.[this.settings.propertyNameToMatchCase] as string[]) ?? []);
        const aliasesWithIgnoreCase: Set<string> = new Set((metadata?.frontmatter?.[this.settings.propertyNameToIgnoreCase] as string[]) ?? []);

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

        // Everything that can throw has run - only NOW touch the tree. Removing
        // the old entries is destructive (prefix-tree nodes, heading ids, fuzzy
        // entries); if a read above failed after that point, the file would be
        // left unindexed and every link pointing at it would degrade to fuzzy
        // matching, heading ids included. That is exactly the symptom a hover
        // preview used to produce: previewing a note re-indexes it, and a
        // metadata cache that is mid-update can fail the reads above. Doing the
        // reads first means a failure simply leaves the previous entries alone.
        this.removeFileFromTree(file);

        // Register the file as indexed (removeFileFromTree just deleted these)
        this.setIndexedFilePaths.add(path);
        this.mapIndexedFilePathsToUpdateTime.set(path, file.stat.mtime);

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
            if (tags.includes(this.settings.tagToIgnoreCase)) {
                namesWithCaseIgnore = [...names];
            } else {
                namesWithCaseMatch = [...names];
            }
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
                // Fuzzy match: reduce a keyword to a normalized
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
                // Note: an unchanged result (`fuzzy === name`) is NOT skipped —
                // keywords with no function words still need a fuzzy-index entry,
                // otherwise a near-miss input (e.g. "科目冲刺带背3" for the note
                // "科目二冲刺带背3") can never match.
                if (!fuzzy || fuzzy.length < 2) {
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
            // Deliberately NOT addStem for namesWithCaseMatch: stem variants are
            // registered case-insensitively (the exact-trie node gets
            // matchCase=false and the fuzzy index keys are lowercased), so a
            // case-matched keyword like "NASA" would become reachable from body
            // text "nasa" via the stem node / fuzzy path, silently bypassing
            // requiresCaseMatch. Exact matches still enforce the case rule
            // through the original trie node.
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
            // Fast path: no stopword present, nothing to strip. Most candidates
            // hit this — the per-stopword split/join loop below is what made
            // scrolling lag, so avoid it whenever possible.
            if (!FUZZY_ZH_STOPWORD_TEST.test(name)) {
                return name.trim() || '';
            }
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
            // Remove the file from the node IN PLACE.
            //
            // Replacing the Set (node.files = new Set(...)) silently broke the
            // fuzzy index: addFileWithName stores this very Set by reference in
            // fuzzyKeywordMap, so a fresh Set left every existing entry pointing
            // at the old, still-populated one. A deleted, renamed or newly
            // excluded note then kept being returned by fuzzy matching, and
            // clicking such a link opened a note that no longer existed.
            for (const f of node.files) {
                if (f.path === path) node.files.delete(f);
            }
        }

        // If the nodes have no files or children, remove them from the tree
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            let currentNode = node;
            while (currentNode.files.size === 0 && currentNode.children.size === 0) {
                const parent = currentNode.parent;
                if (!parent) {
                    break;
                }
                parent.children.delete(currentNode.charValue);
                // Stop at the root itself (it has no parent to delete it from).
                // The old code stopped one level EARLIER, which left the now
                // empty first-character node in root.children forever - one
                // orphan per removed keyword, accumulated for the whole session.
                if (parent === this.root) {
                    break;
                }
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

    /**
     * Rebuild the index. Concurrent rebuilds are coalesced: every open pane (plus
     * the settings callback) asks for one at the same time, and each run removes
     * and re-adds files on the SAME tree, so interleaving them left it half-built
     * for a moment - links flickered in and out. A rebuild asking for the same
     * files shares the one already running; a different one waits its turn.
     */
    async updateTree(updateFiles?: (string | undefined)[]) {
        const key = `${this.generation}\u0000${updateFiles?.length ? updateFiles.join('\u0000') : '*'}`;
        // Loop, not a single `await`: several callers can be parked on the same
        // in-flight build, and one await would release them all at once - they
        // would then rebuild concurrently, which is exactly what this guard
        // exists to prevent. Re-check after every wait instead.
        for (;;) {
            if (this.treeUpdateInFlight && this.treeUpdateInFlightKey === key) {
                return this.treeUpdateInFlight;
            }
            if (!this.treeUpdateInFlight) break;
            await this.treeUpdateInFlight;
        }
        const run = this.doUpdateTree(updateFiles);
        this.treeUpdateInFlight = run;
        this.treeUpdateInFlightKey = key;
        try {
            await run;
        } finally {
            this.treeUpdateInFlight = null;
            this.treeUpdateInFlightKey = '';
        }
    }

    private async doUpdateTree(updateFiles?: (string | undefined)[]) {
        this.fetcher.refreshSettings();

        const currentVaultFiles = new Set<string>();
        let files = new Array<TFile>();

        // Get all files and filter for supported types
        const allFiles = this.app.vault.getFiles().filter((file): file is TFile => {
            const ext = file.extension.toLowerCase();
            return PrefixTree.SUPPORTED_EXTENSIONS.includes(ext);
        });

        allFiles.forEach((f) => currentVaultFiles.add(f.path));

        // Rebuild everything only when no explicit file list was given.
        //
        // `allFiles.length !== this.setIndexedFilePaths.size` used to be part of
        // this test, which made it true on EVERY call once a vault held any
        // excluded file: excluded files are never added to setIndexedFilePaths,
        // so the two counts can never match (SUPPORTED_EXTENSIONS includes mp4
        // and the default settings exclude it). Every save then re-scanned the
        // whole vault instead of the single note that changed. Additions and
        // deletions are already covered by the vault create/delete/rename
        // listeners, which schedule a full refresh.
        if (!updateFiles?.length) {
            files = allFiles;
        } else {
            // If files are provided, only update the provided files
            files = updateFiles
                .map((f) => f ? this.app.vault.getAbstractFileByPath(f) : null)
                .filter((f): f is TFile => f instanceof TFile);
        }

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            // Check if the file has been updated
            if (this.fileIsUpToDate(file)) {
                continue;
            }

            // Otherwise, add the file to the tree
            try {
                this.addFileToTree(file);
            } catch {
                // A failure here is not harmless: addFileToTree removes the
                // file's existing entries FIRST, so an error in the middle
                // leaves the file unindexed - and every link pointing at it
                // degrades to fuzzy matching (its heading ids are gone too).
                // That is exactly what a hover preview used to trigger, because
                // previewing a note re-indexes that note. The usual cause is a
                // metadata cache that is mid-update, so give it one more go
                // before reporting it.
                try {
                    this.addFileToTree(file);
                } catch (err) {
                    console.error('[fakelink] failed to index', file.path, err);
                }
            }

            // Yield every 256 files so indexing a huge vault never blocks the
            // UI. A long synchronous loop here is what made enabling the plugin
            // freeze on very large vaults.
            if ((i & 0xff) === 0) {
                await new Promise((resolve) => window.setTimeout(resolve, 0));
            }
        }

        // Remove files that are no longer in the vault
        const filesToRemove = [...this.setIndexedFilePaths].filter((f) => !currentVaultFiles.has(f));
        filesToRemove.forEach((f) => this.removeFileFromTree(f));
    }

    // Extract the "first sentence" of a note's body: the first non-empty line
    // after the YAML frontmatter, with leading Markdown markers (# / - / * / + /
    // > / numbered-list) and surrounding whitespace stripped. Used by
    // auto-exclude to decide whether two notes are renamed duplicates.
    private static extractFirstSentence(content: string): string {
        if (!content) return '';

        let body = content;
        // Strip YAML frontmatter if present.
        const fm = body.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
        if (fm) {
            body = body.slice(fm[0].length);
        }

        for (const rawLine of body.split(/\r?\n/)) {
            let line = rawLine.trim();
            if (!line) continue;

            // Strip leading Markdown block markers. The (?:...)+ repeats to handle
            // nesting like "- # heading" or "1. - item". A bare "-" is kept (it
            // needs a following space to be a list marker).
            line = line.replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)、]\s*)+/, '').trim();

            if (line) return line;
        }

        return '';
    }

    // Read a file's first sentence, caching it by path and invalidating on mtime
    // change so edits are picked up.
    private async getFirstSentence(file: TFile): Promise<string> {
        const cached = this.firstSentenceCache.get(file.path);
        if (cached && cached.mtime === file.stat.mtime) {
            return cached.sentence;
        }

        let content = '';
        try {
            content = await this.app.vault.cachedRead(file);
        } catch {
            try {
                content = await this.app.vault.read(file);
            } catch {
                content = '';
            }
        }

        const sentence = PrefixTree.extractFirstSentence(content);
        this.firstSentenceCache.set(file.path, { mtime: file.stat.mtime, sentence });
        return sentence;
    }

    // Auto-exclude renamed duplicates: find note pairs where one file name fully
    // contains another (shorter ⊂ longer) AND both notes share the same first
    // sentence, then exclude the longer-named note. Runs asynchronously because
    // the first sentence requires reading file content. Returns true when the
    // index changed so the caller can refresh decorations.
    async computeAutoExclude(): Promise<boolean> {
        if (!this.settings.autoExcludeContainedCopies) return false;

        const allFiles = this.app.vault.getFiles().filter((file): file is TFile =>
            PrefixTree.SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())
        );

        // Two signatures: the NAME signature only changes on rename/create/
        // delete (rare), while the CONTENT signature changes on every save.
        // The O(n^2) containment pair scan is cached behind the name signature,
        // so a normal edit reuses the pairs and only re-verifies first
        // sentences (themselves cached by mtime). The old single path+mtime
        // signature re-ran the full O(n^2) scan on EVERY save, which froze
        // Obsidian on large vaults after each edit.
        const nameSig = allFiles.map((f) => `${f.path}\u0000${f.basename}`).sort().join('|');
        const contentSig = allFiles.map((f) => `${f.path}:${f.stat.mtime}`).sort().join('|');
        if (nameSig === this.autoExcludeNameSig && contentSig === this.autoExcludeContentSig) {
            return false;
        }

        if (nameSig !== this.autoExcludeNameSig) {
            this.autoExcludeNameSig = nameSig;

            // Candidates: notes that are currently indexed (not already excluded).
            const candidates: { file: TFile; name: string }[] = [];
            for (const file of allFiles) {
                if (this.shouldExcludeFile(file)) continue;
                const name = file.basename;
                if (name && name.length >= 2) candidates.push({ file, name });
            }

            // Sort by name length ascending so the shorter name is the outer loop.
            candidates.sort((a, b) => a.name.length - b.name.length);

            // Pass 1: collect containment pairs. The shorter name must be a
            // strict substring of a longer name (equal-length names are
            // skipped).
            //
            // This is O(n^2) over the whole vault, so it yields to the event
            // loop periodically. Running it straight through froze Obsidian for
            // the whole duration on a large vault when the setting was switched
            // on. Pairs are stored as paths so they survive the index rebuilds
            // that auto-exclude itself triggers.
            const pairs: { shorterPath: string; longerPath: string }[] = [];
            for (let i = 0; i < candidates.length; i++) {
                const shorter = candidates[i];
                if (i % 200 === 199) await new Promise((resolve) => window.setTimeout(resolve, 0));
                for (let j = i + 1; j < candidates.length; j++) {
                    const longer = candidates[j];
                    if (longer.name.length === shorter.name.length) continue;
                    if (longer.name.includes(shorter.name)) {
                        pairs.push({ shorterPath: shorter.file.path, longerPath: longer.file.path });
                    }
                }
            }
            this.autoExcludePairs = pairs;
        }
        this.autoExcludeContentSig = contentSig;

        // Pass 2 (async): read first sentences only for the (few) containment
        // pairs. getFirstSentence is cached by mtime, so on a normal save only
        // the edited file hits the disk.
        let changed = false;
        const stillMatching = new Set<string>();
        for (const pair of this.autoExcludePairs) {
            const shorter = this.app.vault.getFileByPath(pair.shorterPath);
            const longer = this.app.vault.getFileByPath(pair.longerPath);
            if (!shorter || !longer) continue;
            const shortSentence = await this.getFirstSentence(shorter);
            const longSentence = await this.getFirstSentence(longer);
            if (shortSentence && longSentence && shortSentence === longSentence) {
                stillMatching.add(pair.longerPath);
                if (!this.autoExcludedPaths.has(pair.longerPath)) {
                    this.autoExcludedPaths.add(pair.longerPath);
                    this.removeFileFromTree(longer);
                    changed = true;
                }
            }
        }

        // Lift stale exclusions: the first sentence diverged (or the pair file
        // disappeared), so the longer note is a real note again. Re-add it to
        // the tree; addFileToTree re-checks every exclusion rule first. This
        // also cleans up entries for deleted files. The old code kept such
        // exclusions sticky until a full plugin reload.
        for (const path of [...this.autoExcludedPaths]) {
            if (stillMatching.has(path)) continue;
            this.autoExcludedPaths.delete(path);
            const file = this.app.vault.getFileByPath(path);
            if (file) {
                this.addFileToTree(file);
            }
            changed = true;
        }

        return changed;
    }

    resetSearch() {
        // this._current = this.root;
        this._currentNodes = [new VisitedPrefixNode(this.root)];
    }

    pushChar(char: string) {
        const newNodes: VisitedPrefixNode[] = [];
        // Nodes already queued, so the membership test below is O(1). It used to
        // rebuild an array of every queued node and scan it linearly for each
        // node in _currentNodes, which made pushChar quadratic in the number of
        // live nodes - and it runs once per character.
        const queued = new Set<PrefixNode>();
        const chars = [char, char.toLowerCase()];

        chars.forEach((c) => {
            const isBoundary = PrefixTree.checkWordBoundary(c);
            // Skip when already queued: for a lowercase char both entries of
            // `chars` are identical, which used to enqueue the root twice.
            if ((this.settings.matchAnyPartsOfWords || isBoundary || this.settings.matchEndOfWords)
                && !queued.has(this.root)) {
                newNodes.push(new VisitedPrefixNode(this.root, true, isBoundary));
                queued.add(this.root);
            }

            for (const node of this._currentNodes) {
                const child = node.node.children.get(c);
                const startedAtBoundary = node.startedAtWordBeginning;
                if (child && !queued.has(child)) {
                    const newVisited = new VisitedPrefixNode(child, char === c, startedAtBoundary);
                    newVisited.formattingDelta = node.formattingDelta;
                    newNodes.push(newVisited);
                    queued.add(child);
                }
            }
        });
        this._currentNodes = newNodes;
    }

    /**
     * True when the traversal currently sits on at least one COMPLETE keyword
     * (a node that has files), i.e. a keyword ends here.
     *
     * Callers use this to look for a match at this position even when the
     * current character is not a word boundary. Without it, a keyword followed
     * by another letter was never examined: CJK has no spaces and every Han
     * character counts as a letter, so "欧拉方程是变量" never produced a
     * boundary after 欧拉方程 - the exact match was skipped entirely and the
     * fuzzy fallback took over (matching a longer run, in the fuzzy colour).
     *
     * Whether the match is then ACCEPTED is still decided by the caller's
     * matchBeginningOfWords / matchEndOfWords rules - this only makes sure it is
     * looked at.
     */
    hasWordEnd(): boolean {
        for (const n of this._currentNodes) {
            if (n.node.files.size > 0) return true;
        }
        return false;
    }

    static checkWordBoundary(char: string): boolean {
        // \p{L}: any kind of letter; \p{N}: any kind of numeric character.
        // Digits count as word characters, so a name like "科目二冲刺带背3"
        // stays a single word instead of being cut off before the trailing digit.
        const pattern = /[^\p{L}\p{N}]/u;
        return pattern.test(char);
    }

    /**
     * Strip a leading heading number so that "### 1. 基础型课程" is indexed
     * under "基础型课程" instead of "1. 基础型课程". This fixes two problems:
     *   1) A list item "1. 基础型课程" (list marker "1." + text) was falsely
     *      matched as the heading, and its decoration swallowed the list marker,
     *      breaking the line layout (the trailing "视频" got pushed out).
     *   2) The same heading could not be matched from plain "基础型课程" in
     *      read mode, where the list marker is rendered separately.
     *
     * Recognized forms (Arabic/Chinese numerals, optional wrapping bracket,
     * optional multi-level, optional trailing whitespace):
     *   "1. 基础型课程", "1、基础型课程", "1) 基础型课程", "1.1 基础型课程",
     *   "一、基础型课程", "（一）基础型课程"
     * A bare number with no separator (e.g. "123") is left untouched.
     */
    static stripHeadingNumber(heading: string): string {
        // Guard against a heading entry whose text is missing (metadata cache
        // mid-update): returning it unchanged keeps the caller from throwing.
        if (typeof heading !== 'string' || heading.length === 0) return heading;

        const num = '(?:[0-9]+|[零一二三四五六七八九十百千]+)';
        const sep = '[.、)）]';
        const re = new RegExp(
            '^[\\s]*[（(]?' + num + sep + '[\\s]*' +
            '(?:' + num + sep + '[\\s]*)*' +
            '(?=\\S)'
        );
        const m = heading.match(re);
        return m ? heading.slice(m[0].length) : heading;
    }

    /**
     * Normalize a heading into its keyword form: strip the leading number
     * (see stripHeadingNumber) and remove every symbol listed in the heading
     * symbol whitelist. The whitelist lets users decorate headings with
     * markers (e.g. 🔥) without those markers becoming part of the keyword.
     */
    private headingKeyword(heading: string): string {
        // A metadata cache that is mid-update can hand out a heading entry
        // without its text. Treat that as "no keyword" rather than throwing:
        // a throw here used to leave the whole file unindexed (see
        // addFileToTree), which turned every link to it into a fuzzy match.
        if (typeof heading !== 'string' || heading.length === 0) return '';

        // Stripping the leading NUMBER is pure formatting, not derivation: the
        // user writes the heading's content verbatim, the number is only its
        // layout prefix. So a hit on the stripped keyword stays an EXACT match
        // (unlike a stemmed variant, which addFileWithName reports as fuzzy).
        // Symbols from the whitelist (e.g. 🔥) are ignored ON PURPOSE - the
        // user asked for that - so such a match stays exact too.
        const withoutNumber = PrefixTree.stripHeadingNumber(heading);

        let s = withoutNumber;
        const symbols = this.settings.headingSymbolWhitelist;
        if (symbols && symbols.length > 0) {
            for (const sym of symbols) {
                if (sym) s = s.split(sym).join('');
            }
        }
        return s;
    }
}

export interface FuzzyWindowScore {
    bestOffset: number;
    bestResults: ReturnType<PrefixTree['findFuzzyMatches']>;
}

/**
 * Score every offset of a fuzzy sliding window and return the best one.
 *
 * Shared by liveLinker and readModeLinker, whose window logic used to be two
 * ~70-line near-identical copies. `isCovered` lets each caller express the
 * "an exact match already claims this range" test in its own coordinate system
 * (live-mode offsets are absolute, read-mode offsets are text-node relative).
 */
export function scoreFuzzyWindow(opts: {
    cache: PrefixTree;
    settings: LinkerPluginSettings;
    text: string;
    baseFrom: number;
    endPos: number;
    rawWord: string;
    maxOffset: number;
    isWordBoundary: boolean;
    excludeFile: TFile | null;
    renderedFile: TFile | null;
    isCovered: (checkFrom: number, checkTo: number) => boolean;
}): FuzzyWindowScore | null {
    const { cache, settings, text, baseFrom, endPos, rawWord, maxOffset, isWordBoundary, excludeFile, renderedFile, isCovered } = opts;
    let bestOffset = -1;
    let bestSim = -1;
    let bestResults: ReturnType<PrefixTree['findFuzzyMatches']> | null = null;
    for (let offset = 0; offset <= maxOffset; offset++) {
        const rawCandidate = rawWord.slice(offset);
        const leadWs = rawCandidate.length - rawCandidate.replace(/^\s+/, '').length;
        const candidate = rawCandidate.trim();
        if (!candidate) continue;
        // Mirror the exact path's word-boundary rule: with matchAnyPartsOfWords
        // off, a window that neither starts nor ends at a word boundary must be
        // rejected exactly like an exact match would be. The exact path accepts
        // when EITHER side is a boundary; same here.
        if (!settings.matchAnyPartsOfWords
            && settings.matchBeginningOfWords
            && settings.matchEndOfWords
            && !isWordBoundary) {
            const candidateStart = baseFrom + offset + leadWs;
            const startBoundary = candidateStart === 0
                ? PrefixTree.checkWordBoundary(text[0] ?? '')
                : PrefixTree.checkWordBoundary(text[candidateStart - 1] ?? '');
            if (!startBoundary) continue;
        }
        if (candidate.length < cache.minFuzzyKeywordLen - 2) continue;
        // Right-side short-circuit: a candidate more than 2x the longest indexed
        // keyword can never shrink enough (via stopword stripping) to match.
        if (candidate.length > cache.maxFuzzyKeywordLen * 2 + 4) continue;
        const normWord = cache.fuzzyNormalize(candidate, settings.stemmingLanguage);
        if (!normWord) continue;
        // Length short-circuit: a query whose normalized length is >2 away from
        // every indexed fuzzy keyword can never reach the >=80% threshold.
        if (!cache.couldMatchFuzzyLength(normWord.length)) continue;
        const fuzzyResults = cache.findFuzzyMatches(normWord, settings.fuzzyMatchThreshold, excludeFile, renderedFile);
        if (fuzzyResults.length > 0) {
            // Pre-check this window would actually emit: the caller only tries
            // bestOffset, so a window that is covered by an exact match or whose
            // files are all extension-excluded must never win - otherwise this
            // scan position produces no link at all.
            if (isCovered(baseFrom + offset + leadWs, endPos)) continue;
            const usable = fuzzyResults.some((fr) =>
                [...fr.files].some((f) =>
                    !hasExcludedExtension(f.path, settings.excludedExtensions)));
            if (!usable) continue;

            const sim = fuzzyResults[0].similarity;
            if (sim > bestSim) {
                bestSim = sim;
                bestOffset = offset;
                bestResults = fuzzyResults;
                // Already perfect — a shorter window cannot beat it.
                if (sim >= 0.9999) break;
            }
        }
    }
    if (bestOffset < 0) return null;
    return { bestOffset, bestResults: bestResults ?? [] };
}

/** Normalize a user-entered extension ("mp4" or ".mp4") to a lowercased,
 *  leading-dot suffix so only a real extension matches. The old bare endsWith
 *  made "mp4" also exclude files merely NAMED like it, and an empty entry
 *  (''.endsWith('') is always true) exclude every file. */
function normalizeExtensionSuffix(ext: string): string {
    const trimmed = ext.trim();
    return (trimmed.startsWith('.') ? trimmed : '.' + trimmed).toLowerCase();
}

/** True when the path ends with one of the configured excluded extensions.
 *  Shared by the prefix tree, the fuzzy index and both render modes so every
 *  layer applies the identical (normalized) extension rule. */
export function hasExcludedExtension(path: string, extensions: string[]): boolean {
    const lower = path.toLowerCase();
    return extensions.some((ext) => lower.endsWith(normalizeExtensionSuffix(ext)));
}

export class LinkerCache {
    static instance: LinkerCache;

    activeFilePath?: string;
    // files: Map<string, CachedFile> = new Map();
    // linkEntries: Map<string, CachedFile[]> = new Map();
    vault: Vault;
    cache: PrefixTree;
    // Invoked after an async re-index (e.g. auto-excluding a renamed duplicate)
    // changes the tree, so the caller can refresh its decorations.
    onIndexChanged?: () => void;

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
        // Read the setting again: it is captured in the constructor, but this
        // instance is a singleton, so without refreshing it a change to the
        // fuzzy minimum length would only take effect after a plugin reload.
        this.cache.fuzzyMinLength = this.settings.fuzzyMinLength ?? 4;
        // The cached per-file metadata embeds the directory patterns, so it has
        // to go too when the index is rebuilt after a settings change.
        this.cache.fetcher.clearCache();
        this.cache.clear();
        this.cache.resetReady();
        // updateCache() skips rebuilding while the active file path is unchanged.
        // Without clearing it here, a settings change (updateManager calls
        // clearCache) would wipe the index and leave it EMPTY until the user
        // switched notes or restarted Obsidian.
        this.activeFilePath = undefined;
    }

    reset() {
        this.cache.resetSearch();
    }

    updateCache(force = false) {
        // Skip update if plugin is not activated
        if (!this.settings.linkerActivated) return;

        // A missing active file must NOT skip the build. On load the workspace
        // often has not restored the last note yet, and skipping left the index
        // empty; the next incremental build then indexed a single note and
        // markReady() fired on that, so readers rendered against an index holding
        // one entry.
        const activeFile = this.app?.workspace?.getActiveFile()?.path;

        // The index has not finished a REAL full build yet (e.g. the plugin
        // loaded before the vault had listed its files on a cold start). An
        // incremental build now would index the active file only, and the
        // active-file guard below would then consider it "done" forever -
        // every link outside that one note stays missing. Promote to full.
        if (!this.cache.isReady) force = true;

        // We only need to update cache if the active file has changed
        if (activeFile && activeFile === this.activeFilePath && !force) {
            return;
        }

        const full = force || !activeFile;
        void this.cache.updateTree(full ? undefined : [activeFile, this.activeFilePath])
            .then(() => {
                // Only a FULL build that really indexed files proves the index
                // is complete. On a cold start the first full build can run
                // while the vault has not listed its files yet (indexed === 0);
                // marking that as ready would leave the index empty forever,
                // because nothing would ever rebuild it.
                if (full && this.cache.setIndexedFilePaths.size > 0) {
                    this.cache.markReady();
                }
            })
            .catch(() => {
                // Leave isReady false so a later rebuild still marks it ready,
                // and swallow it so a failed build is not an unhandled rejection.
            });

        this.activeFilePath = activeFile;

        // Auto-exclude renamed duplicates (async, only when enabled). Runs after
        // the tree is built; once the longer-named duplicates are removed, notify
        // the caller to refresh so the excluded notes stop producing links.
        if (this.settings.autoExcludeContainedCopies) {
            void this.cache.computeAutoExclude().then((changed) => {
                if (changed) this.onIndexChanged?.();
            });
        }
    }
}