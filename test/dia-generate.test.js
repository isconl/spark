'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDiaSections } = require('../lib/dia-generate');

function fakeRequest(text) {
  return async () => ({ status: 200, data: { choices: [{ message: { content: text } }] } });
}

const VALID_JSON = JSON.stringify({
  strengths: [{ text: 'Ships fast', evidence: '2026-08-01 call' }],
  weaknesses: [{ text: 'Overcommits', evidence: '2026-08-10 meeting' }],
  personalityObserved: ['Direct communicator'],
  personalityInferred: [{ text: 'Detail-oriented', basis: 'follow-up questions pattern' }],
});

test('generateDiaSections parses a clean JSON response and includes interaction history + person name in the prompt', async () => {
  let seenBody;
  const requestImpl = async (opts, body) => { seenBody = body; return { status: 200, data: { choices: [{ message: { content: VALID_JSON } }] } }; };
  const result = await generateDiaSections({
    personName: 'Alex',
    existingSections: '',
    interactions: [{ DATE: '2026-08-01', CHANNEL: 'call', SUMMARY: 'Discussed Q3 plan' }],
    getKey: () => 'k', requestImpl,
  });
  assert.deepEqual(result.strengths, [{ text: 'Ships fast', evidence: '2026-08-01 call' }]);
  const sent = JSON.parse(seenBody);
  assert.match(sent.messages[1].content, /Person: Alex/);
  assert.match(sent.messages[1].content, /Discussed Q3 plan/);
});

test('generateDiaSections includes existingSections in the prompt when provided, revise/extend framing', async () => {
  let seenBody;
  const requestImpl = async (opts, body) => { seenBody = body; return { status: 200, data: { choices: [{ message: { content: VALID_JSON } }] } }; };
  await generateDiaSections({
    personName: 'Alex', existingSections: 'Prior note: reliable.', interactions: [],
    getKey: () => 'k', requestImpl,
  });
  const sent = JSON.parse(seenBody);
  assert.match(sent.messages[1].content, /revise\/extend/);
  assert.match(sent.messages[1].content, /Prior note: reliable\./);
});

test('generateDiaSections strips a ```json fence before parsing', async () => {
  const requestImpl = fakeRequest('```json\n' + VALID_JSON + '\n```');
  const result = await generateDiaSections({ personName: 'Alex', interactions: [], getKey: () => 'k', requestImpl });
  assert.equal(result.strengths[0].text, 'Ships fast');
});

test('generateDiaSections throws on invalid JSON rather than silently returning garbage', async () => {
  const requestImpl = fakeRequest('not json at all');
  await assert.rejects(() => generateDiaSections({ personName: 'Alex', interactions: [], getKey: () => 'k', requestImpl }));
});

test('generateDiaSections handles no logged interactions yet', async () => {
  let seenBody;
  const requestImpl = async (opts, body) => { seenBody = body; return { status: 200, data: { choices: [{ message: { content: VALID_JSON } }] } }; };
  await generateDiaSections({ personName: 'Alex', interactions: [], getKey: () => 'k', requestImpl });
  const sent = JSON.parse(seenBody);
  assert.match(sent.messages[1].content, /\(none logged yet\)/);
});
