import IntervalTree from '@flatten-js/interval-tree';

/**
 * One pass over the whole text, marking regions that must not be linked or
 * converted: frontmatter, fenced code blocks, inline code, math (block and
 * inline), existing wikilinks/embeds and Markdown links.
 *
 * Shared by batch conversion and by "only link once", which has to know
 * whether an earlier occurrence of a keyword is a real occurrence or sits
 * inside a code block / an existing link.
 */
export function buildExcludedIntervals(text: string): IntervalTree {
    const tree = new IntervalTree();
    const n = text.length;
    // The tree uses CLOSED intervals while every `to` here is exclusive;
    // inserting `to` as-is made a range cover the first character after it,
    // so a match starting right after "[[...]]" (with no separator) was
    // skipped as "inside a link". Same fix as liveLinker.
    const add = (from: number, to: number) => { if (to > from) tree.insert([from, to - 1]); };

    // Frontmatter: a leading "---" ... "---" (or "...") block. Both YAML
    // terminators are handled; the old code only found "---", so a "..."-closed
    // frontmatter still had its contents converted.
    if (text.startsWith('---')) {
        const endDashes = text.indexOf('\n---', 3);
        const endDots = text.indexOf('\n...', 3);
        let end = -1;
        if (endDashes !== -1 && (endDots === -1 || endDashes < endDots)) {
            end = endDashes;
        } else if (endDots !== -1) {
            end = endDots;
        }
        if (end !== -1) {
            const lineEnd = text.indexOf('\n', end + 1);
            add(0, lineEnd === -1 ? n : lineEnd + 1);
        }
    }

    for (let i = 0; i < n;) {
        const ch = text[i];

        // Fenced code block: a run of >=3 ` or ~ that STARTS the line (possibly
        // indented). A run elsewhere is inline code, handled below - the old
        // code treated any mid-line ``` as a fence opener, and when no closing
        // fence existed it excluded everything to the end of the document,
        // silently dropping every link in the rest of the note.
        if (ch === '`' || ch === '~') {
            let j = i;
            while (j < n && text[j] === ch) j++;
            const fenceLen = j - i;
            const lineStart = text.lastIndexOf('\n', i - 1) + 1;
            const atLineStart = !/\S/.test(text.slice(lineStart, i));
            if (fenceLen >= 3 && atLineStart) {
                const close = findClosingFence(text, j, ch, fenceLen);
                if (close !== -1) {
                    const lineEnd = text.indexOf('\n', close);
                    add(i, lineEnd === -1 ? n : lineEnd + 1);
                    i = lineEnd === -1 ? n : lineEnd + 1;
                    continue;
                }
                // Unclosed fence: everything from here on is code.
                add(i, n);
                break;
            }
        }

        // Inline code span: a backtick run closed by a run of the SAME length
        // (CommonMark pairing). The old single-backtick search closed a ``-span
        // at the first backtick of the opening run's twin, leaking the rest of
        // the span into the conversion scan.
        if (ch === '`') {
            let j = i;
            while (j < n && text[j] === '`') j++;
            const openLen = j - i;
            let p = j;
            let closed = false;
            while (p < n && !closed) {
                const idx = text.indexOf('`', p);
                if (idx === -1) break;
                let q = idx;
                while (q < n && text[q] === '`') q++;
                if (q - idx === openLen) {
                    add(i, q);
                    i = q;
                    closed = true;
                } else {
                    p = q;
                }
            }
            if (closed) continue;
        }

        // Math: $$...$$ block, or $...$ inline.
        if (ch === '$') {
            if (text[i + 1] === '$') {
                const close = text.indexOf('$$', i + 2);
                if (close !== -1) { add(i, close + 2); i = close + 2; continue; }
            } else {
                const close = text.indexOf('$', i + 1);
                if (close !== -1 && close > i + 1) { add(i, close + 1); i = close + 1; continue; }
            }
        }

        // Existing wikilink / embed: [[...]] or ![[...]].
        if (text.startsWith('[[', i) || text.startsWith('![[', i)) {
            const open = i + (text[i] === '!' ? 3 : 2);
            const close = text.indexOf(']]', open);
            if (close !== -1) { add(i, close + 2); i = close + 2; continue; }
        }

        // Markdown link [text](url).
        if (ch === '[') {
            const closeBracket = text.indexOf(']', i + 1);
            if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
                const closeParen = text.indexOf(')', closeBracket + 2);
                if (closeParen !== -1) { add(i, closeParen + 1); i = closeParen + 1; continue; }
            }
        }

        i++;
    }
    return tree;
}

/** Find the line start of a closing fence (>=minLen of the same char). */
function findClosingFence(text: string, from: number, ch: string, minLen: number): number {
    let i = from;
    while (i < text.length) {
        const lineStart = text.lastIndexOf('\n', i - 1) + 1;
        let j = lineStart;
        while (j < text.length && text[j] === ch) j++;
        if (j - lineStart >= minLen) return lineStart;
        const next = text.indexOf('\n', i);
        if (next === -1) return -1;
        i = next + 1;
    }
    return -1;
}
