// Quick live check that your key + Muse Ember work:  node smoke.js
import { ask, meter, loadEnv, MODEL } from './lib/ember.js';
await loadEnv();
const r = await ask('In one sentence: what can you do for one dollar?');
console.log(`model: ${MODEL}\nreply: ${r.text}\ncost:  $${r.cost.toFixed(6)}  (${r.usage.prompt_tokens} in / ${r.usage.completion_tokens} out)\nspent: $${meter.spent.toFixed(6)} of $${meter.limit}`);
