import assert from 'node:assert/strict';
import { loadTs } from './loadTs.mjs';

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.log(`  FAIL ${name}`);
        console.log(`       ${error.message}`);
    }
}

const { stem, isStemmingSupported } = await loadTs('linker/stemmer.ts');
// stripHeadingNumber / checkWordBoundary live on PrefixTree, not LinkerCache
// (LinkerCache only carries getInstance plus its instance methods).
const { PrefixTree } = await loadTs('linker/linkerCache.ts');

console.log('stemmer');

test('English is supported, unsupported languages fall back', () => {
    assert.equal(isStemmingSupported('en'), true);
    assert.equal(isStemmingSupported('zh'), false);
    assert.equal(isStemmingSupported('klingon'), false);
});

test('stemming is idempotent', () => {
    // "caresses" belongs in this list: it used to stem to "cares" and then to
    // "care", because the rebuilt ending was sliced off again afterwards.
    for (const word of ['running', 'connections', 'relational', 'ponies', 'caresses', 'caress']) {
        const once = stem(word, 'en');
        assert.equal(stem(once, 'en'), once, `not stable for ${word}`);
    }
});

test('plural endings stem to the right place', () => {
    assert.equal(stem('caresses', 'en'), 'caress');
    assert.equal(stem('caress', 'en'), 'caress');
    assert.equal(stem('ponies', 'en'), 'poni');
    assert.equal(stem('cats', 'en'), 'cat');
    assert.equal(stem('press', 'en'), 'press');
    // Porter's (*v*) s rule: the part before the s must contain a vowel, so
    // vowel-less words keep their s (a length-only check made this "gp").
    assert.equal(stem('gps', 'en'), 'gps');
    assert.equal(stem('gas', 'en'), 'ga');
});

test('stemming never grows the word and never returns empty', () => {
    for (const word of ['cats', 'running', 'generalizations', 'a', 'the']) {
        const result = stem(word, 'en');
        assert.ok(result.length > 0, `empty stem for ${word}`);
        assert.ok(result.length <= word.length, `stem grew for ${word}`);
    }
});

test('unsupported languages are a no-op', () => {
    assert.equal(stem('running', 'zh'), 'running');
});

console.log('LinkerCache.stripHeadingNumber');

test('strips a bracketed Chinese numeral', () => {
    assert.equal(PrefixTree.stripHeadingNumber('（六）牙痛'), '牙痛');
});

test('strips Arabic and Chinese numbering', () => {
    assert.equal(PrefixTree.stripHeadingNumber('5、治法'), '治法');
    assert.equal(PrefixTree.stripHeadingNumber('(1) 概述'), '概述');
    assert.equal(PrefixTree.stripHeadingNumber('一、总论'), '总论');
});

test('leaves a heading without numbering untouched', () => {
    assert.equal(PrefixTree.stripHeadingNumber('牙痛'), '牙痛');
});

test('does not strip a number that is the whole heading', () => {
    // Stripping these would leave an empty string, which used to be indexed as
    // a keyword of its own.
    assert.equal(PrefixTree.stripHeadingNumber('1.'), '1.');
    assert.equal(PrefixTree.stripHeadingNumber('  1. '), '  1. ');
});

test('section numbers do not cause catastrophic backtracking', () => {
    // The previous implementation was a nested `(?:...)*` regexp and went
    // exponential on this shape, which ran once per heading and froze the
    // whole preview. It has to stay linear.
    const adversarial = Array(30).fill('111111111').join('.') + 'x';
    const started = Date.now();
    PrefixTree.stripHeadingNumber(adversarial);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 50, `took ${elapsed}ms`);
});

console.log('LinkerCache.checkWordBoundary');

test('letters and digits are word characters', () => {
    assert.equal(PrefixTree.checkWordBoundary('a'), false);
    assert.equal(PrefixTree.checkWordBoundary('3'), false);
    assert.equal(PrefixTree.checkWordBoundary('牙'), false);
});

test('punctuation and spaces are boundaries', () => {
    assert.equal(PrefixTree.checkWordBoundary(' '), true);
    assert.equal(PrefixTree.checkWordBoundary('。'), true);
    assert.equal(PrefixTree.checkWordBoundary('.'), true);
});

console.log('LinkerCache.shouldAcceptWordMatch');

const S = (matchAnyPartsOfWords, matchBeginningOfWords, matchEndOfWords) => ({
    matchAnyPartsOfWords, matchBeginningOfWords, matchEndOfWords,
});

test('CJK always matches as a substring regardless of the toggles', () => {
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, false), '牙痛', false, false), true);
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, false), '牙痛', true, true), true);
});

test('kana, Hangul and Han extensions also match as substrings', () => {
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, false), 'かな', false, false), true);    // Hiragana
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, false), 'カナ', false, false), true);    // Katakana
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, false), '한글', false, false), true);    // Hangul
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, false), '\u{20000}', false, false), true); // Han ext-B
});

test('a whole English word is always accepted', () => {
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, false), 'nit', true, true), true);
});

test('a prefix needs matchBeginningOfWords', () => {
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, true), 'nit', true, false), false);
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, true, false), 'nit', true, false), true);
});

test('a suffix needs matchEndOfWords', () => {
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, true, false), 'nit', false, true), false);
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, false, true), 'nit', false, true), true);
});

test('an inner substring is rejected unless matchAnyPartsOfWords is on', () => {
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(false, true, true), 'nit', false, false), false);
    assert.equal(PrefixTree.shouldAcceptWordMatch(S(true, false, false), 'nit', false, false), true);
});

console.log('convertLink.relative');

// Shared by both conversion paths (convertLink and batchConvert), so the
// relative link format is computed by one implementation.
const { relative } = await loadTs('linker/convertLink.ts');

test('same directory yields no prefix', () => {
    assert.equal(relative('a/b', 'a/b'), '');
});

test('descends into a subdirectory', () => {
    // No levels to climb, so the prefix is "./" rather than "../".
    assert.equal(relative('a', 'a/c'), './c');
});

test('climbs out to a sibling tree', () => {
    assert.equal(relative('a/b', 'c'), '../../c');
});

test('handles the vault root', () => {
    assert.equal(relative('', 'a'), './a');
    assert.equal(relative('a', ''), '..');
});

test('a built relative path never gains a leading slash', () => {
    // Regression: concatenating '/' onto the '' returned for the same directory
    // produced "/target.md", which resolves from the vault root instead of from
    // the note being converted.
    const build = (from, to, base) => {
        const relDir = relative(from, to);
        return (relDir ? relDir + '/' : '') + base;
    };
    assert.equal(build('a/b', 'a/b', 'target.md'), 'target.md');
    assert.equal(build('a/b', 'c', 'target.md'), '../../c/target.md');
    assert.equal(build('', 'a', 'target.md'), './a/target.md');
});

console.log('folder scopes');

const { normalizeFolderPath, effectiveScopes, scopeOf, isVisibleInScope, realLinkTargets, effectiveTopLevel } = await loadTs('linker/scope.ts');

test('folder paths normalize across separators and stray slashes', () => {
    assert.equal(normalizeFolderPath('Work\\Project A\\'), 'Work/Project A');
    assert.equal(normalizeFolderPath('/Work//Project A/'), 'Work/Project A');
    assert.equal(normalizeFolderPath('./Work/./Project A'), 'Work/Project A');
    assert.equal(normalizeFolderPath(''), '');
});

test('the master switch keeps every note global', () => {
    assert.deepEqual(effectiveScopes({ enabled: false, topLevel: ['Work'], custom: [] }), []);
});

test('a deeper custom path replaces its own ancestors only', () => {
    // Discussion #21, option A: "Work" drops out, "Life" is untouched.
    assert.deepEqual(
        effectiveScopes({ enabled: true, topLevel: ['Work', 'Life'], custom: ['Work/Project A'] }),
        ['Life', 'Work/Project A'],
    );
});

test('two deeper paths replace the shared ancestor together', () => {
    assert.deepEqual(
        effectiveScopes({ enabled: true, topLevel: ['Work'], custom: ['Work/Project A', 'Work/Project B'] }),
        ['Work/Project A', 'Work/Project B'],
    );
});

test('a custom path works without a matching top-level pick', () => {
    assert.deepEqual(
        effectiveScopes({ enabled: true, topLevel: ['Life'], custom: ['Work/Project A'] }),
        ['Life', 'Work/Project A'],
    );
});

test('duplicates and empty lines are dropped', () => {
    assert.deepEqual(
        effectiveScopes({ enabled: true, topLevel: ['Work', 'Work'], custom: ['', 'Work'] }),
        ['Work'],
    );
});

test('scopeOf picks the deepest containing scope', () => {
    const scopes = ['Work', 'Work/Project A'];
    assert.equal(scopeOf('Work/Project A/note.md', scopes), 'Work/Project A');
    assert.equal(scopeOf('Work/Other/note.md', scopes), 'Work');
    assert.equal(scopeOf('Root.md', scopes), '');
});

test('scopeOf does not match a prefix that is not a folder boundary', () => {
    // "Workplace" must not be treated as being inside "Work".
    assert.equal(scopeOf('Workplace/note.md', ['Work']), '');
});

test('scoped sources see their scope, global notes and real link targets', () => {
    const scopes = ['Work', 'Life'];
    const linked = new Set(['Life/Shared.md']);
    // Same scope.
    assert.equal(isVisibleInScope('Work/a.md', 'Work/b.md', scopes, linked), true);
    // Global note.
    assert.equal(isVisibleInScope('Work/a.md', 'Templates/t.md', scopes, linked), true);
    // Real link target that lives in another scope.
    assert.equal(isVisibleInScope('Work/a.md', 'Life/Shared.md', scopes, linked), true);
    // Another scope, no real link.
    assert.equal(isVisibleInScope('Work/a.md', 'Life/x.md', scopes, linked), false);
});

test('global sources keep the previous behaviour', () => {
    assert.equal(isVisibleInScope('Root.md', 'Work/a.md', ['Work'], new Set()), true);
});

test('top-level folders are scopes by default', () => {
    assert.deepEqual(
        effectiveTopLevel(['Work', 'Life', 'Inbox'], { scopeTopLevelAsScopes: true }),
        ['Work', 'Life', 'Inbox'],
    );
});

test('with the default off, no top-level folder is a scope', () => {
    assert.deepEqual(
        effectiveTopLevel(['Work', 'Life'], { scopeTopLevelAsScopes: false }),
        [],
    );
});

test('real link targets cover aliases, headings, blocks and embeds', () => {
    const fakeApp = {
        metadataCache: {
            getFileCache: () => ({
                links: [
                    { link: 'Plain' },
                    // Obsidian keeps the alias in displayText, not in link.link.
                    { link: 'Aliased', displayText: 'shown text' },
                    { link: 'WithHeading#Some heading' },
                    { link: 'WithBlock#^abc123' },
                    { link: '#LocalHeading' },
                ],
                embeds: [{ link: 'Embedded' }],
            }),
            getFirstLinkpathDest: (linkpath) => {
                const known = ['Plain', 'Aliased', 'WithHeading', 'WithBlock', 'Embedded'];
                return known.includes(linkpath) ? { path: 'Life/' + linkpath + '.md' } : null;
            },
        },
    };
    const targets = realLinkTargets(fakeApp, { path: 'Work/source.md' });
    assert.deepEqual([...targets].sort(), [
        'Life/Aliased.md',
        'Life/Embedded.md',
        'Life/Plain.md',
        'Life/WithBlock.md',
        'Life/WithHeading.md',
    ]);
});

console.log('');
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
