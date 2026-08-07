import { App, Editor, MarkdownView, Modal, Setting, TFile, getLinkpath } from 'obsidian';

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
    return [...Array(up).fill('..'), ...down].join('/');
}

interface BatchLinkItem {
    from: number;
    to: number;
    displayText: string;
    replacement: string;
    anchor: HTMLAnchorElement;
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

        this.items = this.collectLinks(view);
        this.enabled = this.items.map(() => true);

        contentEl.createEl('h3', { text: 'Convert virtual links to real links' });
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
                .setDesc(item.replacement)
                .addToggle((toggle) =>
                    toggle.setValue(true).onChange((value) => {
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

    private collectLinks(view: MarkdownView): BatchLinkItem[] {
        const anchors = activeDocument.querySelectorAll('.virtual-link-a');
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

            const replacement = this.buildReplacement(anchor, originText, href, view);
            if (!replacement) {
                return;
            }

            items.push({ from, to, displayText: originText, replacement, anchor });
        });

        // Sort from last to first so earlier offsets stay valid when replacing
        items.sort((a, b) => b.from - a.from);
        return items;
    }

    private buildReplacement(
        anchor: HTMLAnchorElement,
        text: string,
        href: string,
        view: MarkdownView
    ): string {
        const hrefWithoutAnchor = href.split('#')[0];
        const targetFile = this.app.vault.getAbstractFileByPath(hrefWithoutAnchor);
        if (!(targetFile instanceof TFile)) {
            return '';
        }

        const activeFilePath = view.file?.path ?? '';

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
