'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNluClient, parseIntent, matchTask, resolveDue, tokenise } = require('../lib/nlu');
const { createIdeasClient } = require('../lib/ideas');
const { tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => { const before = (data[rel] || []).length; data[rel] = fn((data[rel] || []).slice()); return before - data[rel].length; },
  };
}

function makeClient(overrides = {}) {
  const store = makeStore(overrides.seed);
  const ideas = createIdeasClient({ ...store, tsvEscapeText, tsvUnescapeText });
  const client = createNluClient({ ...store, ideas, ...overrides });
  return { client, store, ideas };
}

test('createNluClient throws without readTSV/ideas', () => {
  assert.throws(() => createNluClient({}));
  assert.throws(() => createNluClient({ readTSV: () => [] }));
});

test('tokenise drops stopwords', () => {
  assert.deepEqual(tokenise('add the task for me please'), ['add', 'task']);
});

test('resolveDue parses an explicit ISO date, "tomorrow", and a weekday name', () => {
  assert.equal(resolveDue('due 2026-09-01'), '2026-09-01');
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  assert.equal(resolveDue('due tomorrow'), tomorrow);
  assert.ok(resolveDue('due friday'));
});

test('matchTask reports ambiguous when two tasks score close together', () => {
  const tasks = [{ ID: 'T1', TITLE: 'Renew SSL certificate' }, { ID: 'T2', TITLE: 'Renew SSH certificate' }];
  const r = matchTask('renew certificate', tasks);
  assert.equal(r.match, null);
  assert.equal(r.reason, 'ambiguous');
});

test('matchTask matches directly on an exact task ID or Jira key', () => {
  const tasks = [{ ID: 'T1', TITLE: 'Something long and unrelated', JIRA_KEY: 'WSRU-5' }];
  assert.equal(matchTask('T1', tasks).match.ID, 'T1');
  assert.equal(matchTask('WSRU-5', tasks).match.ID, 'T1');
});

test('parseIntent recognises task creation, stripping schedule/priority words from the stored title', () => {
  const plan = parseIntent('add task: call the bank tomorrow urgent', []);
  assert.equal(plan.action, 'task.create');
  assert.equal(plan.priority, 'high');
  assert.doesNotMatch(plan.title, /tomorrow|urgent/);
  assert.equal(plan.gated, false);
});

test('parseIntent marks task.complete as gated for "done" but not for "review"', () => {
  const tasks = [{ ID: 'T1', TITLE: 'Ship the release notes' }];
  const done = parseIntent('mark ship the release notes as done', tasks);
  assert.equal(done.action, 'task.complete');
  assert.equal(done.gated, true);
  const review = parseIntent('mark ship the release notes as review', tasks);
  assert.equal(review.gated, false);
});

test('parseIntent returns a clarify plan when no task matches', () => {
  const plan = parseIntent('complete the nonexistent thing', []);
  assert.equal(plan.action, 'clarify');
});

test('parseIntent marks task.delete and task.toJira as gated', () => {
  const tasks = [{ ID: 'T1', TITLE: 'Ship the release notes', JIRA_KEY: '-' }];
  assert.equal(parseIntent('delete ship the release notes', tasks).gated, true);
  assert.equal(parseIntent('push ship the release notes to jira', tasks).gated, true);
});

test('parseIntent recognises idea capture with an explicit domain prefix', () => {
  const plan = parseIntent('log this idea for the dashboard: dark mode toggle', []);
  assert.equal(plan.action, 'idea.create');
  assert.equal(plan.domain, 'dashboard');
  assert.match(plan.title, /dark mode toggle/);
});

test('parseIntent recognises Jira assign/unassign/transition', () => {
  assert.equal(parseIntent('assign WSRU-1 to Taylor', []).action, 'jira.assign');
  assert.equal(parseIntent('assign WSRU-1 to nobody', []).action, 'jira.unassign');
  assert.equal(parseIntent('move WSRU-1 to in review', []).action, 'jira.transition');
});

test('parseIntent recognises navigation to a known view, and returns null for an unknown one', () => {
  assert.equal(parseIntent('open jira', []).action, 'navigate');
  assert.equal(parseIntent('go to the moon', []), null);
});

test('parseIntent returns null for text matching nothing', () => {
  assert.equal(parseIntent('what a nice day', []), null);
});

test('act() returns understood:false for unparseable text', async () => {
  const { client } = makeClient();
  const r = await client.act({ text: 'what a nice day' });
  assert.equal(r.understood, false);
});

test('act() returns needsConfirmation for a gated action without confirm, and does not execute it', async () => {
  const { client, store } = makeClient({ seed: { 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Ship the release notes', JIRA_KEY: '-' }] } });
  const r = await client.act({ text: 'delete ship the release notes' });
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.executed, undefined);
});

test('act() executes an ungated action immediately (idea.create)', async () => {
  const { client, ideas } = makeClient();
  const r = await client.act({ text: 'log this idea: a faster build' });
  assert.equal(r.executed, true);
  assert.equal(r.ok, true);
  assert.equal((await ideas.readIdeas()).length, 1);
});

test('act() executes a gated action once confirm:true is passed with the same plan', async () => {
  const { client } = makeClient({
    seed: { 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Ship the release notes', JIRA_KEY: '-' }] },
    scope: { deleteTask: async () => ({ ok: true }) },
  });
  const first = await client.act({ text: 'delete ship the release notes' });
  const second = await client.act({ plan: first.plan, confirm: true });
  assert.equal(second.executed, true);
  assert.equal(second.ok, true);
});

test('act() surfaces needsClarification with near-match options instead of guessing', async () => {
  const { client } = makeClient({ seed: { 'scope/tasks.tsv': [
    { ID: 'T1', TITLE: 'Renew SSL certificate' }, { ID: 'T2', TITLE: 'Renew SSH certificate' },
  ] } });
  const r = await client.act({ text: 'complete renew certificate' });
  assert.equal(r.needsClarification, true);
  assert.equal(r.options.length, 2);
});

test('execute(task.create) calls the injected scope.createTask and reports failure without throwing when scope is not wired', async () => {
  const { client } = makeClient();
  const r = await client.execute({ action: 'task.create', title: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not wired/);
});

test('execute(jira.assign) picks the best-scoring assignable user and reports ambiguity on a tie', async () => {
  const { client } = makeClient({
    scope: { jiraAssignableUsers: async () => [{ accountId: 'a1', displayName: 'Taylor Kariuki' }, { accountId: 'a2', displayName: 'Taylor Otieno' }] },
  });
  const r = await client.execute({ action: 'jira.assign', jiraKey: 'WSRU-1', who: 'Taylor' });
  assert.match(r.message, /could be Taylor Kariuki or Taylor Otieno/);
});

test('execute(navigate) never touches scope and just reports the view', async () => {
  const { client } = makeClient();
  const r = await client.execute({ action: 'navigate', view: 'ideas' });
  assert.equal(r.ok, true);
  assert.equal(r.navigate, 'ideas');
});
