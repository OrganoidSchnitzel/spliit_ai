'use strict';

/**
 * German word lists for fast category matching without LLM calls.
 * These lists contain common German merchant names and keywords that can be matched instantly.
 */

const wordLists = {
  groceryStores: {
    targetCategoryNames: ['Groceries', 'Lebensmittel', 'Supermarket', 'Food', 'Essen'],
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
    ],
  },
  restaurants: {
    targetCategoryNames: ['Restaurant', 'Restaurants', 'Food & Dining', 'Essen & Trinken', 'Dining'],
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
    ],
  },
  fuelStations: {
    targetCategoryNames: ['Fuel', 'Gas', 'Petrol', 'Tankstelle', 'Benzin', 'Transportation'],
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
    ],
  },
  pharmacies: {
    targetCategoryNames: ['Pharmacy', 'Apotheke', 'Health', 'Healthcare', 'Medical'],
    keywords: [
      'apotheke',
      'pharmacy',
      'dm',
      'rossmann',
      'müller',
      'budni',
      'douglas',
    ],
  },
  transportation: {
    targetCategoryNames: ['Transportation', 'Transport', 'Travel', 'Verkehr', 'Fahrt'],
    keywords: [
      'deutsche bahn',
      'db',
      'bahn',
      'train',
      'bus',
      'uber',
      'taxi',
      'flixbus',
      'mvg',
      'hvv',
      'vvs',
      'vrr',
      'öpnv',
      'nahverkehr',
    ],
  },
  furniture: {
    targetCategoryNames: ['Furniture', 'Möbel', 'Home', 'Household', 'Haushalt'],
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
    ],
  },
  electronics: {
    targetCategoryNames: ['Electronics', 'Elektronik', 'Technology', 'Tech'],
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
    ],
  },
  clothing: {
    targetCategoryNames: ['Clothing', 'Fashion', 'Kleidung', 'Mode'],
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
    ],
  },
  healthFitness: {
    targetCategoryNames: ['Health', 'Fitness', 'Sport', 'Gym', 'Gesundheit'],
    keywords: [
      'fitnessstudio',
      'gym',
      'mcfit',
      'fitness first',
      'clever fit',
      'john reed',
      'kieser',
      'yoga',
      'pilates',
    ],
  },
  entertainment: {
    targetCategoryNames: ['Entertainment', 'Unterhaltung', 'Leisure', 'Fun'],
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
    ],
  },
  hardware: {
    targetCategoryNames: ['Hardware', 'DIY', 'Home Improvement', 'Baumarkt'],
    keywords: [
      'bauhaus',
      'obi',
      'hornbach',
      'toom',
      'hagebau',
      'baumarkt',
      'werkzeug',
      'heimwerker',
    ],
  },
};

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

  const normalized = keyword.toLowerCase().trim();
  if (!normalized || wordLists[listName].keywords.includes(normalized)) {
    return false;
  }

  wordLists[listName].keywords.push(normalized);
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

  const normalized = keyword.toLowerCase().trim();
  const idx = wordLists[listName].keywords.indexOf(normalized);
  if (idx < 0) {
    return false;
  }

  wordLists[listName].keywords.splice(idx, 1);
  return true;
}

module.exports = {
  matchWordList,
  getWordLists,
  addKeyword,
  removeKeyword,
};
