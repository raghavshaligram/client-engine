// The researcher's eyes: load a prospect's home page once and note what is on it.
import dns from 'node:dns';
import net from 'node:net';
import { splitEmails } from './clean.mjs';

function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l === '::') return true;
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? privateIp(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function safeUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw new Error('bad website address'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('not a web address');
  if (process.env.ALLOW_PRIVATE !== '1') {
    const addrs = await dns.promises.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('address points to a private network');
  }
  return u;
}

export async function fetchPage(raw, { timeout = 7000, maxBytes = 700_000 } = {}) {
  let url = await safeUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClientEngine/1.0; +one page view per site)', Accept: 'text/html,*/*;q=0.5' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = await safeUrl(new URL(res.headers.get('location'), url).toString());
        continue;
      }
      if (!res.ok) throw new Error(`site answered ${res.status}`);
      const reader = res.body.getReader();
      const chunks = []; let size = 0;
      while (size < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); size += value.length;
      }
      try { reader.cancel(); } catch {}
      return { url: url.toString(), html: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8') };
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'site took too long' : e.message);
    } finally { clearTimeout(t); }
  }
  throw new Error('too many redirects');
}

const decodeEntities = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const strip = s => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function cfDecode(hex) {
  const key = parseInt(hex.slice(0, 2), 16); let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const RX = {
  chat: /intercom|widget\.drift|js\.driftt|tawk\.to|livechatinc|crisp\.chat|tidio|podium|birdeye|smith\.ai|olark|zopim|zendesk.{0,40}(chat|widget)|leadconnectorhq|msgsndr|hubspot.{0,30}conversations|textus|webchat|chat-widget/i,
  chatWords: /\b(text us|chat with us|live chat)\b/i,
  booking: /calendly\.com|acuityscheduling|booksy|vagaro|squareup\.com\/appointments|housecallpro|getjobber|servicetitan|schedulicity|mindbody|zocdoc|setmore|simplybook|clio.{0,20}grow|lawmatics/i,
  bookingWords: /\b(book online|schedule online|book now|book an appointment|schedule (a |your )?service|request (an )?appointment|online booking)\b/i,
  tel: /href=["']tel:/i,
  crm: /gohighlevel|highlevel|leadconnector|white[- ]label|\bcrm\b|marketing automation/i,
  local: /local business|small business|local seo|contractors|home service|service business|plumbers|hvac/i,
  small: /family[- ]owned|owner[- ]operated|locally owned|solo practi|small (firm|team|business)|husband and wife|one-on-one/i,
  practice: /family law|divorce|child custody|immigration|personal injury|estate planning|probate|bankruptcy|criminal defense/gi,
};

export function readSignals(html) {
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const desc = decodeEntities((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || '');
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const heads = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => strip(m[1])).filter(Boolean).slice(0, 8);
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => strip(m[1])).filter(p => p.length > 40).slice(0, 8);
  const text = `${title} ${desc} ${strip(body)}`;
  const emails = new Set(splitEmails(text));
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) splitEmails(decodeURIComponent(m[1])).forEach(e => emails.add(e));
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) splitEmails(cfDecode(m[1])).forEach(e => emails.add(e));
  const practice = [...new Set((text.match(RX.practice) || []).map(s => s.toLowerCase()))];
  const signals = {
    chat: RX.chat.test(html) || RX.chatWords.test(text), booking: RX.booking.test(html) || RX.bookingWords.test(text), click_to_call: RX.tel.test(html),
    crm: RX.crm.test(text), serves_local: RX.local.test(text), small: RX.small.test(text), practice,
  };
  // A short, honest extract the writer may draw its one detail from. Nothing else.
  const site_text = [title, desc, ...heads, ...paras].filter(Boolean).join('\n').slice(0, 1800);
  return { signals, site_text, emails: [...emails] };
}

export async function scanSite(website) {
  const { url, html } = await fetchPage(website);
  return { url, ...readSignals(html) };
}
