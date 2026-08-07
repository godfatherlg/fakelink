import { App, MarkdownView, Modal, Notice, Setting, TFile, FuzzySuggestModal } from 'obsidian';
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
    const ownNote = settings.excludeLinksToOwnNote ? app.vault.getAbstractFileByPath(sourcePath) : null;

    cache.reset();
    const matches: VirtualMatch[] = [];
    let id = 0;

    // Iterate over UTF-16 code units so the resulting `from`/`to` offsets match
    // Obsidian's editor offsets (editor.offsetToPos / getRange use code units).
    // Mixing code-point counting with editor code-unit offsets was the root
    // cause of partial conversions and "links not found on second run".
    for (let i = 0; i <= text.length; i++) {
        const char = i < text.length ? text[i] : '\n';
        const isWordBoundary = PrefixTree.checkWordBoundary(char);

        if (settings.matchAnyPartsOfWords || settings.matchBeginningOfWords || isWordBoundary) {
            const currentNodes = cacheTree.getCurrentMatchNodes(i, ownNote);

            for (const node of currentNodes) {
                if (!settings.matchAnyPartsOfWords) {
                    if (
                        (settings.matchBeginningOfWords && !node.startsAtWordBoundary) &&
                        (settings.matchEndOfWords && !isWordBoundary)
                    ) {
                        continue;
                    }
                }

                const nFrom = node.start;
                const nTo = node.end;
                const name = text.slice(nFrom, nTo);

                if (rangeFrom !== undefined && rangeTo !== undefined) {
                    if (nTo <= rangeFrom || nFrom >= rangeTo) continue;
                }

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
                    settings,
                    plugin,
                    node.headerId
                );

                // Resolve the correct headerId for EACH target file individually.
                // Passing `node.headerId` to the constructor would wrongly tag every
                // file with the first match's header; instead we look up each file's
                // own header so the generated link points to the right place.
                filteredFiles.forEach((file: TFile) => {
                    const fileNodes = cacheTree.getCurrentMatchNodes(i, null, file);
                    if (fileNodes && fileNodes.length > 0 && fileNodes[0].headerId) {
                        vm.setFileHeaderId(file, fileNodes[0].headerId);
                    } else {
                        vm.setFileHeaderId(file, '');
                    }
                });

                matches.push(vm);
            }
        }

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
    const targetFile = match.files[0];
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
    let relativePath = dirname(sourcePath) + '/' + basename(targetFile.path);
    relativePath = relativePath.replace(/\\/g, '/');

    const replacementPath = app.metadataCache.fileToLinktext(targetFile, sourcePath);
    const lastPart = replacementPath.split('/').pop() ?? '';
    const shortestFile = app.metadataCache.getFirstLinkpathDest(lastPart, '');
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
        const tableCell = isInTableText(text);
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

/** Heuristic: a link text containing an unescaped pipe likely lives in a table. */
function isInTableText(linkText: string): boolean {
    return /(?<!\\)\|/.test(linkText);
}

/** Apply replacements to a plain string (used for files not currently open in an editor). */
export function applyReplacementsToString(text: string, items: BatchLinkItem[]): string {
    let result = text;
    for (const item of items) {
        result = result.slice(0, item.from) + item.replacement + result.slice(item.to);
    }
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

    constructor(
        app: App,
        settings: LinkerPluginSettings,
        plugin?: LinkerPluginType | null,
        range?: [number, number] | null
    ) {
        super(app);
        this.settings = settings;
        this.plugin = plugin ?? null;
        this.range = range ?? null;
    }

    onOpen() {
        const { contentEl } = this;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor ?? null;

        if (!editor) {
            contentEl.createEl('p', { text: '请先打开一个 Markdown 笔记，再运行此命令。' });
            return;
        }
        if (!this.settings.linkerActivated) {
            contentEl.createEl('p', { text: '虚拟链接功能当前已关闭，请先在设置中启用后再运行批量转换。' });
            return;
        }

        this.text = editor.getValue();
        this.sourcePath = this.app.workspace.getActiveFile()?.path ?? '';

        if (this.range) {
            const [from, to] = this.range;
            if (from >= to) {
                contentEl.createEl('p', { text: '请先选择一段文本，再运行此命令。' });
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

        const scopeLabel = this.range ? '选中内容中' : '当前笔记中';
        contentEl.createEl('h2', { text: '批量固化虚拟链接为真实链接' });
        contentEl.createEl('p', {
            text: `${scopeLabel}共找到 ${this.items.length} 个虚拟链接。勾选需要转换的项，点击"转换"。`,
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

    private convert() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor ?? null;
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
        contentEl.createEl('h2', { text: '批量固化多个笔记中的虚拟链接' });
        contentEl.createEl('p', {
            text: '选择要处理的笔记，然后点击"扫描"预览每个笔记可转换的链接数量。',
        });

        const pickerBar = contentEl.createEl('div');
        pickerBar.addClass('batch-convert-buttons');

        const pickBtn = pickerBar.createEl('button', { text: '选择笔记…' });
        pickBtn.addClass('mod-cta');
        pickBtn.onclick = () => {
            const picker = new FileMultiSuggestModal(this.app);
            picker.onChoose((files) => {
                this.selectedFiles = files;
                this.renderSelected(contentEl);
            });
            picker.open();
        };

        const scanBtn = pickerBar.createEl('button', { text: '扫描并转换' });
        scanBtn.onclick = () => this.scanAndConvert();
    }

    private renderSelected(contentEl: HTMLElement) {
        const existing = contentEl.querySelector('.batch-selected-files');
        if (existing) existing.remove();

        const box = contentEl.createEl('div');
        box.addClass('batch-selected-files');
        box.createEl('p', { text: `已选择 ${this.selectedFiles.length} 个笔记：` });
        const list = box.createEl('ul');
        for (const f of this.selectedFiles) {
            list.createEl('li', { text: f.path });
        }
    }

    private async scanAndConvert() {
        if (this.selectedFiles.length === 0) {
            new Notice('请先选择至少一个笔记。');
            return;
        }
        if (!this.settings.linkerActivated) {
            new Notice('虚拟链接功能当前已关闭，请先在设置中启用。');
            return;
        }

        let totalApplied = 0;
        let totalLinks = 0;
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
                totalLinks += activeItems.length;

                if (activeItems.length === 0) continue;

                const newContent = applyReplacementsToString(content, activeItems);

                // If the file is currently open in an editor, update it live
                const openView = this.app.workspace.getLeavesOfType('markdown')
                    .map((l) => l.view)
                    .find((v): v is MarkdownView => v instanceof MarkdownView && (v as MarkdownView).file?.path === file.path);

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
            new Notice(`完成。${totalApplied} 个链接已固化（${errors.length} 个文件出错，详见控制台）。`);
            console.error('Batch convert files errors:', errors);
        } else {
            new Notice(`已完成。在 ${this.selectedFiles.length} 个笔记中固化了 ${totalApplied} 个虚拟链接。`);
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
        new Notice(`已添加：${file.path}（共 ${this.chosen.length} 个）`);
        this.cb([...this.chosen]);
    }
}
