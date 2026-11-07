/**
 * Folder-scoped dictionaries (discussion #21).
 *
 * A scope is a folder path. A note belongs to the DEEPEST scope that contains
 * it. Notes that belong to no scope are "global" and keep the previous
 * behaviour: they match every note.
 *
 * Effective scopes = (top-level picks ∪ custom paths) − every ancestor that a
 * deeper path already covers. Only the ancestor chain of a deeper path is
 * removed - unrelated top-level picks stay untouched.
 *
 * Visibility for a note inside a scope:
 *   - notes of the same scope
 *   - global notes (no scope)
 *   - files the note links to with a real [[link]] (direct targets only; the
 *     target keeps its own scope - nothing is re-assigned, nothing cascades)
 */

import { TFolder } from 'obsidian';
import type { App, TFile } from 'obsidian';

export interface ScopeConfig {
    /** Master switch: without it every note behaves globally. */
    enabled: boolean;
    /** Top-level folders that are scopes (every one, minus the disabled). */
    topLevel: string[];
    /** Custom folder paths, as typed by the user. */
    custom: string[];
}

/** Every top-level folder in the vault, as paths. */
export function topLevelFolders(app: App): string[] {
    return app.vault.getRoot().children
        .filter((child): child is TFolder => child instanceof TFolder)
        .map((folder) => folder.path);
}

/**
 * The top-level folders that are scopes.
 *
 * One simple switch: on means every top-level folder is its own dictionary;
 * off means none is, and the user lists the folders to isolate in
 * "Custom scope folders" instead.
 */
export function effectiveTopLevel(
    allTopLevel: string[],
    settings: { scopeTopLevelAsScopes: boolean },
): string[] {
    return settings.scopeTopLevelAsScopes ? allTopLevel : [];
}

/**
 * Resolve the stored settings into a ScopeConfig.
 *
 * Custom paths are only used in the "off" mode, where they are the sole
 * source of scopes.
 */
export function resolveScopeConfig(app: App, settings: {
    folderDictionaryIsolation: boolean;
    scopeTopLevelAsScopes: boolean;
    scopeCustom: string[];
}): ScopeConfig {
    // Fast path: the feature is off. Do not walk the vault tree at all - this
    // runs on every decoration rebuild.
    if (!settings.folderDictionaryIsolation) {
        return { enabled: false, topLevel: [], custom: [] };
    }
    return {
        enabled: true,
        topLevel: effectiveTopLevel(topLevelFolders(app), settings),
        custom: settings.scopeCustom,
    };
}

const EMPTY_TARGETS: ReadonlySet<string> = new Set();

// Resolved link targets per note, keyed by path and invalidated by the file's
// mtime. buildDecorations runs on every cursor move / scroll / mode switch, and
// re-resolving every link each time was measurable on link-heavy notes.
const realLinkTargetCache = new Map<string, { mtime: number; targets: ReadonlySet<string> }>();

/**
 * Paths `file` links to with a real [[link]] (direct targets only).
 *
 * Folder-scope visibility lets a scoped note also match a file it explicitly
 * links to, even when that file lives in another scope. The target keeps its
 * own scope; nothing is re-assigned and nothing cascades.
 *
 * Every link form counts, and only the FILE is added: plain links, aliases,
 * heading links ([[Note#Heading]]) and block links ([[Note#^block]]) all point
 * at the note itself, and embeds (![[Note]]) are references too. The #anchor
 * part must be stripped before resolving - getFirstLinkpathDest cannot find a
 * file called "Note#Heading".
 */
export function realLinkTargets(app: App, file: TFile): ReadonlySet<string> {
    const mtime = file.stat?.mtime ?? 0;
    const cached = realLinkTargetCache.get(file.path);
    if (cached && cached.mtime === mtime) return cached.targets;

    const cache = app.metadataCache.getFileCache(file);
    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    if (refs.length === 0) {
        realLinkTargetCache.set(file.path, { mtime, targets: EMPTY_TARGETS });
        return EMPTY_TARGETS;
    }
    const targets = new Set<string>();
    for (const ref of refs) {
        // [[#Heading]] points at this very note - nothing to add.
        const linkpath = ref.link.split('#')[0].trim();
        if (!linkpath) continue;
        const dest = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
        if (dest) targets.add(dest.path);
    }
    realLinkTargetCache.set(file.path, { mtime, targets });
    return targets;
}

/** Normalize a folder path: forward slashes, no leading/trailing slash, no '.' segments. */
export function normalizeFolderPath(path: string): string {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((part) => part !== '' && part !== '.')
        .join('/');
}

/**
 * The effective scope list.
 *
 * Writing "Work/Project A" replaces the "Work" scope (its whole ancestor
 * chain), while unrelated picks such as "Life" keep working. This is the
 * "deeper path wins, but only over its own ancestors" rule.
 */
export function effectiveScopes(config: ScopeConfig): string[] {
    if (!config.enabled) return [];
    const all: string[] = [];
    const seen = new Set<string>();
    for (const raw of [...config.topLevel, ...config.custom]) {
        const path = normalizeFolderPath(raw);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        all.push(path);
    }
    return all.filter((scope) => !all.some(
        (other) => other !== scope && other.startsWith(scope + '/'),
    ));
}

/** The deepest scope containing `path`; '' when the note is global. */
export function scopeOf(path: string, scopes: string[]): string {
    const normalized = normalizeFolderPath(path);
    let best = '';
    for (const scope of scopes) {
        if (normalized === scope || normalized.startsWith(scope + '/')) {
            if (scope.length > best.length) best = scope;
        }
    }
    return best;
}

/**
 * Whether a candidate note may be linked from `sourcePath`.
 *
 * - A global source (no scope) keeps the previous behaviour: every note.
 * - A scoped source sees its own scope, global notes, and the files it links
 *   to with a real [[link]] (direct targets only; the target keeps its own
 *   scope, nothing is re-assigned).
 */
export function isVisibleInScope(
    sourcePath: string,
    candidatePath: string,
    scopes: string[],
    realLinkTargets: ReadonlySet<string>,
): boolean {
    const sourceScope = scopeOf(sourcePath, scopes);
    if (!sourceScope) return true;
    const candidateScope = scopeOf(candidatePath, scopes);
    if (candidateScope === sourceScope) return true;
    if (!candidateScope) return true;
    return realLinkTargets.has(normalizeFolderPath(candidatePath));
}
