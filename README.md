# One Dollar Swarm

**Ask one question and get answers from 100 to 1,000 AI experts at once, all for under $1.**

This project is for the OpenRouter × Meta Build Day $1 Challenge. It uses **Meta Muse Ember** (`meta/muse-ember`) through **OpenRouter**:

1. One call comes up with *N* very different expert lenses for your question (economist, contrarian, historian, engineer, …).
2. *N* Muse Ember agents answer **in parallel**, and each answer appears on screen as soon as it's ready.
3. A final call combines them into the consensus, the strongest dissent, and the most surprising insight.
4. A live **$ / $1 meter** tracks the exact cost of every call (OpenRouter's `usage.cost`). A hard budget guard stops all work at $1.

At $0.10/M input and $0.50/M output, $1 buys roughly **10M input tokens or 2M output tokens**. That's enough for thousands of short agent calls.

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
| `server.js` | Demo server with Server-Sent Events streaming of agents and meter |
| `public/index.html` | Live UI |
| `test/` | `node --test` suite (mocked fetch) |

Built for the OpenRouter × Meta Build Day.
