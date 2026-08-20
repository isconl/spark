'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { researchField, fullDraft } = require('../lib/writer-assist');

function fakeRequest(text) {
  return async () => ({ status: 200, data: { choices: [{ message: { content: text } }] } });
}

test('researchField returns {field, value} and includes other field values as context', async () => {
  let seenBody;
  const requestImpl = async (opts, body) => { seenBody = body; return { status: 200, data: { choices: [{ message: { content: 'A proposed value' } }] } }; };
  const r = await researchField({
    archetypeId: 'decision-brief',
    field: { name: 'recommendation', label: 'Recommendation', type: 'textarea' },
    brief: 'be concise', otherFieldValues: { title: 'Q3 Budget' },
    getKey: () => 'k', requestImpl,
  });
  assert.equal(r.field, 'recommendation');
  assert.equal(r.value, 'A proposed value');
  const sent = JSON.parse(seenBody);
  assert.match(sent.messages[1].content, /title: Q3 Budget/);
  assert.match(sent.messages[1].content, /be concise/);
});

test('fullDraft parses a clean JSON object response', async () => {
  const requestImpl = fakeRequest(JSON.stringify({ title: 'T', recommendation: 'R' }));
  const r = await fullDraft({
    archetypeId: 'decision-brief',
    fields: [{ name: 'title', label: 'Title' }, { name: 'recommendation', label: 'Recommendation' }],
    brief: 'a budget decision', getKey: () => 'k', requestImpl,
  });
  assert.deepEqual(r, { title: 'T', recommendation: 'R' });
});

test('fullDraft strips a markdown code fence if the model adds one anyway', async () => {
  const requestImpl = fakeRequest('```json\n{"title":"T"}\n```');
  const r = await fullDraft({ archetypeId: 'decision-brief', fields: [{ name: 'title' }], brief: 'x', getKey: () => 'k', requestImpl });
  assert.deepEqual(r, { title: 'T' });
});

test('fullDraft throws a clear error on invalid JSON rather than crashing', async () => {
  const requestImpl = fakeRequest('not json at all');
  await assert.rejects(
    () => fullDraft({ archetypeId: 'decision-brief', fields: [{ name: 'title' }], brief: 'x', getKey: () => 'k', requestImpl }),
    /wasn't valid JSON/,
  );
});

test('fullDraft rejects a non-object JSON response (e.g. an array)', async () => {
  const requestImpl = fakeRequest('["not", "an", "object"]');
  await assert.rejects(
    () => fullDraft({ archetypeId: 'decision-brief', fields: [{ name: 'title' }], brief: 'x', getKey: () => 'k', requestImpl }),
    /not a field->value object/,
  );
});
