// Who decides: the owner or founder named on the business's own website, and their email address.
// Reads the home page plus up to three of the site's own people pages (about, team, studio, contact).
// Pure parsing functions are exported for tests; findOwner() does the fetching.
import { fetchPage, readSignals } from './scan.mjs';
import { domainOf, isGeneric } from './clean.mjs';

// Rank 0 = owns or runs the business; rank 1 = senior, worth writing to when no owner is named.
const TITLES = [
  [0, /\b(co-?founder|founder|owner|proprietor|principal|ceo|chief executive( officer)?|managing director|managing partner|president|studio (director|head)|head of studio)\b/i],
  [1, /\b(creative director|executive creative director|design director|executive producer|art director|partner|director)\b/i],
];
const NOT_PERSON = new Set(('our the meet team studio creative design about contact services service work works get let we us you your ' +
  'founder founders owner director partner partners principal president client clients agency company home news blog case studies ' +
  'brand branding digital web video motion production productions media group creative studio people careers hello why how what ' +
  'who where when new york san los las united states read more view all learn more privacy policy terms cookie cookies all rights reserved ' +
  'senior junior designer designers developer manager lead head producer editor strategist coordinator assistant associate intern account art executive chief officer marketing project operations animator illustrator copywriter photographer writer engineer specialist ' +
  'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december')
  .split(' '));
const PAST = /\b(former|formerly|late|past|retired|founding member|in memory)\b/i;
const NAME = "[A-Z][a-z'’-]+(?:\\s(?:[A-Z]\\.|[A-Z][a-z'’-]+)){1,2}";
const T_ALL = TITLES.map(([, rx]) => rx.source.replace(/^\\b\(|\)\\b$/g, '')).join('|');
const TITLE_START = new RegExp(`^(?:${T_ALL})\\b`, 'i');
const TITLE_END = new RegExp(`\\b((?:${T_ALL})(?:\\s*(?:&|and|\\/)\\s*(?:${T_ALL}))?)\\s*[,:]?\\s*$`, 'i');
const words = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'studio', 'design', 'agency', 'creative', 'inc', 'llc', 'ltd', 'co'].includes(w));
const sameBusiness = (a, b) => { const x = new Set(words(b)); return words(a).some(w => x.has(w)); };
const PEOPLE_LINK = /\b(about|team|people|studio|who[- ]we[- ]are|our[- ]story|founders?|leadership|contact|meet)\b/i;

const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

export function looksLikeName(s) {
  const t = String(s || '').trim();
  if (!new RegExp(`^${NAME}$`).test(t)) return false;
  const words = t.split(/\s+/);
  return !words.some(w => NOT_PERSON.has(w.toLowerCase().replace(/[^a-z]/g, '')));
}

export function titleRank(s) {
  if (!s || PAST.test(s)) return null;
  for (const [rank, rx] of TITLES) if (rx.test(s)) return rank;
  return null;
}

// Text blocks in reading order, with testimonials, quotes, nav, footer and scripts removed.
export function blocksOf(html) {
  const body = String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<(div|section|li|article)[^>]*class=["'][^"']*(testimonial|review|quote|client-say)[^"']*["'][\s\S]*?<\/\1>/gi, ' ');
  return body.split(/<\/?(?:h[1-6]|p|li|div|span|br|td|th|strong|b|em|figcaption|dt|dd|a|section|article)\b[^>]*>/i)
    .map(b => decode(b.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(b => b && b.length < 400);
}

function fromJsonLd(html) {
  const out = [];
  const add = (o, fallbackTitle) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(x => add(x, fallbackTitle));
    if (o['@type'] && !/person/i.test([].concat(o['@type']).join(' '))) return;
    const name = String(o.name || '').trim(), title = String(o.jobTitle || fallbackTitle || '').trim();
    if (looksLikeName(name)) out.push({ name, title, how: 'schema.org' });
  };
  for (const m of String(html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of [].concat(data, data?.['@graph'] || [])) {
      if (!node || typeof node !== 'object' || /article|blogposting|review/i.test([].concat(node['@type'] || '').join(' '))) continue;
      add(node.founder, 'Founder'); add(node.founders, 'Founder'); add(node.employee, ''); add(node.employees, '');
    }
  }
  return out;
}

// Named people with a title, from one page.
export function readPeople(html, businessName = '') {
  const found = [...fromJsonLd(html)];
  const blocks = blocksOf(html);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // A card: the name alone in one block, the title in the next (or the one before).
    if (looksLikeName(b)) {
      const t = blocks[i + 1];
      if (t && t.length <= 80 && titleRank(t) !== null && !looksLikeName(t)) found.push({ name: b, title: t, how: 'card' });
    }
    if (PAST.test(b) || /[“”"]/.test(b)) continue; // a quote or a former owner, not a current person
    for (const m of b.matchAll(new RegExp(NAME, 'g'))) {
      // "Founder Jane Park" matches as one run of capitals: drop leading words until a name is left.
      let name = m[0], idx = m.index;
      while (!looksLikeName(name) && name.includes(' ')) { const cut = name.indexOf(' ') + 1; idx += cut; name = name.slice(cut); }
      if (!looksLikeName(name)) continue;
      const before = b.slice(Math.max(0, idx - 70), idx);
      const after = b.slice(idx + name.length, idx + name.length + 80);
      if (/[—–-]\s*$/.test(before)) continue; // "— Mark Lee, Founder at X" is a quote's attribution
      let title = null;
      const a = after.match(/^\s*(?:[,–—|(:]|-\s|is\s+(?:the\s+|our\s+)?)\s*(?:our\s+|the\s+)?([^.;)|\n]{2,60})/i);
      if (a && TITLE_START.test(a[1])) {
        const at = a[1].match(/\b(?:at|of)\s+(.+)$/i);
        if (!(at && businessName && !sameBusiness(at[1], businessName))) title = a[1].trim();
      }
      if (!title) { const t = before.match(TITLE_END); if (t) title = t[1]; }
      if (!title && /\b(?:founded|started|owned(?: and (?:run|operated))?|run|led)\s+by\s*$/i.test(before)) title = 'Founder';
      if (!title && /^\s+(?:founded|started)\s+(?:the\s+)?(?:studio|agency|company|[A-Z])/.test(after)) title = 'Founder';
      if (title) found.push({ name, title, how: 'text' });
    }
  }
  // One entry per person, keeping their best title.
  const by = new Map();
  for (const p of found) {
    const rank = titleRank(p.title);
    if (rank === null) continue;
    const key = p.name.toLowerCase();
    const cur = by.get(key);
    if (!cur || rank < cur.rank) by.set(key, { ...p, rank });
  }
  return [...by.values()];
}

// Links to the site's own people pages, best first, at most `max`.
export function peopleLinks(html, baseUrl, max = 3) {
  const base = new URL(baseUrl);
  const seen = new Set([base.origin + base.pathname.replace(/\/$/, '')]);
  const out = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = decode(m[2].replace(/<[^>]+>/g, ' ')).trim();
    let u; try { u = new URL(m[1], base); } catch { continue; }
    if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
    if (!PEOPLE_LINK.test(`${label} ${u.pathname}`) || /\.(pdf|jpe?g|png|zip)$/i.test(u.pathname)) continue;
    const key = u.origin + u.pathname.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const prio = /team|people|founder|leadership|meet|who/i.test(`${label} ${u.pathname}`) ? 0 : /about|story|studio/i.test(`${label} ${u.pathname}`) ? 1 : 2;
    out.push({ url: u.toString(), prio });
  }
  return out.sort((a, b) => a.prio - b.prio).slice(0, max).map(x => x.url);
}

const ascii = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function parts(name) {
  const w = name.split(/\s+/).filter(x => !/^[A-Z]\.$/.test(x)).map(ascii);
  const first = w[0], last = w[w.length - 1];
  if (!first || !last || first === last || !/^[a-z]+$/.test(first) || !/^[a-z'-]+$/.test(last)) return null;
  return { first, last: last.replace(/['-]/g, '') };
}
const PATTERNS = {
  first: p => p.first, 'first.last': p => `${p.first}.${p.last}`, firstlast: p => p.first + p.last, flast: p => p.first[0] + p.last,
  'f.last': p => `${p.first[0]}.${p.last}`, firstl: p => p.first + p.last[0], first_last: p => `${p.first}_${p.last}`, last: p => p.last,
};

// The owner and the best address for them. source: published | pattern | guess | none.
export function chooseOwner({ people, emails, website, businessName = '' }) {
  if (!people.length) return null;
  const domain = domainOf(website);
  const named = people.map(p => ({ ...p, parts: parts(p.name) }));
  const inName = p => p.parts && ascii(`${businessName} ${domain}`).includes(p.parts.last);
  named.sort((a, b) => a.rank - b.rank || Number(inName(b)) - Number(inName(a)));
  const owner = named[0];
  const result = { name: owner.name, title: owner.title, email: '', source: 'none' };
  if (!owner.parts || !domain) return result;
  const own = emails.map(e => e.toLowerCase()).filter(e => e.endsWith('@' + domain) && !isGeneric(e));
  const locals = own.map(e => e.split('@')[0]);
  // 1. Their own address, printed on the site.
  for (const [, make] of Object.entries(PATTERNS)) {
    const l = make(owner.parts);
    if (locals.includes(l)) return { ...result, email: `${l}@${domain}`, source: 'published' };
  }
  // 2. The pattern another named person's printed address shows.
  const others = named.filter(p => p !== owner && p.parts);
  for (const p of others) {
    for (const [pat, make] of Object.entries(PATTERNS)) {
      if (pat === 'first' && p.parts.first.length < 3) continue;
      if (!locals.includes(make(p.parts))) continue;
      const l = PATTERNS[pat](owner.parts);
      // Never guess an address another named person could own.
      if (others.some(o => Object.values(PATTERNS).some(f => f(o.parts) === l))) return result;
      return { ...result, email: `${l}@${domain}`, source: 'pattern', pattern: pat };
    }
  }
  // 3. No evidence: small studios mostly use first@.
  const l = PATTERNS.first(owner.parts);
  if (others.some(o => o.parts.first === owner.parts.first)) return result;
  return { ...result, email: `${l}@${domain}`, source: 'guess', pattern: 'first' };
}

// Fetches the people pages and returns { owner, pages } or { owner: null }. Stops early near the deadline.
export async function findOwner({ homeUrl, homeHtml, homeEmails = [], website, businessName, deadline = Date.now() + 4000 }) {
  const links = peopleLinks(homeHtml, homeUrl);
  const people = readPeople(homeHtml, businessName);
  const emails = new Set(homeEmails);
  const left = deadline - Date.now();
  if (links.length && left > 1200) {
    const pages = await Promise.allSettled(links.map(u => fetchPage(u, { timeout: Math.min(4000, left - 200), maxBytes: 500_000 })));
    for (const r of pages) {
      if (r.status !== 'fulfilled') continue;
      people.push(...readPeople(r.value.html, businessName));
      readSignals(r.value.html).emails.forEach(e => emails.add(e));
    }
  }
  const merged = new Map();
  for (const p of people) { const k = p.name.toLowerCase(); if (!merged.has(k) || p.rank < merged.get(k).rank) merged.set(k, p); }
  return { owner: chooseOwner({ people: [...merged.values()], emails: [...emails], website, businessName }), pages: links.length };
}
