import { App, Editor, MarkdownView, Modal, Setting, TFile } from 'obsidian';

import { LinkerPluginSettings } from 'main';

// Minimal path helpers mirroring the ones used by the existing
// "convert selected virtual links" command.
function dirname(filePath: string): string {
    const i = filePath.lastIndexOf('/');
    return i === -1 ? '' : filePath.substring(0, i);
}

function basename(filePath: string): string {
    const i = filePath.lastIndexOf('/');
    return i === -1 ? filePath : filePath.substring(i + 1);
}

function relative(from: string, to: string): string {
    const fromParts = from.split('/').filter(Boolean);
    const toParts = to.split('/').filter(Boolean);
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
        i++;
    }
    const up = fromParts.length - i;
    const down = toParts.slice(i);
    const parts: string[] = [];
    for (let j = 0; j < up; j++) {
        parts.push('..');
    }
    return [...parts, ...down].join('/');
}

interface BatchLinkItem {
    from: number;
    to: number;
    displayText: string;
    replacement: string;
    anchor: HTMLAnchorElement;
    multipleTargets: boolean;
}

/**
 * Collects all currently rendered virtual links in the active markdown view
 * and lets the user convert them into real links, with a preview list.
 */
export class BatchConvertModal extends Modal {
    private items: BatchLinkItem[] = [];
    private enabled: boolean[];
    private editor: Editor | null = null;
    private readonly settings: LinkerPluginSettings;

    constructor(app: App, settings: LinkerPluginSettings) {
        super(app);
        this.settings = settings;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
            contentEl.createEl('p', { text: 'No active markdown note found.' });
            return;
        }
        this.editor = view.editor;

        contentEl.createEl('h3', { text: 'Convert virtual links to real links' });
        contentEl.createEl('p', { text: 'Collecting virtual links…' });

        // Force CodeMirror to render all link widgets by scrolling through the
        // whole document, then collect on the next frame so the count is stable
        // (widgets are lazily rendered only for the visible area otherwise).
        const ed = this.editor;
        try {
            const lastLine = ed.lastLine();
            ed.setCursor({ line: lastLine, ch: ed.getLine(lastLine).length });
            ed.setCursor({ line: 0, ch: 0 });
        } catch {
            // ignore
        }

        window.setTimeout(() => {
            if (!this.editor) {
                return;
            }
            this.renderList(contentEl);
        }, 120);
    }

    private renderList(contentEl: HTMLElement) {
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Convert virtual links to real links' });

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const sourcePath = view?.file?.path ?? '';
        this.items = this.collectLinks(sourcePath);

        contentEl.createEl('p', {
            text: `${this.items.length} virtual link(s) found in the current note. Uncheck any you want to keep as virtual links.`,
        });

        if (this.items.length === 0) {
            contentEl.createEl('p', { text: 'Nothing to convert.' });
            return;
        }

        const listEl = contentEl.createEl('div', { cls: 'fakelink-batch-list' });
        this.items.forEach((item, index) => {
            const row = listEl.createEl('div', { cls: 'fakelink-batch-row' });
            new Setting(row)
                .setName(`"${item.displayText}"`)
                .setDesc(item.multipleTargets
                    ? `${item.replacement}  (multiple targets — converts the first one)`
                    : item.replacement)
                .addToggle((toggle) =>
                    toggle.setValue(this.enabled[index] ?? true).onChange((value) => {
                        this.enabled[index] = value;
                    })
                );
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText('Convert selected').setCta().onClick(() => {
                    this.applyConversions();
                    this.close();
                })
            )
            .addButton((btn) =>
                btn.setButtonText('Cancel').onClick(() => this.close())
            );
    }

    onClose() {
        this.contentEl.empty();
    }

    private collectLinks(sourcePath: string): BatchLinkItem[] {
        const editor = this.editor;
        if (!editor) {
            return [];
        }
        // Scope to the active editor's CodeMirror DOM only. Using activeDocument
        // would also pick up virtual links rendered in a split preview pane, whose
        // offsets belong to a different document and would corrupt replacements.
        const cmDom = (editor as unknown as { cm?: { dom?: HTMLElement } }).cm?.dom;
        const scope: ParentNode = cmDom ?? activeDocument;
        const anchors = scope.querySelectorAll('.virtual-link-a');
        const seen = new Set<string>();
        const items: BatchLinkItem[] = [];

        anchors.forEach((el) => {
            const anchor = el as HTMLAnchorElement;
            const fromAttr = anchor.getAttribute('from');
            const toAttr = anchor.getAttribute('to');
            const originText = anchor.getAttribute('origin-text');
            const href = anchor.getAttribute('href') ?? '';

            if (fromAttr === null || toAttr === null || !originText) {
                return;
            }
            const from = parseInt(fromAttr, 10);
            const to = parseInt(toAttr, 10);
            if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
                return;
            }

            // Deduplicate identical spans (CodeMirror may render the same link
            // more than once during measurement passes).
            const key = `${from}-${to}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);

            // Validate that the document actually contains the expected text at
            // this offset. Skips stale/wrong offsets that would otherwise insert
            // junk at the end of the note.
            const fromPos = editor.offsetToPos(from);
            const toPos = editor.offsetToPos(to);
            if (editor.getRange(fromPos, toPos) !== originText) {
                return;
            }

            const replacement = this.buildReplacement(anchor, originText, href, sourcePath);
            if (!replacement) {
                return;
            }

            // Detect links pointing to multiple notes: the root .virtual-link span
            // contains a .multiple-files-references child in that case.
            const rootLink = anchor.closest('.virtual-link');
            const multipleTargets = !!rootLink?.querySelector('.multiple-files-references');

            // When configured, skip (exclude entirely) links with multiple targets
            // so the user can convert those individually.
            if (multipleTargets && this.settings.skipMultipleTargets) {
                return;
            }

            items.push({ from, to, displayText: originText, replacement, anchor, multipleTargets });
        });

        // Sort from last to first so earlier offsets stay valid when replacing
        items.sort((a, b) => b.from - a.from);
        // All items default to checked. (When "skip multiple targets" is on,
        // multi-target links are already excluded above; when off, they are
        // included and checked so the user doesn't have to tick them one by one.
        // Converting a multi-target link only uses its first target.)
        this.enabled = items.map(() => true);
        return items;
    }

    private buildReplacement(
        anchor: HTMLAnchorElement,
        text: string,
        href: string,
        sourcePath: string
    ): string {
        const hrefWithoutAnchor = href.split('#')[0];
        const targetFile = this.app.vault.getAbstractFileByPath(hrefWithoutAnchor);
        if (!(targetFile instanceof TFile)) {
            return '';
        }

        const activeFilePath = sourcePath;

        let absolutePath = targetFile.path;
        let relativePath =
            relative(dirname(activeFilePath), dirname(absolutePath)) + '/' + basename(absolutePath);
        relativePath = relativePath.replace(/\\/g, '/');

        const replacementPath = this.app.metadataCache.fileToLinktext(targetFile, activeFilePath);
        const lastPart = replacementPath.split('/').pop();
        if (!lastPart) {
            return '';
        }
        const shortestFile = this.app.metadataCache.getFirstLinkpathDest(lastPart, '');
        let shortestPath = shortestFile?.path === targetFile.path ? lastPart : absolutePath;

        const headerId = anchor.getAttribute('data-heading-id');
        const pathSuffix = headerId ? `#${headerId}` : '';

        if (!replacementPath.endsWith('.md')) {
            if (absolutePath.endsWith('.md')) absolutePath = absolutePath.slice(0, -3);
            if (shortestPath.endsWith('.md')) shortestPath = shortestPath.slice(0, -3);
            if (relativePath.endsWith('.md')) relativePath = relativePath.slice(0, -3);

            absolutePath += pathSuffix;
            shortestPath += pathSuffix;
            relativePath += pathSuffix;
        }

        const useMarkdownLinks = this.settings.useDefaultLinkStyleForConversion
            ? this.settings.defaultUseMarkdownLinks
            : this.settings.useMarkdownLinks;

        const linkFormat = this.settings.useDefaultLinkStyleForConversion
            ? this.settings.defaultLinkFormat
            : this.settings.linkFormat;

        if (replacementPath === text && linkFormat === 'shortest') {
            return `[[${replacementPath}]]`;
        }

        const path = linkFormat === 'shortest' ? shortestPath
            : linkFormat === 'relative' ? relativePath
                : absolutePath;

        if (useMarkdownLinks) {
            return `[${text}](${path})`;
        }

        // Wiki links: escape pipe characters when inside a table cell
        const isInTable = !!anchor.closest('td, th');
        const escapedText = isInTable ? text.replace(/[\\|]/g, '\\$&') : text;
        return `[[${path}\\|${escapedText}]]`;
    }

    private applyConversions() {
        if (!this.editor) {
            return;
        }
        for (let i = 0; i < this.items.length; i++) {
            if (!this.enabled[i]) {
                continue;
            }
            const item = this.items[i];
            const fromPos = this.editor.offsetToPos(item.from);
            const toPos = this.editor.offsetToPos(item.to);
            this.editor.replaceRange(item.replacement, fromPos, toPos);
        }
    }
}
