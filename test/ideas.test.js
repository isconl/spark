'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdeasClient } = require('../lib/ideas');
const { tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => {
      const before = (data[rel] || []).length;
      data[rel] = fn((data[rel] || []).slice());
      return before - data[rel].length;
    },
  };
}

function makeClient(overrides = {}) {
  return createIdeasClient({ ...makeStore(overrides.seed), tsvEscapeText, tsvUnescapeText, ...overrides });
}

test('createIdeasClient throws without the required deps', () => {
  assert.throws(() => createIdeasClient({}));
});

test('captureIdea requires a title', async () => {
  const client = makeClient();
  await assert.rejects(() => client.captureIdea({}));
});

test('captureIdea defaults stage/type/status and fires onCaptured without blocking', async () => {
  let captured = null;
  const client = createIdeasClient({ ...makeStore(), tsvEscapeText, tsvUnescapeText, onCaptured: async (row) => { captured = row; } });
  const row = await client.captureIdea({ title: 'A new agent capability' });
  assert.equal(row.STAGE, 'captured');
  assert.equal(row.TYPE, 'general');
  assert.equal(row.STATUS, 'open');
  await new Promise(r => setImmediate(r));
  assert.equal(captured.ID, row.ID);
});

test('listIdeas computes stats/facets/tags from what is actually on file', async () => {
  const client = makeClient();
  await client.captureIdea({ title: 'Idea one', type: 'agent', domain: 'chat', tags: 'ux, speed' });
  await client.captureIdea({ title: 'Idea two', type: 'product' });
  const r = await client.listIdeas();
  assert.equal(r.stats.total, 2);
  assert.equal(r.stats.agent, 1);
  assert.deepEqual(r.domains, ['chat']);
  assert.deepEqual(r.tags, ['speed', 'ux']);
});

test('updateIdea edits fields and validates status; throws for an unknown id', async () => {
  const client = makeClient();
  const row = await client.captureIdea({ title: 'x' });
  await client.updateIdea({ id: row.ID, stage: 'shipped', status: 'done' });
  const updated = (await client.readIdeas()).find(i => i.ID === row.ID);
  assert.equal(updated.STAGE, 'shipped');
  assert.equal(updated.STATUS, 'done');
  await assert.rejects(() => client.updateIdea({ id: 'nope' }));
});

test('deleteIdea removes the row', async () => {
  const client = makeClient();
  const row = await client.captureIdea({ title: 'x' });
  assert.equal((await client.deleteIdea(row.ID)).success, true);
  assert.equal((await client.readIdeas()).length, 0);
});

test('applyIdeaDirectives executes [[IDEA: ...]] directives, strips them, and appends a real receipt', async () => {
  const client = makeClient();
  const reply = 'Noted. [[IDEA: Ship faster || Cut the build step || general || ci]] Let me know if you want more.';
  const { text, captured } = await client.applyIdeaDirectives(reply);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].TITLE, 'Ship faster');
  assert.doesNotMatch(text, /\[\[IDEA:/);
  assert.match(text, new RegExp(captured[0].ID));
});

test('applyIdeaDirectives handles multiple directives and reports a plural receipt', async () => {
  const client = makeClient();
  const reply = '[[IDEA: First || detail || general || x]] and [[IDEA: Second || detail || general || y]]';
  const { captured, text } = await client.applyIdeaDirectives(reply);
  assert.equal(captured.length, 2);
  assert.match(text, /Captured 2 ideas/);
});

test('applyIdeaDirectives is a no-op passthrough when there is no directive', async () => {
  const client = makeClient();
  const r = await client.applyIdeaDirectives('Just a normal reply.');
  assert.equal(r.captured.length, 0);
  assert.equal(r.text, 'Just a normal reply.');
});
