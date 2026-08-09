'use strict';
/**
 * The idea pipeline: capture anywhere, file it properly, find it again.
 * Ported from isconl-agent's server.js (constants/helpers ~1758-1840,
 * routes ~10151-10239).
 *
 * Everything writes through captureIdea() so "logged" is always true -- the
 * bug this fixed originally: a model claiming "logged in your vault" with
 * nothing actually written. applyIdeaDirectives() is the other half of that
 * fix: the model can only ASK for a write via a `[[IDEA: ...]]` directive in
 * its reply; this executes it and returns a receipt built from the row that
 * was actually written, never words the model wrote itself.
 *
 * OUT OF SCOPE (deliberate): enrichIdea (classifies/scores an idea via
 * processAiChat) and /api/ideas/refine, /api/ideas/review (both AI) --
 * `onCaptured` is an injected hook (default no-op), same pattern as every
 * other engine's AI-generation exclusion in this split.
 */

const IDEA_STAGES = ['captured', 'shaping', 'committed', 'shipped', 'parked'];
const IDEA_TYPES = ['agent', 'product', 'venture', 'content', 'system', 'process', 'general'];

const ideaStage = (v) => IDEA_STAGES.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'captured';
const ideaType = (v) => IDEA_TYPES.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'general';
const ideaScore = (v) => { const n = parseInt(v, 10); return (n >= 1 && n <= 10) ? String(n) : '-'; };
const ideaCell = (v, max = 200) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim().slice(0, max) || '-';

function createIdeasClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    tsvEscapeText, tsvUnescapeText,
    onCaptured = async () => {},
    ideasFile = 'spark/ideas.tsv',
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createIdeasClient requires readTSV/appendTSV/rewriteTSV');
  if (!tsvEscapeText || !tsvUnescapeText) throw new Error('createIdeasClient requires tsvEscapeText/tsvUnescapeText');

  async function readIdeas() {
    const rows = await readTSV(ideasFile);
    return rows.map(r => ({
      ...r,
      BODY: r.BODY === '-' ? '' : tsvUnescapeText(r.BODY),
      AI_NOTE: r.AI_NOTE === '-' ? '' : tsvUnescapeText(r.AI_NOTE),
      NOTE: r.NOTE === '-' ? '' : tsvUnescapeText(r.NOTE),
    })).sort((a, b) => String(b.CREATED_AT || '').localeCompare(String(a.CREATED_AT || '')));
  }

  async function captureIdea(input = {}) {
    const title = String(input.title || '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 200);
    if (!title) throw new Error('an idea needs a title');
    const now = new Date().toISOString();
    const row = {
      ID: `ID${Date.now()}${Math.floor(Math.random() * 90 + 10)}`,
      TITLE: title, BODY: input.body ? tsvEscapeText(String(input.body)).slice(0, 20000) : '-',
      STAGE: ideaStage(input.stage), TYPE: ideaType(input.type),
      DOMAIN: ideaCell(input.domain, 60), TAGS: ideaCell(input.tags, 160),
      IMPACT: ideaScore(input.impact), EFFORT: ideaScore(input.effort),
      STATUS: 'open', SOURCE: ideaCell(input.source || 'ui', 40),
      CREATED_AT: now, UPDATED_AT: now, AI_NOTE: '-',
      NOTE: input.note ? tsvEscapeText(String(input.note)).slice(0, 4000) : '-',
      LINKS: ideaCell(input.links, 300),
    };
    await appendTSV(ideasFile, row);
    auditLog.log('idea_captured', { id: row.ID, type: row.TYPE, source: row.SOURCE, title: title.slice(0, 80) });
    onCaptured(row).catch(() => {});
    return row;
  }

  async function listIdeas() {
    const ideas = await readIdeas();
    const live = ideas.filter(i => i.STATUS !== 'dropped');
    const count = (list, key) => list.reduce((acc, r) => { const k = r[key] || 'general'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    const facet = (key) => [...new Set(ideas.map(r => r[key]).filter(v => v && v !== '-'))].sort();
    return {
      ideas,
      stats: { total: ideas.length, open: live.filter(i => i.STATUS === 'open').length,
        agent: live.filter(i => i.TYPE === 'agent').length, shipped: ideas.filter(i => i.STAGE === 'shipped').length,
        byStage: count(live, 'STAGE'), byType: count(live, 'TYPE') },
      domains: facet('DOMAIN'),
      tags: [...new Set(ideas.flatMap(r => String(r.TAGS || '').split(',').map(s => s.trim()).filter(t => t && t !== '-')))].sort(),
      stages: IDEA_STAGES, types: IDEA_TYPES,
    };
  }

  async function updateIdea(p) {
    if (!p.id) throw new Error('which idea?');
    let found = false;
    await rewriteTSV(ideasFile, rows => rows.map(r => {
      if (r.ID !== p.id) return r;
      found = true;
      const next = { ...r, UPDATED_AT: new Date().toISOString() };
      if (p.title !== undefined) next.TITLE = ideaCell(p.title, 200);
      if (p.body !== undefined) next.BODY = p.body ? tsvEscapeText(String(p.body)).slice(0, 20000) : '-';
      if (p.note !== undefined) next.NOTE = p.note ? tsvEscapeText(String(p.note)).slice(0, 4000) : '-';
      if (p.stage !== undefined) next.STAGE = ideaStage(p.stage);
      if (p.type !== undefined) next.TYPE = ideaType(p.type);
      if (p.domain !== undefined) next.DOMAIN = ideaCell(p.domain, 60);
      if (p.tags !== undefined) next.TAGS = ideaCell(p.tags, 160);
      if (p.links !== undefined) next.LINKS = ideaCell(p.links, 300);
      if (p.impact !== undefined) next.IMPACT = ideaScore(p.impact);
      if (p.effort !== undefined) next.EFFORT = ideaScore(p.effort);
      if (p.status !== undefined) next.STATUS = ['open', 'done', 'dropped'].includes(p.status) ? p.status : r.STATUS;
      return next;
    }));
    if (!found) throw new Error(`No idea ${p.id}`);
    auditLog.log('idea_updated', { id: p.id, fields: Object.keys(p).filter(k => k !== 'id').join(',') });
    return { success: true };
  }

  async function deleteIdea(id) {
    const removed = await rewriteTSV(ideasFile, rows => rows.filter(r => r.ID !== id));
    auditLog.log('idea_deleted', { id, removed });
    return { success: removed > 0 };
  }

  /** Execute [[IDEA: title || detail || type || domain]] directives from AI chat text, strip them, and append a real receipt. */
  async function applyIdeaDirectives(reply, source = 'chat') {
    const text = String(reply || '');
    if (!text.includes('[[IDEA:')) return { text, captured: [] };
    const captured = [];
    const matches = [...text.matchAll(/\[\[IDEA:\s*([\s\S]*?)\]\]/gi)];
    let cleaned = text;
    for (const m of matches) {
      try {
        const [title, body, type, domain] = String(m[1]).split('||').map(s => s.trim());
        if (title) {
          const row = await captureIdea({ title, body: body && body !== title ? body : '', type, domain, source });
          captured.push(row);
        }
      } catch (e) {
        auditLog.log('idea_directive_failed', { error: String(e.message || e).slice(0, 120) });
      }
      cleaned = cleaned.replace(m[0], '');
    }
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    if (!captured.length) return { text: cleaned, captured };
    const receipt = captured.length === 1
      ? `\n\nCaptured as ${captured[0].ID}. It is in the vault, on OneDrive within the minute, and in [Ideas](?v=ideas).`
      : `\n\nCaptured ${captured.length} ideas (${captured.map(c => c.ID).join(', ')}). They are in [Ideas](?v=ideas).`;
    return { text: cleaned + receipt, captured };
  }

  return { readIdeas, listIdeas, captureIdea, updateIdea, deleteIdea, applyIdeaDirectives };
}

module.exports = { createIdeasClient, IDEA_STAGES, IDEA_TYPES, ideaStage, ideaType, ideaScore, ideaCell };
