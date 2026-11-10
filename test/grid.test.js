import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuote, parseCandidates, dedupeCriteria } from '../server.js';

const resume = 'Rayan Sohrabian\nBuilt ScreenSense, a macOS app with 2,000 users. Led a team of 4 engineers shipping a Chrome extension.';

test('verifyQuote accepts exact and lightly-reformatted quotes', () => {
  assert.ok(verifyQuote('Led a team of 4 engineers', resume));
  assert.ok(verifyQuote('built screensense, a macOS app with 2,000 users!', resume));
});
test('verifyQuote rejects invented evidence', () => {
  assert.equal(verifyQuote('Managed a team of 40 at Google for ten years', resume), false);
  assert.equal(verifyQuote('', resume), false);
});
test('parseCandidates splits on --- and takes first line as name', () => {
  const c = parseCandidates('Alice\nPython dev\n---\nBob\nGo dev\n  ---  \nCara');
  assert.deepEqual(c.map((x) => x.name), ['Alice', 'Bob', 'Cara']);
});
test('dedupeCriteria removes near-duplicates and protected attributes, caps count', () => {
  const out = dedupeCriteria([
    { criterion: 'Production experience with Python services' },
    { criterion: 'Python services production experience' },
    { criterion: 'Candidate age between 25 and 35' },
    { criterion: 'Native English speaker nationality' },
    { criterion: 'Shipped LLM features to users' },
    { criterion: 'Mentored junior engineers' },
  ], 2);
  assert.deepEqual(out.map((c) => c.criterion), ['Production experience with Python services', 'Shipped LLM features to users']);
});

import { extractJob, htmlToText } from '../server.js';

test('extractJob prefers JSON-LD JobPosting (Greenhouse/Lever/Ashby style)', () => {
  const html = `<html><head><title>Careers</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Founding AI Engineer","hiringOrganization":{"name":"Moon"},"description":"&lt;p&gt;Build agents.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;5+ years Python&lt;/li&gt;&lt;/ul&gt;"}</script></head><body>nav junk</body></html>`;
  const j = extractJob(html);
  assert.equal(j.title, 'Founding AI Engineer at Moon');
  assert.match(j.text, /Build agents\./);
  assert.match(j.text, /- 5\+ years Python/);
  assert.doesNotMatch(j.text, /nav junk/);
});
test('extractJob falls back to page text without scripts/styles', () => {
  const body = 'We are hiring a Senior Recruiter. '.repeat(20);
  const j = extractJob(`<title>Senior Recruiter</title><style>.x{}</style><script>var a=1</script><main><p>${body}</p></main>`);
  assert.equal(j.title, 'Senior Recruiter');
  assert.match(j.text, /Senior Recruiter/);
  assert.doesNotMatch(j.text, /var a=1|\.x\{\}/);
});
test('htmlToText decodes entities and keeps list structure', () => {
  assert.equal(htmlToText('<ul><li>A &amp; B</li><li>C&#39;s</li></ul>'), '- A & B\n- C\'s');
});
