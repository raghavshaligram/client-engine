// Local server for the browser test: static files + /api backed by fake Supabase and OpenAI,
// plus two fake business websites at acme.test and busy.test.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fakeDb, fakeOpenAI, installFetch } from './fakes.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'svc';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.APP_KEY = 'test-key';
process.env.GOOGLE_CLIENT_ID = 'fake-client.apps.googleusercontent.com';
process.env.ALLOW_PRIVATE = '1';

const sites = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url.startsWith('/acme')
    ? `<title>Acme Plumbing</title><h1>Same-day water heater replacement</h1><p>Family-owned plumbers serving Austin homeowners for twenty years.</p>`
    : `<title>Busy HVAC</title><h1>Heating and cooling</h1><p>Book online today for repairs across central Texas since 1998.</p><a href="tel:1">call</a>`);
});
await new Promise(r => sites.listen(0, '127.0.0.1', r));
process.env.SITE_PORT = String(sites.address().port);

const db = fakeDb();
installFetch({ db, ai: fakeOpenAI(), passthrough: true, testHosts: true });
if (process.env.SEED_AGENCY) {
  const now = Date.now(), ago = h => new Date(now - h * 3600_000).toISOString();
  const add = (name, city, stage, extra = {}) => {
    const pid = 'p-' + name.replace(/\W+/g, '').toLowerCase();
    db.T.prospects.push({ id: pid, product_id: 'websites', name, email: 'owner@' + pid + '.test', city, state: 'TX', website: 'http://' + pid + '.test', status: 'interested', step: 1, extra: {}, signals: {}, score: 7 });
    db.T.deals.push({ id: 'd-' + pid, slug: pid + '-abc123', prospect_id: pid, product_id: 'websites', stage, needs_human: false, auto_messages: 2, growth_status: 'none', revisions_used: 0, fix_attempts: 0, owner_ok: false, seo: {}, reminders: {}, log: [{ at: ago(3), note: 'mockup made' }], mockup: {}, updated_at: ago(Math.random() * 30), created_at: ago(40), ...extra });
  };
  add('Lone Star Plumbing', 'Austin', 'owner_check', { paid_at: ago(100), amount_cents: 49700, preview_url: 'https://s-lone-star.pages.dev' });
  add('Hill Country Roofing', 'Round Rock', 'offer_sent', { needs_human: true, human_reason: 'they asked for a discount: "can you do $350 if I pay today?"' });
  add('Bright Smile Dental', 'Austin', 'live', { paid_at: ago(400), amount_cents: 49700, growth_status: 'active', domain: 'www.brightsmile.test' });
  add('Cedar Park HVAC', 'Cedar Park', 'mockup_sent');
  add('Elm Street Salon', 'Austin', 'building', { paid_at: ago(30), amount_cents: 49700 });
  db.T.replies.push({ id: 'r1', prospect_id: 'p-hillcountryroofing', product_id: 'websites', gmail_id: 'g1', body: 'Looks great. Can you do $350 if I pay today?', label: 'needs_you', handled: false, received_at: ago(2) });
  db.T.messages.push({ id: 'm1', prospect_id: 'p-hillcountryroofing', product_id: 'websites', step: 1, status: 'sent', body: 'Hi Hill Country Roofing,\n\nYour site loads without HTTPS...', sent_at: ago(50), subject: 'your site on phones' });
}
const { default: handler } = await import('../netlify/functions/api.mjs');

const CSP = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8').match(/Content-Security-Policy = "([^"]+)"/)[1];
const port = Number(process.argv[2] || 8899);
http.createServer(async (req, res) => {
  if (req.url === '/api') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handler(new Request('http://localhost/api', { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(await r.text()); return;
  }
  if (req.url === '/__siteport') { res.end(process.env.SITE_PORT); return; }
  const f = path.join(root, 'public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(path.join(root, 'public')) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'Content-Security-Policy': CSP });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log('ready on ' + port));
