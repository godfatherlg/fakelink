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

console.log('');
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
