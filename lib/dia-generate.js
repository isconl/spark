'use strict';
/**
 * BM26082601 -- regenerates a person's relationship-intelligence dossier
 * sections (3.2 strengths / 3.3 weaknesses & blind spots / 3.4 personality
 * traits) from their full interaction history, on top of ai-provider.js's
 * chat-completion call. Same pattern as writer-assist.js's researchField/
 * fullDraft. Called by circle over HTTP -- this engine never touches
 * circle's dia files directly, it only returns the JSON shape circle's
 * writeDiaFile() splices in.
 */

const { chatComplete } = require('./ai-provider');

async function generateDiaSections({ personName, existingSections, interactions, getKey, requestImpl }) {
  const history = (interactions || []).map(i => `- ${i.DATE} [${i.CHANNEL}]: ${i.SUMMARY}`).join('\n');
  const messages = [
    { role: 'system', content: 'You analyze a real professional/personal relationship\'s interaction history and produce three sections for a relationship-intelligence dossier: strengths, weaknesses, and personality traits. Return ONLY a JSON object: {"strengths": [{"text": "...", "evidence": "..."}], "weaknesses": [{"text": "...", "evidence": "..."}], "personalityObserved": ["..."], "personalityInferred": [{"text": "...", "basis": "..."}]}. Every strength/weakness needs an "evidence" string naming which touch/date grounds it. Every inferred personality trait needs a "basis" string explaining the reasoning. Never invent a claim with no basis in the given history -- omit it instead. No markdown fencing, no other text.' },
    { role: 'user', content: [
      `Person: ${personName}`,
      existingSections ? `Existing analysis (revise/extend, don't just repeat):\n${existingSections}` : null,
      `Interaction history:\n${history || '(none logged yet)'}`,
    ].filter(Boolean).join('\n\n') },
  ];
  const raw = await chatComplete({ messages, temperature: 0.4, maxTokens: 1500, getKey, requestImpl });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned); // let a parse failure throw -- caller (circle) already treats this as best-effort, per its existing generateDia(...).catch(() => {})
}

module.exports = { generateDiaSections };
