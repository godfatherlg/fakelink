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
export const WHATS_NEW_VERSION = '1.24.32';

/**
 * Each entry is the English original - t() turns it into Chinese when the UI
 * language is Chinese, so there is nothing to keep in sync by hand.
 */
const WHATS_NEW: string[] = [
    '"Only link once" is now decided from the whole note instead of the current screen: an occurrence is kept only when no earlier occurrence of the same keyword exists in the document, so scrolling no longer makes links appear and disappear, and two occurrences a few screens apart are not both linked.',
    'Callouts in Live Preview follow the same rule now: a duplicate inside a callout is no longer linked just because the callout keeps its own small ledger, and the body keeps counting after the callout.',
    'A heading line is no longer counted as the "first occurrence": its own link is never rendered, so counting it used to swallow the first real body link.',
    'Faster: the duplicate check no longer rebuilds a ledger per block; it reads the note once and reuses that until the text changes.',
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
