import { LinkerPluginSettings } from "main";
import { App, getAllTags, TAbstractFile, TFile } from "obsidian";


export class LinkerFileMetaInfo {
    file: TFile;
    tags: string[];
    includeFile: boolean;
    excludeFile: boolean;

    isInIncludedDir: boolean;
    isInExcludedDir: boolean;

    includeAllFiles: boolean;

    constructor(public fetcher: LinkerMetaInfoFetcher, file: TFile | TAbstractFile) {
        this.fetcher = fetcher;
        // @ts-ignore: getFileByPath returns TFile when it exists
        this.file = file instanceof TFile ? file : this.fetcher.app.vault.getFileByPath(file.path);

        const settings = this.fetcher.settings;

        const fileCache = this.fetcher.app.metadataCache.getFileCache(this.file);
        // @ts-ignore: Obsidian API type issue
        this.tags = (fileCache ? getAllTags(fileCache) : [])
            .filter(tag => tag.trim().length > 0)
            .map(tag => tag.startsWith("#") ? tag.slice(1) : tag);

        this.includeFile = this.tags.includes(settings.tagToIncludeFile);
        this.excludeFile = this.tags.includes(settings.tagToExcludeFile);

        this.includeAllFiles = fetcher.includeAllFiles;
        this.isInIncludedDir = fetcher.includeDirPattern.test(this.file.path); //fetcher.includeAllFiles || 
        this.isInExcludedDir = fetcher.excludeDirPattern.test(this.file.path);
    }
}

/** Escape a user-supplied string so it can be used literally inside a RegExp. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class LinkerMetaInfoFetcher {
    includeDirPattern: RegExp;
    excludeDirPattern: RegExp;
    includeAllFiles: boolean;

    // Per-path cache. Building a LinkerFileMetaInfo costs a getFileCache call,
    // getallTags on the result and two regex tests, and it sits in the innermost
    // loop of fuzzy matching - once per candidate file, per sliding-window
    // offset, per scan position - so it was being rebuilt thousands of times per
    // keystroke. Keyed by path and invalidated by mtime so an edit is picked up
    // on the next rebuild.
    private metaCache: Map<string, { mtime: number; info: LinkerFileMetaInfo }> = new Map();

    constructor(public app: App, public settings: LinkerPluginSettings) {
        this.refreshSettings();
    }

    /** Drop cached metadata. Called when the index is rebuilt, because the
     *  directory patterns baked into each entry may have changed. */
    clearCache() {
        this.metaCache.clear();
    }

    refreshSettings(settings?: LinkerPluginSettings) {
        this.settings = settings ?? this.settings;
        this.includeAllFiles = this.settings.includeAllFiles;
        // Escape the directory names: they are user input going straight into a
        // RegExp, so a name like "C++" or "(草稿)" threw a SyntaxError - and this
        // runs on the first line of doUpdateTree, so every rebuild then failed and
        // the index froze.
        this.includeDirPattern = new RegExp(`(^|/)(${this.settings.linkerDirectories.map(escapeRegExp).join("|")})/`);
        this.excludeDirPattern = new RegExp(`(^|/)(${this.settings.excludedDirectories.map(escapeRegExp).join("|")})/`);
    }

    getMetaInfo(file: TFile | TAbstractFile) {
        const path = file.path;
        const mtime = file instanceof TFile ? file.stat.mtime : 0;
        const cached = this.metaCache.get(path);
        if (cached && cached.mtime === mtime) {
            return cached.info;
        }
        const info = new LinkerFileMetaInfo(this, file);
        this.metaCache.set(path, { mtime, info });
        return info;
    }
}