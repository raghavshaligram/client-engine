// Conversations (from Launch Radar): find people asking for help on Reddit, X, LinkedIn, Hacker News,
// Bluesky and forums, draft a reply in your voice, and track which replies bring clicks, signups and sales.
// It never posts. You post each reply yourself.
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { grok, parseJSON, getUsage } from './xai.mjs';

export const PLATFORMS = ['reddit', 'forums', 'x', 'linkedin', 'hn', 'bluesky'];
export const PLATFORM_LABEL = { x: 'X', reddit: 'Reddit', linkedin: 'LinkedIn', forums: 'Forums', hn: 'Hacker News', bluesky: 'Bluesky' };

export const RADAR_DEFAULT_SETTINGS = {
  scanEveryHours: 6, dailyCapPerPlatform: 10, minScore: 70, lookbackDays: 3,
  monthlyXPostLimit: 3000, monthlyWebSearchLimit: 600, model: 'grok-4.7',
  bannedPhrases: ['game-changer', 'revolutionize', 'seamless', 'unlock', 'elevate', 'leverage', 'delve', "in today's fast-paced"],
};

const iso = d => new Date(d).toISOString();
const sha = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
const slugId = (n = 8) => { const a = 'abcdefghijkmnopqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(n), b => a[b % a.length]).join(''); };

export async function radarSettings() {
  const s = (await db.one('settings', { key: 'radar.settings' }))?.value || {};
  return { ...RADAR_DEFAULT_SETTINGS, ...s };
}
export async function saveRadarSettings(patch) {
  const cur = await radarSettings();
  const n = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : d));
  const value = {
    ...cur,
    scanEveryHours: n(patch.scanEveryHours ?? cur.scanEveryHours, 1, 48, 6),
    dailyCapPerPlatform: n(patch.dailyCapPerPlatform ?? cur.dailyCapPerPlatform, 1, 50, 10),
    minScore: n(patch.minScore ?? cur.minScore, 40, 95, 70),
    lookbackDays: n(patch.lookbackDays ?? cur.lookbackDays, 1, 14, 3),
    monthlyXPostLimit: n(patch.monthlyXPostLimit ?? cur.monthlyXPostLimit, 0, 100000, 3000),
    monthlyWebSearchLimit: n(patch.monthlyWebSearchLimit ?? cur.monthlyWebSearchLimit, 0, 20000, 600),
    model: String(patch.model ?? cur.model).trim() || 'grok-4.7',
    bannedPhrases: Array.isArray(patch.bannedPhrases) ? patch.bannedPhrases.map(String).filter(Boolean).slice(0, 60) : cur.bannedPhrases,
  };
  await db.upsert('settings', [{ key: 'radar.settings', value, updated_at: iso(Date.now()) }], 'key');
  return value;
}

// A Client Engine product, seen the way the Conversations search needs it.
export function projectOf(p) {
  const r = p.radar || {};
  const first = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
  return {
    id: p.id, name: p.name, url: p.site,
    oneLiner: first(p.proof)[0] || '', problem: first(p.pains).join(' '), audience: p.buyer || '',
    proof: p.proof || '', neverSay: p.never_say || '',
    competitors: r.competitors || [], keywords: r.keywords || [], subreddits: r.subreddits || [],
    forumDomains: r.forumDomains || [], sources: r.sources || {}, voiceSamples: r.voice || '',
  };
}

// ---- Search ---------------------------------------------------------------------
export function rotateKeywords(keywords, n, seed = Math.floor(Date.now() / 3_600_000)) {
  const list = keywords.filter(Boolean);
  if (list.length <= n) return list;
  const start = (seed * n) % list.length;
  return Array.from({ length: n }, (_, i) => list[(start + i) % list.length]);
}
const daysAgo = d => iso(Date.now() - d * 86_400_000).slice(0, 10);

function brief(p) {
  return [`Product: ${p.name} (${p.url})`, p.oneLiner && `What it does: ${p.oneLiner}`, p.problem && `Problem it solves: ${p.problem}`,
    p.audience && `Who it's for: ${p.audience}`, p.competitors.length && `Alternatives people use today: ${p.competitors.join(', ')}`].filter(Boolean).join('\n');
}

const LEAD_RULES = `A good lead is a real person who, in this post, does at least one of:
- describes the exact problem the product solves, in their own words
- asks for a tool, app, or recommendation in this space
- complains about a competitor or a workaround they are stuck with
Score 0-100 for how likely a short, genuinely helpful reply from the maker would be welcome and lead to them trying the product.
90+: explicitly asking for a tool like this. 70-89: clearly has the problem now. Below 70: tangential, old, or just discussing the topic.
Exclude: companies or founders promoting their own products, job posts, bots, giveaways, news/link shares with no personal need, and anything from the product's own accounts.`;

const OUTPUT_SHAPE = `Return ONLY JSON, no commentary:
{"leads":[{"url":"<direct link to the post or comment>","author":"<handle or username>","text":"<the post text, max 500 chars>","posted_at":"<YYYY-MM-DD if known>","score":<0-100>,"reason":"<one short sentence: why this person needs the product>"}]}
Only include posts you actually found through search, with their real URLs. Never invent posts. If nothing qualifies, return {"leads":[]}.`;

function toCandidates(platform, text, urlTest) {
  const parsed = parseJSON(text);
  const list = Array.isArray(parsed) ? parsed : parsed?.leads || [];
  return list.filter(l => typeof l.url === 'string' && /^https?:\/\//.test(l.url) && (() => { try { return urlTest(l.url); } catch { return false; } })())
    .map(l => ({
      platform, url: l.url.split('#')[0], author: String(l.author || '').replace(/^@/, '').replace(/^u\//, '').slice(0, 80),
      text: String(l.text || '').slice(0, 800), postedAt: l.posted_at, score: Math.max(0, Math.min(100, Number(l.score) || 0)), reason: String(l.reason || '').slice(0, 240),
    }));
}

async function searchX(p, s) {
  const kws = rotateKeywords(p.keywords, 6);
  const res = await grok({
    model: s.model, maxTurns: 3, tools: [{ type: 'x_search', from_date: daysAgo(s.lookbackDays) }],
    system: `You find warm leads on X for an indie maker. Be strict: precision matters more than volume.\n${LEAD_RULES}\n${OUTPUT_SHAPE}`,
    user: `${brief(p)}\n\nSearch X for recent posts by people who need this. Try phrasings like: ${kws.map(k => `"${k}"`).join(', ')}. Prefer Latest results. Return up to 15 leads with post URLs in the form https://x.com/<handle>/status/<id>.`,
  });
  return toCandidates('x', res.text, u => /(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(u));
}

const FORUM_DEFAULTS = ['indiehackers.com', 'quora.com', 'producthunt.com', 'stackexchange.com', 'dev.to'];
const WEB = {
  reddit: { label: 'Reddit', domains: () => ['reddit.com'], test: u => /reddit\.com\/r\/[^/]+\/comments\//.test(u),
    hint: p => `Find Reddit threads (reddit.com/r/<sub>/comments/...) where the original poster or a commenter needs this.${p.subreddits.length ? ` Look first in: ${p.subreddits.map(s => 'r/' + s).join(', ')}.` : ''}` },
  linkedin: { label: 'LinkedIn', domains: () => ['linkedin.com'], test: u => /linkedin\.com\/(posts|feed\/update)\//.test(u),
    hint: () => 'Find public LinkedIn posts (linkedin.com/posts/...) where the author describes this problem or asks for a tool.' },
  forums: { label: 'forums', domains: p => (p.forumDomains.length ? p.forumDomains : FORUM_DEFAULTS).slice(0, 5),
    test: (u, p) => { const h = new URL(u).hostname.replace(/^www\./, ''); return WEB.forums.domains(p).some(d => h === d || h.endsWith('.' + d)); },
    hint: () => 'Find forum threads and Q&A questions where someone needs this.' },
};

async function searchWeb(kind, p, s) {
  const t = WEB[kind];
  const kws = rotateKeywords(p.keywords, 5);
  const res = await grok({
    model: s.model, maxTurns: 3, tools: [{ type: 'web_search', filters: { allowed_domains: t.domains(p) } }],
    system: `You find warm leads on ${t.label} for an indie maker. Be strict: precision matters more than volume.\n${LEAD_RULES}\nOnly include posts from the last 30 days when you can tell the date; skip anything clearly older than 60 days.\n${OUTPUT_SHAPE}`,
    user: `${brief(p)}\n\n${t.hint(p)} Useful search phrasings: ${kws.map(k => `"${k}"`).join(', ')}. Return up to 10 leads.`,
  });
  return toCandidates(kind, res.text, u => t.test(u, p));
}

const stripHtml = h => String(h).replace(/<p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();

async function searchHN(p, s) {
  const since = Math.floor(Date.now() / 1000) - Math.max(s.lookbackDays, 3) * 86_400;
  const out = new Map();
  for (const kw of rotateKeywords(p.keywords, 5)) {
    try {
      const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(kw)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=15`);
      if (!r.ok) continue;
      for (const h of (await r.json()).hits || []) {
        const text = stripHtml([h.title, h.story_text, h.comment_text].filter(Boolean).join('\n'));
        if (text.length < 40) continue;
        const link = `https://news.ycombinator.com/item?id=${h.objectID}`;
        out.set(link, { platform: 'hn', url: link, author: h.author || '', text: text.slice(0, 800), postedAt: String(h.created_at || '').slice(0, 10) });
      }
    } catch {}
  }
  return [...out.values()].slice(0, 40);
}

async function searchBluesky(p, s) {
  const handle = process.env.BSKY_HANDLE, password = process.env.BSKY_APP_PASSWORD;
  if (!handle || !password) throw new Error('Bluesky needs BSKY_HANDLE and BSKY_APP_PASSWORD');
  const sess = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: handle, password }) });
  if (!sess.ok) throw new Error(`Bluesky login failed (${sess.status})`);
  const { accessJwt } = await sess.json();
  const since = iso(Date.now() - Math.max(s.lookbackDays, 2) * 86_400_000);
  const out = new Map();
  for (const kw of rotateKeywords(p.keywords, 5)) {
    try {
      const r = await fetch(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(kw)}&sort=latest&limit=25&since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${accessJwt}` } });
      if (!r.ok) continue;
      for (const post of (await r.json()).posts || []) {
        const rkey = String(post.uri || '').split('/').pop(), h = post.author?.handle;
        if (!rkey || !h) continue;
        const link = `https://bsky.app/profile/${h}/post/${rkey}`;
        out.set(link, { platform: 'bluesky', url: link, author: h, text: String(post.record?.text || '').slice(0, 800), postedAt: String(post.record?.createdAt || '').slice(0, 10) });
      }
    } catch {}
  }
  return [...out.values()].slice(0, 40);
}

async function scoreCandidates(p, s, list) {
  const scored = [];
  for (let i = 0; i < list.length; i += 30) {
    const batch = list.slice(i, i + 30);
    const res = await grok({
      model: s.model,
      system: `You judge whether social posts are warm leads for an indie maker.\n${LEAD_RULES}\nReturn ONLY JSON: {"scores":[{"i":<index>,"score":<0-100>,"reason":"<one short sentence>"}]} covering every index.`,
      user: `${brief(p)}\n\nPosts:\n${batch.map((c, j) => `[${j}] @${c.author}: ${c.text.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n')}`,
    });
    for (const sc of parseJSON(res.text)?.scores || []) {
      const c = batch[sc.i];
      if (c) scored.push({ ...c, score: Math.max(0, Math.min(100, Number(sc.score) || 0)), reason: String(sc.reason || '') });
    }
  }
  return scored;
}

async function fetchSource(platform, p, s) {
  if (platform === 'x') return searchX(p, s);
  if (platform === 'hn') return scoreCandidates(p, s, await searchHN(p, s));
  if (platform === 'bluesky') return scoreCandidates(p, s, await searchBluesky(p, s));
  return searchWeb(platform, p, s);
}

function overBudget(platform, u, s) {
  if (platform === 'x' && u.xPostsFetched >= s.monthlyXPostLimit) return `monthly X post limit reached (${u.xPostsFetched}/${s.monthlyXPostLimit})`;
  if (['reddit', 'linkedin', 'forums'].includes(platform) && u.webSearchCalls >= s.monthlyWebSearchLimit) return `monthly web search limit reached (${u.webSearchCalls}/${s.monthlyWebSearchLimit})`;
  return null;
}

// ---- Drafting ---------------------------------------------------------------------
const STYLE = {
  x: 'X reply. Max 240 characters including the link. Casual, lowercase is fine, no hashtags, no emoji spam.',
  bluesky: 'Bluesky reply. Max 240 characters including the link. Casual and friendly.',
  reddit: 'Reddit comment. 2-5 sentences, plain text. Lead with real help (a tip, an approach, what worked). Only include the link if the poster is explicitly asking for tools; otherwise set include_link false. If you mention the product, say you built it.',
  hn: 'Hacker News comment. 2-4 sentences, understated, technical, zero marketing tone. Only link if they ask for tools, and disclose you made it.',
  linkedin: 'LinkedIn comment. 2-4 sentences, warm and professional. Add value first; mention the product lightly with the link only if it clearly fits.',
  forums: 'Forum or Q&A answer. 3-6 sentences that genuinely answer the question, then mention the product (disclosing you built it) with the link if relevant.',
};

export async function draftReplies(p, s, leads, note) {
  const out = new Map();
  for (let i = 0; i < leads.length; i += 8) {
    const batch = leads.slice(i, i + 8);
    const res = await grok({
      model: s.model,
      system: `You write replies that an indie maker will post personally under their own name. The goal is to genuinely help the person; the product is mentioned only where it truly fits.
Rules:
- Sound like the maker (voice samples below). Specific, human, brief. No sales pitch, no "Great question!", no exclamation stacks, no em dashes.
- Never claim anything the product facts below don't support. Never invent customers, numbers or results. If you mention the product, make it clear the writer built it ("I built…", "I made…").
- Respect the NEVER SAY list.
- Where the tracked link belongs, write the placeholder {{LINK}} exactly once. If a link would feel pushy for this post, leave it out and set include_link false.
- Never use these words or phrases: ${s.bannedPhrases.join(', ') || '(none)'}.
- Follow the per-platform style given for each post.
Return ONLY JSON: {"replies":[{"i":<index>,"reply":"<text>","include_link":<true|false>}]}`,
      user: `Product:\nName: ${p.name}\nWhat it does: ${p.oneLiner}\nProblem: ${p.problem}\nAudience: ${p.audience}\nWhat is true about it:\n${p.proof}\nNEVER SAY:\n${p.neverSay}\n\nThe maker's voice samples:\n${p.voiceSamples || '(none given; write plainly and casually)'}${note ? `\n\nExtra instruction for this reply: ${note}` : ''}\n\nPosts to reply to:\n${batch
        .map((l, j) => `[${j}] Platform style: ${STYLE[l.platform]}\nAuthor: @${l.author}\nPost: ${l.text.replace(/\s+/g, ' ').slice(0, 600)}\nWhy it's a lead: ${l.reason}`).join('\n\n')}`,
    });
    for (const r of parseJSON(res.text)?.replies || []) {
      const lead = batch[r.i];
      if (!lead || !r.reply) continue;
      let draft = String(r.reply).trim().replace(/\s*[—–]\s*/g, ', ');
      const wants = !!r.include_link;
      if (!wants) draft = draft.replace(/\s*\{\{LINK\}\}\s*/g, ' ').trim();
      else if (!draft.includes('{{LINK}}')) draft = `${draft} {{LINK}}`;
      out.set(lead.id, { draft, linkIncluded: wants });
    }
  }
  return out;
}

// ---- Scanning ------------------------------------------------------------------------
export async function scanStatus() {
  return (await db.one('settings', { key: 'radar.scan' }))?.value || { running: false, log: [] };
}
async function setStatus(fn) {
  const value = fn(await scanStatus());
  await db.upsert('settings', [{ key: 'radar.scan', value, updated_at: iso(Date.now()) }], 'key');
  return value;
}
const log = line => setStatus(s => ({ ...s, log: [...(s.log || []), `${iso(Date.now()).slice(11, 19)} ${line}`].slice(-80) }));

export async function startScan(trigger) {
  const s = await scanStatus();
  if (s.running && s.startedAt && Date.now() - Date.parse(s.startedAt) < 15 * 60_000) return false;
  await setStatus(() => ({ running: true, startedAt: iso(Date.now()), trigger, log: [] }));
  return true;
}
export const finishScan = err => setStatus(s => ({ ...s, running: false, finishedAt: iso(Date.now()), error: err || null }));

export function trackedTarget(url, slug) {
  try { const u = new URL(url); u.searchParams.set('ref', `ce_${slug}`); return u.toString(); } catch { return url; }
}

export async function scanProduct(product, s, only, carry = null) {
  const p = projectOf(product);
  const platforms = PLATFORMS.filter(k => p.sources[k] && (!only || only.includes(k)));
  const fresh = [], summary = [];
  for (const platform of platforms) {
    const blocked = overBudget(platform, await getUsage(), s);
    if (blocked) { await log(`${p.name} · ${PLATFORM_LABEL[platform]}: skipped, ${blocked}`); continue; }
    try {
      const found = await fetchSource(platform, p, s);
      const urls = [...new Set(found.map(c => c.url))];
      const seenRows = urls.length ? await db.insertIgnore('radar_seen', urls.map(url => ({ url, product_id: p.id })), 'url') : [];
      const unseen = new Set(seenRows.map(r => r.url)); // posts this app has never looked at before
      const keep = [];
      for (const c of found) {
        if (!unseen.has(c.url)) continue;
        unseen.delete(c.url); // once per post, even if a source returns it twice
        if ((c.score ?? 0) >= s.minScore) keep.push(c);
      }
      for (const c of keep) fresh.push({
        id: sha(c.url), product_id: p.id, platform: c.platform, url: c.url, author: c.author, text: c.text, posted_at: c.postedAt || null,
        score: c.score ?? 0, reason: c.reason || '', status: 'new', draft: '', link_included: false, slug: slugId(),
      });
      summary.push(`${PLATFORM_LABEL[platform]} ${keep.length}`);
      await log(`${p.name} · ${PLATFORM_LABEL[platform]}: ${found.length} found, ${seenRows.length} new, ${keep.length} scored ${s.minScore}+`);
    } catch (e) { await log(`${p.name} · ${PLATFORM_LABEL[platform]}: error, ${String(e.message).slice(0, 160)}`); }
  }
  if (fresh.length) {
    try {
      const drafts = await draftReplies(p, s, fresh);
      for (const l of fresh) { const d = drafts.get(l.id); if (d) { l.draft = d.draft; l.link_included = d.linkIncluded; } }
      await log(`${p.name}: drafted ${drafts.size} repl${drafts.size === 1 ? "y" : "ies"}`);
    } catch (e) { await log(`${p.name}: drafting failed, ${String(e.message).slice(0, 160)}`); }
    for (const l of fresh) l.target = trackedTarget(p.url, l.slug);
    await db.insertIgnore('conversations', fresh, 'id');
  }
  // A scan done one site at a time (no background functions) carries its running totals between requests.
  const total = fresh.length + (carry?.added || 0), parts = [...(carry?.parts || []), ...summary];
  const radar = { ...(product.radar || {}), lastScanAt: iso(Date.now()), lastScanSummary: `${total} new lead${total === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}` };
  await db.update('products', { id: p.id }, { radar });
  if (carry) { carry.added = total; carry.parts = parts; }
  return fresh.length;
}

export async function runScan({ productId, platforms, trigger }) {
  const s = await radarSettings();
  const products = (await db.select('products', { order: 'id' })).filter(p => (productId ? p.id === productId : p.radar?.on) && !p.paused);
  if (!products.length) { await log('No product has Conversations switched on. Turn it on under Products.'); return 0; }
  let total = 0;
  for (const p of products) { await log(`Scanning ${p.name}…`); total += await scanProduct(p, s, platforms); }
  await log(`Done. ${total} new lead${total === 1 ? '' : 's'} in Conversations.`);
  return total;
}

export function scanDue(products, s, now = Date.now()) {
  const on = products.filter(p => p.radar?.on && !p.paused);
  if (!on.length) return false;
  const last = Math.min(...on.map(p => (p.radar?.lastScanAt ? Date.parse(p.radar.lastScanAt) : 0)));
  return now - last >= s.scanEveryHours * 3_600_000 - 5 * 60_000;
}

// One function calling another: an HMAC of APP_KEY, so only this site can start a background scan.
export const internalToken = () => crypto.createHmac('sha256', process.env.APP_KEY || 'x').update('radar-internal-scan').digest('base64url');
export function isInternal(req) {
  const t = req.headers.get('x-radar-internal') || '', want = internalToken();
  return t.length === want.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(want));
}
export const siteUrl = () => (process.env.URL || 'http://localhost:8888').replace(/\/$/, '');
