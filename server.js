// $1 Hiring Grid: Muse Ember generates up to ~100 industry hiring criteria in
// parallel, then one agent checks each (criterion x candidate) and must quote
// evidence. Quotes are verified verbatim against the resume ("receipts").
//   node server.js   →  http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { ask, swarm, meter, loadEnv, MODEL } from './lib/ember.js';

await loadEnv();
const PORT = Number(process.env.PORT || 3000);
const LOW = { effort: 'low' };
const clients = new Set();
const send = (event, data) => { for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
meter.onChange((s) => send('meter', s));

export const CATEGORIES = [
  ['Role skills', 'hard technical/functional skills the job explicitly or implicitly requires'],
  ['Domain knowledge', 'industry, product-area and customer knowledge for this role'],
  ['Experience & seniority', 'years, scope, level, team size, complexity of past work'],
  ['Impact & outcomes', 'measurable results: metrics moved, things shipped, revenue, scale'],
  ['Career trajectory', 'growth rate, promotions, increasing scope, slope over time'],
  ['Ownership & leadership', 'leading projects/people, initiative, founding, driving decisions'],
  ['Collaboration & communication', 'cross-functional work, writing, mentoring, stakeholder mgmt'],
  ['Credentials & learning', 'relevant education, certifications, publications, open source, awards'],
  ['Company & stage fit', 'fit with company size/stage/pace, similar environments, tooling'],
  ['Risk signals', 'gaps between claims and evidence, very short tenures, missing must-haves (phrase each as a positive criterion to check)'],
];

const PROTECTED = /\b(age|gender|sex|race|ethnic|religio|nationality|national origin|citizenship|marital|pregnan|disabilit|veteran|sexual orientation|photo|birth)\w*/i;

export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Is the quoted evidence actually in the resume? (fuzzy: 80% of quote words, in order-insensitive bag) */
export function verifyQuote(quote, resume) {
  const q = norm(quote);
  if (!q) return false;
  const r = norm(resume);
  if (r.includes(q)) return true;
  const words = q.split(' ').filter((w) => w.length > 2);
  if (words.length < 3) return false;
  const bag = new Set(r.split(' '));
  return words.filter((w) => bag.has(w)).length / words.length >= 0.8;
}

/** Recover fields from truncated JSON like {"verdict":"met","quote":"Led a te */
export function salvage(text) {
  const t = String(text || '');
  const verdict = (t.match(/"verdict"\s*:\s*"(met|partial|missing)"/) || [])[1];
  if (!verdict) return null;
  const field = (k) => ((t.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`)) || [])[1] || '').replace(/\\"/g, '"');
  return { verdict, quote: field('quote'), note: field('note') };
}

export function parseCandidates(text) {
  return String(text || '').split(/\n\s*-{3,}\s*\n/).map((t) => t.trim()).filter(Boolean)
    .map((t, i) => ({ name: (t.split('\n')[0] || `Candidate ${i + 1}`).replace(/^#+\s*/, '').slice(0, 60), text: t }));
}

const STOP = new Set(['with', 'from', 'that', 'this', 'have', 'into', 'their', 'using', 'experience', 'strong', 'proven', 'demonstrated', 'ability', 'years']);
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i || 1); };

export function dedupeCriteria(list, max) {
  const kept = [], out = [];
  for (const c of list) {
    if (!c?.criterion || PROTECTED.test(c.criterion)) continue;
    const w = words(c.criterion);
    if (!w.size || kept.some((k) => jaccard(w, k) >= 0.7)) continue;
    kept.push(w);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
export function htmlToText(html) {
  return decode(String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+(?=- )/g, '\n').trim();
}
/** Pull the job text out of a page: JSON-LD JobPosting first (Greenhouse/Lever/Ashby/LinkedIn ship it), else page text. */
export function extractJob(html) {
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = [].concat(data, data['@graph'] || []);
      const jp = nodes.find((x) => x && [].concat(x['@type']).includes('JobPosting'));
      if (jp?.description) {
        const org = jp.hiringOrganization?.name ? ` at ${jp.hiringOrganization.name}` : '';
        return { title: `${jp.title || 'Job'}${org}`, text: `${jp.title || ''}${org}\n\n${htmlToText(decode(jp.description))}` };
      }
    } catch { /* ignore bad JSON-LD */ }
  }
  const title = decode((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || 'Job').trim();
  const og = decode((String(html).match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) || [])[1] || '');
  const body = htmlToText(html);
  return { title, text: (body.length > 300 ? body : `${og}\n\n${body}`).slice(0, 20000) };
}
export async function fetchJob(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Job URL must start with http(s)://');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36', Accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Couldn't fetch job page (${res.status}). Paste the description instead.`);
  const job = extractJob(await res.text());
  if (job.text.length < 200) throw new Error('That page has almost no text (it may need JavaScript or a login). Paste the description instead.');
  return job;
}

export async function run({ job, jobUrl, candidates: candIn, n }) {
  n = Math.max(10, Math.min(Number(n) || 100, 300));
  if (!job?.trim() && jobUrl) { send('status', { msg: 'Fetching job description…' }); job = (await fetchJob(jobUrl)).text; }
  if (!job?.trim()) throw new Error('Add a job description or URL');
  const candidates = Array.isArray(candIn)
    ? candIn.filter((c) => c?.text?.trim()).map((c, i) => ({ name: String(c.name || `Candidate ${i + 1}`).slice(0, 60), text: c.text }))
    : parseCandidates(candIn);
  if (!candidates.length) throw new Error('Add at least one candidate');
  send('candidates', candidates.map((c) => c.name));

  // 1) Generate criteria — one agent per category, in parallel.
  const per = Math.ceil((n * 1.25) / CATEGORIES.length); // over-generate, then dedupe
  send('status', { msg: `${CATEGORIES.length} agents generating hiring criteria…` });
  let raw = [];
  await swarm(CATEGORIES, async ([cat, desc]) => {
    const { json } = await ask(
      `JOB DESCRIPTION:\n${job}\n\nYou are a senior recruiter. List ${per} distinct, concrete, CHECKABLE hiring criteria in the category ` +
      `"${cat}" (${desc}) for THIS role, using real industry standards. Each must be verifiable from a resume. ` +
      `Never use protected attributes (age, gender, race, religion, nationality, marital status, disability, etc.). ` +
      `Return {"criteria":[{"criterion":"<=12 words","evidence":"what in a resume proves it, <=12 words","weight":1-5,"must_have":true|false}]}`,
      { json: true, reasoning: LOW, temperature: 0.6, max_tokens: 2500 },
    );
    const items = (json?.criteria || []).map((c) => ({ ...c, category: cat }));
    raw = raw.concat(items);
    send('criteriaCount', { count: raw.length });
  }, { concurrency: 10 });

  const criteria = dedupeCriteria(raw, n).map((c, i) => ({ id: i, ...c, weight: Math.max(1, Math.min(5, Number(c.weight) || 3)) }));
  send('criteria', { criteria, generated: raw.length });

  // 2) One agent per (criterion x candidate), evidence required.
  const jobs = [];
  for (const cand of candidates) for (const crit of criteria) jobs.push({ cand, crit });
  send('status', { msg: `${jobs.length} evidence checks (${criteria.length} criteria × ${candidates.length} candidates)…` });
  const ci = new Map(candidates.map((c, i) => [c, i]));
  await swarm(jobs, async ({ cand, crit }) => {
    let parsed;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const { json, text } = await ask(
        `CRITERION: ${crit.criterion}\nWHAT COUNTS AS EVIDENCE: ${crit.evidence}\n\nRESUME:\n${cand.text}`,
        {
          system: 'You verify ONE hiring criterion against ONE resume. Be strict: no evidence in the resume means "missing". ' +
            'Reply with ONLY compact JSON {"verdict":"met"|"partial"|"missing","quote":"<=25 exact words copied from the resume, or empty","note":"<=12 words"}.',
          json: true, reasoning: LOW, temperature: 0, max_tokens: 900,
        },
      );
      parsed = json || salvage(text);
    }
    if (!parsed) throw new Error('no answer');
    const verdict = ['met', 'partial', 'missing'].includes(parsed.verdict) ? parsed.verdict : 'missing';
    const verified = verdict === 'missing' ? true : verifyQuote(parsed.quote, cand.text);
    return { verdict: verdict !== 'missing' && !verified ? 'unverified' : verdict, quote: parsed.quote || '', note: parsed.note || '' };
  }, {
    concurrency: 48,
    onResult: (r, i) => send('cell', { c: ci.get(jobs[i].cand), k: jobs[i].crit.id, ...(r.ok ? r.value : { verdict: 'error', note: r.error }) }),
  });

  send('status', { msg: `Done: ${meter.calls} calls, $${meter.spent.toFixed(4)} spent.` });
}

export function start() {
  return http.createServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: meter\ndata: ${JSON.stringify(meter.snapshot())}\n\n`);
      res.write(`event: model\ndata: ${JSON.stringify({ model: MODEL })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/jd' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const job = await fetchJob(JSON.parse(body || '{}').url || '');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(job));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
        }
      });
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
  }).listen(PORT, () => console.log(`$1 Hiring Grid on http://localhost:${PORT}  (model ${MODEL}, budget $${meter.limit})`));
}
if (process.argv[1] && import.meta.url.endsWith('/' + process.argv[1].split('/').pop())) start();
