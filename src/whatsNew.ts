import { App, Modal, Setting } from 'obsidian';
import { t } from './lang/helpers';

/**
 * What changed in the release the user just updated to.
 *
 * The notes live IN the plugin rather than being fetched from GitHub: no network
 * request (and no network permission) is needed, and it works offline. Only the
 * CURRENT release is listed - the dialog is shown once, right after an update,
 * so notes for older versions would never be read.
 *
 * Update WHATS_NEW_VERSION and WHATS_NEW together when cutting a release; the
 * text mirrors RELEASE_NOTES.md.
 */
export const WHATS_NEW_VERSION = '1.24.31';

/**
 * Each entry is the English original - t() turns it into Chinese when the UI
 * language is Chinese, so there is nothing to keep in sync by hand.
 */
const WHATS_NEW: string[] = [
    '"Exclude self-links to the current note" now only governs the note name and its aliases: links to its headings are controlled by "Allow links to headers in the current note" alone, so the two options no longer override each other. Enabling "Allow virtual links in headers" no longer switches the other option on behind your back.',
    '"Only link once" now counts a note plus its heading as one target, so a glossary written as headings inside a single note keeps one link per entry instead of one per note.',
    'Fixed: with "Only link once" on, the reading view dropped every link (its bookkeeping survived a re-render and marked the whole note as already linked).',
    'The "Fix ime typing issues" description now explains why the word-boundary options do not apply to Chinese/Japanese/Korean and why this option has to stay on for them.',
];

export class WhatsNewModal extends Modal {
    constructor(app: App, private readonly version: string) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('fakelink-whats-new');
        contentEl.createEl('h2', { text: `${t('What is new')} · ${this.version}` });

        const list = contentEl.createEl('ul');
        list.addClass('fakelink-whats-new-list');
        for (const item of WHATS_NEW) {
            list.createEl('li', { text: t(item) });
        }

        new Setting(contentEl).addButton((b) => b
            .setButtonText(t('See the full release notes'))
            .setCta()
            .onClick(() => {
                window.open(`https://github.com/godfatherlg/fakelink/releases/tag/${this.version}`, '_blank');
            }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
