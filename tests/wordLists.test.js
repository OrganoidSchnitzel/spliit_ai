'use strict';

const wordLists = require('../src/data/germanWordLists');

const AMBIGUOUS_CATEGORIES = [
  { id: 10, grouping: 'Entertainment', name: 'Entertainment' },
  { id: 11, grouping: 'Utilities', name: 'TV/Phone/Internet' },
];

const CATEGORIES = [
  { id: 1, grouping: 'Food and Drink', name: 'Groceries' },
  { id: 2, grouping: 'Food and Drink', name: 'Dining Out' },
  { id: 3, grouping: 'Food and Drink', name: 'Liquor' },
  { id: 4, grouping: 'Transportation', name: 'Gas/Fuel' },
  { id: 5, grouping: 'Transportation', name: 'Bus/Train' },
  { id: 6, grouping: 'Transportation', name: 'Hotel' },
  { id: 7, grouping: 'Home', name: 'Furniture' },
  { id: 8, grouping: 'Home', name: 'Household Supplies' },
  { id: 9, grouping: 'Life', name: 'Clothing' },
];

beforeAll(() => wordLists.init());

const match = (title) => wordLists.matchWordList({ title }, CATEGORIES);

describe('word-list matching: substring false positives', () => {
  // Each of these was auto-applied at 0.95 confidence by the previous
  // `combined.includes(keyword)` implementation, writing a wrong category
  // straight into the user's Spliit database.
  it.each([
    ['Barbecue Grillfleisch', 'bar'],
    ['Bargeld Abhebung', 'bar'],
    ['Barbier Haarschnitt', 'bar'],
    ['Jetzt Pizza', 'jet'],
    ['Cereal Kauf', 'real'],
    ['Portugal Reise', 'regal'],
  ])('does not match %s on the substring "%s"', (title) => {
    expect(match(title)).toBeNull();
  });
});

describe('word-list matching: real merchants still match', () => {
  it('matches a whole-word merchant name', () => {
    expect(match('Rewe Wocheneinkauf')).toMatchObject({ categoryName: 'Groceries' });
  });

  it('matches a multi-word phrase', () => {
    const res = match('Deutsche Bahn Ticket');
    expect(res).toMatchObject({ categoryName: 'Bus/Train', keyword: 'deutsche bahn' });
    expect(res.confidence).toBe(wordLists.CONFIDENCE.phrase);
  });

  it('matches through punctuation', () => {
    expect(match('H&M Sommerjacke')).toMatchObject({ categoryName: 'Clothing' });
  });

  it('matches a short keyword only as a whole token', () => {
    expect(match('DM Drogerie')).toMatchObject({ categoryName: 'Household Supplies' });
  });
});

describe('word-list matching: German compounds', () => {
  it('matches a keyword at the head of a compound', () => {
    expect(match('Tankstellenrechnung')).toMatchObject({
      categoryName: 'Gas/Fuel',
      keyword: 'tankstelle',
    });
  });

  it('matches a long keyword at the tail of a compound', () => {
    expect(match('Kleiderschrank')).toMatchObject({
      categoryName: 'Furniture',
      keyword: 'schrank',
    });
  });

  it('refuses tail matching for keywords below the safe length', () => {
    // "regal" is long enough to match a compound head but not a tail, which is
    // what keeps "Portugal" out of the furniture category.
    expect(wordLists.COMPOUND_SUFFIX_MIN_LENGTH).toBeGreaterThan(
      wordLists.COMPOUND_MIN_LENGTH
    );
    expect(match('Portugal Reise')).toBeNull();
  });
});

describe('word-list matching: umlaut folding', () => {
  it.each(['Möbel Schrank', 'Moebel Schrank', 'Möbelhaus Roller'])(
    'treats %s as furniture regardless of spelling',
    (title) => {
      expect(match(title)).toMatchObject({ categoryName: 'Furniture' });
    }
  );
});

describe('word-list matching: ambiguity', () => {
  it('defers to the LLM when two lists match equally strongly', () => {
    // "netflix" appears in both the entertainment and the TV/Phone/Internet
    // lists, so neither wins and guessing would be worse than asking the model.
    const res = wordLists.explain({ title: 'Netflix' }, AMBIGUOUS_CATEGORIES);
    expect(res.match).toBeNull();
    expect(res.ambiguous).toBe(true);
    expect(res.ambiguousBetween.length).toBeGreaterThan(1);
  });

  it('does not call a decisive win ambiguous', () => {
    // A phrase match outscores a lone token, so this resolves cleanly.
    const res = wordLists.explain({ title: 'Hotel Total Tankstelle' }, CATEGORIES);
    expect(res.ambiguous).toBe(false);
    expect(res.match.categoryName).toBe('Gas/Fuel');
  });

  it('prefers the longer, more specific keyword when scores differ', () => {
    // "drogerie" (8 chars) beats "dm" (2 chars); both point at the same list
    // here, so the winning keyword is what is asserted.
    expect(match('DM Drogerie').keyword).toBe('drogerie');
  });
});

describe('explain()', () => {
  it('reports the normalized text and all candidates', () => {
    const res = wordLists.explain({ title: 'REWE Markt!' }, CATEGORIES);
    expect(res.normalized).toBe('rewe markt');
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.match.categoryName).toBe('Groceries');
  });

  it('returns no match for an empty title', () => {
    expect(wordLists.explain({ title: '' }, CATEGORIES).match).toBeNull();
  });
});

describe('keyword editing', () => {
  afterEach(() => wordLists.resetList('liquor'));

  it('normalizes a keyword on the way in', () => {
    const res = wordLists.addKeyword('liquor', '  Spätkauf ');
    expect(res.ok).toBe(true);
    expect(res.keyword).toBe('spaetkauf');
    expect(res.warning).toBeNull();
  });

  it('warns that a short keyword only matches as a whole word', () => {
    const res = wordLists.addKeyword('liquor', 'gin');
    expect(res.warning).toMatch(/whole word/);
  });

  it('rejects a duplicate', () => {
    expect(() => wordLists.addKeyword('liquor', 'kneipe')).toThrow(/already in/);
  });

  it('rejects an unknown list', () => {
    expect(() => wordLists.addKeyword('nope', 'x')).toThrow(/Unknown word list/);
  });

  it('rejects a keyword that is too short', () => {
    expect(() => wordLists.addKeyword('liquor', 'a')).toThrow(/too short/);
  });

  it('removes a built-in keyword and records the removal so it stays gone', () => {
    const res = wordLists.removeKeyword('liquor', 'bar');
    expect(res).toMatchObject({ ok: true, wasManual: false });
    expect(wordLists.getWordLists().liquor.keywords).not.toContain('bar');
    expect(wordLists.getWordLists().liquor.removedKeywords).toContain('bar');
  });

  it('clears the removal when a removed built-in is added back', () => {
    wordLists.removeKeyword('liquor', 'bar');
    wordLists.addKeyword('liquor', 'bar');
    const list = wordLists.getWordLists().liquor;
    expect(list.keywords).toContain('bar');
    expect(list.removedKeywords).not.toContain('bar');
    expect(list.manualKeywords).not.toContain('bar');
  });

  it('rejects removing a keyword that is not there', () => {
    expect(() => wordLists.removeKeyword('liquor', 'nonexistent')).toThrow(/is not in/);
  });
});
