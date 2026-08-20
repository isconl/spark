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
