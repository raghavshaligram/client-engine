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

installFetch({ db: fakeDb(), ai: fakeOpenAI(), passthrough: true, testHosts: true });
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
