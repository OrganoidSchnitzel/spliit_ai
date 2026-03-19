'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');
const apiRouter = require('./routes/api');
const scheduler = require('./scheduler');

const app = express();

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // max 120 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static assets (CSS, JS, favicon)
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ─── SPA fallback: serve index.html for all non-API routes ────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`[App] Spliit AI listening on http://0.0.0.0:${config.port}`);
  });

  scheduler.start();

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`[App] ${signal} received – shutting down…`);
    scheduler.stop();
    server.close(() => {
      console.log('[App] HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
