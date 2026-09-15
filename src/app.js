'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const localDb = require('./localDb');
const settingsStore = require('./settingsStore');
const historyService = require('./services/historyService');
const germanWordLists = require('./data/germanWordLists');
const apiRouter = require('./routes/api');
const scheduler = require('./scheduler');

/**
 * Open the local database and load persisted state.
 *
 * This used to happen as a side effect of `require`, which meant a read-only or
 * root-owned data directory surfaced as an unhandled throw during module
 * resolution, before any logging existed.
 */
function init() {
  localDb.init();
  settingsStore.init();
  historyService.init();
  germanWordLists.init();

  const overridden = settingsStore.getOverriddenKeys();
  if (overridden.length) {
    console.log(`[App] ${overridden.length} setting(s) overridden from the UI: ${overridden.join(', ')}`);
  }
  if (settingsStore.get('dryRun')) {
    console.warn('[App] DRY RUN is enabled — no categories will be written to Spliit.');
  }
}

const app = express();
app.set('trust proxy', 1);

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

/**
 * Optional shared-secret auth.
 *
 * This service holds write access to the Spliit database, so leaving it wide
 * open on a LAN is a real exposure. Auth stays opt-in (many homelab setups sit
 * behind a reverse proxy that already handles it) but the health endpoint is
 * always public so Docker's HEALTHCHECK keeps working.
 */
function requireToken(req, res, next) {
  if (!config.apiToken) return next();
  if (req.path === '/health') return next();

  const header = req.get('authorization') || '';
  const provided = req.get('x-api-token') || (header.startsWith('Bearer ') ? header.slice(7) : '');

  const expected = Buffer.from(config.apiToken);
  const actual = Buffer.from(provided);
  const ok =
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!ok) return res.status(401).json({ error: 'Missing or invalid API token' });
  return next();
}

// ─── API routes ────────────────────────────────────────────────────────────────
app.use('/api', requireToken, apiRouter);

// ─── Static assets & SPA fallback ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handling ────────────────────────────────────────────────────────────
// Without this, a malformed JSON body returned body-parser's default HTML error
// page to a client that asked for JSON.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.statusCode || err.status || 500;

  if (status >= 500) {
    console.error(`[App] ${req.method} ${req.originalUrl} failed:`, err.stack || err.message);
  }

  const body = { error: err.message || 'Internal server error' };
  if (err.type === 'entity.parse.failed') body.error = 'Request body is not valid JSON';
  if (err.details) body.details = err.details;

  res.status(status).json(body);
});

// ─── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    init();
  } catch (err) {
    console.error(`[App] Startup failed: ${err.message}`);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`[App] Spliit AI listening on http://0.0.0.0:${config.port}`);
    if (config.apiToken) console.log('[App] API token authentication is enabled.');
  });

  scheduler.start();
  // Apply the retention policy once at boot; the batch run prunes thereafter.
  try {
    historyService.prune();
  } catch (err) {
    console.warn(`[App] History prune failed: ${err.message}`);
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[App] ${signal} received – shutting down…`);
    scheduler.stop();
    server.close(() => {
      localDb.close();
      console.log('[App] HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
module.exports.init = init;
