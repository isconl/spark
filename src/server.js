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
const writerAssist = require('../lib/writer-assist');
const { generateDiaSections } = require('../lib/dia-generate');
const { generateStatusBrief } = require('../lib/status-brief-generate');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.SPARK_PORT || process.env.PORT || '8085', 10);
const BIND = process.env.SPARK_BIND || '127.0.0.1';
const VAULT_URL = process.env.VAULT_URL || '';
const LOGS_DIR = process.env.SPARK_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
// Lesson content (learning/<courseId>/*.md) now reads through vault's
// /vault-dir/ + /vault-raw/ HTTP API instead of a local directory -- same
// host-sharing gap /lib/store.js's TSV read/append/rewrite were built to
// fix, just never closed for this. Notes are personal scratch annotations
// on a lesson, not vault-owned classroom content, and stay local.
const LEARNING_DIR = process.env.SPARK_LEARNING_DIR || path.join(__dirname, '..', 'memory', 'learning');
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
  const token = process.env.SPARK_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('SPARK_TOKEN') || '';
  if (!token) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return provided.length === token.length && provided === token;
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
  if (!VAULT_URL) {
    console.error('  REFUSING TO START: VAULT_URL is not configured -- spark has no data store without it.');
    process.exit(1);
  }
  const store = createStore({
    baseUrl: VAULT_URL,
    getToken: () => process.env.VAULT_TOKEN || secretStore.get('VAULT_TOKEN') || '',
    auditLog,
  });
  const readTSV = store.read, appendTSV = store.append, rewriteTSV = store.rewrite;

  const ideas = createIdeasClient({ readTSV, appendTSV, rewriteTSV, auditLog, tsvEscapeText, tsvUnescapeText });

  // scope left unwired -- real cross-engine composition is hub's job (task
  // #7); /act degrades gracefully (see nlu.js's notWired default) rather
  // than crashing when a task/Jira action is attempted standalone.
  const nlu = createNluClient({ readTSV, ideas, auditLog });

  const learning = createLearningClient({
    readTSV, appendTSV, rewriteTSV, auditLog,
    listLessonFiles: async (courseId) => {
      const entries = await store.listDir(`learning/${courseId}`);
      const mdFiles = entries.filter(e => /\.md$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
      return Promise.all(mdFiles.map(async (e) => ({
        file: e.name, raw: await store.rawRead(`learning/${courseId}/${e.name}`), mtimeIso: e.mtimeIso,
      })));
    },
    readLessonFile: async (course, file) => { try { return await store.rawRead(`learning/${course}/${file}`); } catch { return null; } },
    readNoteFile: (course, file) => { try { return fs.readFileSync(path.join(LEARNING_DIR, course, '_notes', file), 'utf8'); } catch { return ''; } },
    writeNoteFile: (course, file, text) => {
      const dir = path.join(LEARNING_DIR, course, '_notes');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    },
  });

  const articles = createArticlesClient({ listFiles: listArticleFiles });

  // BA26081812: Groq-backed, per Architect's 20 Aug decision -- spark's first
  // real AI-calling capability. getGroqKey resolves ISCONL_GROQ_API_KEY
  // (the Bitwarden-namespaced key secrets.js's own prefix convention
  // exposes under its bare name too, see lib/secrets.js's SECRET_PREFIX).
  const getGroqKey = () => process.env.GROQ_API_KEY || secretStore.get('GROQ_API_KEY') || '';

  const tokenConfigured = !!(process.env.SPARK_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('SPARK_TOKEN'));
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
      if (pathname === '/ideas' && req.method === 'GET') return sendJson(res, 200, await ideas.listIdeas());
      if (pathname === '/ideas' && req.method === 'POST') {
        const row = await ideas.captureIdea(JSON.parse(await readBody(req) || '{}'));
        return sendJson(res, 200, { success: true, id: row.ID, idea: row });
      }
      if (pathname === '/ideas/update' && req.method === 'POST') return sendJson(res, 200, await ideas.updateIdea(JSON.parse(await readBody(req) || '{}')));
      if (pathname === '/ideas/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await ideas.deleteIdea(p.id));
      }

      if (pathname === '/act' && req.method === 'POST') {
        return sendJson(res, 200, await nlu.act(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/learning' && req.method === 'GET') return sendJson(res, 200, await learning.listCourses());
      if (pathname === '/learning/groups' && req.method === 'GET') return sendJson(res, 200, await learning.listGroups());
      if (pathname === '/learning/group' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await learning.saveGroup(p));
      }
      if (pathname === '/learning/group/archive' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await learning.archiveGroup(p.id || p.groupId, p.status));
      }
      if (pathname === '/learning/course/status' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await learning.setCourseStatus(p));
      }
      if (pathname === '/learning/module/meta' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await learning.setModuleMeta(p));
      }
      if (pathname === '/learning/lesson' && req.method === 'GET') {
        return sendJson(res, 200, await learning.getLesson(url.searchParams.get('course') || '', url.searchParams.get('file') || ''));
      }
      if (pathname === '/learning/parse-md' && req.method === 'POST') {
        const { parseMarkdownBlockTree } = require('../lib/learning-parser');
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, parseMarkdownBlockTree(p.markdown || ''));
      }
      if (pathname === '/learning/notes' && req.method === 'GET') {
        return sendJson(res, 200, learning.getNote(url.searchParams.get('course') || '', url.searchParams.get('file') || ''));
      }
      if (pathname === '/learning/notes' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, learning.saveNote(p.course, p.file, p.text));
      }
      if (pathname === '/learning/resume' && req.method === 'POST') return sendJson(res, 200, await learning.saveResume(JSON.parse(await readBody(req) || '{}')));
      if (pathname === '/learning/progress' && req.method === 'POST') return sendJson(res, 200, await learning.saveProgress(JSON.parse(await readBody(req) || '{}')));
      if (pathname === '/learning/contributions' && req.method === 'GET') return sendJson(res, 200, await learning.contributions());
      if (pathname === '/learning/campus' && req.method === 'GET') return sendJson(res, 200, await learning.campus());
      if (pathname === '/learning/prime' && req.method === 'GET') return sendJson(res, 200, await learning.primeBrief({ q: url.searchParams.get('q') || '' }));
      if (pathname === '/learning/manifest' && req.method === 'GET') return sendJson(res, 200, await learning.getManifest());

      if (pathname === '/articles' && req.method === 'GET') return sendJson(res, 200, articles.listArticles());

      if (pathname === '/writer/research-field' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await writerAssist.researchField({ ...p, getKey: getGroqKey }));
      }
      if (pathname === '/writer/full-draft' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await writerAssist.fullDraft({ ...p, getKey: getGroqKey }));
      }

      // BM26082601: dossier regeneration, called by circle over HTTP.
      if (pathname === '/generate-dia' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await generateDiaSections({ ...p, getKey: getGroqKey }));
      }

      // BA26082420: weekly status-brief bullet drafting, called by scope over HTTP.
      if (pathname === '/generate-status-brief' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await generateStatusBrief({ ...p, getKey: getGroqKey }));
      }
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
