// The website audit behind every agency email: what is actually wrong with a prospect's site.
// Two parts: cheap checks on the HTML we already downloaded, and Google PageSpeed (mobile).
// Every fact the writer may mention comes from here, with the real number attached.

const YEAR = () => new Date().getUTCFullYear();

const BUILDERS = [
  [/wix\.com|wixstatic|_wix/i, 'Wix'],
  [/squarespace/i, 'Squarespace'],
  [/godaddy|websites\.godaddy|img1\.wsimg\.com/i, 'GoDaddy Website Builder'],
  [/weebly/i, 'Weebly'],
  [/wp-content|wp-includes|wordpress/i, 'WordPress'],
  [/joomla/i, 'Joomla'],
  [/webflow/i, 'Webflow'],
  [/shopify/i, 'Shopify'],
  [/duda|dudaone|multiscreensite/i, 'Duda'],
  [/hibu/i, 'Hibu'],
  [/yola/i, 'Yola'],
  [/homestead/i, 'Homestead'],
];
const MODERN = /__next|_next\/static|data-reactroot|gatsby|nuxt|astro-island|webflow/i;

const abs = (src, base) => { try { return new URL(src.replace(/&amp;/g, '&'), base).toString(); } catch { return ''; } };

// Pure: everything we can learn from one HTML page.
export function htmlAudit(html, url) {
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0];
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
  const years = [...text.matchAll(/(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map(m => +m[1]).filter(y => y <= YEAR());
  const copyright = years.length ? Math.max(...years) : null;
  const since = (text.match(/\b(?:since|established|est\.?|founded in)\s+((?:19|20)\d{2})\b/i) || [])[1];
  const jq = (html.match(/jquery[.-]?(1\.\d+(?:\.\d+)?)(?:\.min)?\.js/i) || [])[1];
  const builder = (BUILDERS.find(([rx]) => rx.test(html)) || [])[1] || '';
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const imgSrc = t => (t.match(/\s(?:data-src|src)=["']([^"']+)["']/i) || [])[1] || '';
  const logoTag = imgs.find(t => /logo/i.test(t));
  const og = (head.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || [])[1];
  const photos = imgs.filter(t => !/logo|icon|sprite|pixel|badge|avatar|spinner|loader/i.test(t))
    .map(imgSrc).filter(s => s && !/^data:/.test(s) && /\.(jpe?g|png|webp)(\?|$)/i.test(s))
    .map(s => abs(s, url)).filter(Boolean);
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const contactForm = forms.some(f => /type=["']?(email|tel)|name=["']?(email|phone|message)/i.test(f));
  return {
    https: u ? u.protocol === 'https:' : null,
    viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    title: !!(head.match(/<title[^>]*>\s*[^<\s][^<]*<\/title>/i)),
    meta_description: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(head) || /<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(head),
    h1: /<h1[\s>]/i.test(html),
    schema: /"@type"\s*:\s*"(LocalBusiness|[A-Za-z]*(Business|Service|Contractor|Plumber|Electrician|Dentist|Attorney|Store|Restaurant|Salon|Clinic))"/i.test(html),
    contact_form: contactForm,
    copyright_year: copyright,
    since_year: since ? +since : null,
    builder,
    old_jquery: jq || '',
    table_layout: (html.match(/<table/gi) || []).length >= 4 && !/<(main|section|header|nav)\b/i.test(html),
    flash: /\.swf\b|shockwave/i.test(html),
    modern: MODERN.test(html),
    html_kb: Math.round(html.length / 1024),
    images: [...new Set([og && abs(og, url), ...photos].filter(Boolean))].slice(0, 12),
    logo: logoTag ? abs(imgSrc(logoTag), url) : '',
  };
}

// Google PageSpeed Insights, mobile. Slow (10-30 seconds), so the agency tick runs a few at a time.
export async function pageSpeed(url, { key = process.env.PSI_API_KEY, timeout = 24000 } = {}) {
  if (!key) return null;
  const q = new URLSearchParams({ url, strategy: 'mobile', key });
  for (const c of ['performance', 'seo', 'accessibility']) q.append('category', c);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + q, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error?.message || 'PageSpeed ' + res.status };
    const lh = data.lighthouseResult || {}, cat = lh.categories || {}, a = lh.audits || {};
    const pct = c => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : null);
    const ms = id => (a[id] && typeof a[id].numericValue === 'number' ? a[id].numericValue : null);
    return {
      performance: pct(cat.performance), seo: pct(cat.seo), accessibility: pct(cat.accessibility),
      lcp_s: ms('largest-contentful-paint') != null ? Math.round(ms('largest-contentful-paint') / 100) / 10 : null,
      cls: ms('cumulative-layout-shift') != null ? Math.round(ms('cumulative-layout-shift') * 100) / 100 : null,
      tap_targets_ok: a['tap-targets'] ? a['tap-targets'].score === 1 : null,
      font_size_ok: a['font-size'] ? a['font-size'].score === 1 : null,
      checked_at: new Date().toISOString(),
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'PageSpeed took too long' : e.message };
  } finally { clearTimeout(t); }
}

// Plain-English findings, worst first. Each carries the evidence, so emails never exaggerate.
export function findings(audit = {}, psi = null) {
  const f = [], y = YEAR();
  if (audit.https === false) f.push({ w: 5, k: 'https', say: 'the site loads without HTTPS, so Chrome marks it "Not secure"' });
  if (audit.viewport === false) f.push({ w: 5, k: 'mobile', say: 'the site has no mobile layout, so on a phone it shows the desktop page shrunk down' });
  if (psi && psi.performance != null && psi.performance < 50) f.push({ w: 4, k: 'speed', say: `Google PageSpeed scores the mobile site ${psi.performance} out of 100${psi.lcp_s ? `, with the main content taking ${psi.lcp_s} seconds to appear` : ''}` });
  else if (psi && psi.lcp_s && psi.lcp_s > 4) f.push({ w: 3, k: 'speed', say: `on mobile the main content takes ${psi.lcp_s} seconds to appear (Google's target is under 2.5)` });
  if (audit.copyright_year && audit.copyright_year <= y - 3) f.push({ w: 3, k: 'dated', say: `the footer still says © ${audit.copyright_year}, which makes the site look unmaintained` });
  if (audit.flash) f.push({ w: 3, k: 'flash', say: 'part of the site uses Flash, which no browser plays any more' });
  if (audit.table_layout) f.push({ w: 2, k: 'tables', say: 'the page is laid out with old-style tables, which breaks on phones' });
  if (audit.old_jquery) f.push({ w: 1, k: 'jquery', say: `it runs jQuery ${audit.old_jquery}, a library version from around 2012` });
  if (psi && psi.tap_targets_ok === false) f.push({ w: 2, k: 'tap', say: 'buttons and links are too small or close together to tap easily on a phone' });
  if (psi && psi.font_size_ok === false) f.push({ w: 2, k: 'font', say: 'the text is too small to read on a phone without zooming' });
  if (audit.meta_description === false) f.push({ w: 1, k: 'meta', say: 'the home page has no meta description, so Google writes its own snippet' });
  if (audit.h1 === false) f.push({ w: 1, k: 'h1', say: "the home page has no main heading, which makes it harder for Google to tell what you do" });
  if (psi && psi.seo != null && psi.seo < 80) f.push({ w: 2, k: 'seo', say: `Google's own SEO check scores the home page ${psi.seo} out of 100` });
  if (audit.contact_form === false && audit.booking === false) f.push({ w: 1, k: 'form', say: 'there is no contact form or online booking on the home page' });
  if (audit.click_to_call === false) f.push({ w: 1, k: 'call', say: 'the phone number is not tap-to-call on mobile' });
  return f.sort((a, b) => b.w - a.w);
}

// How much the site needs replacing (pain) plus whether the business looks able to pay.
export function agencyScore(p) {
  const x = p.extra || {}, a = x.audit || {}, psi = x.psi || null, s = p.signals || {};
  const why = []; let n = 0;
  const add = (pts, reason) => { n += pts; why.push(`${pts > 0 ? '+' : ''}${pts} ${reason}`); };
  if (!Object.keys(a).length) return { score: 0, score_why: 'site not read yet' };
  const fs = findings({ ...a, booking: s.booking, click_to_call: s.click_to_call }, psi);
  for (const f of fs) add(Math.min(f.w, 3), f.k);
  const good = a.https && a.viewport && (a.modern || (psi && psi.performance >= 80)) && (!a.copyright_year || a.copyright_year >= YEAR() - 1);
  if (good) add(-4, 'site already modern and fast');
  if ((p.rating || 0) >= 4.3 && (p.reviews || 0) >= 25) add(2, `healthy business: ${p.rating} stars, ${p.reviews} reviews`);
  if ((p.reviews || 0) >= 100) add(1, 'well established');
  if ((p.reviews || 0) > 0 && (p.reviews || 0) < 5) add(-1, 'very few reviews');
  if (x.generic_email) add(-1, 'generic address');
  return { score: n, score_why: why.join('; ') || 'nothing wrong found', findings: fs.map(f => f.say) };
}

// The lines the writer and the closer get. Only facts we measured.
export function auditFacts(p) {
  const x = p.extra || {}, a = x.audit || {}, psi = x.psi || null, s = p.signals || {};
  if (!Object.keys(a).length) return '';
  const fs = findings({ ...a, booking: s.booking, click_to_call: s.click_to_call }, psi);
  const lines = ['WEBSITE AUDIT (measured; you may only state these, with these numbers):'];
  lines.push(fs.length ? fs.slice(0, 6).map(f => '- ' + f.say).join('\n') : '- nothing clearly wrong was found');
  if (a.builder) lines.push(`- built with: ${a.builder}`);
  if (a.since_year) lines.push(`- their site says they have been in business since ${a.since_year}`);
  if (x.search_volume?.total) lines.push(`- Google Ads data: about ${x.search_volume.total.toLocaleString('en-US')} searches a month for ${x.search_volume.label} (${x.search_volume.terms.join(', ')})`);
  return lines.join('\n');
}
