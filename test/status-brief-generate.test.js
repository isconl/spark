'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateStatusBrief } = require('../lib/status-brief-generate');

function fakeRequest(text) {
  return async () => ({ status: 200, data: { choices: [{ message: { content: text } }] } });
}

const VALID_JSON = JSON.stringify({
  signal: ['Portal use-case catalogue due this week'],
  substance: ['Drafted 100 use cases across 4 categories'],
  trajectory: ['On track for Friday review'],
});

test('generateStatusBrief parses a clean JSON response and includes subject/activity in the prompt', async () => {
  let seenBody;
  const requestImpl = async (opts, body) => { seenBody = body; return { status: 200, data: { choices: [{ message: { content: VALID_JSON } }] } }; };
  const r = await generateStatusBrief({
    subjectName: 'Viva Valentia', supervisorName: 'Alex Rivera',
    activity: [{ date: '2026-08-24', kind: 'task', summary: 'Drafted use-case catalogue' }],
    getKey: () => 'k', requestImpl,
  });
  assert.deepEqual(r.signal, ['Portal use-case catalogue due this week']);
  const sent = JSON.parse(seenBody);
  assert.match(sent.messages[1].content, /Subject: Viva Valentia/);
  assert.match(sent.messages[1].content, /Alex Rivera/);
  assert.match(sent.messages[1].content, /Drafted use-case catalogue/);
});

test('generateStatusBrief omits the supervisor line when not given', async () => {
  let seenBody;
  const requestImpl = async (opts, body) => { seenBody = body; return { status: 200, data: { choices: [{ message: { content: VALID_JSON } }] } }; };
  await generateStatusBrief({ subjectName: 'Acexoft', activity: [], getKey: () => 'k', requestImpl });
  const sent = JSON.parse(seenBody);
  assert.doesNotMatch(sent.messages[1].content, /Reports to/);
});

test('generateStatusBrief reports a quiet week plainly rather than requiring padding', async () => {
  const requestImpl = fakeRequest(VALID_JSON);
  const r = await generateStatusBrief({ subjectName: 'X', activity: [], getKey: () => 'k', requestImpl });
  assert.ok(Array.isArray(r.signal));
});

test('generateStatusBrief strips a ```json fence before parsing', async () => {
  const requestImpl = fakeRequest('```json\n' + VALID_JSON + '\n```');
  const r = await generateStatusBrief({ subjectName: 'X', activity: [], getKey: () => 'k', requestImpl });
  assert.equal(r.substance[0], 'Drafted 100 use cases across 4 categories');
});

test('generateStatusBrief defaults each section to an empty array if the model omits one', async () => {
  const requestImpl = fakeRequest(JSON.stringify({ signal: ['only this'] }));
  const r = await generateStatusBrief({ subjectName: 'X', activity: [], getKey: () => 'k', requestImpl });
  assert.deepEqual(r.substance, []);
  assert.deepEqual(r.trajectory, []);
});

test('generateStatusBrief throws on invalid JSON rather than silently returning garbage', async () => {
  const requestImpl = fakeRequest('not json');
  await assert.rejects(() => generateStatusBrief({ subjectName: 'X', activity: [], getKey: () => 'k', requestImpl }));
});
