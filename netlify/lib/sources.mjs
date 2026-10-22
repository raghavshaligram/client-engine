// Public state registries that feed KeepHOA. Only addresses that look like a volunteer's are kept:
// management companies are a different buyer and would get the wrong email.

export const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|att|sbcglobal|bellsouth|verizon|cox|charter|earthlink|juno|protonmail|proton|gmx|mail|zoho|frontier|windstream|centurylink|optonline|roadrunner|twc|rcn)\.[a-z.]+$/i;
const MANAGER_WORDS = /manag|mgmt|propert|realty|partners|services|associa|community|cmc|hoa(?!s)|condo|residential|group|capital|estate|law|legal|pllc|llp|cpa|builder|develop|construct/i;

export const VIRGINIA_URL = 'https://www.dpor.virginia.gov/sites/default/files/Records%20and%20Documents/Regulant%20List/0550__crnt.txt';

const title = s => String(s || '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())
  .replace(/\b(Llc|Hoa|Poa|Ii|Iii|Iv)\b/g, w => w.toUpperCase()).replace(/\s+(,|\.)/g, '$1').replace(/\s{2,}/g, ' ').trim();

function parseTab(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = (lines.shift() || '').split('\t').map(h => h.trim());
  return { head, rows: lines.map(l => { const c = l.split('\t'); return Object.fromEntries(head.map((h, i) => [h, (c[i] || '').trim()])); }) };
}

// Virginia DPOR "Common Interest Community Association" list (board 05, occupation 50).
export function virginiaRows(text, now = new Date()) {
  const { head, rows } = parseTab(text);
  if (!head.includes('EMAILADDRESS') || !head.includes('BUSINESS NAME')) throw new Error('This is not the Virginia DPOR association list (no EMAILADDRESS / BUSINESS NAME columns)');
  const domainCount = {};
  for (const r of rows) {
    const d = (r.EMAILADDRESS.toLowerCase().split('@')[1] || '');
    if (d) domainCount[d] = (domainCount[d] || 0) + 1;
  }
  const keep = [], skipped = {};
  const skip = why => { skipped[why] = (skipped[why] || 0) + 1; };
  const yearAgo = now.getTime() - 365 * 86_400_000;
  for (const r of rows) {
    const email = r.EMAILADDRESS.toLowerCase();
    const name = r['BUSINESS NAME'] || r['INDIVIDUAL NAME'];
    if (!name) { skip('no association name'); continue; }
    if (!email.includes('@')) { skip('no email listed'); continue; }
    const dom = email.split('@')[1];
    const free = FREEMAIL.test(email);
    if (!free && (domainCount[dom] > 1 || MANAGER_WORDS.test(dom))) { skip('management company address'); continue; }
    if (!free && r.STATE && r.STATE !== 'VA') { skip('management company address'); continue; }
    const [m, d, y] = (r['CERTIFICATION DATE'] || '').split('/');
    const certified = y ? `${y}-${m}-${d}` : '';
    keep.push({
      name: title(name), email, city: title(r.CITY), state: 'VA', type: /condo/i.test(name) ? 'Condominium' : '',
      registered: certified, new_registration: certified ? Date.parse(certified) > yearAgo : false,
    });
  }
  return { rows: keep, skipped, total: rows.length };
}

// Texas: what the nightly OCR step sends back for one certificate.
// Keeps only personal addresses; a management company's address on a Texas certificate is the norm.
export function texasRow({ name, city, county, zip, type, emails = [] }) {
  const personal = [...new Set(emails.map(e => String(e).toLowerCase().replace(/[.,;:)]+$/, '')))].filter(e => FREEMAIL.test(e));
  if (!personal.length) return null;
  return { name: title(name), email: personal[0], city: title(city), state: 'TX', county: /^tx$/i.test(county || '') ? '' : title(county), type: type === 'Condo' ? 'Condominium' : '' };
}
