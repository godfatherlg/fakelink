import IntervalTree from '@flatten-js/interval-tree';

import type { LinkerPluginSettings } from '../main';
import { buildExcludedIntervals } from './excludedIntervals';
import { PrefixTree } from './linkerCache';

/**
 * Document-wide "only link once" support.
 *
 * The old check compared a match against the matches produced by the SAME
 * render pass, so "once" really meant "once per screenful": two occurrences a
 * few screens apart were both linked, scrolling made links appear and
 * disappear, and callouts (rendered through the reading-view path) kept a
 * separate ledger. Deciding from the document text instead is stable: a match
 * is kept only when no earlier accepted occurrence of the same keyword exists.
 *
 * Known simplification: case-insensitive matching lowercases the whole text,
 * which changes string length for a few exotic characters (e.g. "İ"). For such
 * documents the context falls back to case-sensitive positions - earlier
 * occurrences with different casing are then not counted, which can leave one
 * extra link rather than dropping one.
 */
export interface FirstOccurrenceContext {
    text: string;
    /** Lowercased copy for case-insensitive lookups; null when lowercasing changed the length. */
    lowerText: string | null;
    excluded: IntervalTree;
    settings: Pick<
        LinkerPluginSettings,
        'matchAnyPartsOfWords' | 'matchBeginningOfWords' | 'matchEndOfWords' | 'matchCaseSensitive' | 'allowLinksInHeaders'
    >;
}

export function buildFirstOccurrenceContext(
    text: string,
    settings: FirstOccurrenceContext['settings']
): FirstOccurrenceContext {
    const lower = text.toLowerCase();
    return {
        text,
        // Index-preserving lowercase only. Turkish "İ" and friends expand to
        // two code units, which would shift every position after them.
        lowerText: lower.length === text.length ? lower : null,
        excluded: buildExcludedIntervals(text),
        settings,
    };
}

/**
 * True when `keyword` has no accepted occurrence before `from`.
 *
 * "Accepted" mirrors the scanner: the occurrence must not sit inside code,
 * maths, frontmatter or an existing link, and it must satisfy the same
 * word-boundary toggles the editor uses.
 */
export function isFirstOccurrence(ctx: FirstOccurrenceContext, from: number, keyword: string): boolean {
    if (keyword.length === 0) return true;
    const caseSensitive = ctx.settings.matchCaseSensitive;
    const haystack = caseSensitive ? ctx.text : (ctx.lowerText ?? ctx.text);
    const needle = caseSensitive ? keyword : keyword.toLowerCase();
    if (needle.length === 0) return true;

    let index = from > 0 ? haystack.lastIndexOf(needle, from - 1) : -1;
    while (index !== -1) {
        if (!isExcluded(ctx, index, index + needle.length) && acceptsOccurrence(ctx, index, needle)) {
            return false;
        }
        index = index === 0 ? -1 : haystack.lastIndexOf(needle, index - 1);
    }
    return true;
}

/**
 * Start offset of `line` (0-based) in `text`, cached per text.
 *
 * Reading view reports a section as a line range, so this is what turns
 * "before this section" into an offset the checker understands.
 */
const lineOffsets = new Map<string, number[]>();

export function lineStartOffset(text: string, line: number): number {
    let offsets = lineOffsets.get(text);
    if (!offsets) {
        if (lineOffsets.size > 8) lineOffsets.clear();
        offsets = [0];
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10) offsets.push(i + 1);
        }
        lineOffsets.set(text, offsets);
    }
    const index = Math.max(0, Math.min(line, offsets.length - 1));
    return offsets[index];
}

/**
 * True when `keyword` already appears in an already-rendered text prefix.
 *
 * Used for repeats inside one section: the rendered text no longer contains
 * markdown markers, so exclusion rules cannot be applied there - only the word
 * boundary rules, which is enough for the "second occurrence in the same
 * paragraph" case.
 */
export function containsAcceptedOccurrence(
    text: string,
    keyword: string,
    settings: FirstOccurrenceContext['settings']
): boolean {
    if (keyword.length === 0 || text.length === 0) return false;
    const caseSensitive = settings.matchCaseSensitive;
    const haystack = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? keyword : keyword.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        const end = index + needle.length;
        const before = index === 0 ? '' : text[index - 1];
        const after = end >= text.length ? '' : text[end];
        const startsAtWordBoundary = index === 0 || PrefixTree.checkWordBoundary(before);
        const endsAtWordBoundary = end >= text.length || PrefixTree.checkWordBoundary(after);
        if (PrefixTree.shouldAcceptWordMatch(settings, needle, startsAtWordBoundary, endsAtWordBoundary)) {
            return true;
        }
        index = haystack.indexOf(needle, index + 1);
    }
    return false;
}

function isExcluded(ctx: FirstOccurrenceContext, from: number, to: number): boolean {
    // Intervals are stored closed, so an occurrence spans [from, to - 1].
    return ctx.excluded.search([from, Math.max(from, to - 1)]).length > 0;
}

function acceptsOccurrence(ctx: FirstOccurrenceContext, position: number, needle: string): boolean {
    const text = ctx.text;

    // A heading line never counts as the occurrence the body "already"
    // linked: a heading must not link to its own note, and heading matches are
    // dropped from the render when that rule applies. Counting them made the
    // first body occurrence disappear whenever the heading text came earlier
    // in the document.
    const lineStart = text.lastIndexOf('\n', position - 1) + 1;
    if (/^#{1,6}\s/.test(text.slice(lineStart, position + 1))) return false;

    const before = position === 0 ? '' : text[position - 1];
    const end = position + needle.length;
    const after = end >= text.length ? '' : text[end];
    const startsAtWordBoundary = position === 0 || PrefixTree.checkWordBoundary(before);
    const endsAtWordBoundary = end >= text.length || PrefixTree.checkWordBoundary(after);
    return PrefixTree.shouldAcceptWordMatch(ctx.settings, needle, startsAtWordBoundary, endsAtWordBoundary);
}
