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
export const WHATS_NEW_VERSION = '1.24.14';

/**
 * Each entry is the English original - t() turns it into Chinese when the UI
 * language is Chinese, so there is nothing to keep in sync by hand.
 */
const WHATS_NEW: string[] = [
    'Improved: the cursor line now marks its line number with a colour chip, so the current line stays identifiable even with the in-text band off.',
    'New: a "Pseudo-3D band" toggle and a "Cursor line colour" picker; the line number chip and the band both follow the chosen colour.',
    'Improved: the pseudo-3D band is built from the cursor-line colour instead of a grey shadow, so it blends with the background.',
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
