'use strict';

const { Pool } = require('pg');
const config = require('./config');

// When DB_SSL=true, enable TLS. Certificate validation stays on by default;
// set DB_SSL_REJECT_UNAUTHORIZED=false only if connecting to a self-signed cert
// and you understand the security implications.
const sslConfig = (() => {
  if (!config.database.ssl) return false;
  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';
  return { rejectUnauthorized };
})();

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  ssl: sslConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Run a query against the Spliit PostgreSQL database.
 * @param {string} text - SQL query
 * @param {Array} [params] - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.debug(`[DB] query (${duration}ms): ${text.trim().substring(0, 80)}`);
  return res;
}

/**
 * Check that the database is reachable.
 */
async function healthCheck() {
  const res = await pool.query('SELECT 1');
  return res.rowCount === 1;
}

module.exports = { query, healthCheck, pool };
