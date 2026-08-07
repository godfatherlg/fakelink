import { App, Editor, MarkdownView, Modal, Notice, Setting, TFile } from 'obsidian';
import { LinkerPluginSettings } from '../main';
import { LinkerCache, PrefixTree } from '../linker/linkerCache';
import { VirtualMatch } from '../linker/virtualLinkDom';

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

function relative(from: string, to: string): string {
    const fromParts = dirname(from).split('/').filter(Boolean);
    const toParts = dirname(to).split('/').filter(Boolean);
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    const up = fromParts.length - i;
    const down = toParts.slice(i);
    return [...Array(up).fill('..'), ...down].join('/') || '.';
}


interface BatchLinkItem {
    from: number;
    to: number;
    displayText: string;
    replacement: string;
    multipleTargets: boolean;
}

export class BatchConvertModal extends Modal {
    private items: BatchLinkItem[] = [];
    private enabled: boolean[] = [];
    private editor: Editor | null = null;
    private readonly settings: LinkerPluginSettings;
    private readonly plugin: LinkerPluginType | null;
    private rendered = false;

    constructor(app: App, settings: LinkerPluginSettings, plugin?: LinkerPluginType | null) {
        super(app);
        this.settings = settings;
        this.plugin = plugin ?? null;
    }

    onOpen() {
        const { contentEl } = this;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        this.editor = view?.editor ?? null;

        if (!this.editor) {
            contentEl.createEl('p', { text: '请先打开一个 Markdown 笔记，再运行此命令。' });
            return;
        }
        if (!this.settings.linkerActivated) {
            contentEl.createEl('p', { text: '虚拟链接功能当前已关闭，请先在设置中启用后再运行批量转换。' });
            return;
        }

        this.renderList(contentEl);
    }

    onClose() {
        this.items = [];
        this.enabled = [];
        this.editor = null;
        this.rendered = false;
        this.contentEl.empty();
    }

    private renderList(contentEl: HTMLElement) {
        contentEl.empty();
        const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
        this.items = this.collectLinks(sourcePath);
        this.enabled = this.items.map(() => true);

        contentEl.createEl('h2', { text: '批量固化虚拟链接为真实链接' });
        contentEl.createEl('p', {
            text: `当前笔记共找到 ${this.items.length} 个虚拟链接。勾选需要转换的项，点击"转换"。`,
        });

        if (this.items.length === 0) {
            contentEl.createEl('p', { text: '未检测到可转换的虚拟链接。' });
            return;
        }

        const listEl = contentEl.createEl('div');
        listEl.addClass('batch-convert-list');

        this.items.forEach((item, idx) => {
            const row = listEl.createEl('div');
            row.addClass('batch-convert-row');

            const toggle = new Setting(row)
                .setName(item.displayText)
                .setDesc(
                    item.multipleTargets
                        ? '多个指向 — 将转换为第一个目标'
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

        const buttonBar = contentEl.createEl('div');
        buttonBar.addClass('batch-convert-buttons');

        const convertBtn = buttonBar.createEl('button', { text: '转换' });
        convertBtn.addClass('mod-cta');
        convertBtn.onclick = () => this.convert();

        const cancelBtn = buttonBar.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => this.close();
    }

    /**
     * Scan the WHOLE document through LinkerCache (the same trie logic used by
     * the live linker) so we get every virtual link regardless of what is
     * currently rendered in the viewport. This avoids the CodeMirror lazy
     * widget rendering problem and does not require scrolling.
     */
    private collectLinks(sourcePath: string): BatchLinkItem[] {
        const editor = this.editor;
        if (!editor) return [];

        const cache = LinkerCache.getInstance(this.app, this.settings);
        const cacheTree = cache.cache;

        const text = editor.getValue();
        const excludedExtensions = this.settings.excludedExtensions;
        const ownNote = this.settings.excludeLinksToOwnNote ? this.app.workspace.getActiveFile() : null;

        cache.reset();
        const matches: VirtualMatch[] = [];
        let id = 0;

        for (let i = 0; i <= text.length; ) {
            const codePoint = text.codePointAt(i)!;
            const char = i < text.length ? String.fromCodePoint(codePoint) : '\n';
            const isWordBoundary = PrefixTree.checkWordBoundary(char);

            if (
                this.settings.matchAnyPartsOfWords ||
                this.settings.matchBeginningOfWords ||
                isWordBoundary
            ) {
                const currentNodes = cacheTree.getCurrentMatchNodes(i, ownNote);

                for (const node of currentNodes) {
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
                    const name = text.slice(nFrom, nTo);

                    const filteredFiles = Array.from(node.files).filter((file: TFile) => {
                        return !excludedExtensions.some((ext: string) =>
                            file.path.toLowerCase().endsWith(ext.toLowerCase())
                        );
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
                        this.settings,
                        this.plugin,
                        node.headerId
                    );

                    if (filteredFiles.length > 1) {
                        filteredFiles.forEach((file: TFile, index: number) => {
                            if (index === 0) return;
                            const fileNodes = cacheTree.getCurrentMatchNodes(i, null, file);
                            if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                                vm.setFileHeaderId(file, fileNodes[0].headerId);
                            }
                        });
                    }

                    matches.push(vm);
                }
            }

            cacheTree.pushChar(char);
            i += char.length;
        }

        let sorted = VirtualMatch.sort(matches);
        sorted = VirtualMatch.filterOverlapping(sorted, this.settings.onlyLinkOnce);

        const items: BatchLinkItem[] = sorted.map((m) => {
            const multipleTargets = m.files.length > 1;
            const replacement = this.buildReplacement(m, sourcePath);
            return {
                from: m.from,
                to: m.to,
                displayText: m.originText,
                replacement,
                multipleTargets,
            };
        });

        // Sort descending by position so later replacements don't shift earlier offsets
        items.sort((a, b) => b.from - a.from);
        return items;
    }

    private buildReplacement(match: VirtualMatch, sourcePath: string): string {
        const targetFile = match.files[0];
        if (!targetFile) return match.originText;

        const activeFile = this.app.workspace.getActiveFile();
        const activeFilePath = activeFile?.path ?? '';
        const text = match.originText;
        const headerId = match.getFileHeaderId(targetFile) || match.headerId;

        const useMarkdownLinks = this.settings.useDefaultLinkStyleForConversion
            ? this.settings.defaultUseMarkdownLinks
            : this.settings.useMarkdownLinks;
        const linkFormat = this.settings.useDefaultLinkStyleForConversion
            ? this.settings.defaultLinkFormat
            : this.settings.linkFormat;

        let absolutePath = targetFile.path;
        let relativePath =
            dirname(activeFile?.path ?? '') + '/' + basename(targetFile.path);
        relativePath = relativePath.replace(/\\/g, '/');

        const replacementPath = this.app.metadataCache.fileToLinktext(targetFile, activeFilePath);
        const lastPart = replacementPath.split('/').pop() ?? '';
        const shortestFile = this.app.metadataCache.getFirstLinkpathDest(lastPart, '');
        let shortestPath = shortestFile?.path === targetFile.path ? lastPart : absolutePath;

        const pathSuffix = headerId ? `#${headerId}` : '';
        if (!replacementPath.endsWith('.md')) {
            if (absolutePath.endsWith('.md')) absolutePath = absolutePath.slice(0, -3);
            if (shortestPath && shortestPath.endsWith('.md')) shortestPath = shortestPath.slice(0, -3);
            if (relativePath.endsWith('.md')) relativePath = relativePath.slice(0, -3);
            absolutePath += pathSuffix;
            shortestPath += pathSuffix;
            relativePath += pathSuffix;
        }

        const createLink = (replacementTarget: string, linkText: string, markdownStyle: boolean) => {
            if (markdownStyle) {
                return `[${linkText}](${replacementTarget})`;
            }
            const tableCell = isInTable(this.editor, match.from);
            if (tableCell) {
                const escapedText = linkText.replace(/[\\|]/g, '\\$&');
                return `[[${replacementTarget}\\|${escapedText}]]`;
            }
            return `[[${replacementTarget}|${linkText}]]`;
        };

        if (replacementPath === text && linkFormat === 'shortest') {
            return `[[${replacementPath}]]`;
        }
        if (linkFormat === 'shortest') {
            return createLink(shortestPath || absolutePath, text, useMarkdownLinks);
        } else if (linkFormat === 'relative') {
            return createLink(relativePath, text, useMarkdownLinks);
        } else {
            return createLink(absolutePath, text, useMarkdownLinks);
        }
    }

    private convert() {
        const editor = this.editor;
        if (!editor) return;

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

        new Notice(`已固化 ${applied} 个虚拟链接为真实链接。`);
        this.close();
    }
}

function isInTable(editor: Editor | null, offset: number): boolean {
    try {
        const cm = (editor as unknown as { cm?: { dom?: HTMLElement } })?.cm?.dom;
        if (!cm) return false;
        // Fallback heuristic: check the line text for table pipes
        if (editor) {
            const pos = editor.offsetToPos(offset);
            const line = editor.getLine(pos.line);
            const pipeCount = (line.match(/\|/g) || []).length;
            const prevLine = pos.line > 0 ? editor.getLine(pos.line - 1) : '';
            const nextLine = editor.lineCount() > pos.line + 1 ? editor.getLine(pos.line + 1) : '';
            const sep = /^\s*\|?[-: |]+\|?\s*$/;
            if (pipeCount >= 1 && (sep.test(prevLine) || sep.test(nextLine))) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}
