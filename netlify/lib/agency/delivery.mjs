// After the sale: payment, the details form, build jobs for the worker, checks, the client's
// review, going live on their domain, and Growth (weekly articles, monthly report).
import { db } from '../db.mjs';
import { conf, links, touch, queue, escalate, notifyOwner, firstName, iso, getProduct, requestChanges, PAID } from './deals.mjs';
import { pageSpeed } from './audit.mjs';
import { blogKeywords, seoReady } from './seo.mjs';
import { addDomain, domainStatus, siteHost, dnsHost, cnameOf, cfReady } from './cloudflare.mjs';
import { uploadUrl, downloadUrl, list } from './storage.mjs';

const DAY = 86_400_000, HOUR = 3_600_000;
const sig = product => firstName(product.from_name) || product.name;
const ageDays = t => (t ? (Date.now() - Date.parse(t)) / DAY : Infinity);

export const projectName = deal => ('s-' + deal.slug).replace(/[^a-z0-9-]/g, '-').slice(0, 58);

// ---- Payment (called by the Dodo webhook) -------------------------------------------
export async function findDeal({ slug, email }) {
  if (slug) { const d = await db.one('deals', { slug }); if (d) return d; }
  if (email) {
    const e = String(email).toLowerCase();
    const d = await db.one('deals', { customer_email: e });
    if (d) return d;
    const p = await db.one('prospects', { email: e });
    if (p) return db.one('deals', { prospect_id: p.id });
  }
  return null;
}

export async function sitePaid(deal, { paymentId, amount, email }) {
  if (deal.paid_at) return { already: true };
  const prospect = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  await touch(deal, { stage: 'intake', paid_at: iso(Date.now()), payment_id: paymentId, amount_cents: amount ?? null, customer_email: email || deal.customer_email, needs_human: false, project: projectName(deal) }, `paid ${amount != null ? '$' + (amount / 100).toFixed(2) : ''}`);
  await db.update('prospects', { id: prospect.id }, { status: 'won', next_due_at: null });
  await db.update('messages', { prospect_id: prospect.id, status: ['in', ['draft', 'approved']] }, { status: 'rejected', error: 'they bought' });
  await queue({ deal, prospect, kind: 'intake', immediate: true, body:
`Thank you, payment received. Here's what happens next.

1. Fill in this short form so the site has your details right (about 10 minutes, and you can upload your logo and photos): {{INTAKE_LINK}}
2. We build your site. You'll get a link to review it in about ${conf(product).delivery_days} days.
3. You ask for any changes, approve it, and we walk you through putting it on your domain.

If anything is easier to explain by email, just reply here.

${sig(product)}` });
  await notifyOwner(`New client: ${prospect.name}`, `${prospect.name} paid${amount != null ? ` $${(amount / 100).toFixed(2)}` : ''}. The details form has been sent. Nothing needed from you.`);
  return { ok: true };
}

export async function growthChanged(deal, status, subscriptionId) {
  const prospect = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  if (status === 'active') {
    if (deal.growth_status === 'active') return;
    await touch(deal, { growth_status: 'active', growth_since: iso(Date.now()), subscription_id: subscriptionId }, 'Growth started');
    await queue({ deal, prospect, kind: 'growth', immediate: true, body:
`Thanks for starting Growth. From here on, a new article aimed at local Google searches goes up on your site about once a week, and you'll get a short report at the start of each month with the enquiries your site sent you.

For small changes (hours, prices, photos, a new service), just reply to this email with what you'd like and it's done within 2 business days.

${sig(product)}` });
    await notifyOwner(`Growth started: ${prospect.name}`, 'Recurring revenue. Nothing needed from you.');
  } else if (deal.growth_status === 'active') {
    await touch(deal, { growth_status: 'cancelled' }, 'Growth ended: ' + status);
    await notifyOwner(`Growth ended: ${prospect.name}`, `Their subscription is now "${status}". Articles have stopped.`);
  }
}

// ---- The details form ------------------------------------------------------------------
export async function intakeSubmitted(deal, data) {
  const prospect = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  const first = !deal.intake_at;
  await touch(deal, { intake: { ...(deal.intake || {}), ...data }, intake_at: iso(Date.now()) }, first ? 'details form received' : 'details form updated');
  if (first && deal.stage === 'intake') {
    await startBuild(deal);
    await queue({ deal, prospect, kind: 'reply', immediate: true, body:
`Got your details, thank you. We've started on your site and you'll get a link to review it in about ${conf(product).delivery_days} days.

${sig(product)}` });
  }
}

export async function startBuild(deal) {
  await db.insert('jobs', [{ deal_id: deal.id, type: 'build', input: {} }]);
  await touch(deal, { stage: 'building', project: deal.project || projectName(deal) }, 'build queued');
}

// ---- Jobs for the worker ----------------------------------------------------------------
function list2(v) { return Array.isArray(v) ? v : String(v || '').split(/\n|,/).map(s => s.trim()).filter(Boolean); }

export async function brief(deal, job) {
  const p = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  const i = deal.intake || {}, m = deal.mockup || {}, x = p.extra || {}, a = x.audit || {};
  const services = list2(i.services).length ? list2(i.services) : (m.services || []).map(s => s.name);
  const L = links(deal);
  const lines = [
    `# Website brief: ${i.business_name || p.name}`,
    '',
    `Site id: ${deal.slug} (keep the <meta name="x-site-id" content="${deal.slug}"> tag on every page)`,
    `Domain: ${(siteHost(i.domain || p.website) || {}).host || '(not known yet)'} (use https://<this> in canonical URLs and the sitemap)`,
    `Studio name: ${product.name}`,
    `Contact form endpoint: ${L.form} (POST, fields: name, email, phone, message, page; hidden honeypot field "company" must stay empty)`,
    '',
    '## The business',
    `- Name: ${i.business_name || p.name}`,
    `- Type: ${p.category || ''}`,
    `- Phone: ${i.phone || p.phone || ''}`,
    `- Email for enquiries: ${i.enquiry_email || p.email}`,
    `- Address: ${i.address || x.address || ''}${i.hide_address ? ' (do NOT show the street address, show the city only)' : ''}`,
    `- City: ${[p.city, p.state].filter(Boolean).join(', ')}`,
    `- Service area: ${i.service_area || m.area || ''}`,
    `- Hours: ${i.hours || x.hours || ''}`,
    p.rating ? `- Google rating: ${p.rating} from ${p.reviews} reviews (you may show this exact figure)` : '',
    a.since_year || i.since ? `- In business since: ${i.since || a.since_year}` : '',
    '',
    '## Services (one page each, plus a services overview on the home page)',
    ...services.map(s => `- ${s}`),
    '',
    '## In their words',
    i.about ? `About: ${i.about}` : '',
    i.different ? `What makes them different: ${i.different}` : '',
    i.customers ? `Their customers: ${i.customers}` : '',
    i.style ? `Look and feel they want: ${i.style}` : '',
    i.colors ? `Colours: ${i.colors}` : '',
    i.likes ? `Sites they like: ${i.likes}` : '',
    i.mockup_feedback ? `About the mockup: ${i.mockup_feedback}` : '',
    i.notes ? `Other notes: ${i.notes}` : '',
    i.auto ? 'They did not send the details form in time, so build from the facts here and their current site; keep claims modest.' : '',
    '',
    '## Pages',
    `- ${list2(i.pages).length ? list2(i.pages).join(', ') : 'Home, one page per service, About, Contact'}`,
    '',
    '## Starting point: the mockup they liked',
    m.headline ? `Headline: ${m.headline}\nSubhead: ${m.subhead}\nStyle family: ${m.style}` : '(no mockup)',
    (m.why || []).length ? 'Reasons to choose them (from facts): ' + m.why.map(w => `${w.title}: ${w.text}`).join(' | ') : '',
    '',
    '## Text from their current website (facts you may use; rewrite, do not copy word for word)',
    (p.site_text || '').slice(0, 2500),
    x.about ? `\nGoogle profile: ${x.about}` : '',
    '',
    '## Their current site problems (the new site must not have these)',
    ...(a.https === false ? ['- no HTTPS'] : []), ...(a.viewport === false ? ['- no mobile layout'] : []),
    ...(x.psi?.performance != null ? [`- mobile PageSpeed ${x.psi.performance}/100`] : []),
  ];
  if (job.type === 'revise' || job.type === 'edit') lines.push('', `## CHANGES REQUESTED NOW`, job.input.notes || '');
  if (job.type === 'fix') lines.push('', '## FIX THESE PROBLEMS FOUND BY OUR CHECKS', ...(job.input.problems || []).map(s => '- ' + s));
  if (job.type === 'blog') lines.push('', '## WRITE ONE ARTICLE NOW', `Target search: ${job.input.keyword || '(choose a useful local topic about one of the services)'}${job.input.volume ? ` (about ${job.input.volume} searches a month)` : ''}`, `Articles already on the site: ${(deal.seo?.used || []).join('; ') || 'none'}`);
  return lines.filter(l => l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}

export async function claimJob() {
  const stale = iso(Date.now() - 90 * 60_000);
  await db.update('jobs', { status: 'running', claimed_at: ['lt', stale] }, { status: 'queued', error: 'worker stopped part way; retrying' });
  const [job] = await db.select('jobs', { filters: { status: 'queued' }, order: 'created_at.asc', limit: 1 });
  if (!job) return { job: null };
  const [row] = await db.update('jobs', { id: job.id, status: 'queued' }, { status: 'running', claimed_at: iso(Date.now()), attempts: job.attempts + 1 });
  if (!row) return { job: null };
  const deal = await db.one('deals', { id: job.deal_id });
  const p = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  const uploads = await list(`intake/${deal.slug}/`).catch(() => []);
  const files = [];
  for (const f of uploads) files.push({ name: f.path.split('/').pop(), url: await downloadUrl(f.path) });
  const backup = (await list(`sites/`).catch(() => [])).find(f => f.path.endsWith(`/${deal.slug}.tar.gz`) || f.path === `sites/${deal.slug}.tar.gz`);
  return {
    job: {
      id: row.id, type: row.type, attempts: row.attempts, slug: deal.slug, project: deal.project || projectName(deal),
      business: p.name, studio: product.name, brief: await brief(deal, row), form: links(deal).form,
      uploads: files, oldImages: (p.extra?.audit?.images || []).slice(0, 8), logo: p.extra?.audit?.logo || '',
      restore: backup ? await downloadUrl(backup.path) : null,
      backup: await uploadUrl(`sites/${deal.slug}.tar.gz`),
    },
  };
}

export async function jobDone({ id, previewUrl, summary, title, path }) {
  const job = await db.one('jobs', { id });
  if (!job) throw new Error('Unknown job');
  await db.update('jobs', { id }, { status: 'done', finished_at: iso(Date.now()), output: { previewUrl, summary, title, path } });
  const deal = await db.one('deals', { id: job.deal_id });
  const p = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  if (['build', 'revise', 'fix'].includes(job.type)) {
    await touch(deal, { stage: 'qa', preview_url: previewUrl || deal.preview_url, qa: null }, `${job.type} finished`);
  } else if (job.type === 'edit') {
    await touch(deal, {}, 'edit live: ' + (summary || '').slice(0, 100));
    await queue({ deal, prospect: p, kind: 'reply', body: `Done. ${summary ? summary.trim() + ' ' : ''}It's live on your site now.\n\n${sig(product)}` });
  } else if (job.type === 'blog') {
    const seo = deal.seo || {};
    await touch(deal, { seo: { ...seo, published: [...(seo.published || []), { title, path, at: iso(Date.now()) }].slice(-200) } }, 'article published: ' + (title || ''));
  }
  return { ok: true };
}

export async function jobFailed({ id, error }) {
  const job = await db.one('jobs', { id });
  if (!job) throw new Error('Unknown job');
  const final = job.attempts >= 3;
  await db.update('jobs', { id }, { status: final ? 'failed' : 'queued', error: String(error).slice(0, 800) });
  if (final) {
    const deal = await db.one('deals', { id: job.deal_id });
    const p = await db.one('prospects', { id: deal.prospect_id });
    await escalate(deal, p, `the ${job.type} job failed 3 times: ${String(error).slice(0, 200)}`);
  }
  return { ok: true, retry: !final };
}

// ---- Checks on a finished build (run from the audit tick: PageSpeed is slow) ------------
export async function qaDeal(deal) {
  const p = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  const problems = [];
  try {
    const res = await fetch(deal.preview_url, { redirect: 'follow' });
    const html = await res.text();
    if (!res.ok) problems.push(`home page answered ${res.status}`);
    if (!html.includes(deal.slug)) problems.push('home page is missing the x-site-id meta tag');
    if (!/<meta[^>]+name=["']viewport/i.test(html)) problems.push('home page has no viewport meta tag');
    if (!/<title>[^<]{5,}/i.test(html)) problems.push('home page title is missing or too short');
  } catch (e) { problems.push('preview did not load: ' + e.message); }
  const psi = process.env.PSI_API_KEY ? await pageSpeed(deal.preview_url, { timeout: 22000 }) : null;
  if (psi && !psi.error) {
    if (psi.performance < 80) problems.push(`mobile PageSpeed performance is ${psi.performance}/100 (needs 80+): compress and resize images, avoid render-blocking scripts and fonts`);
    if (psi.seo < 90) problems.push(`PageSpeed SEO score is ${psi.seo}/100 (needs 90+)`);
    if (psi.accessibility < 85) problems.push(`PageSpeed accessibility score is ${psi.accessibility}/100 (needs 85+): contrast, alt text, labels`);
  }
  const qa = { at: iso(Date.now()), psi, problems };
  if (psi?.error && !problems.length) { await touch(deal, { qa }, 'PageSpeed unavailable, will retry'); return 'retry'; }
  if (problems.length) {
    if (deal.fix_attempts < 2) {
      await db.insert('jobs', [{ deal_id: deal.id, type: 'fix', input: { problems } }]);
      await touch(deal, { qa, stage: 'building', fix_attempts: deal.fix_attempts + 1 }, 'checks failed, fixing: ' + problems.join('; ').slice(0, 200));
      return 'fix';
    }
    await touch(deal, { qa }, 'checks still failing after 2 fixes');
    await escalate(deal, p, 'the site still fails our checks after 2 automatic fixes: ' + problems.join('; '));
    return 'escalated';
  }
  const c = conf(product);
  const approvedBefore = await db.count('deals', { product_id: deal.product_id, owner_ok: true });
  if (!deal.owner_ok && approvedBefore < c.review_first) {
    await touch(deal, { qa, stage: 'owner_check' }, 'passed checks, waiting for your OK');
    await notifyOwner(`Site ready for your OK: ${p.name}`, `Preview: ${deal.preview_url}\nPageSpeed mobile: ${psi?.performance ?? 'n/a'}, SEO ${psi?.seo ?? 'n/a'}\n\nThe first ${c.review_first} sites wait for you. Open Client Engine > Agency and press "Send to client" (or ask for changes).`);
    return 'owner_check';
  }
  await toClient(deal, p, product, qa);
  return 'client_review';
}

export async function toClient(deal, p, product, qa = deal.qa) {
  const c = conf(product);
  const first = deal.revisions_used === 0;
  await touch(deal, { qa, stage: 'client_review', owner_ok: true }, 'sent to client for review');
  await queue({ deal, prospect: p, kind: 'review', body: first
    ? `Your new site is ready for you to look at: {{REVIEW_LINK}}

Have a click through on your phone and computer. On that page you can approve it, or list anything you'd like changed (${c.revisions} rounds of changes are included).

${sig(product)}`
    : `Your changes are done: {{REVIEW_LINK}}

Have a look, then approve it or send any last changes on that page.

${sig(product)}` });
}

// ---- The client's answer on the review page ---------------------------------------------
export async function reviewAnswer(deal, { approve, changes }) {
  const p = await db.one('prospects', { id: deal.prospect_id });
  const product = await getProduct(deal.product_id);
  if (approve) {
    if (deal.stage !== 'client_review') return { ok: true };
    await touch(deal, { stage: 'domain' }, 'client approved the site');
    await setupDomain(deal, p, product);
    return { ok: true, approved: true };
  }
  const r = await requestChanges(deal, p, product, changes, 'review page');
  if (r.ok) await queue({ deal, prospect: p, kind: 'reply', immediate: true, body: `Got your changes, thank you. We're on them and you'll get a new link to review shortly.\n\n${sig(product)}` });
  return r;
}

// ---- Going live ---------------------------------------------------------------------------
export async function setupDomain(deal, p, product) {
  const target = siteHost(deal.intake?.domain || p.website);
  if (!target) { await escalate(deal, p, 'no usable domain to put the site on'); return; }
  const host = await dnsHost(target.apex);
  if (cfReady()) {
    try { await addDomain(deal.project, target.host); } catch (e) { await escalate(deal, p, 'Cloudflare would not add the domain: ' + e.message); return; }
  }
  await touch(deal, { domain: target.host, dns_host: host.name || '', next_check_at: iso(Date.now() + HOUR) }, `domain step: ${target.host} (${host.name || 'unknown DNS host'})`);
  const where = host.name ? `at ${host.name}` : 'where your domain is managed (the company you pay for the domain each year)';
  await queue({ deal, prospect: p, kind: 'domain', immediate: true, body:
`Approved, thank you. One last step puts it live on ${target.host}. It takes about 5 minutes ${where}:

1. Log in and open the DNS settings for ${target.apex}.
2. Find the record named "www". Change it (or add one) to:
   Type: CNAME
   Name: www
   Value: ${deal.project}.pages.dev
   Remove any other record named "www".
3. Set ${target.apex} itself to forward (redirect) to https://${target.host}. This is usually called "Forwarding" or "Redirect".

Leave everything else alone, especially MX records: your email keeps working exactly as it does now.${host.help ? `\n\n${host.name}'s own guide: ${host.help}` : ''}

I'll keep an eye on it and let you know the moment it's live. If you'd rather someone else (whoever set up your domain) does it, you can forward them this email.

${sig(product)}` });
}

async function checkDomain(deal, p, product) {
  if (deal.next_check_at && Date.parse(deal.next_check_at) > Date.now()) return '';
  let status = 'unknown';
  if (cfReady()) { try { status = await domainStatus(deal.project, deal.domain); } catch (e) { status = 'error: ' + e.message; } }
  let ours = false;
  try { const r = await fetch(`https://${deal.domain}/`, { redirect: 'follow' }); ours = (await r.text()).includes(deal.slug); } catch {}
  if (ours || status === 'active') {
    let apexOk = false;
    try { const r = await fetch(`http://${deal.domain.replace(/^www\./, '')}/`, { redirect: 'follow' }); apexOk = (await r.text()).includes(deal.slug); } catch {}
    await touch(deal, { stage: 'live', live_at: iso(Date.now()) }, `live on ${deal.domain}`);
    const growth = conf(product).packages.find(x => x.kind === 'monthly');
    await queue({ deal, prospect: p, kind: 'live', immediate: true, body:
`You're live: https://${deal.domain}${apexOk ? '' : `

One small thing: ${deal.domain.replace(/^www\./, '')} (without the www) still shows the old site. Setting it to forward to https://${deal.domain} in your domain settings fixes that.`}

Enquiries from the contact form go to ${deal.intake?.enquiry_email || p.email}.${deal.growth_status !== 'active' && growth ? `

If you'd like the site to keep bringing in more searches, ${growth.name} is $${growth.price} a month: ${growth.summary} Details here: {{OFFER_LINK}}` : ''}

Thank you for trusting us with it.

${sig(product)}` });
    await notifyOwner(`Live: ${p.name}`, `https://${deal.domain}`);
    return 'live';
  }
  const days = ageDays((deal.log || []).find(l => /^domain step/.test(l.note))?.at);
  const r = deal.reminders || {};
  const cname = await cnameOf(deal.domain);
  const pointed = cname.some(c => c.endsWith('.pages.dev'));
  if (days > 2 && !r.domain1 && !pointed) {
    await touch(deal, { reminders: { ...r, domain1: iso(Date.now()) } });
    await queue({ deal, prospect: p, kind: 'reply', body: `A quick nudge on the last step: once the "www" record points to ${deal.project}.pages.dev, your new site goes live. If you're stuck or don't know who manages your domain, reply and tell me what you see.\n\n${sig(product)}` });
  } else if (days > 5 && !r.domain2 && !pointed) {
    await touch(deal, { reminders: { ...r, domain2: iso(Date.now()) } });
    await queue({ deal, prospect: p, kind: 'reply', body: `Your new site is finished and waiting. The only thing left is the one DNS change from my earlier email. If it's easier, forward that email to whoever set up your domain.\n\n${sig(product)}` });
  } else if (days > 9 && !r.domain3) {
    await touch(deal, { reminders: { ...r, domain3: iso(Date.now()) } });
    await escalate(deal, p, `the site has waited ${Math.floor(days)} days for the DNS change${pointed ? ' (www points to us but Cloudflare says ' + status + ')' : ''}`);
  }
  await touch(deal, { next_check_at: iso(Date.now() + (pointed ? 20 * 60_000 : 2 * HOUR)) });
  return '';
}

// ---- Growth -------------------------------------------------------------------------------
async function growthWork(deal, p, product) {
  const out = [];
  const seo = deal.seo || {};
  const lastBlog = await db.select('jobs', { select: 'created_at,status', filters: { deal_id: deal.id, type: 'blog' }, order: 'created_at.desc', limit: 1 });
  const busy = lastBlog[0] && ['queued', 'running'].includes(lastBlog[0].status);
  if (!busy && ageDays(lastBlog[0]?.created_at) >= 7) {
    let keywords = seo.keywords || [];
    if (!keywords.length || ageDays(seo.keywords_at) > 90) {
      const services = (deal.intake?.services ? String(deal.intake.services).split(/\n|,/) : (deal.mockup?.services || []).map(s => s.name)).map(s => s.trim()).filter(Boolean);
      try { keywords = seoReady() ? await blogKeywords({ services, city: p.city, state: p.state }) : []; } catch { keywords = seo.keywords || []; }
      seo.keywords = keywords; seo.keywords_at = iso(Date.now());
    }
    const used = new Set(seo.used || []);
    const pick = keywords.find(k => !used.has(k.keyword));
    await db.insert('jobs', [{ deal_id: deal.id, type: 'blog', input: pick ? { keyword: pick.keyword, volume: pick.volume } : {} }]);
    await touch(deal, { seo: { ...seo, used: pick ? [...(seo.used || []), pick.keyword] : seo.used || [] } }, 'article queued' + (pick ? ': ' + pick.keyword : ''));
    out.push(`${p.name}: article queued`);
  }
  const month = new Date().toISOString().slice(0, 7);
  const r = deal.reminders || {};
  if (r.report !== month && ageDays(deal.growth_since) > 20 && new Date().getUTCDate() <= 3) {
    const since = iso(Date.now() - 31 * DAY);
    const leads = await db.count('site_leads', { deal_id: deal.id, created_at: ['gte', since] });
    const posts = (seo.published || []).filter(x => Date.parse(x.at) > Date.parse(since));
    await touch(deal, { reminders: { ...r, report: month } });
    await queue({ deal, prospect: p, kind: 'report', body:
`Here's your site's month.

Enquiries from your contact form: ${leads}
New articles published: ${posts.length}${posts.length ? '\n' + posts.map(x => `- ${x.title} (https://${deal.domain}${x.path || ''})`).join('\n') : ''}

Anything you'd like changed or added this month, just reply.

${sig(product)}` });
    out.push(`${p.name}: monthly report`);
  }
  return out;
}

// ---- The stage checks the agency tick runs ---------------------------------------------------
export async function stageChecks({ timeLeft = () => 99999 } = {}) {
  const log = [];
  const deals = await db.select('deals', { filters: { stage: ['in', ['intake', 'owner_check', 'domain', 'live']], needs_human: false }, order: 'updated_at.asc', limit: 40 });
  for (const deal of deals) {
    if (timeLeft() < 5000) break;
    const p = await db.one('prospects', { id: deal.prospect_id });
    const product = await getProduct(deal.product_id);
    try {
      if (deal.stage === 'intake' && !deal.intake_at) {
        const days = ageDays(deal.paid_at), r = deal.reminders || {};
        if (days > 5) {
          await touch(deal, { intake: { ...(deal.intake || {}), auto: true } }, 'no details form after 5 days: building from what we have');
          await startBuild(deal);
          await queue({ deal, prospect: p, kind: 'reply', body: `So your site isn't held up, we've started building it with the details from your current site and Google profile. You'll get a link to review it, and you can change anything then.\n\n${sig(product)}` });
          log.push(`${p.name}: building without the form`);
        } else if (days > 2 && !r.intake1) {
          await touch(deal, { reminders: { ...r, intake1: iso(Date.now()) } });
          await queue({ deal, prospect: p, kind: 'reply', body: `A quick reminder: once you send the short details form, we start building your site. {{INTAKE_LINK}}\n\nIf you're short on time, reply "use what you have" and we'll start from your current site.\n\n${sig(product)}` });
          log.push(`${p.name}: form reminder`);
        }
      } else if (deal.stage === 'domain') {
        const r = await checkDomain(deal, p, product);
        if (r) log.push(`${p.name}: ${r}`);
      } else if (deal.stage === 'live' && deal.growth_status === 'active') {
        log.push(...await growthWork(deal, p, product));
      }
    } catch (e) { log.push(`${p.name}: ${e.message}`); }
  }
  return log;
}

// ---- Enquiries from client sites ---------------------------------------------------------------
export async function siteLead(deal, f) {
  const today = iso(Date.now() - DAY);
  if ((await db.count('site_leads', { deal_id: deal.id, created_at: ['gte', today] })) >= 30) return { ok: false, reason: 'too many today' };
  const clean = v => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const lead = { deal_id: deal.id, name: clean(f.name), email: clean(f.email), phone: clean(f.phone), message: String(f.message || '').trim().slice(0, 4000), page: clean(f.page) };
  if (!lead.message && !lead.phone && !lead.email) return { ok: false, reason: 'empty' };
  await db.insert('site_leads', [lead]);
  const p = await db.one('prospects', { id: deal.prospect_id });
  const to = deal.intake?.enquiry_email || deal.customer_email || p.email;
  await queue({ deal, prospect: p, kind: 'lead', to, replyTo: lead.email, subject: `New enquiry from your website: ${lead.name || lead.phone || lead.email}`, body:
`New enquiry from ${deal.domain || 'your website'}${lead.page ? ` (${lead.page})` : ''}:

Name: ${lead.name || '-'}
Email: ${lead.email || '-'}
Phone: ${lead.phone || '-'}

${lead.message || ''}

Reply to ${lead.email || 'them'} directly to answer.` });
  return { ok: true };
}

export { PAID };
