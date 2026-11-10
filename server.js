// Live demo server: fan a question out to N parallel Muse Ember agents,
// stream each answer + a live "$ of $1" meter to the browser, then synthesize.
//   node server.js   →  http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { ask, swarm, meter, loadEnv, MODEL } from './lib/ember.js';

await loadEnv();
const PORT = Number(process.env.PORT || 3000);
const clients = new Set();
const send = (event, data) => { for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
meter.onChange((s) => send('meter', s));

async function run({ question, n }) {
  n = Math.max(1, Math.min(Number(n) || 50, 1000));
  send('status', { msg: `Designing ${n} distinct perspectives…` });

  // 1) One call invents N distinct expert lenses (cheap, structured).
  const { json } = await ask(
    `Question: "${question}"\nInvent ${n} genuinely different expert perspectives to attack this question ` +
    `(different fields, incentives, eras, contrarians). Return {"agents":[{"name":"...","lens":"one sentence"}]} with exactly ${n} items.`,
    { json: true, reasoning: { effort: 'low' }, temperature: 0.9, max_tokens: Math.min(60 * n + 200, 60000) },
  );
  const agents = (json?.agents || []).slice(0, n);
  while (agents.length < n) agents.push({ name: `Generalist #${agents.length + 1}`, lens: 'first-principles thinker' });
  send('agents', agents);

  // 2) Fan out — every agent answers in parallel.
  send('status', { msg: `Running ${agents.length} agents in parallel…` });
  const results = await swarm(agents, async (a) => {
    const r = await ask(question, {
      system: `You are ${a.name}. Lens: ${a.lens}. Answer in <=60 words. Be specific and non-obvious. End with a confidence 0-100 as "CONF: N".`,
      temperature: 0.8, max_tokens: 400, reasoning: { effort: 'low' },
    });
    return r.text;
  }, { concurrency: 32, onResult: (r, i) => send('answer', { i, ...r }) });

  // 3) Synthesize.
  send('status', { msg: 'Synthesizing the swarm…' });
  const corpus = results.map((r, i) => r.ok ? `[${agents[i].name}] ${r.value}` : '').filter(Boolean).join('\n');
  const final = await ask(
    `Question: "${question}"\n\n${agents.length} independent experts answered:\n${corpus}\n\n` +
    `Synthesize: (1) the consensus answer, (2) the strongest dissent and who raised it, (3) the single most surprising insight. Markdown, <=200 words.`,
    { max_tokens: 600, temperature: 0.3 },
  );
  send('final', { text: final.text });
  send('status', { msg: `Done — ${meter.calls} calls, $${meter.spent.toFixed(4)} spent.` });
}

http.createServer(async (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: meter\ndata: ${JSON.stringify(meter.snapshot())}\n\n`);
    res.write(`event: model\ndata: ${JSON.stringify({ model: MODEL })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/run' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      run(JSON.parse(body || '{}')).catch((e) => send('error', { msg: e.message }));
      res.writeHead(202).end();
    });
    return;
  }
  const html = await readFile(new URL('./public/index.html', import.meta.url));
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
}).listen(PORT, () => console.log(`Ember swarm on http://localhost:${PORT}  (model ${MODEL}, budget $${meter.limit})`));
