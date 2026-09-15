'use strict';

const fs = require('fs');
const path = require('path');
const localDb = require('../localDb');

/**
 * German word lists for fast category matching without LLM calls.
 * These lists contain common German merchant names and keywords that can be matched instantly.
 *
 * Categories are mapped to match the Spliit database schema:
 * https://github.com/spliit-app/spliit/blob/main/prisma/migrations/20240108194443_add_categories/migration.sql
 */

const wordLists = {
  // Food and Drink (grouping: "Food and Drink")
  groceryStores: {
    targetCategoryNames: ['Groceries', 'Food and Drink'],
    keywords: [
      'lidl',
      'rewe',
      'edeka',
      'aldi',
      'kaufland',
      'netto',
      'penny',
      'real',
      'hit',
      'tegut',
      'famila',
      'marktkauf',
      'combi',
      'globus',
      'norma',
      'supermarkt',
      'lebensmittel',
    ],
  },
  restaurants: {
    targetCategoryNames: ['Dining Out', 'Food and Drink'],
    keywords: [
      'mcdonalds',
      'burger king',
      'kfc',
      'subway',
      'pizza hut',
      'dominos',
      'restaurant',
      'cafe',
      'bistro',
      'pizzeria',
      'imbiss',
      'döner',
      'kebab',
      'bakery',
      'bäckerei',
      'coffeeshop',
      'starbucks',
      'mensa',
      'kantine',
    ],
  },
  liquor: {
    targetCategoryNames: ['Liquor', 'Food and Drink'],
    keywords: [
      'getränkemarkt',
      'weinhandlung',
      'spirituosen',
      'liquor',
      'wine shop',
      'bar',
      'pub',
      'kneipe',
    ],
  },

  // Transportation (grouping: "Transportation")
  fuelStations: {
    targetCategoryNames: ['Gas/Fuel', 'Transportation'],
    keywords: [
      'shell',
      'aral',
      'esso',
      'jet',
      'bp',
      'agip',
      'totalenergies',
      'total tankstelle',
      'tankstelle',
      'tanken',
      'gas station',
      'petrol',
      'fuel',
      'benzin',
      'diesel',
    ],
  },
  publicTransport: {
    targetCategoryNames: ['Bus/Train', 'Transportation'],
    keywords: [
      'deutsche bahn',
      'db',
      'bahn',
      'train',
      'bus',
      'flixbus',
      'mvg',
      'hvv',
      'vvs',
      'vrr',
      'öpnv',
      'nahverkehr',
      'vgn',
      'rmv',
      'kvb',
      'bvg',
      's-bahn',
      'u-bahn',
      'straßenbahn',
      'tram',
    ],
  },
  taxi: {
    targetCategoryNames: ['Taxi', 'Transportation'],
    keywords: [
      'uber',
      'taxi',
      'lyft',
      'bolt',
      'freenow',
      'mytaxi',
    ],
  },
  hotel: {
    targetCategoryNames: ['Hotel', 'Transportation'],
    keywords: [
      'hotel',
      'motel',
      'hostel',
      'airbnb',
      'booking',
      'pension',
      'unterkunft',
      'accommodation',
    ],
  },
  parking: {
    targetCategoryNames: ['Parking', 'Transportation'],
    keywords: [
      'parkhaus',
      'parking',
      'parkplatz',
      'park',
      'tiefgarage',
    ],
  },
  plane: {
    targetCategoryNames: ['Plane', 'Transportation'],
    keywords: [
      'lufthansa',
      'ryanair',
      'easyjet',
      'eurowings',
      'airline',
      'flight',
      'flug',
      'airport',
      'flughafen',
    ],
  },
  bicycle: {
    targetCategoryNames: ['Bicycle', 'Transportation'],
    keywords: [
      'fahrrad',
      'bicycle',
      'bike',
      'e-bike',
      'nextbike',
      'call a bike',
      'radstation',
    ],
  },
  car: {
    targetCategoryNames: ['Car', 'Transportation'],
    keywords: [
      'autowerkstatt',
      'car repair',
      'werkstatt',
      'atu',
      'sixt',
      'europcar',
      'car rental',
      'mietwagen',
      'autovermietung',
    ],
  },

  // Home (grouping: "Home")
  furniture: {
    targetCategoryNames: ['Furniture', 'Home'],
    keywords: [
      'ikea',
      'möbel',
      'moebel',
      'möbelhaus',
      'poco',
      'roller',
      'höffner',
      'segmüller',
      'xxxlutz',
      'home24',
      'furniture',
      // Generic item words. These used to live as a private constant in
      // ollamaService; they belong with the rest of the matching data.
      'schrank',
      'kommode',
      'regal',
      'schreibtisch',
      'couchtisch',
      'esstisch',
      'sessel',
      'sofa',
      'couch',
      'bett',
      'matratze',
      'lampe',
      'stuhl',
      'tisch',
    ],
  },
  electronics: {
    targetCategoryNames: ['Electronics', 'Home'],
    keywords: [
      'media markt',
      'mediamarkt',
      'saturn',
      'conrad',
      'cyberport',
      'notebooksbilliger',
      'alternate',
      'apple',
      'samsung',
      'elektronik',
    ],
  },
  householdSupplies: {
    targetCategoryNames: ['Household Supplies', 'Home'],
    keywords: [
      'dm',
      'rossmann',
      'müller',
      'drogerie',
      'drugstore',
      'haushaltswaren',
      'reinigung',
      'cleaning supplies',
    ],
  },
  pets: {
    targetCategoryNames: ['Pets', 'Home'],
    keywords: [
      'fressnapf',
      'zoo zajac',
      'tierarzt',
      'veterinary',
      'tierbedarf',
      'pet',
      'haustier',
    ],
  },
  maintenance: {
    targetCategoryNames: ['Maintenance', 'Home'],
    keywords: [
      'handwerker',
      'reparatur',
      'repair',
      'maintenance',
      'wartung',
      'instandhaltung',
    ],
  },
  rent: {
    targetCategoryNames: ['Rent', 'Home'],
    keywords: [
      'miete',
      'rent',
      'wohnungsmiete',
      'kaltmiete',
      'warmmiete',
    ],
  },
  mortgage: {
    targetCategoryNames: ['Mortgage', 'Home'],
    keywords: [
      'hypothek',
      'mortgage',
      'baudarlehen',
      'immobilienkredit',
    ],
  },
  homeServices: {
    targetCategoryNames: ['Services', 'Home'],
    keywords: [
      'gartenpflege',
      'gebäudereinigung',
      'schornsteinfeger',
      'hausmeister',
      'home service',
    ],
  },

  // Entertainment (grouping: "Entertainment")
  entertainment: {
    targetCategoryNames: ['Entertainment', 'Movies', 'Music'],
    keywords: [
      'kino',
      'cinema',
      'cinemaxx',
      'cinestar',
      'uci',
      'netflix',
      'spotify',
      'disney+',
      'amazon prime',
      'museum',
      'theater',
      'zoo',
      'concert',
      'konzert',
      'streaming',
    ],
  },
  games: {
    targetCategoryNames: ['Games', 'Entertainment'],
    keywords: [
      'steam',
      'playstation',
      'xbox',
      'nintendo',
      'gamestop',
      'epic games',
      'gaming',
      'videospiel',
    ],
  },
  sports: {
    targetCategoryNames: ['Sports', 'Entertainment'],
    keywords: [
      'sportstudio',
      'sportverein',
      'stadion',
      'arena',
      'sports',
      'decathlon',
      'sport',
      'intersport',
    ],
  },

  // Life (grouping: "Life")
  clothing: {
    targetCategoryNames: ['Clothing', 'Life'],
    keywords: [
      'h&m',
      'zara',
      'c&a',
      'primark',
      'new yorker',
      'esprit',
      'peek & cloppenburg',
      'galeria',
      'breuninger',
      'zalando',
      'kleidung',
      'fashion',
      'mode',
    ],
  },
  medicalExpenses: {
    targetCategoryNames: ['Medical Expenses', 'Life'],
    keywords: [
      'apotheke',
      'pharmacy',
      'arzt',
      'doctor',
      'krankenhaus',
      'hospital',
      'klinik',
      'clinic',
      'zahnarzt',
      'dentist',
      'physiotherapie',
      'physiotherapy',
      'orthopäde',
    ],
  },
  insurance: {
    targetCategoryNames: ['Insurance', 'Life'],
    keywords: [
      'versicherung',
      'insurance',
      'krankenkasse',
      'health insurance',
      'haftpflicht',
      'liability',
      'allianz',
      'axa',
      'ergo',
    ],
  },
  gifts: {
    targetCategoryNames: ['Gifts', 'Life'],
    keywords: [
      'geschenk',
      'gift',
      'present',
      'blumen',
      'flowers',
      'geschenkgutschein',
    ],
  },
  education: {
    targetCategoryNames: ['Education', 'Life'],
    keywords: [
      'schule',
      'school',
      'universität',
      'university',
      'uni',
      'bildung',
      'education',
      'kurs',
      'course',
      'seminar',
      'studiengebühren',
      'tuition',
    ],
  },
  childcare: {
    targetCategoryNames: ['Childcare', 'Life'],
    keywords: [
      'kindergarten',
      'kita',
      'kinderbetreuung',
      'childcare',
      'daycare',
      'babysitter',
    ],
  },
  donation: {
    targetCategoryNames: ['Donation', 'Life'],
    keywords: [
      'spende',
      'donation',
      'charity',
      'wohltätigkeit',
      'fundraising',
    ],
  },
  taxes: {
    targetCategoryNames: ['Taxes', 'Life'],
    keywords: [
      'steuer',
      'tax',
      'finanzamt',
      'steuererklärung',
      'einkommensteuer',
    ],
  },

  // Utilities (grouping: "Utilities")
  electricity: {
    targetCategoryNames: ['Electricity', 'Utilities'],
    keywords: [
      'strom',
      'electricity',
      'eon',
      'vattenfall',
      'stadtwerke',
      'energieversorger',
    ],
  },
  heatGas: {
    targetCategoryNames: ['Heat/Gas', 'Utilities'],
    keywords: [
      'gas',
      'heizung',
      'heating',
      'fernwärme',
      'district heating',
    ],
  },
  water: {
    targetCategoryNames: ['Water', 'Utilities'],
    keywords: [
      'wasser',
      'water',
      'wasserwerk',
      'wasserbetrieb',
    ],
  },
  internet: {
    targetCategoryNames: ['TV/Phone/Internet', 'Utilities'],
    keywords: [
      'telekom',
      'vodafone',
      'o2',
      '1&1',
      'telefon',
      'phone',
      'internet',
      'mobilfunk',
      'mobile',
      'kabel',
      'cable',
      'tv',
      'netflix',
      'streaming',
    ],
  },
  trash: {
    targetCategoryNames: ['Trash', 'Utilities'],
    keywords: [
      'müll',
      'trash',
      'garbage',
      'abfall',
      'müllabfuhr',
      'entsorgung',
    ],
  },
  cleaning: {
    targetCategoryNames: ['Cleaning', 'Utilities'],
    keywords: [
      'reinigung',
      'cleaning',
      'putzfrau',
      'gebäudereinigung',
    ],
  },

  // Hardware/DIY (grouping: "Home")
  hardware: {
    targetCategoryNames: ['Maintenance', 'Home'],
    keywords: [
      'bauhaus',
      'obi',
      'hornbach',
      'toom',
      'hagebau',
      'baumarkt',
      'werkzeug',
      'heimwerker',
      'diy',
      'hardware store',
    ],
  },
};

const COMPOUND_MIN_LENGTH = 5;
const COMPOUND_SUFFIX_MIN_LENGTH = 6;
const MIN_KEYWORD_LENGTH = 2;
const MAX_KEYWORD_LENGTH = 60;
const MAX_MANUAL_KEYWORDS_FILE_BYTES = 1024 * 1024; // 1 MB

/** Confidence assigned per match quality. */
const CONFIDENCE = {
  phrase: 0.95,       // "deutsche bahn" — several tokens, very unlikely by chance
  exactLong: 0.93,    // whole token, 5+ chars
  compound: 0.9,      // token prefix, e.g. "tankstelle" in "Tankstellenrechnung"
  exactMedium: 0.88,  // whole token, 4 chars
  exactShort: 0.8,    // whole token, <= 3 chars ("dm", "db", "o2")
};

// User edits layered on top of the built-in lists.
const manualKeywords = {};   // listName -> [keyword]  (added by the user)
const removedKeywords = {};  // listName -> [keyword]  (built-ins the user deleted)

let builtInKeywords = null;  // frozen snapshot, so "removed" can be undone
let initialized = false;

function manualKeywordsPath() {
  return path.join(localDb.dataDir(), 'manual-keywords.json');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fold German umlauts so "möbel" and "moebel" are the same token, then strip
 * punctuation to spaces so "H&M" becomes the two-token phrase "h m".
 * @param {string} value
 */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize a keyword for storage and comparison. */
function normalizeKeyword(keyword) {
  return normalizeText(keyword);
}

/**
 * Does `keyword` occur in `haystack` in a way that should count as a match?
 *
 * Plain `String.includes` is not usable here: it matched "bar" inside
 * "Bargeld", "jet" inside "Jetzt" and "real" inside "Cereal", and because a
 * word-list hit is auto-applied, those wrote wrong categories straight into
 * the user's Spliit database.
 *
 * Matching therefore runs at token boundaries. Keywords of 5+ characters may
 * also match the *start* of a longer token, because German compounds words
 * freely ("Tankstellenrechnung", "Supermarkteinkauf"); shorter keywords must
 * be a whole token, where a chance collision is far less likely.
 *
 * @param {string} haystack - normalized title + notes
 * @param {string} keyword  - normalized keyword
 * @returns {{ keyword: string, score: number, kind: string, confidence: number } | null}
 */
function matchKeyword(haystack, keyword) {
  if (!keyword) return null;

  const isPhrase = keyword.includes(' ');
  const escaped = escapeRegex(keyword);
  const exact = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'u').test(haystack);

  let kind = null;
  if (exact) {
    if (isPhrase) kind = 'phrase';
    else if (keyword.length >= COMPOUND_MIN_LENGTH) kind = 'exactLong';
    else if (keyword.length === 4) kind = 'exactMedium';
    else kind = 'exactShort';
  } else if (!isPhrase && keyword.length >= COMPOUND_MIN_LENGTH) {
    // German compounds run in both directions: "Tankstellenrechnung" has the
    // keyword at the head, "Kleiderschrank" at the tail. Tail matching needs a
    // longer keyword to stay safe — "regal" would otherwise match "Portugal".
    if (new RegExp(`(?:^|\\s)${escaped}`, 'u').test(haystack)) {
      kind = 'compound';
    } else if (
      keyword.length >= COMPOUND_SUFFIX_MIN_LENGTH &&
      new RegExp(`${escaped}(?=\\s|$)`, 'u').test(haystack)
    ) {
      kind = 'compound';
    }
  }

  if (!kind) return null;

  return {
    keyword,
    // Longer, more specific keywords win over short generic ones.
    score: keyword.replace(/\s+/g, '').length + (kind === 'phrase' ? 2 : 0) + (exact ? 1 : 0),
    kind,
    confidence: CONFIDENCE[kind],
  };
}

/** Resolve a list's target names against the categories present in Spliit. */
function resolveCategory(listData, categories) {
  for (const targetName of listData.targetCategoryNames) {
    const found = categories.find(
      (cat) => String(cat.name).toLowerCase() === String(targetName).toLowerCase()
    );
    if (found) return found;
  }
  return null;
}

/**
 * Score an expense against every word list.
 *
 * Returns all candidates so the UI can explain a decision, plus the winner and
 * whether the result was discarded as ambiguous.
 *
 * @param {{ title?: string, notes?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 */
function evaluate(expense, categories) {
  const haystack = normalizeText(`${expense.title || ''} ${expense.notes || ''}`);
  const candidates = [];

  if (!haystack) return { match: null, candidates, ambiguous: false };

  for (const [listName, listData] of Object.entries(wordLists)) {
    let best = null;
    for (const keyword of listData.keywords) {
      const hit = matchKeyword(haystack, normalizeKeyword(keyword));
      if (hit && (!best || hit.score > best.score)) best = hit;
    }
    if (!best) continue;

    const category = resolveCategory(listData, categories);
    if (!category) continue;

    candidates.push({
      listName,
      keyword: best.keyword,
      kind: best.kind,
      score: best.score,
      confidence: best.confidence,
      categoryId: category.id,
      categoryName: category.name,
    });
  }

  if (candidates.length === 0) return { match: null, candidates, ambiguous: false };

  candidates.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
  const [winner] = candidates;

  // "Hotel Total" matches both the hotel list and the fuel brand Total with
  // equal weight. Guessing would be worse than asking the model, so an
  // unbroken tie between different categories falls through to the LLM.
  const tied = candidates.filter(
    (c) => c.score === winner.score && c.categoryId !== winner.categoryId
  );
  if (tied.length > 0) {
    return {
      match: null,
      candidates,
      ambiguous: true,
      ambiguousBetween: [winner, ...tied].map((c) => c.categoryName),
    };
  }

  return { match: winner, candidates, ambiguous: false };
}

/**
 * Match an expense title against the word lists.
 * @param {{ title?: string, notes?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {{ categoryId: number, categoryName: string, confidence: number,
 *             reasoning: string, source: string } | null}
 */
function matchWordList(expense, categories) {
  const { match } = evaluate(expense, categories || []);
  if (!match) return null;

  const how =
    match.kind === 'compound'
      ? `as part of a compound word`
      : match.kind === 'phrase'
        ? `as a phrase`
        : `as a whole word`;

  return {
    categoryId: match.categoryId,
    categoryName: match.categoryName,
    confidence: match.confidence,
    reasoning: `Matched "${match.keyword}" ${how} from the ${match.listName} word list.`,
    source: 'wordlist',
    listName: match.listName,
    keyword: match.keyword,
  };
}

/**
 * Explain what the word lists would do with a title, without needing an
 * expense to exist. Powers the word-list tester in the UI.
 */
function explain(expense, categories) {
  const result = evaluate(expense, categories || []);
  return {
    normalized: normalizeText(`${expense.title || ''} ${expense.notes || ''}`),
    match: result.match,
    candidates: result.candidates,
    ambiguous: result.ambiguous,
    ambiguousBetween: result.ambiguousBetween || null,
  };
}

// ─── Persistence ───────────────────────────────────────────────────────────────

function persist() {
  const target = manualKeywordsPath();
  const tmpPath = `${target}.tmp`;
  const payload = { version: 2, added: manualKeywords, removed: removedKeywords };

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  } catch (err) {
    throw new Error(`Failed to write keyword temp file ${tmpPath}: ${err.message}`);
  }

  try {
    fs.renameSync(tmpPath, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw new Error(`Failed to persist keywords to ${target}: ${err.message}`);
  }
}

function readPersistedFile() {
  const target = manualKeywordsPath();

  let stats;
  try {
    if (!fs.existsSync(target)) return null;
    stats = fs.statSync(target);
  } catch (err) {
    console.warn(`[WordLists] Cannot stat ${target}: ${err.message}`);
    return null;
  }

  if (stats.size > MAX_MANUAL_KEYWORDS_FILE_BYTES) {
    console.warn(
      `[WordLists] Skipping keyword load from ${target}: file too large (${stats.size} bytes)`
    );
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    console.warn(`[WordLists] Failed to load keywords from ${target}: ${err.message}`);
    return null;
  }
}

function mergeInto(bucket, listName, keyword) {
  if (!bucket[listName]) bucket[listName] = [];
  if (!bucket[listName].includes(keyword)) bucket[listName].push(keyword);
}

function loadPersisted() {
  const parsed = readPersistedFile();
  if (!parsed || typeof parsed !== 'object') return;

  // v1 stored a bare { listName: [keyword] } map of additions only.
  const added = parsed.version === 2 ? parsed.added || {} : parsed;
  const removed = parsed.version === 2 ? parsed.removed || {} : {};

  for (const [listName, keywords] of Object.entries(added)) {
    if (!wordLists[listName] || !Array.isArray(keywords)) continue;
    for (const raw of keywords) {
      const normalized = normalizeKeyword(raw);
      if (!normalized) continue;
      if (!wordLists[listName].keywords.includes(normalized)) {
        wordLists[listName].keywords.push(normalized);
      }
      mergeInto(manualKeywords, listName, normalized);
    }
  }

  for (const [listName, keywords] of Object.entries(removed)) {
    if (!wordLists[listName] || !Array.isArray(keywords)) continue;
    for (const raw of keywords) {
      const normalized = normalizeKeyword(raw);
      if (!normalized) continue;
      const idx = wordLists[listName].keywords.findIndex(
        (k) => normalizeKeyword(k) === normalized
      );
      if (idx >= 0) wordLists[listName].keywords.splice(idx, 1);
      mergeInto(removedKeywords, listName, normalized);
    }
  }
}

/**
 * Load persisted keyword edits. Explicit rather than a require-time side
 * effect, so a broken data directory surfaces as a startup error with context.
 */
function init() {
  if (initialized) return;
  builtInKeywords = Object.fromEntries(
    Object.entries(wordLists).map(([name, data]) => [name, [...data.keywords]])
  );
  loadPersisted();
  initialized = true;
}

// ─── Read / edit API ───────────────────────────────────────────────────────────

/**
 * All word lists, annotated with which keywords the user added and which
 * built-ins they removed.
 */
function getWordLists() {
  const out = {};
  for (const [listName, data] of Object.entries(wordLists)) {
    out[listName] = {
      targetCategoryNames: data.targetCategoryNames,
      keywords: [...data.keywords],
      manualKeywords: manualKeywords[listName] ? [...manualKeywords[listName]] : [],
      removedKeywords: removedKeywords[listName] ? [...removedKeywords[listName]] : [],
    };
  }
  return out;
}

/** Bare list names and sizes, for pickers. */
function getWordListSummary() {
  return Object.entries(wordLists).map(([listName, data]) => ({
    listName,
    targetCategoryNames: data.targetCategoryNames,
    keywordCount: data.keywords.length,
    manualCount: manualKeywords[listName] ? manualKeywords[listName].length : 0,
  }));
}

function validateKeyword(keyword) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) throw Object.assign(new Error('Keyword cannot be empty'), { statusCode: 400 });
  if (normalized.length < MIN_KEYWORD_LENGTH) {
    throw Object.assign(
      new Error(`Keyword "${normalized}" is too short (minimum ${MIN_KEYWORD_LENGTH} characters)`),
      { statusCode: 400 }
    );
  }
  if (normalized.length > MAX_KEYWORD_LENGTH) {
    throw Object.assign(
      new Error(`Keyword is too long (maximum ${MAX_KEYWORD_LENGTH} characters)`),
      { statusCode: 400 }
    );
  }
  return normalized;
}

/**
 * Add a keyword to a list.
 * @returns {{ ok: boolean, keyword: string, warning: string | null }}
 */
function addKeyword(listName, keyword) {
  if (!wordLists[listName]) {
    throw Object.assign(new Error(`Unknown word list "${listName}"`), { statusCode: 404 });
  }

  const normalized = validateKeyword(keyword);
  if (wordLists[listName].keywords.includes(normalized)) {
    throw Object.assign(
      new Error(`"${normalized}" is already in ${listName}`),
      { statusCode: 409 }
    );
  }

  wordLists[listName].keywords.push(normalized);

  // Re-adding a built-in the user previously removed just clears the removal.
  const removedIdx = removedKeywords[listName]
    ? removedKeywords[listName].indexOf(normalized)
    : -1;
  const wasRemovedBuiltIn = removedIdx >= 0;
  if (wasRemovedBuiltIn) {
    removedKeywords[listName].splice(removedIdx, 1);
    if (removedKeywords[listName].length === 0) delete removedKeywords[listName];
  } else {
    mergeInto(manualKeywords, listName, normalized);
  }

  try {
    persist();
  } catch (err) {
    // Roll the in-memory state back so it cannot drift from what is on disk.
    wordLists[listName].keywords.pop();
    if (wasRemovedBuiltIn) mergeInto(removedKeywords, listName, normalized);
    else if (manualKeywords[listName]) {
      const idx = manualKeywords[listName].indexOf(normalized);
      if (idx >= 0) manualKeywords[listName].splice(idx, 1);
      if (manualKeywords[listName].length === 0) delete manualKeywords[listName];
    }
    throw err;
  }

  return {
    ok: true,
    keyword: normalized,
    warning:
      !normalized.includes(' ') && normalized.length < COMPOUND_MIN_LENGTH
        ? `"${normalized}" is short, so it only matches as a whole word — it will not match inside compounds.`
        : null,
  };
}

/**
 * Remove a keyword from a list. Unlike the previous implementation, removing a
 * *built-in* keyword is persisted too, so it does not reappear on restart.
 */
function removeKeyword(listName, keyword) {
  if (!wordLists[listName]) {
    throw Object.assign(new Error(`Unknown word list "${listName}"`), { statusCode: 404 });
  }

  const normalized = normalizeKeyword(keyword);
  const idx = wordLists[listName].keywords.findIndex(
    (k) => normalizeKeyword(k) === normalized
  );
  if (idx < 0) {
    throw Object.assign(
      new Error(`"${keyword}" is not in ${listName}`),
      { statusCode: 404 }
    );
  }

  const [actual] = wordLists[listName].keywords.splice(idx, 1);
  const manualIdx = manualKeywords[listName]
    ? manualKeywords[listName].indexOf(normalized)
    : -1;
  const wasManual = manualIdx >= 0;

  if (wasManual) {
    manualKeywords[listName].splice(manualIdx, 1);
    if (manualKeywords[listName].length === 0) delete manualKeywords[listName];
  } else {
    mergeInto(removedKeywords, listName, normalized);
  }

  try {
    persist();
  } catch (err) {
    wordLists[listName].keywords.splice(idx, 0, actual);
    if (wasManual) mergeInto(manualKeywords, listName, normalized);
    else if (removedKeywords[listName]) {
      const rIdx = removedKeywords[listName].indexOf(normalized);
      if (rIdx >= 0) removedKeywords[listName].splice(rIdx, 1);
      if (removedKeywords[listName].length === 0) delete removedKeywords[listName];
    }
    throw err;
  }

  return { ok: true, keyword: normalized, wasManual };
}

/** Restore a list (or every list) to its shipped keywords. */
function resetList(listName) {
  if (!builtInKeywords) init();

  const names = listName ? [listName] : Object.keys(wordLists);
  for (const name of names) {
    if (!wordLists[name]) {
      throw Object.assign(new Error(`Unknown word list "${name}"`), { statusCode: 404 });
    }
    wordLists[name].keywords = [...builtInKeywords[name]];
    delete manualKeywords[name];
    delete removedKeywords[name];
  }
  persist();
  return names;
}

module.exports = {
  init,
  matchWordList,
  explain,
  getWordLists,
  getWordListSummary,
  addKeyword,
  removeKeyword,
  resetList,
  normalizeText,
  normalizeKeyword,
  matchKeyword,
  COMPOUND_MIN_LENGTH,
  COMPOUND_SUFFIX_MIN_LENGTH,
  CONFIDENCE,
};
