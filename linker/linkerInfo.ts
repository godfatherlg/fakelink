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

export class LinkerMetaInfoFetcher {
    includeDirPattern: RegExp;
    excludeDirPattern: RegExp;
    includeAllFiles: boolean;

    constructor(public app: App, public settings: LinkerPluginSettings) {
        this.refreshSettings();
    }

    refreshSettings(settings?: LinkerPluginSettings) {
        this.settings = settings ?? this.settings;
        this.includeAllFiles = this.settings.includeAllFiles;
        // eslint-disable-next-line no-useless-escape -- forward slash must be escaped in RegExp
        this.includeDirPattern = new RegExp(`(^|/)(${this.settings.linkerDirectories.join("|")})/`);
        // eslint-disable-next-line no-useless-escape -- forward slash must be escaped in RegExp
        this.excludeDirPattern = new RegExp(`(^|/)(${this.settings.excludedDirectories.join("|")})/`);
    }

    getMetaInfo(file: TFile | TAbstractFile) {
        return new LinkerFileMetaInfo(this, file);
    }
}