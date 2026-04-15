'use strict';

const fs = require('fs');
const path = require('path');

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
      'total',
      'jet',
      'bp',
      'agip',
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

const DATA_DIR = path.join(process.cwd(), 'data');
const MANUAL_KEYWORDS_PATH = path.join(DATA_DIR, 'manual-keywords.json');
const manualKeywords = {};

function normalizeKeyword(keyword) {
  return String(keyword).toLowerCase().trim();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function persistManualKeywords() {
  ensureDataDir();
  const tmpPath = `${MANUAL_KEYWORDS_PATH}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(manualKeywords, null, 2));
    fs.renameSync(tmpPath, MANUAL_KEYWORDS_PATH);
  } catch (err) {
    throw new Error(`Failed to persist manual keywords to ${MANUAL_KEYWORDS_PATH}: ${err.message}`);
  }
}

function loadPersistedManualKeywords() {
  if (!fs.existsSync(MANUAL_KEYWORDS_PATH)) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(MANUAL_KEYWORDS_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[WordLists] Failed to load persisted manual keywords from ${MANUAL_KEYWORDS_PATH}: ${err.message}`);
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    return;
  }

  for (const [listName, keywords] of Object.entries(parsed)) {
    if (!wordLists[listName] || !Array.isArray(keywords)) {
      continue;
    }
    for (const rawKeyword of keywords) {
      const normalized = normalizeKeyword(rawKeyword);
      if (!normalized) {
        continue;
      }
      if (!wordLists[listName].keywords.includes(normalized)) {
        wordLists[listName].keywords.push(normalized);
      }
      if (!manualKeywords[listName]) {
        manualKeywords[listName] = [];
      }
      if (!manualKeywords[listName].includes(normalized)) {
        manualKeywords[listName].push(normalized);
      }
    }
  }
}

function trackManualKeyword(listName, keyword) {
  if (!manualKeywords[listName]) {
    manualKeywords[listName] = [];
  }
  if (!manualKeywords[listName].includes(keyword)) {
    manualKeywords[listName].push(keyword);
    persistManualKeywords();
  }
}

function untrackManualKeyword(listName, keyword) {
  const list = manualKeywords[listName];
  if (!list) {
    return;
  }

  const idx = list.indexOf(keyword);
  if (idx < 0) {
    return;
  }

  list.splice(idx, 1);
  if (list.length === 0) {
    delete manualKeywords[listName];
  }
  persistManualKeywords();
}

loadPersistedManualKeywords();

/**
 * Match an expense title against all word lists.
 * Returns the first matching category with high confidence (0.95) if found.
 * @param {{ title: string, notes?: string }} expense
 * @param {Array<{ id: number, name: string }>} categories
 * @returns {{ categoryId: number, categoryName: string, confidence: number, reasoning: string, source: string } | null}
 */
function matchWordList(expense, categories) {
  const title = (expense.title || '').toLowerCase();
  const notes = (expense.notes || '').toLowerCase();
  const combined = `${title} ${notes}`;

  for (const [listName, listData] of Object.entries(wordLists)) {
    for (const keyword of listData.keywords) {
      if (combined.includes(keyword)) {
        // Find matching category by name
        const matchedCategory = categories.find((cat) =>
          listData.targetCategoryNames.some(
            (targetName) => cat.name.toLowerCase() === targetName.toLowerCase()
          )
        );

        if (matchedCategory) {
          return {
            categoryId: matchedCategory.id,
            categoryName: matchedCategory.name,
            confidence: 0.95,
            reasoning: `Matched keyword "${keyword}" from ${listName} word list`,
            source: 'wordlist',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Get all word lists for display/editing in the UI.
 * @returns {Object<string, { targetCategoryNames: string[], keywords: string[] }>}
 */
function getWordLists() {
  return wordLists;
}

/**
 * Add a keyword to a specific word list.
 * @param {string} listName
 * @param {string} keyword
 * @returns {boolean} true if added successfully, false otherwise
 */
function addKeyword(listName, keyword) {
  if (!wordLists[listName]) {
    return false;
  }

  const normalized = normalizeKeyword(keyword);
  if (!normalized || wordLists[listName].keywords.includes(normalized)) {
    return false;
  }

  wordLists[listName].keywords.push(normalized);
  try {
    trackManualKeyword(listName, normalized);
  } catch (err) {
    wordLists[listName].keywords.pop();
    throw err;
  }
  return true;
}

/**
 * Remove a keyword from a specific word list.
 * @param {string} listName
 * @param {string} keyword
 * @returns {boolean} true if removed successfully, false otherwise
 */
function removeKeyword(listName, keyword) {
  if (!wordLists[listName]) {
    return false;
  }

  const normalized = normalizeKeyword(keyword);
  const idx = wordLists[listName].keywords.indexOf(normalized);
  if (idx < 0) {
    return false;
  }

  wordLists[listName].keywords.splice(idx, 1);
  const wasManual = manualKeywords[listName] && manualKeywords[listName].includes(normalized);
  if (wasManual) {
    try {
      untrackManualKeyword(listName, normalized);
    } catch (err) {
      wordLists[listName].keywords.splice(idx, 0, normalized);
      throw err;
    }
  }
  return true;
}

module.exports = {
  matchWordList,
  getWordLists,
  addKeyword,
  removeKeyword,
};
