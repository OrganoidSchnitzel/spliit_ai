'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * These cover upgrading an existing install. A user who changes nothing must
 * still get a container that starts.
 */
describe('data directory and upgrade path', () => {
  let dir;
  let localDb;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spliit-upgrade-'));
    process.env.DATA_DIR = dir;
    jest.resetModules();
    localDb = require('../src/localDb');
  });

  afterEach(() => {
    try {
      localDb.close();
    } catch {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write the schema a pre-1.1 install left behind. */
  function seedLegacyDb() {
    const legacy = new Database(path.join(dir, 'history.db'));
    legacy.exec(`
      CREATE TABLE history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id TEXT NOT NULL, title TEXT NOT NULL, group_name TEXT,
        amount INTEGER NOT NULL, currency TEXT, category_id INTEGER,
        category_name TEXT, confidence REAL, reasoning TEXT, status TEXT NOT NULL,
        provider TEXT, processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    legacy
      .prepare('INSERT INTO history (expense_id,title,amount,status,category_name) VALUES (?,?,?,?,?)')
      .run('e1', 'Alte Buchung', 999, 'applied', 'Groceries');
    legacy.close();
  }

  it('adopts a pre-1.1 history.db and keeps its rows', () => {
    seedLegacyDb();
    localDb.init();
    const historyService = require('../src/services/historyService');
    require('../src/settingsStore').init();
    historyService.init();

    expect(path.basename(localDb.dbPath())).toBe('app.db');
    const { rows } = historyService.getHistory({ limit: 1 });
    expect(rows[0]).toMatchObject({ title: 'Alte Buchung', category_name: 'Groceries' });
  });

  it('adds the new columns to a pre-1.1 table', () => {
    seedLegacyDb();
    localDb.init();
    require('../src/settingsStore').init();
    require('../src/services/historyService').init();

    const columns = localDb.get().prepare('PRAGMA table_info(history)').all().map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['source', 'duration_ms', 'parked']));
  });

  it('starts anyway when the legacy file cannot be renamed', () => {
    // Renaming needs write permission on the directory. An upgrade must never
    // be the thing that refuses to boot, so this falls back to the old file.
    seedLegacyDb();
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    expect(() => localDb.init()).not.toThrow();
    expect(path.basename(localDb.dbPath())).toBe('history.db');

    renameSpy.mockRestore();
  });

  it('creates a fresh database when there is nothing to migrate', () => {
    localDb.init();
    expect(path.basename(localDb.dbPath())).toBe('app.db');
    expect(fs.existsSync(path.join(dir, 'app.db'))).toBe(true);
  });

  it('explains how to fix an unwritable data directory', () => {
    process.env.DATA_DIR = path.join(dir, 'a-file', 'data');
    fs.writeFileSync(path.join(dir, 'a-file'), 'not a directory');
    jest.resetModules();
    const blocked = require('../src/localDb');

    expect(() => blocked.init()).toThrow(/PUID\/PGID/);
  });
});
