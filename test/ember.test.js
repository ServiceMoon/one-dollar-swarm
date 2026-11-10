import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask, swarm, agent, Meter, BudgetExceeded, PRICE } from '../lib/ember.js';

const fakeFetch = (reply = 'hi', usage = { prompt_tokens: 1000, completion_tokens: 200 }, captured = []) =>
  async (url, init) => {
    captured.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: reply } }], usage }) };
  };

test('uses meta/muse-ember and requests usage accounting', async () => {
  const cap = [];
  await ask('hello', { meter: new Meter(1), fetchImpl: fakeFetch('x', undefined, cap) });
  assert.equal(cap[0].model, 'meta/muse-ember');
  assert.deepEqual(cap[0].usage, { include: true });
  assert.equal(cap[0].messages.at(-1).content, 'hello');
});

test('cost falls back to list price when OpenRouter omits usage.cost', async () => {
  const m = new Meter(1);
  const { cost } = await ask('q', { meter: m, fetchImpl: fakeFetch() });
  const expected = 1000 * PRICE.input + 200 * PRICE.output; // $0.0002
  assert.ok(Math.abs(cost - expected) < 1e-12);
  assert.equal(m.calls, 1);
});

test('prefers exact usage.cost from OpenRouter', async () => {
  const m = new Meter(1);
  await ask('q', { meter: m, fetchImpl: fakeFetch('x', { prompt_tokens: 5, completion_tokens: 5, cost: 0.0123 }) });
  assert.equal(m.spent, 0.0123);
});

test('budget guard blocks calls once $1 is spent', async () => {
  const m = new Meter(1);
  m.spent = 1;
  await assert.rejects(ask('q', { meter: m, fetchImpl: fakeFetch() }), BudgetExceeded);
});

test('json mode parses fenced JSON', async () => {
  const { json } = await ask('q', { json: true, meter: new Meter(1), fetchImpl: fakeFetch('```json\n{"a":1}\n```') });
  assert.deepEqual(json, { a: 1 });
});

test('swarm preserves order and respects concurrency', async () => {
  let live = 0, peak = 0;
  const out = await swarm([1, 2, 3, 4, 5, 6], async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5 * (7 - x)));
    live--; return x * 2;
  }, { concurrency: 2 });
  assert.deepEqual(out.map((r) => r.value), [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

test('swarm stops launching work after budget is exceeded', async () => {
  let ran = 0;
  const out = await swarm(Array(10).fill(0), async () => { ran++; throw new BudgetExceeded(1, 1); }, { concurrency: 1 });
  assert.equal(ran, 1);
  assert.equal(out[0].budget, true);
});

test('agent loop executes a tool call then returns the answer', async () => {
  let n = 0;
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => (++n === 1
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] } }], usage: {} }
      : { choices: [{ message: { role: 'assistant', content: 'The answer is 5' } }], usage: {} }),
  });
  const tools = { add: { description: 'add', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }, run: ({ a, b }) => a + b } };
  const r = await agent('2+3?', tools, { meter: new Meter(1), fetchImpl });
  assert.equal(r.answer, 'The answer is 5');
  assert.equal(r.messages.find((m) => m.role === 'tool').content, '5');
});

test('4xx errors surface without retrying', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) }; };
  await assert.rejects(ask('q', { meter: new Meter(1), fetchImpl }), /401: bad key/);
  assert.equal(calls, 1);
});
