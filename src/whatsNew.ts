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
export const WHATS_NEW_VERSION = '1.24.33';

/**
 * Each entry is the English original - t() turns it into Chinese when the UI
 * language is Chinese, so there is nothing to keep in sync by hand.
 */
const WHATS_NEW: string[] = [
    'Callouts: a short keyword (three characters, common in Japanese) was linked on every line instead of once - the lookup skipped anything shorter than four characters.',
    'Callouts: a line starting with a space lost its link, because the position was computed from the trimmed text while the match offset was not.',
    'Callouts: identical lines all pointed at the first of them, so a link could move to another line after the callout was rendered.',
    'Callout text is now located in the note by searching forward from the previous line, so short words, leading spaces and repeated lines behave exactly like body text.',
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
