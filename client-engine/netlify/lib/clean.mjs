// Turning raw rows (Maps scraper CSV, state registry files) into clean prospects.
// Pure functions: no network, easy to test.

const GENERIC = /^(info|contact|office|hello|admin|support|sales|service|team|mail|enquiries|inquiries|help|booking|bookings|appointments|frontdesk|reception|general)@/i;
const JUNK_LOCAL = /^(no-?reply|do-?not-?reply|postmaster|mailer-daemon|abuse|privacy|webmaster|example|test|user|name|email|your)@/i;
const JUNK_DOMAIN = /(example\.(com|org)|sentry\.|wixpress\.com|godaddy\.com|domain\.com|email\.com|yourdomain|sentry-next|cloudflare\.com|squarespace\.com|wordpress\.(com|org)|schema\.org|w3\.org|googleapis\.com|gstatic\.com)$/i;
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|pdf|mp4)$/i;
// Personal addresses of people in the EU, UK and similar regimes are never emailed.
const BLOCKED_TLD = /\.(uk|eu|de|fr|it|es|nl|be|ie|at|se|dk|fi|pt|pl|cz|gr|hu|ro|bg|hr|si|sk|lt|lv|ee|lu|mt|cy|ch|no|is|li)$/i;
const FREEMAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|comcast|att|sbcglobal|verizon|protonmail|ymail)\.(com|net)$/i;

// National brands and franchises: excluded for RingSparrow and PDFMacro.
const CHAINS = [
  'roto-rooter', 'mr. rooter', 'mr rooter', 'ars rescue', 'one hour heating', 'benjamin franklin plumbing', 'mister sparky',
  'aire serv', 'mr. electric', 'mr electric', 'mr. handyman', 'mr handyman', 'servpro', 'servicemaster', 'molly maid',
  'merry maids', 'two men and a truck', 'pop-a-lock', 'great clips', 'supercuts', 'sport clips', 'fantastic sams',
  'cost cutters', 'regis salon', 'ulta', 'aspen dental', 'western dental', 'heartland dental', 'pacific dental',
  'bright now', 'coast dental', 'home depot', "lowe's", 'lowes', 'sears', 'terminix', 'orkin', 'truly nolen',
  'stanley steemer', 'chem-dry', 'window genie', 'mosquito joe', 'neighborly', 'precision garage door', 'a1 garage',
  'leaf filter', 'leaffilter', 'bath fitter', 're-bath', 'floor coverings international', 'empire today',
  'jacoby & meyers', 'morgan & morgan', 'legalzoom', 'rocket lawyer',
];

export const lower = s => String(s ?? '').trim().toLowerCase();

export function domainOf(url) {
  if (!url) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

// The scraper writes emails as "a@x.com, b@y.com", or as a JSON-ish list.
export function splitEmails(raw) {
  if (!raw) return [];
  const found = String(raw).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(found.map(e => e.toLowerCase().replace(/^mailto:/, '')))];
}

export function isGeneric(email) { return GENERIC.test(email); }

export function emailProblem(email, website, needOwnDomain) {
  const e = lower(email);
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return 'not a valid email';
  if (JUNK_LOCAL.test(e)) return 'no-reply or placeholder address';
  const dom = e.split('@')[1];
  if (JUNK_DOMAIN.test(dom)) return 'web-platform or placeholder address';
  if (FILE_EXT.test(e)) return 'image or file name, not an email';
  if (BLOCKED_TLD.test(dom)) return 'EU/UK or similar address';
  if (needOwnDomain) {
    const site = domainOf(website);
    if (!site) return 'no website to match the email against';
    if (!(dom === site || dom.endsWith('.' + site) || site.endsWith('.' + dom))) return "email is not on the business's own domain";
  }
  return '';
}

// Prefer a named person on the business's own domain, then a generic one on its domain, then anything usable.
export function pickEmail(emails, website, needOwnDomain) {
  const ok = emails.filter(e => !emailProblem(e, website, needOwnDomain));
  if (!ok.length) return { email: '', why: emails.length ? emailProblem(emails[0], website, needOwnDomain) : 'no email found' };
  const site = domainOf(website);
  const rank = e => (e.endsWith('@' + site) ? 0 : FREEMAIL.test(e) ? 2 : 1) * 2 + (isGeneric(e) ? 1 : 0);
  ok.sort((a, b) => rank(a) - rank(b));
  return { email: ok[0], why: '' };
}

export function isChain(name, website) {
  const n = lower(name), d = domainOf(website);
  return CHAINS.some(c => n.includes(c) || d.includes(c.replace(/[^a-z0-9]/g, '')));
}

const STATES = { AL:1,AK:1,AZ:1,AR:1,CA:1,CO:1,CT:1,DE:1,FL:1,GA:1,HI:1,ID:1,IL:1,IN:1,IA:1,KS:1,KY:1,LA:1,ME:1,MD:1,MA:1,MI:1,MN:1,MS:1,MO:1,MT:1,NE:1,NV:1,NH:1,NJ:1,NM:1,NY:1,NC:1,ND:1,OH:1,OK:1,OR:1,PA:1,RI:1,SC:1,SD:1,TN:1,TX:1,UT:1,VT:1,VA:1,WA:1,WV:1,WI:1,WY:1,DC:1 };

// "123 Main St, Austin, TX 78701, United States" -> { city, state, us }
export function parseAddress(address, completeJson) {
  let city = '', state = '', country = '';
  if (completeJson) {
    try {
      const c = typeof completeJson === 'string' ? JSON.parse(completeJson) : completeJson;
      city = c.city || ''; state = c.state || ''; country = c.country || '';
    } catch {}
  }
  const a = String(address || '');
  if (!state) {
    const m = a.match(/,\s*([^,]+),\s*([A-Z]{2})\s+\d{5}(-\d{4})?/);
    if (m) { city = city || m[1].trim(); state = m[2]; }
  }
  if (state && state.length > 2) {
    const full = { colorado: 'CO', virginia: 'VA', texas: 'TX', california: 'CA', florida: 'FL', 'new york': 'NY' };
    state = full[lower(state)] || state;
  }
  const us = country ? /^(us|usa|united states)/i.test(country) : !!STATES[state] || /United States|USA/.test(a);
  return { city, state: STATES[state] ? state : state, us };
}

// One row from gosom/google-maps-scraper CSV -> prospect, or { skip }.
export function fromMapsRow(row, { productId, segment, needOwnDomain, sourceFile }) {
  const name = (row.title || '').trim();
  const website = (row.website || '').trim();
  if (!name) return { skip: 'no business name' };
  if (!website) return { skip: 'no website' };
  if (isChain(name, website)) return { skip: 'chain or franchise' };
  if (/permanently closed|temporarily closed/i.test(row.status || '')) return { skip: 'closed' };
  const { city, state, us } = parseAddress(row.address, row.complete_address);
  if (!us) return { skip: 'not in the US' };
  const { email, why } = pickEmail(splitEmails(row.emails), website, needOwnDomain);
  if (!email) return { skip: why };
  return {
    prospect: {
      product_id: productId, segment, source: 'maps', source_file: sourceFile,
      name, email, website, phone: (row.phone || '').trim(), category: (row.category || '').trim(),
      city, state,
      rating: Number(row.review_rating) || null,
      reviews: parseInt(row.review_count, 10) || null,
      extra: {
        maps_link: row.link || '', about: [row.about, row.descriptions].map(v => String(v ?? '').trim()).find(v => v && !/^(\[\]|\{\}|null)$/.test(v))?.slice(0, 600) || '',
        generic_email: isGeneric(email),
      },
    },
  };
}

// One row from a state registry file, after the user has mapped its columns in the app.
// Fields: name, email, city, state, units, manager, self_managed, county, type, contact.
export function fromRegistryRow(row, { productId, segment, sourceFile, defaultState }) {
  const name = (row.name || '').trim();
  if (!name) return { skip: 'no association name' };
  const { email, why } = pickEmail(splitEmails(row.email), '', false);
  if (!email) return { skip: why };
  const manager = (row.manager || '').trim();
  const sm = lower(row.self_managed);
  const selfManaged = /self/.test(lower(manager)) || ['yes', 'y', 'true', '1', 'self-managed', 'self managed'].includes(sm)
    ? true : (sm === 'no' || sm === 'false' || sm === 'n' ? false : null);
  return {
    prospect: {
      product_id: productId, segment, source: 'registry', source_file: sourceFile,
      name, email, website: '', phone: (row.phone || '').trim(), category: (row.type || '').trim(),
      city: (row.city || '').trim(), state: (row.state || defaultState || '').trim().toUpperCase().slice(0, 2),
      units: parseInt(row.units, 10) || null, self_managed: selfManaged,
      extra: {
        manager, county: (row.county || '').trim(), contact: (row.contact || '').trim(),
        generic_email: isGeneric(email),
        manager_email: /manag|mgmt|property|realty|partners|services/i.test(email.split('@')[1] || ''),
      },
    },
  };
}
