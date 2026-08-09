#!/usr/bin/env node
'use strict';
/**
 * spark engine -- HTTP entry point. Same boot sequence/style as vault, pulse, scope, circle.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createStore } = require('../lib/store');
const { tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');
const { createIdeasClient } = require('../lib/ideas');
const { createNluClient } = require('../lib/nlu');
const { createLearningClient } = require('../lib/learning');
const { createArticlesClient } = require('../lib/articles');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.SPARK_PORT || process.env.PORT || '8085', 10);
const BIND = process.env.SPARK_BIND || '127.0.0.1';
const MEMORY_DIR = process.env.SPARK_MEMORY_DIR || process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.SPARK_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
const LEARNING_DIR = path.join(MEMORY_DIR, 'learning');
// No hardcoded personal path -- was Sconl/Core/Axial/Creator/Author/author-nonfiction
// in the original; genericized to an env var with a neutral local default.
const ARTICLES_DIR = process.env.SPARK_ARTICLES_DIR || path.join(__dirname, '..', 'articles');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function checkAuth(req) {
  const token = process.env.SPARK_TOKEN || process.env.ISCONL_TOKEN || '';
  if (!token) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return provided.length === token.length && provided === token;
}

function listLessonFiles(courseId) {
  const dir = path.join(LEARNING_DIR, courseId);
  try {
    return fs.readdirSync(dir).filter(f => /\.md$/i.test(f) && !/\.(conflict|backup)[-.\d]/i.test(f)).sort().map(f => {
      const fp = path.join(dir, f);
      return { file: f, raw: fs.readFileSync(fp, 'utf8'), mtimeIso: fs.statSync(fp).mtime.toISOString() };
    });
  } catch { return []; }
}

function listArticleFiles() {
  try {
    if (!fs.existsSync(ARTICLES_DIR)) return [];
    return fs.readdirSync(ARTICLES_DIR)
      .filter(f => /\.(md|markdown|docx|txt)$/i.test(f) && !/\.(conflict|backup)[-.\d]/i.test(f))
      .map(f => {
        const fp = path.join(ARTICLES_DIR, f);
        const st = fs.statSync(fp);
        const raw = /\.(md|markdown|txt)$/i.test(f) ? fs.readFileSync(fp, 'utf8') : '';
        return { file: f, rel: f, raw, bytes: st.size, mtimeIso: st.mtime.toISOString() };
      });
  } catch { return []; }
}

async function main() {
  const secretsResult = await secretStore.init();
  console.log(`  secrets: ${secretsResult.source}, ${secretsResult.count} key(s)`);

  const auditLog = createAuditLog({ logsDir: LOGS_DIR });
  const store = createStore({ memoryDir: MEMORY_DIR, auditLog });
  const readTSV = store.read, appendTSV = store.append, rewriteTSV = store.rewrite;

  const ideas = createIdeasClient({ readTSV, appendTSV, rewriteTSV, auditLog, tsvEscapeText, tsvUnescapeText });

  // scope left unwired -- real cross-engine composition is hub's job (task
  // #7); /act degrades gracefully (see nlu.js's notWired default) rather
  // than crashing when a task/Jira action is attempted standalone.
  const nlu = createNluClient({ readTSV, ideas, auditLog });

  const learning = createLearningClient({
    readTSV, appendTSV, rewriteTSV, auditLog, listLessonFiles,
    readLessonFile: (course, file) => { try { return fs.readFileSync(path.join(LEARNING_DIR, course, file), 'utf8'); } catch { return null; } },
    readNoteFile: (course, file) => { try { return fs.readFileSync(path.join(LEARNING_DIR, course, '_notes', file), 'utf8'); } catch { return ''; } },
    writeNoteFile: (course, file, text) => {
      const dir = path.join(LEARNING_DIR, course, '_notes');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    },
  });

  const articles = createArticlesClient({ listFiles: listArticleFiles });

  const tokenConfigured = !!(process.env.SPARK_TOKEN || process.env.ISCONL_TOKEN);
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
  if (!isLoopback && !tokenConfigured) {
    console.error('  REFUSING TO BIND: no SPARK_TOKEN/ISCONL_TOKEN configured and BIND is not loopback.');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', engine: 'spark', version: manifest.version });
    }
    if (pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, manifest);
    }

    if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

    try {
      if (pathname === '/ideas' && req.method === 'GET') return sendJson(res, 200, ideas.listIdeas());
      if (pathname === '/ideas' && req.method === 'POST') {
        const row = ideas.captureIdea(JSON.parse(await readBody(req) || '{}'));
        return sendJson(res, 200, { success: true, id: row.ID, idea: row });
      }
      if (pathname === '/ideas/update' && req.method === 'POST') return sendJson(res, 200, ideas.updateIdea(JSON.parse(await readBody(req) || '{}')));
      if (pathname === '/ideas/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, ideas.deleteIdea(p.id));
      }

      if (pathname === '/act' && req.method === 'POST') {
        return sendJson(res, 200, await nlu.act(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/learning' && req.method === 'GET') return sendJson(res, 200, learning.listCourses());
      if (pathname === '/learning/lesson' && req.method === 'GET') {
        return sendJson(res, 200, learning.getLesson(url.searchParams.get('course') || '', url.searchParams.get('file') || ''));
      }
      if (pathname === '/learning/notes' && req.method === 'GET') {
        return sendJson(res, 200, learning.getNote(url.searchParams.get('course') || '', url.searchParams.get('file') || ''));
      }
      if (pathname === '/learning/notes' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, learning.saveNote(p.course, p.file, p.text));
      }
      if (pathname === '/learning/resume' && req.method === 'POST') return sendJson(res, 200, learning.saveResume(JSON.parse(await readBody(req) || '{}')));
      if (pathname === '/learning/progress' && req.method === 'POST') return sendJson(res, 200, learning.saveProgress(JSON.parse(await readBody(req) || '{}')));
      if (pathname === '/learning/contributions' && req.method === 'GET') return sendJson(res, 200, learning.contributions());

      if (pathname === '/articles' && req.method === 'GET') return sendJson(res, 200, articles.listArticles());
    } catch (e) {
      return sendJson(res, 400, { success: false, error: String(e.message || e) });
    }

    return sendJson(res, 404, { error: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND, () => {
      const actualPort = server.address().port;
      console.log(`  spark listening on ${BIND}:${actualPort}`);
      resolve({ server, store, ideas, nlu, learning, articles, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('spark failed to start:', e); process.exit(1); });
}

module.exports = { main };
