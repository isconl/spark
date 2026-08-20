'use strict';
/**
 * BA26081812 -- Writer's two AI input modes, on top of ai-provider.js's
 * chat-completion call. AI NEVER touches layout/formatting in either mode
 * -- that stays the archetype's own deterministic doc-builder.js script,
 * full stop. Both modes only ever propose FIELD VALUES that land in the
 * same input controls manual entry uses, always reviewable/editable
 * before Generate -- never a silent unreviewed draft.
 *
 * researchField: one field at a time, matches document-generation-canon.md
 *   §8's existing model (spark drafting one field at a time).
 * fullDraft: every field at once, in one call -- the "for when we need
 *   work done fast" mode, genuinely new relative to canon §1's absolute
 *   "No AI calls happen anywhere" (reconciled in the same doc, see
 *   document-generation-canon.md's revision alongside this).
 */

const { chatComplete } = require('./ai-provider');

function fieldDescriptor(f) {
  return `${f.name} (${f.label || f.name}, type: ${f.type || 'text'})`;
}

async function researchField({ archetypeId, field, brief, otherFieldValues, getKey, requestImpl }) {
  const context = Object.entries(otherFieldValues || {})
    .filter(([, v]) => v !== undefined && v !== '' && (!Array.isArray(v) || v.length))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join('\n');
  const messages = [
    { role: 'system', content: `You draft ONE field's value for a "${archetypeId}" document. Return ONLY the field's value -- no preamble, no markdown fencing, no field name/label. If the field type is "list", return one item per line. If "textarea", return prose paragraphs.` },
    { role: 'user', content: [
      `Field to draft: ${fieldDescriptor(field)}`,
      brief ? `Brief: ${brief}` : null,
      context ? `Other fields already filled in, for context:\n${context}` : null,
    ].filter(Boolean).join('\n\n') },
  ];
  const value = await chatComplete({ messages, temperature: 0.4, getKey, requestImpl });
  return { field: field.name, value };
}

async function fullDraft({ archetypeId, fields, brief, getKey, requestImpl }) {
  const fieldList = fields.map(f => `- ${fieldDescriptor(f)}`).join('\n');
  const messages = [
    { role: 'system', content: `You draft every field of a "${archetypeId}" document in one pass, from a brief. Return ONLY a JSON object mapping each field name to its proposed value (string, or a JSON array of strings for "list"-type fields) -- no other text, no markdown fencing.` },
    { role: 'user', content: [
      `Fields to draft:\n${fieldList}`,
      `Brief: ${brief}`,
    ].join('\n\n') },
  ];
  const raw = await chatComplete({ messages, temperature: 0.5, maxTokens: 2048, getKey, requestImpl });
  let parsed;
  try {
    // A model asked for "no markdown fencing" sometimes sends it anyway --
    // strip a ```json ... ``` wrapper before parsing rather than failing.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI full-draft response wasn't valid JSON: ${String(e.message || e)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI full-draft response was not a field->value object');
  return parsed;
}

module.exports = { researchField, fullDraft };
