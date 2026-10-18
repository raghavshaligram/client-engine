// The free home page mockup: AI writes the copy from the prospect's real details,
// a fixed template lays it out. Fast (one short AI call), consistent, and never invents facts.
import { ai } from '../brain.mjs';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function styleFor(p) {
  const t = `${p.category || ''} ${p.segment || ''}`.toLowerCase();
  if (/dent|orthodon|chiro|clinic|medical|physical therap|optom|vet|health|pediatric|dermat|med spa/.test(t)) return 'health';
  if (/salon|barber|spa|nail|lash|brow|beauty|massage|wax|tattoo|esthetic/.test(t)) return 'beauty';
  if (/law|attorney|lawyer|account|cpa|tax|insurance|financial|real estate|consult|pro\b/.test(t)) return 'pro';
  return 'trades';
}

const WRITER = `You write the copy for a one-page website mockup for a real local business, so the owner can see what a modern version of their site could look like.
Rules:
- Use only facts given: the business name, category, city, phone, rating, services and claims found in their website text or Google profile. Never invent years in business, licences, awards, guarantees, prices, staff names or service areas.
- If the facts do not support something, leave it out (use an empty string or a shorter list).
- Services: 3 to 6 of their real services, each with a plain one-sentence description of the service (no claims about quality or speed unless their own text says so).
- "why": up to 3 short reasons to choose them, each backed by a given fact (for example their rating and review count, "family owned" if their text says so, "since 1998" if their text says so). Fewer is fine.
- Headline: under 9 words, specific to what they do and where. Subhead: one sentence.
- Plain, warm, confident. No exclamation marks, no em dashes, no clichés like "look no further" or "your one-stop shop".
- If the owner asked for changes to an earlier version, apply them.
Return JSON: {"headline":"","subhead":"","services":[{"name":"","text":""}],"why":[{"title":"","text":""}],"about":"","area":"","cta":"Get a free quote"}`;

function facts(p) {
  const x = p.extra || {}, a = x.audit || {};
  return [
    `Business: ${p.name}`, p.category && `Category: ${p.category}`, (p.city || p.state) && `Location: ${[p.city, p.state].filter(Boolean).join(', ')}`,
    p.phone && `Phone: ${p.phone}`, p.rating && `Google rating: ${p.rating} from ${p.reviews} reviews`,
    a.since_year && `Their site says: in business since ${a.since_year}`,
    x.hours && `Opening hours (from Google): ${String(x.hours).slice(0, 300)}`,
    x.about && `Google profile text: ${x.about}`,
    p.site_text && `Text from their current website:\n${p.site_text}`,
  ].filter(Boolean).join('\n');
}

export async function writeMockup(p, notes = '') {
  const out = await ai(WRITER, `${facts(p)}${notes ? `\n\nTHE OWNER ASKED FOR THESE CHANGES:\n${notes}` : ''}`, { temperature: 0.5 });
  const str = (v, n) => String(v || '').replace(/\s*[—–]\s*/g, ', ').replace(/!/g, '.').trim().slice(0, n);
  return {
    headline: str(out.headline, 90) || `${p.category || 'Local service'} in ${p.city || 'your area'}`,
    subhead: str(out.subhead, 220),
    services: (Array.isArray(out.services) ? out.services : []).slice(0, 6).map(s => ({ name: str(s.name, 50), text: str(s.text, 200) })).filter(s => s.name),
    why: (Array.isArray(out.why) ? out.why : []).slice(0, 3).map(s => ({ title: str(s.title, 50), text: str(s.text, 180) })).filter(s => s.title),
    about: str(out.about, 600),
    area: str(out.area, 120),
    cta: str(out.cta, 30) || 'Get a free quote',
    style: styleFor(p),
    made_at: new Date().toISOString(),
  };
}

// Four looks, one per kind of business. Each picks its own fonts and colours.
const STYLES = {
  trades: {
    fonts: 'Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600',
    display: "'Barlow Condensed', 'Arial Narrow', sans-serif", body: "'Barlow', system-ui, sans-serif",
    bg: '#EDF0F2', surface: '#FFFFFF', ink: '#14213D', soft: '#4A5568', accent: '#FFB703', accentInk: '#14213D', band: '#14213D', bandInk: '#FFFFFF', radius: '4px',
  },
  health: {
    fonts: 'Outfit:wght@500;600&family=Source+Sans+3:wght@400;600',
    display: "'Outfit', system-ui, sans-serif", body: "'Source Sans 3', system-ui, sans-serif",
    bg: '#F4FAF9', surface: '#FFFFFF', ink: '#0F3B47', soft: '#4D6670', accent: '#0F766E', accentInk: '#FFFFFF', band: '#DDF1EE', bandInk: '#0F3B47', radius: '14px',
  },
  beauty: {
    fonts: 'Fraunces:opsz,wght@9..144,500;9..144,600&family=Karla:wght@400;500;600',
    display: "'Fraunces', Georgia, serif", body: "'Karla', system-ui, sans-serif",
    bg: '#F7E9E4', surface: '#FFFAF8', ink: '#3B1F33', soft: '#6E5363', accent: '#7A2E5C', accentInk: '#FFFFFF', band: '#3B1F33', bandInk: '#F7E9E4', radius: '22px',
  },
  pro: {
    fonts: 'Libre+Caslon+Text:wght@400;700&family=IBM+Plex+Sans:wght@400;500;600',
    display: "'Libre Caslon Text', Georgia, serif", body: "'IBM Plex Sans', system-ui, sans-serif",
    bg: '#ECEAE4', surface: '#FFFFFF', ink: '#1C2B22', soft: '#4F5B54', accent: '#1F4D36', accentInk: '#FFFFFF', band: '#1F4D36', bandInk: '#ECEAE4', radius: '2px',
  },
};

const telHref = phone => 'tel:' + String(phone || '').replace(/[^\d+]/g, '');
const ICON = {
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 17.3 6.2 3.7-1.6-7 5.4-4.7-7.1-.6L12 2 9.1 8.7 2 9.3l5.4 4.7-1.6 7z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
};

// The page. `ctx`: { agency, startUrl, preview (bool) }.
export function renderMockup(m, p, ctx = {}) {
  const S = STYLES[m.style] || STYLES.trades;
  const x = p.extra || {}, a = x.audit || {};
  const photo = (a.images || [])[0] || x.thumbnail || '';
  const logo = a.logo || '';
  const year = new Date().getUTCFullYear();
  const where = [p.city, p.state].filter(Boolean).join(', ');
  const trust = [
    p.rating && p.reviews ? `<span>${ICON.star}${esc(p.rating)} from ${esc(p.reviews)} Google reviews</span>` : '',
    a.since_year ? `<span>In business since ${esc(a.since_year)}</span>` : '',
    where ? `<span>${ICON.pin}${esc(m.area || 'Serving ' + where)}</span>` : '',
  ].filter(Boolean).join('');
  const phoneHero = m.style === 'trades' && p.phone;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(p.name)}: new home page concept</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${S.fonts}&display=swap" rel="stylesheet">
<style>
:root{--bg:${S.bg};--surface:${S.surface};--ink:${S.ink};--soft:${S.soft};--accent:${S.accent};--accent-ink:${S.accentInk};--band:${S.band};--band-ink:${S.bandInk};--r:${S.radius};--display:${S.display};--body:${S.body}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.6 var(--body)}
a{color:inherit}img{max-width:100%;display:block}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.concept{background:var(--ink);color:var(--bg);font-size:13px;padding:8px 0;text-align:center}
header.top{background:var(--surface);border-bottom:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:68px}
.brand{display:flex;align-items:center;gap:12px;font:600 21px/1.1 var(--display);text-decoration:none}
.brand img{max-height:44px;width:auto}
nav.links{display:flex;gap:22px;font-weight:500;font-size:15px}nav.links a{text-decoration:none;color:var(--soft)}
.call{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;padding:11px 18px;border-radius:var(--r);white-space:nowrap}
.call svg{width:18px;height:18px}
.ghost{display:inline-flex;align-items:center;padding:11px 18px;border-radius:var(--r);border:2px solid currentColor;text-decoration:none;font-weight:600}
.hero{position:relative;color:${photo ? '#fff' : 'var(--ink)'};${photo ? `background:linear-gradient(90deg,rgba(10,14,22,.86) 0%,rgba(10,14,22,.62) 55%,rgba(10,14,22,.25) 100%),url("${esc(photo)}") center/cover;` : 'background:var(--bg);'}}
.hero .wrap{padding:${phoneHero ? '72px 20px 64px' : '96px 20px 88px'};max-width:1120px}
.hero h1{font:${m.style === 'trades' ? '700 clamp(44px,7.4vw,84px)/0.95' : '600 clamp(38px,5.6vw,66px)/1.05'} var(--display);margin:0 0 18px;max-width:15ch;${m.style === 'trades' ? 'text-transform:uppercase;letter-spacing:.01em' : 'letter-spacing:-.015em'}}
.hero p.sub{font-size:20px;max-width:46ch;margin:0 0 28px;opacity:.92}
.hero .actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.bignum{display:inline-block;font:700 clamp(40px,8vw,92px)/1 var(--display);text-decoration:none;margin:6px 0 26px;letter-spacing:.01em;${photo ? 'color:var(--accent)' : 'color:var(--ink);background:linear-gradient(transparent 64%,var(--accent) 64%,var(--accent) 90%,transparent 90%)'}}
.trust{background:var(--band);color:var(--band-ink)}.trust .wrap{display:flex;flex-wrap:wrap;gap:12px 36px;padding:18px 20px;font-weight:500}
.trust span{display:inline-flex;align-items:center;gap:8px}.trust svg{width:18px;height:18px;color:var(--accent)}
section{padding:80px 0}h2{font:600 clamp(30px,3.6vw,42px)/1.15 var(--display);margin:0 0 12px;letter-spacing:-.01em}
.lead{color:var(--soft);max-width:60ch;margin:0 0 40px}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:2px;background:color-mix(in srgb,var(--ink) 10%,transparent);border-radius:var(--r);overflow:hidden}
.svc{background:var(--surface);padding:30px 28px}.svc h3{font:600 22px/1.25 var(--display);margin:0 0 8px}.svc p{margin:0;color:var(--soft)}
${m.style === 'trades' ? '.svc{border-top:6px solid var(--accent)}' : ''}
.why{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:36px}
.why h3{font:600 20px/1.3 var(--display);margin:0 0 6px}.why p{margin:0;color:var(--soft)}
.about{display:grid;grid-template-columns:${(a.images || []).length > 1 ? '1.1fr .9fr' : '1fr'};gap:48px;align-items:center}
.about img{border-radius:var(--r);aspect-ratio:4/3;object-fit:cover;width:100%}
.cta{background:var(--band);color:var(--band-ink);text-align:center}.cta h2{margin-bottom:18px}.cta .actions{display:flex;justify-content:center;flex-wrap:wrap;gap:12px}
footer{padding:44px 0 120px;color:var(--soft);font-size:15px}footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:20px}
.next{position:fixed;left:0;right:0;bottom:0;background:var(--ink);color:var(--bg);box-shadow:0 -6px 24px rgba(0,0,0,.18);z-index:5}
.next .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;font-size:15px}
.next a{background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;padding:10px 16px;border-radius:var(--r);white-space:nowrap}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
@media (max-width:760px){nav.links{display:none}.hero .wrap{padding:56px 20px}section{padding:56px 0}.about{grid-template-columns:1fr}.next .wrap{flex-direction:column;align-items:stretch;text-align:center}.brand{font-size:18px}}
</style></head><body>
<div class="concept">Concept home page for ${esc(p.name)}${ctx.agency ? `, prepared by ${esc(ctx.agency)}` : ''}. Not live: no one else can find this page.</div>
<header class="top"><div class="wrap">
  <a class="brand" href="#">${logo ? `<img src="${esc(logo)}" alt="" onerror="this.remove()">` : ''}<span>${esc(p.name)}</span></a>
  <nav class="links"><a href="#services">Services</a><a href="#about">About</a><a href="#contact">Contact</a></nav>
  ${p.phone ? `<a class="call" href="${telHref(p.phone)}">${ICON.phone}${esc(p.phone)}</a>` : `<a class="call" href="#contact">${esc(m.cta)}</a>`}
</div></header>
<main>
<section class="hero"><div class="wrap">
  <h1>${esc(m.headline)}</h1>
  ${m.subhead ? `<p class="sub">${esc(m.subhead)}</p>` : ''}
  ${phoneHero ? `<a class="bignum" href="${telHref(p.phone)}">${esc(p.phone)}</a>` : ''}
  <div class="actions">${!phoneHero && p.phone ? `<a class="call" href="${telHref(p.phone)}">${ICON.phone}Call ${esc(p.phone)}</a>` : ''}<a class="ghost" href="#contact">${esc(m.cta)}</a></div>
</div></section>
${trust ? `<div class="trust"><div class="wrap">${trust}</div></div>` : ''}
${m.services.length ? `<section id="services"><div class="wrap"><h2>What we do</h2><p class="lead">${esc(m.area || (where ? 'Serving ' + where + ' and nearby.' : ''))}</p>
  <div class="services">${m.services.map(s => `<div class="svc"><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p></div>`).join('')}</div></div></section>` : ''}
${m.why.length ? `<section style="background:var(--surface)"><div class="wrap"><h2 style="margin-bottom:32px">Why people choose ${esc(p.name)}</h2>
  <div class="why">${m.why.map(w => `<div><h3>${esc(w.title)}</h3><p>${esc(w.text)}</p></div>`).join('')}</div></div></section>` : ''}
${m.about ? `<section id="about"><div class="wrap about"><div><h2>About us</h2><p>${esc(m.about)}</p></div>${(a.images || []).length > 1 ? `<img src="${esc(a.images[1])}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div></section>` : ''}
<section class="cta" id="contact"><div class="wrap"><h2>${p.phone ? 'Talk to us today' : 'Get in touch'}</h2>
  <div class="actions">${p.phone ? `<a class="call" href="${telHref(p.phone)}">${ICON.phone}${esc(p.phone)}</a>` : ''}<a class="ghost" href="#contact">${esc(m.cta)}</a></div></div></section>
</main>
<footer><div class="wrap"><div><strong>${esc(p.name)}</strong><br>${esc(x.address || where)}</div><div>© ${year} ${esc(p.name)}</div></div></footer>
${ctx.startUrl ? `<div class="next"><div class="wrap"><span>${esc(ctx.nextLine || 'Like this direction? See what the full site includes.')}</span><a href="${esc(ctx.startUrl)}">See how it works</a></div></div>` : ''}
</body></html>`;
}
