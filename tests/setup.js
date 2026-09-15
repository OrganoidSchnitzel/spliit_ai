'use strict';

/**
 * Give every Jest worker its own data directory so the SQLite database and the
 * persisted keyword file never leak between test files (or into the developer's
 * real ./data directory).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(
  path.join(os.tmpdir(), `spliit-ai-test-${process.env.JEST_WORKER_ID || '0'}-`)
);

process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

afterAll(() => {
  // Close the SQLite handle before removing the directory underneath it.
  try {
    require('../src/localDb').close();
  } catch {
    // Not every suite opens the database.
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});
