'use strict';

/**
 * Owns the local SQLite database (data/app.db) shared by the history log and
 * the runtime settings store.
 *
 * Opening the database is an explicit `init()` rather than a require-time side
 * effect: a read-only or root-owned /app/data used to surface as an unhandled
 * throw during module resolution, before any logging existed.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');

const DB_PATH = path.join(DATA_DIR, 'app.db');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'history.db');

let db = null;
let activePath = DB_PATH;

function dataDir() {
  return DATA_DIR;
}

/**
 * Create the data directory, failing with an actionable message rather than a
 * bare EACCES.
 */
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch (err) {
    throw new Error(
      `Cannot write to the data directory ${DATA_DIR}: ${err.message}. ` +
        'When running in Docker, the container must be able to write the mounted ' +
        'volume. Set PUID/PGID to the owner of that directory (on Unraid the ' +
        'default 99:100 is usually right), or chown it to match.'
    );
  }
}

/**
 * Open the database and apply pragmas. Idempotent.
 * @returns {import('better-sqlite3').Database}
 */
function init() {
  if (db) return db;
  ensureDataDir();

  // Earlier versions wrote to history.db. Adopt it so upgrades keep their log.
  // A failure here must not stop the app: renaming needs write permission on
  // the directory, and an upgrade should never be the thing that refuses to
  // boot. Fall back to using the file where it already is.
  activePath = DB_PATH;
  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    try {
      fs.renameSync(LEGACY_DB_PATH, DB_PATH);
    } catch (err) {
      console.warn(
        `[DB] Could not rename ${LEGACY_DB_PATH} to ${DB_PATH} (${err.message}); ` +
          'continuing with the existing file.'
      );
      activePath = LEGACY_DB_PATH;
    }
  }

  db = new Database(activePath);
  // WAL keeps readers from blocking the scheduler's writes; better-sqlite3 is
  // synchronous, so anything that shortens a write matters on slow storage.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * @returns {import('better-sqlite3').Database}
 */
function get() {
  if (!db) return init();
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { init, get, close, dataDir, DB_PATH, dbPath: () => activePath };
