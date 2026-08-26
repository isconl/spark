'use strict';
/**
 * BA26082420 -- drafts the weekly status-brief's three bullet sections
 * (signal/substance/trajectory) from one subject's week of activity data.
 * Same pattern as writer-assist.js/dia-generate.js: one focused chat-
 * completion call on top of ai-provider.js, AI drafts, Architect reviews
 * before anything is sent (per canon's "AI drafts one field, never a
 * whole doc" rule, document-generation-canon.md §8).
 */

const { chatComplete } = require('./ai-provider');

async function generateStatusBrief({ subjectName, supervisorName, activity, getKey, requestImpl }) {
  const lines = (activity || []).map(a => `- ${a.date} [${a.kind}]: ${a.summary}`).join('\n');
  const messages = [
    { role: 'system', content: 'You draft a weekly status brief for a business/professional engagement, from a list of the week\'s real activity (tasks/interactions). Return ONLY a JSON object: {"signal": ["...", ...], "substance": ["...", ...], "trajectory": ["...", ...]}. "signal" = the headline items worth noticing this week, "substance" = the concrete work actually done, "trajectory" = where this is heading / what happens next. Each is an array of short bullet strings. Never invent an activity not in the given list -- if the week was quiet, say so plainly rather than padding.' },
    { role: 'user', content: [
      `Subject: ${subjectName}`,
      supervisorName && supervisorName !== '-' ? `Reports to / supervised by: ${supervisorName}` : null,
      `This week's activity:\n${lines || '(nothing logged this week)'}`,
    ].filter(Boolean).join('\n\n') },
  ];
  const raw = await chatComplete({ messages, temperature: 0.4, maxTokens: 1200, getKey, requestImpl });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    signal: Array.isArray(parsed.signal) ? parsed.signal : [],
    substance: Array.isArray(parsed.substance) ? parsed.substance : [],
    trajectory: Array.isArray(parsed.trajectory) ? parsed.trajectory : [],
  };
}

module.exports = { generateStatusBrief };
