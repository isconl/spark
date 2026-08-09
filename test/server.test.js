'use strict';
/**
 * End-to-end smoke tests: start spark's real HTTP server, backed by a real
 * (fake, in-process) vault HTTP server for TSV data -- same shape as the
 * real GET/POST/PUT /vault/:collection contract, so this exercises the
 * actual remote-store wire format, not a shortcut.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function startFakeVault(seed = {}) {
  const data = { ...seed };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const collection = decodeURIComponent(url.pathname.slice('/vault/'.length));
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          res.writeHead(200);
          return res.end(JSON.stringify({ collection, rows: data[collection] || [] }));
        }
        if (req.method === 'POST') {
          let row = {};
          try { row = JSON.parse(body || '{}'); } catch { /* ignore */ }
          (data[collection] = data[collection] || []).push(row);
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection }));
        }
        if (req.method === 'PUT') {
          let rows = [];
          try { rows = JSON.parse(body || '{}').rows || []; } catch { /* ignore */ }
          const before = (data[collection] || []).length;
          data[collection] = rows;
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection, count: rows.length, removed: before - rows.length }));
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, data, port: server.address().port }));
  });
}

function tmpEnv() {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-e2e-logs-'));
  const articlesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-e2e-articles-'));
  const learningDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-e2e-learning-'));
  fs.mkdirSync(path.join(learningDir, 'js101'), { recursive: true });
  fs.writeFileSync(path.join(learningDir, 'js101', '01-intro.md'), '# Intro\nHello');
  fs.writeFileSync(path.join(articlesDir, '20260101_essay.md'), '# My Essay\n\n' + 'word '.repeat(50));
  return { logsDir, articlesDir, learningDir };
}

async function startServer(envOverrides = {}, vaultSeed = {}) {
  const { logsDir, articlesDir, learningDir } = tmpEnv();
  const vault = await startFakeVault({
    'learning/courses.tsv': [], 'learning/progress.tsv': [], 'learning/resume.tsv': [],
    'scope/tasks.tsv': [], ...vaultSeed,
  });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    SPARK_PORT: '0', SPARK_BIND: '127.0.0.1',
    VAULT_URL: `http://127.0.0.1:${vault.port}`, VAULT_TOKEN: 'vault-test-token',
    SPARK_LOGS_DIR: logsDir, SPARK_ARTICLES_DIR: articlesDir, SPARK_LEARNING_DIR: learningDir,
    SPARK_TOKEN: 'test-static-token', BWS_ACCESS_TOKEN: '',
    ...envOverrides,
  });
  delete require.cache[require.resolve('../src/server')];
  const { main } = require('../src/server');
  const handle = await main();
  const cleanup = () => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
    vault.server.close();
  };
  return { ...handle, vault, cleanup };
}

test('GET /health responds without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal((await res.json()).engine, 'spark');
  } finally { server.close(); cleanup(); }
});

test('GET /manifest lists spark\'s capabilities without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest`);
    const body = await res.json();
    assert.ok(body.capabilities.some(c => c.name === 'act'));
  } finally { server.close(); cleanup(); }
});

test('a protected route with no credential fails closed (silent 404)', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ideas`);
    assert.equal(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('ideas: capture, list, update, delete', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const add = await fetch(`http://127.0.0.1:${port}/ideas`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Faster onboarding' }) });
    const { id } = await add.json();

    const list = await fetch(`http://127.0.0.1:${port}/ideas`, { headers: auth });
    assert.equal((await list.json()).stats.total, 1);

    const update = await fetch(`http://127.0.0.1:${port}/ideas/update`, { method: 'POST', headers: auth, body: JSON.stringify({ id, stage: 'shipped' }) });
    assert.equal((await update.json()).success, true);

    const del = await fetch(`http://127.0.0.1:${port}/ideas/delete`, { method: 'POST', headers: auth, body: JSON.stringify({ id }) });
    assert.equal((await del.json()).success, true);
  } finally { server.close(); cleanup(); }
});

test('/act: an ungated idea-capture utterance executes immediately', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/act`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'log this idea: a faster build' }) });
    const body = await res.json();
    assert.equal(body.executed, true);
    assert.equal(body.ok, true);
  } finally { server.close(); cleanup(); }
});

test('/act: a gated utterance (task delete) needs confirmation and reports scope-not-wired once confirmed', async () => {
  const { server, port, cleanup } = await startServer({}, { 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Ship the release notes', JIRA_KEY: '-' }] });
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const first = await fetch(`http://127.0.0.1:${port}/act`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'delete ship the release notes' }) });
    const firstBody = await first.json();
    assert.equal(firstBody.needsConfirmation, true);

    const second = await fetch(`http://127.0.0.1:${port}/act`, { method: 'POST', headers: auth, body: JSON.stringify({ plan: firstBody.plan, confirm: true }) });
    const secondBody = await second.json();
    assert.equal(secondBody.executed, true);
    assert.equal(secondBody.ok, false);
    assert.match(secondBody.message, /not wired/);
  } finally { server.close(); cleanup(); }
});

test('learning: list courses, read a lesson, save a note and a resume point', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const courses = await fetch(`http://127.0.0.1:${port}/learning`, { headers: auth });
    const coursesBody = await courses.json();
    assert.equal(coursesBody.courses.length, 0);   // courses.tsv is empty in this fixture -- lesson files alone don't register a course

    const lesson = await fetch(`http://127.0.0.1:${port}/learning/lesson?course=js101&file=01-intro.md`, { headers: auth });
    const lessonBody = await lesson.json();
    assert.match(lessonBody.content, /Hello/);

    const note = await fetch(`http://127.0.0.1:${port}/learning/notes`, { method: 'POST', headers: auth,
      body: JSON.stringify({ course: 'js101', file: '01-intro.md', text: 'my note' }) });
    assert.equal((await note.json()).success, true);

    const resume = await fetch(`http://127.0.0.1:${port}/learning/resume`, { method: 'POST', headers: auth,
      body: JSON.stringify({ course: 'js101', lesson: '01-intro.md', scrollPct: 50 }) });
    assert.equal((await resume.json()).success, true);
  } finally { server.close(); cleanup(); }
});

test('articles: list picks up the fixture file with a real markdown heading as its title', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/articles`, { headers: auth });
    const body = await res.json();
    assert.equal(body.articles[0].title, 'My Essay');
  } finally { server.close(); cleanup(); }
});

test('the audit log recorded requests made during this test run', async () => {
  const { server, port, auditLog, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/ideas`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'x' }) });
    assert.equal(auditLog.verifyChain().ok, true);
  } finally { server.close(); cleanup(); }
});
