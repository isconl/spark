'use strict';
/**
 * Remote vault store: read/append/rewrite as a real HTTP client against
 * vault's GET/POST/PUT /vault/:collection API.
 *
 * Replaces the old local fs-based store, which read/wrote a `memoryDir`
 * directly and only worked because spark and vault happened to share one
 * host's filesystem (true in Docker Compose, false on Render, where each
 * engine is its own container). That was a KNOWN GAP flagged in this
 * file's own previous header comment -- this is the fix.
 *
 * Every call is now async. rewrite() follows the same read-modify-write
 * contract the local version used (fn(rows) => newRows), just translated
 * across the wire: GET the current rows, apply fn locally, PUT the result
 * back. Massacre-guard and previous-version-keeping safety logic now lives
 * server-side in vault (lib/store.js), which is the correct place for it
 * now that vault is the one process actually responsible for the data.
 */

const http = require('http');
const https = require('https');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Connection-level errors only -- never retried for an HTTP error status
// (4xx/5xx), only for the request never actually reaching the server.
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

function attemptOnce(url, lib, method, data, getToken) {
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken() || ''}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// FI26091102 (11 Sep 2026): sibling-engine HTTP calls (spark -> vault, same
// host, both local Node processes) were observed intermittently and
// sometimes persistently refused (ECONNREFUSED) even while the target
// process stayed up and reachable from every other process on the same
// machine the whole time -- root cause not pinned down despite real
// investigation (ruled out: vault actually down, connection-pool
// exhaustion, a general Node/Windows loopback issue -- a plain standalone
// Node script hitting the same address 20x in a row never failed once).
// Whatever the underlying cause, a retry makes the failure mode a
// non-issue for real usage -- this is reasonable resilience for a
// same-host sibling-service call regardless of why it's needed.
//
// Strengthened same day: 2 retries (200/400ms) was NOT always enough --
// the same bad patch recurred and outlasted that budget in a live test
// immediately after the first fix shipped. Now 5 retries with exponential
// backoff (200/400/800/1600/3200ms, ~6.4s worst-case total) -- covers a
// materially longer bad patch while still failing within a few seconds if
// vault is genuinely down, not hanging indefinitely either way.
async function requestWithRetry(url, lib, method, data, getToken, { retries = 5, delayMs = 200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptOnce(url, lib, method, data, getToken);
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE_CODES.has(e.code) || attempt === retries) throw e;
      await sleep(delayMs * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

function defaultRequest(baseUrl, getToken) {
  return (method, path, body) => {
    const url = new URL(path, baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    return requestWithRetry(url, lib, method, data, getToken);
  };
}

function createStore({ baseUrl, getToken = () => '', requestImpl, auditLog = { log: () => {} } }) {
  if (!baseUrl && !requestImpl) throw new Error('createStore requires baseUrl (vault\'s URL)');
  const request = requestImpl || defaultRequest(baseUrl, getToken);

  async function read(collection) {
    const r = await request('GET', `/vault/${encodeURIComponent(collection)}`);
    if (r.status !== 200) {
      auditLog.log('spark_vault_read_failed', { collection, status: r.status });
      throw new Error(`vault read ${collection} failed: HTTP ${r.status}`);
    }
    return r.data.rows || [];
  }

  async function append(collection, row) {
    const r = await request('POST', `/vault/${encodeURIComponent(collection)}`, row);
    if (r.status !== 200) {
      auditLog.log('spark_vault_append_failed', { collection, status: r.status });
      throw new Error(`vault append ${collection} failed: HTTP ${r.status}`);
    }
    return r.data.ok;
  }

  async function rewrite(collection, fn) {
    const rows = await read(collection);
    const newRows = fn(rows);
    const r = await request('PUT', `/vault/${encodeURIComponent(collection)}`, { rows: newRows });
    if (r.status !== 200) {
      auditLog.log('spark_vault_rewrite_failed', { collection, status: r.status });
      throw new Error(`vault rewrite ${collection} failed: HTTP ${r.status}`);
    }
    return r.data.removed;
  }

  // Non-TSV content -- lesson markdown, mirroring pulse's lib/store.js
  // rawRead/listDir additions built the same day for the same reason
  // (spark's own comment above LEARNING_DIR called this out: "still plain
  // files on spark's own disk, not vault-owned rows").
  async function rawRead(collection) {
    const r = await request('GET', `/vault-raw/${encodeURIComponent(collection)}`);
    if (r.status !== 200) {
      auditLog.log('spark_vault_raw_read_failed', { collection, status: r.status });
      throw new Error(`vault raw read ${collection} failed: HTTP ${r.status}`);
    }
    return r.data.text || '';
  }

  async function listDir(dirPath) {
    const r = await request('GET', `/vault-dir/${encodeURIComponent(dirPath)}`);
    if (r.status !== 200) {
      auditLog.log('spark_vault_listdir_failed', { dirPath, status: r.status });
      throw new Error(`vault listDir ${dirPath} failed: HTTP ${r.status}`);
    }
    return r.data.files || [];
  }

  return { read, append, rewrite, rawRead, listDir };
}

module.exports = { createStore };
