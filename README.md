# $1 Hiring Panel

**Paste a job description and a candidate. 100 AI interviewers evaluate them at the same time, each from a different seat. The whole panel costs about a cent.**

This project is for the OpenRouter × Meta Build Day $1 Challenge. It uses **Meta Muse Ember** (`meta/muse-ember`) through **OpenRouter**:

1. The panel starts with 8 core seats: Hiring Manager, Staff Engineer, Skeptic, Comp Analyst, Retention Analyst, Peer, Founder, and Recruiter. Muse Ember then invents more seats specific to the role, up to 1,000.
2. Every panelist votes **in parallel**. Each one returns `hire`/`no_hire`, a 0–100 score, a top strength, a top concern, and one interview question (structured JSON). The votes appear on screen as they arrive.
3. A panel chair combines the votes into a **decision** (Advance / Hold / Pass), the top strengths and risks with the panelists who raised them, **5 interview questions** aimed at the risks, and a **personalized outreach message**.
4. A live **$ / $1 meter** tracks the exact cost of every call (OpenRouter `usage.cost`). A hard budget guard stops all work at $1.

**Why it matters:** a real hiring panel costs hours of engineers' time per candidate. At $0.10/M input and $0.50/M output tokens, $1 pays for about **100 full 100-person panels**. That's enough to give every applicant a full panel review instead of a 6-second resume skim.
## Run it

```bash
cp .env.example .env        # paste your OpenRouter key
npm run smoke               # one live call: prints reply + exact cost
npm start                   # http://localhost:3000
npm test                    # offline unit tests (no key needed)
```

Needs Node 18+. There are no dependencies.

## Use the library in your own idea

```js
import { ask, swarm, agent, meter } from './lib/ember.js';

const { text, cost } = await ask('Summarize this…', { system: 'Be terse', max_tokens: 200 });
const { json } = await ask('Extract fields…', { json: true });            // JSON mode
const results = await swarm(items, (x) => ask(x), { concurrency: 32 });    // parallel fan-out, budget-aware
const { answer } = await agent('What is 2+3?', {                           // tool-calling loop
  add: { description: 'add numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }, run: ({ a, b }) => a + b },
});
console.log(meter.snapshot()); // { spent, limit, calls, inTok, outTok, pct }
```

| File | Contents |
|---|---|
| `lib/ember.js` | OpenRouter client: budget meter, retries, JSON/schema mode, `swarm()`, `agent()` |
| `server.js` | Hiring-panel server: builds the panel, runs parallel votes, the chair writes the decision; streams to the browser |
| `public/index.html` | Live UI |
| `test/` | `node --test` suite (mocked fetch) |

Built for the OpenRouter × Meta Build Day.
