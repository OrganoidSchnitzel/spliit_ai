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
        'When running in Docker, make sure the mounted volume is writable by the ' +
        'container user (e.g. `chown -R 1000:1000 /path/to/data`).'
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
  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    fs.renameSync(LEGACY_DB_PATH, DB_PATH);
  }

  db = new Database(DB_PATH);
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

module.exports = { init, get, close, dataDir, DB_PATH };
