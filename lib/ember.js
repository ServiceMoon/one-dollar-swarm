// Muse Ember via OpenRouter — zero-dependency client with a hard dollar budget.
// Node 18+ (uses global fetch).

export const MODEL = process.env.EMBER_MODEL || 'meta/muse-ember';
export const PRICE = { input: 0.10 / 1e6, output: 0.50 / 1e6 }; // USD per token (OpenRouter list price)

export class BudgetExceeded extends Error {
  constructor(spent, limit) {
    super(`Budget exceeded: $${spent.toFixed(4)} of $${limit.toFixed(2)}`);
    this.name = 'BudgetExceeded';
  }
}

/** Tracks real spend (OpenRouter-reported cost when present, else list price). */
export class Meter {
  constructor(limit = Number(process.env.BUDGET_USD || 1)) {
    this.limit = limit;
    this.spent = 0;
    this.calls = 0;
    this.inTok = 0;
    this.outTok = 0;
    this.listeners = new Set();
  }
  estimate(usage = {}) {
    return (usage.prompt_tokens || 0) * PRICE.input + (usage.completion_tokens || 0) * PRICE.output;
  }
  record(usage = {}) {
    const cost = typeof usage.cost === 'number' ? usage.cost : this.estimate(usage);
    this.spent += cost;
    this.calls += 1;
    this.inTok += usage.prompt_tokens || 0;
    this.outTok += usage.completion_tokens || 0;
    for (const fn of this.listeners) fn(this.snapshot());
    return cost;
  }
  guard() {
    if (this.spent >= this.limit) throw new BudgetExceeded(this.spent, this.limit);
  }
  snapshot() {
    return {
      spent: this.spent, limit: this.limit, calls: this.calls,
      inTok: this.inTok, outTok: this.outTok,
      pct: Math.min(100, (this.spent / this.limit) * 100),
    };
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

export const meter = new Meter();

/**
 * One chat completion.
 * @param {string|Array} input  user string, or a full messages array
 * @param {object} opts  { system, json, schema, tools, temperature, max_tokens, reasoning, meter, fetchImpl }
 * @returns {Promise<{text, json, message, usage, cost}>}
 */
export async function ask(input, opts = {}) {
  const m = opts.meter || meter;
  m.guard();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key && !opts.fetchImpl) throw new Error('Set OPENROUTER_API_KEY (see .env.example)');

  const messages = Array.isArray(input)
    ? input
    : [...(opts.system ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: input }];

  const body = {
    model: opts.model || MODEL,
    messages,
    usage: { include: true }, // OpenRouter returns exact usage.cost
    ...(opts.temperature != null && { temperature: opts.temperature }),
    ...(opts.max_tokens && { max_tokens: opts.max_tokens }),
    ...(opts.tools && { tools: opts.tools, tool_choice: opts.tool_choice || 'auto' }),
    ...(opts.reasoning && { reasoning: opts.reasoning }), // e.g. { effort: 'low' }
  };
  if (opts.schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: opts.schemaName || 'result', strict: true, schema: opts.schema } };
  } else if (opts.json) {
    body.response_format = { type: 'json_object' };
  }

  const doFetch = opts.fetchImpl || fetch;
  let res, data, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await doFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'https://github.com',
          'X-Title': process.env.APP_NAME || 'Ember Starter',
        },
        body: JSON.stringify(body),
      });
      data = await res.json();
      if (res.ok && !data.error) break;
      lastErr = new Error(`OpenRouter ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
      if (res.status !== 429 && res.status < 500) throw lastErr; // don't retry 4xx
    } catch (e) {
      lastErr = e;
      if (e.message?.startsWith('OpenRouter 4') && !e.message.startsWith('OpenRouter 429')) throw e;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    data = null;
  }
  if (!data || data.error || !res?.ok) throw lastErr;

  const usage = data.usage || {};
  const cost = m.record(usage);
  const message = data.choices?.[0]?.message || {};
  const text = message.content || '';
  let json;
  if (opts.json || opts.schema) {
    try { json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { json = undefined; }
  }
  return { text, json, message, usage, cost };
}

/**
 * Run many tasks in parallel with a concurrency cap. Stops launching new
 * work once the budget is hit; returns results in input order.
 */
export async function swarm(items, worker, { concurrency = 16, onResult } = {}) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e.message, budget: e instanceof BudgetExceeded };
        if (e instanceof BudgetExceeded) { next = items.length; }
      }
      onResult?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

/** Minimal tool-calling agent loop. tools: { name: { description, parameters, run(args) } } */
export async function agent(task, tools, { system, maxSteps = 8, ...opts } = {}) {
  const spec = Object.entries(tools).map(([name, t]) => ({
    type: 'function', function: { name, description: t.description, parameters: t.parameters },
  }));
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: task }];
  for (let step = 0; step < maxSteps; step++) {
    const { message } = await ask(messages, { ...opts, tools: spec });
    messages.push(message);
    if (!message.tool_calls?.length) return { answer: message.content, messages };
    for (const call of message.tool_calls) {
      let out;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        out = await tools[call.function.name].run(args);
      } catch (e) { out = { error: e.message }; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: typeof out === 'string' ? out : JSON.stringify(out) });
    }
  }
  return { answer: null, messages, truncated: true };
}

/** Load .env without dependencies. */
export async function loadEnv(path = '.env') {
  try {
    const { readFile } = await import('node:fs/promises');
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — fine */ }
}
