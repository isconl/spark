'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdeasClient } = require('../lib/ideas');
const { tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: (rel) => (data[rel] || []).slice(),
    appendTSV: (rel, row) => { (data[rel] = data[rel] || []).push(row); },
    rewriteTSV: (rel, fn) => {
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

test('captureIdea requires a title', () => {
  const client = makeClient();
  assert.throws(() => client.captureIdea({}));
});

test('captureIdea defaults stage/type/status and fires onCaptured without blocking', async () => {
  let captured = null;
  const client = createIdeasClient({ ...makeStore(), tsvEscapeText, tsvUnescapeText, onCaptured: async (row) => { captured = row; } });
  const row = client.captureIdea({ title: 'A new agent capability' });
  assert.equal(row.STAGE, 'captured');
  assert.equal(row.TYPE, 'general');
  assert.equal(row.STATUS, 'open');
  await new Promise(r => setImmediate(r));
  assert.equal(captured.ID, row.ID);
});

test('listIdeas computes stats/facets/tags from what is actually on file', () => {
  const client = makeClient();
  client.captureIdea({ title: 'Idea one', type: 'agent', domain: 'chat', tags: 'ux, speed' });
  client.captureIdea({ title: 'Idea two', type: 'product' });
  const r = client.listIdeas();
  assert.equal(r.stats.total, 2);
  assert.equal(r.stats.agent, 1);
  assert.deepEqual(r.domains, ['chat']);
  assert.deepEqual(r.tags, ['speed', 'ux']);
});

test('updateIdea edits fields and validates status; throws for an unknown id', () => {
  const client = makeClient();
  const row = client.captureIdea({ title: 'x' });
  client.updateIdea({ id: row.ID, stage: 'shipped', status: 'done' });
  const updated = client.readIdeas().find(i => i.ID === row.ID);
  assert.equal(updated.STAGE, 'shipped');
  assert.equal(updated.STATUS, 'done');
  assert.throws(() => client.updateIdea({ id: 'nope' }));
});

test('deleteIdea removes the row', () => {
  const client = makeClient();
  const row = client.captureIdea({ title: 'x' });
  assert.equal(client.deleteIdea(row.ID).success, true);
  assert.equal(client.readIdeas().length, 0);
});

test('applyIdeaDirectives executes [[IDEA: ...]] directives, strips them, and appends a real receipt', () => {
  const client = makeClient();
  const reply = 'Noted. [[IDEA: Ship faster || Cut the build step || general || ci]] Let me know if you want more.';
  const { text, captured } = client.applyIdeaDirectives(reply);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].TITLE, 'Ship faster');
  assert.doesNotMatch(text, /\[\[IDEA:/);
  assert.match(text, new RegExp(captured[0].ID));
});

test('applyIdeaDirectives handles multiple directives and reports a plural receipt', () => {
  const client = makeClient();
  const reply = '[[IDEA: First || detail || general || x]] and [[IDEA: Second || detail || general || y]]';
  const { captured, text } = client.applyIdeaDirectives(reply);
  assert.equal(captured.length, 2);
  assert.match(text, /Captured 2 ideas/);
});

test('applyIdeaDirectives is a no-op passthrough when there is no directive', () => {
  const client = makeClient();
  const r = client.applyIdeaDirectives('Just a normal reply.');
  assert.equal(r.captured.length, 0);
  assert.equal(r.text, 'Just a normal reply.');
});
