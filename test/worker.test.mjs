// The build worker, with a stand-in for Claude Code and for npx (sharp and wrangler).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const calls = path.join(tmp, 'calls.log');

// Fake Claude Code: reads JOB.md and writes a small site; leaves a broken link on the first round.
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
fs.appendFileSync(${JSON.stringify(calls)}, 'claude ' + process.argv.slice(2).join(' ') + '\\n');
const job = fs.readFileSync('JOB.md', 'utf8'); const brief = fs.readFileSync('BRIEF.md', 'utf8');
const id = brief.match(/Site id: (\\S+)/)[1]; const form = brief.match(/Contact form endpoint: (\\S+)/)[1];
const page = (t, body) => '<!doctype html><html><head><title>' + t + '</title><meta name="viewport" content="width=device-width"><meta name="description" content="Plumbing in Austin from a family owned local team, call today."></head><body>' + body + '</body></html>';
const w = (f, c) => { fs.mkdirSync(path.dirname(path.join('site', f)), { recursive: true }); fs.writeFileSync(path.join('site', f), c); };
if (/# Your job: build/.test(job)) {
  const fixing = /checker found these problems/.test(job);
  w('index.html', page('Lone Star Plumbing | Austin', '<a href="tel:5125550199">Call</a><a href="/services/water-heaters/">Water heaters</a>' + (fixing ? '' : '<a href="/missing/">x</a>') + '<img src="/assets/img/upload-logo.webp" width="10" height="10" alt="">'));
  w('services/water-heaters/index.html', page('Water heaters in Austin | Lone Star', 'hi'));
  w('contact/index.html', page('Contact | Lone Star Plumbing', '<form data-form method="post" action="' + form + '"></form><script src="/assets/form.js" defer></script>'));
  w('404.html', page('Not found | Lone Star', '')); w('sitemap.xml', '<urlset/>'); w('robots.txt', 'User-agent: *');
}
if (/# Your job: blog/.test(job)) { w('blog/a/index.html', page('Water heater cost in Austin | Lone Star', 'article')); fs.writeFileSync('RESULT.json', JSON.stringify({ title: 'Water heater cost in Austin', path: '/blog/a/' })); }
fs.writeFileSync('SUMMARY.md', 'Built the site.');
console.log(JSON.stringify({ result: 'ok', is_error: false, total_cost_usd: 1.23 }));
`, { mode: 0o755 });
// Fake npx: sharp copies the image as .webp; wrangler succeeds.
fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, 'npx ' + a.join(' ') + '\\n');
if (a[1].startsWith('sharp-cli')) { const i = a[a.indexOf('-i') + 1], o = a[a.indexOf('-o') + 1]; fs.copyFileSync(i, path.join(o, path.basename(i).replace(/\\.[a-z]+$/, '.webp'))); }
`, { mode: 0o755 });
process.env.PATH = bin + path.delimiter + process.env.PATH;

const srv = http.createServer((q, r) => { r.setHeader('Content-Type', 'image/png'); r.end(Buffer.alloc(100, 1)); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
test.after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const W = await import('../worker/agency-worker.mjs');
const cfg = { claude: 'claude', model: 'sonnet', sitesDir: path.join(tmp, 'sites'), claudeTimeoutMin: 1, cloudflareApiToken: 't', cloudflareAccountId: 'a' };
const job = {
  id: 'j1', type: 'build', slug: 'lone-star-abc123', project: 's-lone-star-abc123', business: 'Lone Star Plumbing', form: 'https://studio.test/f/lone-star-abc123',
  brief: '# Website brief\n\nSite id: lone-star-abc123\nContact form endpoint: https://studio.test/f/lone-star-abc123 (POST)\n',
  uploads: [{ name: 'logo.png', url: base + '/logo.png' }], oldImages: [base + '/truck.jpg'], logo: '',
  restore: null, backup: { url: base + '/backup' },
};

test('build: images prepared, Claude Code locked down, checker sends it back once, result reported', async () => {
  const out = await W.doJob(cfg, job, { skipDeploy: true });
  const work = path.join(cfg.sitesDir, job.slug);
  assert.ok(fs.existsSync(path.join(work, 'site/assets/img/upload-logo.webp')));
  assert.ok(fs.existsSync(path.join(work, 'site/assets/img/current-site-1.webp')));
  assert.ok(fs.existsSync(path.join(work, 'site/assets/form.js')), 'starter files copied');
  assert.ok(fs.existsSync(path.join(work, 'GUIDE.md')));
  const log = fs.readFileSync(calls, 'utf8');
  const claudeRuns = log.split('\n').filter(l => l.startsWith('claude '));
  assert.equal(claudeRuns.length, 2, 'second round to fix the broken link');
  assert.match(claudeRuns[0], /--permission-mode dontAsk --allowedTools Read,Write,Edit,MultiEdit,Glob,Grep --output-format json --model sonnet/);
  assert.doesNotMatch(claudeRuns[0], /Bash|WebFetch|dangerously/);
  const html = fs.readFileSync(path.join(work, 'site/index.html'), 'utf8');
  assert.match(html, /<meta name="x-site-id" content="lone-star-abc123">/, 'marker injected');
  assert.equal(out.summary, 'Built the site.');
});

test('validate catches what PageSpeed would not', async () => {
  const site = path.join(tmp, 'v/site');
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<html><head></head><body>Lorem ipsum <img src="https://other.com/x.jpg"><a href="about/">a</a></body></html>');
  const p = await W.validate(site, { type: 'build', slug: 's', form: 'https://studio.test/f/s' });
  for (const want of [/missing or empty <title>/, /viewport/, /placeholder text/, /hotlinked image/, /broken link or missing file about\//, /no sitemap/, /no contact form/, /tap-to-call/])
    assert.ok(p.some(x => want.test(x)), 'expected ' + want + ' in ' + p.join(' | '));
});

test('blog job returns title and path', async () => {
  const out = await W.doJob(cfg, { ...job, id: 'j2', type: 'blog' }, { skipDeploy: true });
  assert.equal(out.title, 'Water heater cost in Austin'); assert.equal(out.path, '/blog/a/');
});

test('deploy calls wrangler with the project and the site folder', async () => {
  fs.writeFileSync(calls, '');
  const out = await W.doJob(cfg, { ...job, id: 'j3', type: 'fix', brief: job.brief + '\n## FIX THESE PROBLEMS\n- x' });
  assert.equal(out.previewUrl, 'https://s-lone-star-abc123.pages.dev');
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /npx --yes wrangler@4 pages project create s-lone-star-abc123 --production-branch main/);
  assert.match(log, /npx --yes wrangler@4 pages deploy site --project-name s-lone-star-abc123 --branch main/);
});
