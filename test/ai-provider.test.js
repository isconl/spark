'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatComplete } = require('../lib/ai-provider');

function fakeRequest(response) {
  return async () => response;
}

test('chatComplete throws a clear error when no key is configured, without calling out', async () => {
  let called = false;
  await assert.rejects(
    () => chatComplete({ messages: [], getKey: () => '', requestImpl: async () => { called = true; return { status: 200, data: {} }; } }),
    /no AI provider configured/,
  );
  assert.equal(called, false);
});

test('chatComplete returns the assistant text on a 200', async () => {
  const requestImpl = fakeRequest({ status: 200, data: { choices: [{ message: { content: '  Hello world  ' } }] } });
  const r = await chatComplete({ messages: [{ role: 'user', content: 'hi' }], getKey: () => 'k', requestImpl });
  assert.equal(r, 'Hello world');
});

test('chatComplete surfaces the provider\'s own error message on a non-200', async () => {
  const requestImpl = fakeRequest({ status: 401, data: { error: { message: 'invalid api key' } } });
  await assert.rejects(() => chatComplete({ messages: [], getKey: () => 'bad-key', requestImpl }), /invalid api key/);
});

test('chatComplete throws when the response has no content', async () => {
  const requestImpl = fakeRequest({ status: 200, data: { choices: [] } });
  await assert.rejects(() => chatComplete({ messages: [], getKey: () => 'k', requestImpl }), /no content/);
});

test('chatComplete sends the configured key as a Bearer header and the messages as the body', async () => {
  let seenOptions, seenBody;
  const requestImpl = async (options, body) => { seenOptions = options; seenBody = body; return { status: 200, data: { choices: [{ message: { content: 'ok' } }] } }; };
  await chatComplete({ messages: [{ role: 'user', content: 'test' }], getKey: () => 'my-key', requestImpl });
  assert.equal(seenOptions.headers.Authorization, 'Bearer my-key');
  assert.deepEqual(JSON.parse(seenBody).messages, [{ role: 'user', content: 'test' }]);
});

test('BI26091505: without tools, chatComplete keeps returning a plain string -- every existing caller is unaffected', async () => {
  const requestImpl = fakeRequest({ status: 200, data: { choices: [{ message: { content: 'plain answer' } }] } });
  const r = await chatComplete({ messages: [{ role: 'user', content: 'hi' }], getKey: () => 'k', requestImpl });
  assert.equal(typeof r, 'string');
  assert.equal(r, 'plain answer');
});

test('BI26091505: with tools, chatComplete sends them in the request body and does not throw on empty content when a tool_call is present', async () => {
  let seenBody;
  const requestImpl = async (options, body) => {
    seenBody = body;
    return { status: 200, data: { choices: [{ message: { content: null, tool_calls: [
      { id: 'call_1', function: { name: 'tasks.list', arguments: '{"query":{"status":"open"}}' } },
    ] } }] } };
  };
  const tools = [{ type: 'function', function: { name: 'tasks.list', description: 'List tasks', parameters: { type: 'object' } } }];
  const r = await chatComplete({ messages: [{ role: 'user', content: 'what are my tasks' }], tools, getKey: () => 'k', requestImpl });
  assert.deepEqual(JSON.parse(seenBody).tools, tools);
  assert.equal(r.content, null);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'tasks.list');
  assert.deepEqual(r.toolCalls[0].args, { query: { status: 'open' } });
});

test('BI26091505: a malformed tool_call arguments string parses to an empty object rather than throwing', async () => {
  const requestImpl = fakeRequest({ status: 200, data: { choices: [{ message: { tool_calls: [
    { id: 'call_1', function: { name: 'tasks.list', arguments: 'not json' } },
  ] } }] } });
  const tools = [{ type: 'function', function: { name: 'tasks.list', description: '', parameters: {} } }];
  const r = await chatComplete({ messages: [], tools, getKey: () => 'k', requestImpl });
  assert.deepEqual(r.toolCalls[0].args, {});
});

test('BI26091505: with tools, a plain text answer (no tool call) still comes back with content set and an empty toolCalls array', async () => {
  const requestImpl = fakeRequest({ status: 200, data: { choices: [{ message: { content: '  just an answer  ' } }] } });
  const tools = [{ type: 'function', function: { name: 'tasks.list', description: '', parameters: {} } }];
  const r = await chatComplete({ messages: [], tools, getKey: () => 'k', requestImpl });
  assert.equal(r.content, 'just an answer');
  assert.deepEqual(r.toolCalls, []);
});
