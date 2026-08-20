'use strict';
/**
 * spark's own AI-calling layer -- "processAiChat", referenced in comments
 * across this repo (articles.js, ideas.js, manifest.js) as the thing
 * every AI-dependent feature is blocked on, but never actually built
 * until now. Groq (Decision, 20 Aug 2026): already a configured secret
 * (ISCONL_GROQ_API_KEY/GROQ_API_KEY), fast + cheap, and an OpenAI-
 * compatible chat-completions shape, so swapping providers later only
 * means changing the endpoint/model, not this file's call shape.
 *
 * Zero dependencies, same style as vault/lib/graph.js's own HTTPS client
 * -- no SDK, plain https.request.
 */

const https = require('https');

const GROQ_HOST = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';
// Groq's model catalog turns over -- checked live 20 Aug 2026
// (GET /openai/v1/models) rather than assumed; gpt-oss-120b is a solid
// general-purpose chat model currently available there. GROQ_MODEL
// overrides without a code change when the catalog turns over again.
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      try { req.write(body); } catch (e) { reject(e); return; }
    }
    req.end();
  });
}

/**
 * One chat-completion call. `messages`: [{role, content}]. Returns the
 * assistant's raw text. Throws a clear error (never a raw HTTP/SDK
 * exception) when no key is configured or the call fails, so a caller can
 * degrade gracefully (exactly the "no private-capable model was
 * available" pattern circle's chat-import already established) rather
 * than crash.
 */
async function chatComplete({ messages, model = DEFAULT_MODEL, temperature = 0.4, maxTokens = 1024, getKey, requestImpl = httpsRequest }) {
  const key = getKey();
  if (!key) throw new Error('no AI provider configured -- GROQ_API_KEY is not set');
  const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
  const r = await requestImpl({
    hostname: GROQ_HOST, path: GROQ_PATH, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${key}` },
  }, body);
  if (r.status !== 200) {
    const msg = (r.data && r.data.error && r.data.error.message) || `Groq HTTP ${r.status}`;
    throw new Error(msg);
  }
  const text = r.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned no content');
  return text.trim();
}

module.exports = { chatComplete };
