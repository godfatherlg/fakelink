import { App, MarkdownView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { LinkerPluginSettings } from '../main';
import { t } from './lang/helpers';

/**
 * Line jumping: the obsidian://adv-uri protocol this plugin handles itself, and
 * the command that copies such a link for the line under the cursor.
 *
 * These used to be methods on the plugin class. They are plain functions taking
 * the app and settings instead, so the plugin class does not have to carry them.
 * Nothing here was rewritten while moving - only the `this.` access became
 * parameters.
 */

// Read the text of `lineZeroBased` and return a short anchor used to
// re-locate that line later if the file is edited and line numbers drift.
async function getLineAnchor(app: App, file: TFile, lineZeroBased: number): Promise<string> {
    try {
        const content = await app.vault.cachedRead(file);
        const lines = content.split('\n');
        const text = (lines[lineZeroBased] ?? '').trim();
        const maxLen = 40;
        return text.length > maxLen ? text.slice(0, maxLen) : text;
    } catch {
        return '';
    }
}

// Copy a Markdown link for the current line, e.g.
//   [33](obsidian://adv-uri?vault=<id>&filepath=<url-encoded path>&line=33&column=1&openmode=true&view-mode=source)
// The full parameter set matches what Advanced URI generates, while the
// [line-number](...) wrapper keeps the pasted checklist line clean.
export async function copyLineUri(
    app: App, settings: LinkerPluginSettings, file: TFile, lineZeroBased: number,
): Promise<void> {
    const line = lineZeroBased + 1;
    // Vault id is not part of the public API; fall back to the vault name
    // if getId is unavailable at runtime.
    const vaultId = (app.vault as unknown as { getId?: () => string }).getId?.()
        ?? app.vault.getName();
    let uri = `obsidian://adv-uri?vault=${encodeURIComponent(vaultId)}`
        + `&filepath=${encodeURIComponent(file.path)}`
        + `&line=${line}&column=1&openmode=true&view-mode=source`;
    // Self-heal: store the target line text so the jump can find it again
    // later even after edits shift the line numbers.
    if (settings.lineLinkSelfHeal) {
        const anchor = await getLineAnchor(app, file, lineZeroBased);
        if (anchor) {
            uri += `&anchor=${encodeURIComponent(anchor)}`;
        }
    }
    try {
        // Clipboard use is limited to this user-invoked "copy line link"
        // command: it only WRITES (never reads) the obsidian:// URL of the
        // link the user asked to copy. No clipboard content is inspected.
        await navigator.clipboard.writeText(`[${line}](${uri})`);
        new Notice(t('Line link copied'));
    } catch {
        new Notice(t('Failed to copy line link'));
    }
}

// Return the line that currently holds `anchor`. Falls back to the recorded
// `line` when self-healing is off, no anchor was stored, or the anchor text
// can no longer be found (the line itself was edited away).
async function resolveLineByAnchor(
    app: App, settings: LinkerPluginSettings, file: TFile, line: number, anchor?: string,
): Promise<number> {
    if (!settings.lineLinkSelfHeal || !anchor) return line;
    try {
        const content = await app.vault.cachedRead(file);
        const lines = content.split('\n');
        const idx = line - 1;
        // Recorded line still holds the text → nothing to fix.
        if (idx >= 0 && idx < lines.length && lines[idx].trim().startsWith(anchor)) {
            return line;
        }
        // Drifted: prefer an exact line-start match, then a looser contains match.
        const exact = lines.findIndex(l => l.trim().startsWith(anchor));
        if (exact >= 0) return exact + 1;
        const loose = lines.findIndex(l => l.trim().includes(anchor));
        if (loose >= 0) return loose + 1;
        return line;
    } catch {
        return line;
    }
}

// Wait until the target file's editor has rendered at least `targetLine`
// lines, polling every 200ms until `timeoutMs` elapses.
async function waitForEditor(view: MarkdownView, targetLine: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (view.editor && view.editor.lineCount() >= targetLine) {
            return true;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return view.editor != null;
}

// Open the target file only (reuse its tab if already open, otherwise
// open a new one) and return the leaf. Used both by the jump logic and by
// the protocol handler when a URI carries no line (the "open file" step of
// an external handler's two-step sequence), so the file gets opened early
// and rendered before the line jump arrives.
export async function openFileOnly(
    app: App, settings: LinkerPluginSettings, file: TFile,
): Promise<WorkspaceLeaf | null> {
    const existing = app.workspace.getLeavesOfType('markdown')
        .find(l => (l.getViewState().state as { file?: string })?.file === file.path);

    let leaf: WorkspaceLeaf;
    if (existing) {
        app.workspace.setActiveLeaf(existing, { focus: true });
        leaf = existing;
    } else {
        leaf = settings.jumpOpenInNewTab
            ? app.workspace.getLeaf(true)
            : app.workspace.getLeaf(false);
        await leaf.openFile(file);
        // CodeMirror only mounts its real DOM for the active leaf, so make
        // sure the freshly opened leaf is active before scrolling.
        app.workspace.setActiveLeaf(leaf, { focus: true });
    }
    return leaf;
}

// A line that renders as a tall block (an image embed, a wide table) cannot be
// framed by scrollIntoView: its `center` flag only offers "middle of the screen"
// or "nearest visible", so a line taller than the viewport ends up either
// bottom-aligned (only its lower edge shows) or sliced in half. When the line is
// taller than the viewport - or its head ended up above it - align the top edge
// instead, which is what a jump should show. No-op for ordinary lines.
//
// Note: BlockInfo.top is in document coordinates and scroller.scrollTop is a
// scroll offset; they share the same origin up to CodeMirror's content padding,
// so the alignment can be off by a few pixels - invisible for "show me the head
// of this line". Runs twice because images keep reflowing while they load.
function alignTallLine(view: MarkdownView, line: number, pass = 0): void {
    const cmEl = view.contentEl.querySelector('.cm-editor');
    const cm = cmEl ? EditorView.findFromDOM(cmEl as HTMLElement) : null;
    if (!cm) return;                                  // no view: keep the original behaviour
    const scroller = cm.scrollDOM;
    try {
        const block = cm.lineBlockAt(cm.state.doc.line(line + 1).from);
        const tooTall = block.height > scroller.clientHeight * 0.8;
        const headHidden = block.top < scroller.scrollTop;
        if (!tooTall && !headHidden) return;           // ordinary line: leave it alone
        scroller.scrollTop = block.top - 16;
    } catch {
        return;
    }
    if (pass < 1) window.setTimeout(() => alignTallLine(view, line, pass + 1), 250);
}

// Open the target file (if needed) and, once rendered, move the cursor to
// `line` and scroll it into view. `line` is 1-based (adv-uri format).
export async function jumpToLine(
    app: App, settings: LinkerPluginSettings, filepath: string, line: number, anchor?: string,
): Promise<void> {
    const file = app.vault.getAbstractFileByPath(filepath);
    if (!(file instanceof TFile)) return;

    const wasAlreadyOpen = app.workspace.getLeavesOfType('markdown')
        .some(l => (l.getViewState().state as { file?: string })?.file === file.path);

    const leaf = await openFileOnly(app, settings, file);
    if (!leaf) return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    // Self-heal: correct the line number when the recorded one has drifted.
    const targetLine = await resolveLineByAnchor(app, settings, file, line, anchor);
    await waitForEditor(view, targetLine, settings.lineJumpWaitSeconds * 1000);

    if (!wasAlreadyOpen) {
        // Freshly opened file: wait a beat for CodeMirror's first layout
        // and any MathJax/images to finish reflowing, otherwise
        // scrollIntoView races the ongoing measurement and triggers the
        // "Measure loop restarted" warning (and a visible stutter).
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }

    const safeLine = Math.min(targetLine - 1, Math.max(0, view.editor.lineCount() - 1));
    view.editor.focus();
    view.editor.setCursor({ line: safeLine, ch: 0 });
    // Centering (center=true) cannot scroll to the very first lines of a
    // note - there is not half a viewport of content above them, so CM
    // refuses to move. For those top lines use center=false (scrolls them
    // to the top). For deeper lines use center=true so the target sits in
    // the middle of the screen instead of hugging the bottom edge (which
    // is what center=false's "nearest visible" does for lines below the
    // current viewport).
    const center = safeLine >= 15;
    view.editor.scrollIntoView({ from: { line: safeLine, ch: 0 }, to: { line: safeLine, ch: 0 } }, center);
    // scrollIntoView alone cannot frame a line taller than the viewport (an
    // image embed): center=true slices it and center=false only reveals its
    // lower edge. Top-align such lines instead.
    alignTallLine(view, safeLine);
}
