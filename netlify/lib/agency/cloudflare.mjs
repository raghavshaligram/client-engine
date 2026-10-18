// Cloudflare Pages: attach the client's domain to their site's project and watch it go live.
// Needs CF_ACCOUNT_ID and CF_API_TOKEN (a token with "Cloudflare Pages: Edit").
import dns from 'node:dns';

export const cfReady = () => !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN);

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/pages/projects/${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    const msg = (data.errors || []).map(e => e.message).join('; ') || 'Cloudflare ' + res.status;
    if (/already (exists|added)|in use by this project/i.test(msg)) return { already: true };
    throw new Error(msg);
  }
  return data.result;
}

export const addDomain = (project, name) => cf('POST', `${encodeURIComponent(project)}/domains`, { name });
export async function domainStatus(project, name) {
  const r = await cf('GET', `${encodeURIComponent(project)}/domains/${encodeURIComponent(name)}`);
  return r?.status || 'unknown';
}

// example.com, https://www.example.com/page -> { apex: 'example.com', host: 'www.example.com' }
export function siteHost(input) {
  let h = String(input || '').trim().toLowerCase();
  try { h = new URL(/^https?:\/\//.test(h) ? h : 'https://' + h).hostname; } catch { return null; }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return null;
  const apex = h.replace(/^www\./, '');
  return { apex, host: 'www.' + apex };
}

const HOSTS = [
  [/domaincontrol\.com/, 'GoDaddy', 'https://www.godaddy.com/help/manage-dns-records-680'],
  [/registrar-servers\.com/, 'Namecheap', 'https://www.namecheap.com/support/knowledgebase/article.aspx/434/2237/how-do-i-set-up-host-records-for-a-domain/'],
  [/wixdns\.net/, 'Wix', 'https://support.wix.com/en/article/adding-or-updating-cname-records-in-your-wix-account'],
  [/squarespacedns|googledomains/, 'Squarespace Domains', 'https://support.squarespace.com/hc/en-us/articles/360002101888'],
  [/cloudflare\.com/, 'Cloudflare', 'https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/'],
  [/awsdns/, 'Amazon Route 53', ''],
  [/worldnic\.com/, 'Network Solutions', ''],
  [/bluehost\.com/, 'Bluehost', ''],
  [/hostgator\.com/, 'HostGator', ''],
  [/ui-dns\./, 'IONOS', ''],
  [/dreamhost\.com/, 'DreamHost', ''],
  [/siteground\.net/, 'SiteGround', ''],
  [/hover\.com/, 'Hover', ''],
  [/porkbun\.com/, 'Porkbun', ''],
  [/weebly\.com/, 'Weebly', ''],
  [/name-services\.com|enom/, 'eNom', ''],
];

export async function dnsHost(apex) {
  try {
    const ns = (await dns.promises.resolveNs(apex)).join(' ').toLowerCase();
    const hit = HOSTS.find(([rx]) => rx.test(ns));
    return hit ? { name: hit[1], help: hit[2], ns } : { name: '', help: '', ns };
  } catch { return { name: '', help: '', ns: '' }; }
}

export async function cnameOf(host) {
  try { return (await dns.promises.resolveCname(host)).map(s => s.toLowerCase()); } catch { return []; }
}
