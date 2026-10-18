// Public pages for clients: /m (mockup), /start (packages and checkout), /intake (details form),
// /review (approve or ask for changes), and /f (the contact form endpoint on client sites).
import { db } from '../lib/db.mjs';
import { renderMockup, esc } from '../lib/agency/mockup.mjs';
import { links, conf, getProduct } from '../lib/agency/deals.mjs';
import { offerPage, intakePage, reviewPage, messagePage } from '../lib/agency/pages.mjs';
import { intakeSubmitted, reviewAnswer, siteLead } from '../lib/agency/delivery.mjs';
import { uploadUrl, safeName } from '../lib/agency/storage.mjs';

export const config = { path: ['/m/*', '/start/*', '/intake/*', '/review/*', '/f/*'] };

const supa = () => { try { return new URL(process.env.SUPABASE_URL).origin; } catch { return ''; } };
const CSP = () => `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' ${supa()}; frame-src https:; form-action 'self' https:; base-uri 'none'`;
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': CSP(), 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } });
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

async function load(slug) {
  if (!/^[a-z0-9-]{3,80}$/.test(slug || '')) return null;
  const deal = await db.one('deals', { slug });
  if (!deal) return null;
  const prospect = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  return { deal, prospect, product };
}

const notFound = () => html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><body style="font:17px system-ui;padding:40px">This link isn't valid. Please check the link in your email.</body>`, 404);

async function readBody(req) {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return req.json().catch(() => ({}));
  if (type.includes('form')) return Object.fromEntries((await req.formData()).entries());
  return {};
}

export default async (req) => {
  const url = new URL(req.url);
  const [, kind, slug, extra] = url.pathname.split('/');
  try {
    if (kind === 'f') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, CORS);
      const ctx = await load(slug);
      if (!ctx) return json({ error: 'unknown site' }, 404, CORS);
      const f = await readBody(req);
      if (f.company) return json({ ok: true }, 200, CORS); // honeypot: bots fill it in
      const r = await siteLead(ctx.deal, f);
      if (!(req.headers.get('content-type') || '').includes('json')) {
        const back = req.headers.get('referer') || (ctx.deal.domain ? `https://${ctx.deal.domain}/` : '/');
        try { const u = new URL(back); u.searchParams.set('sent', r.ok ? '1' : '0'); return Response.redirect(u.toString(), 303); } catch {}
      }
      return json(r, r.ok ? 200 : 400, CORS);
    }

    const ctx = await load(slug);
    if (!ctx) return notFound();
    const { deal, prospect, product } = ctx;
    if (!conf(product)) return notFound();

    if (kind === 'm') {
      if (!deal.mockup) return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>Preparing</title><body style="font:18px system-ui;padding:40px;max-width:560px;margin:auto">Your mockup is being prepared. This page refreshes on its own; it usually takes a few minutes.</body>`);
      const c = conf(product), site = c.packages.find(p => p.kind === 'once');
      return html(renderMockup(deal.mockup, prospect, { agency: product.name, startUrl: links(deal).offer, nextLine: site ? `Like this direction? The full site is $${site.price} one time, live in about ${c.delivery_days} days, hosting included.` : '' }));
    }
    if (kind === 'start') return html(offerPage(ctx));

    if (kind === 'intake') {
      if (req.method === 'POST' && extra === 'upload') {
        const { name, size } = await readBody(req);
        if (!name || Number(size) > 15e6) return json({ error: 'File too large (15 MB max)' }, 400);
        const n = await import('../lib/agency/storage.mjs').then(m => m.list(`intake/${deal.slug}/`)).catch(() => []);
        if (n.length >= 20) return json({ error: 'Too many files already uploaded' }, 400);
        return json(await uploadUrl(`intake/${deal.slug}/${Date.now().toString(36)}-${safeName(name)}`));
      }
      if (req.method === 'POST') {
        const d = await readBody(req);
        const keep = ['business_name', 'phone', 'enquiry_email', 'address', 'hide_address', 'service_area', 'hours', 'services', 'since', 'about', 'different', 'pages', 'mockup_feedback', 'colors', 'likes', 'domain', 'notes', 'files'];
        const clean = {};
        for (const k of keep) if (d[k] !== undefined) clean[k] = typeof d[k] === 'string' ? d[k].slice(0, 4000) : Array.isArray(d[k]) ? d[k].slice(0, 20).map(x => String(x).slice(0, 300)) : !!d[k];
        if (!String(clean.services || '').trim()) return json({ error: 'Please list at least one service' }, 400);
        await intakeSubmitted(deal, clean);
        return json({ ok: true });
      }
      return html(intakePage({ ...ctx, justPaid: url.searchParams.has('paid') }));
    }

    if (kind === 'review') {
      if (req.method === 'POST') {
        const d = await readBody(req);
        if (d.approve) return json(await reviewAnswer(deal, { approve: true }));
        if (String(d.changes || '').trim()) {
          const r = await reviewAnswer(deal, { changes: String(d.changes).slice(0, 6000) });
          return json({ ok: true, escalated: !!r.escalated });
        }
        return json({ error: 'Nothing to send' }, 400);
      }
      return html(reviewPage(ctx));
    }
    return notFound();
  } catch (e) {
    console.error(e);
    return kind === 'f' ? json({ error: 'server error' }, 500, CORS) : html(`<!doctype html><meta charset="utf-8"><title>Error</title><body style="font:17px system-ui;padding:40px">Something went wrong on our side. Please try again in a minute, or reply to our email.</body>`, 500);
  }
};
