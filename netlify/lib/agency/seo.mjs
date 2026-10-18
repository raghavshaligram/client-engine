// DataForSEO: real Google Ads search volumes, for outreach ("about 1,900 searches a month for
// plumbers in Austin") and for picking blog topics for Growth clients. Optional: without
// DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD the system simply leaves these facts out.
import { db } from '../db.mjs';

const STATE_NAMES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };

export const seoReady = () => !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

export function locationName(city, state) {
  const st = STATE_NAMES[String(state || '').toUpperCase()] || state;
  return city && st ? `${city},${st},United States` : st ? `${st},United States` : 'United States';
}

// "Roofing contractor" -> "roofing contractor"; "Plumber" -> "plumber". Plural label for prose.
export function serviceTerm(category = '') {
  const c = String(category).toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/\bservice\b$/, '').trim();
  return c || '';
}
const plural = t => /(ist|er|or|ian|ant|ent)$/.test(t) ? t + 's' : /y$/.test(t) && !/[aeiou]y$/.test(t) ? t.slice(0, -1) + 'ies' : /s$/.test(t) ? t : t;

async function call(path, body) {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  const res = await fetch('https://api.dataforseo.com/v3/' + path, {
    method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const task = data.tasks?.[0];
  if (!res.ok || !task || task.status_code !== 20000) throw new Error('DataForSEO: ' + (task?.status_message || data.status_message || res.status));
  return task.result || [];
}

// Searches a month for the business's main service in its city. Cached for 180 days per service+city.
export async function localVolume(category, city, state) {
  const term = serviceTerm(category);
  if (!seoReady() || !term || !city) return null;
  const key = `vol:${term}|${city}|${state}`.toLowerCase();
  const hit = await db.one('kw_cache', { key });
  if (hit && Date.now() - Date.parse(hit.fetched_at) < 180 * 86_400_000) return hit.value;
  const terms = [term, `${term} near me`, `${term} ${String(city).toLowerCase()}`];
  const rows = await call('keywords_data/google_ads/search_volume/live', [{ keywords: terms, location_name: locationName(city, state), language_code: 'en' }]);
  const used = rows.filter(r => r.search_volume > 0);
  const value = used.length ? { total: used.reduce((n, r) => n + r.search_volume, 0), terms: used.map(r => r.keyword), label: `${plural(term)} in ${city}` } : { total: 0, terms: [], label: '' };
  await db.upsert('kw_cache', [{ key, value, fetched_at: new Date().toISOString() }], 'key');
  return value;
}

// Blog topics for a Growth client: question-style and service+city keywords with real volume.
export async function blogKeywords({ services = [], city, state }, { limit = 40 } = {}) {
  if (!seoReady()) return [];
  const seeds = services.map(s => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 10);
  if (!seeds.length) return [];
  const rows = await call('keywords_data/google_ads/keywords_for_keywords/live', [{ keywords: seeds, location_name: locationName(city, state), language_code: 'en', sort_by: 'search_volume' }]);
  const BAD = /\b(jobs?|salary|career|hiring|license exam|school|course|diy kit|free download|near me open now)\b/i;
  return rows
    .filter(r => r.keyword && r.search_volume >= 10 && !BAD.test(r.keyword) && (r.competition_index ?? 50) <= 80)
    .sort((a, b) => b.search_volume - a.search_volume)
    .slice(0, limit)
    .map(r => ({ keyword: r.keyword, volume: r.search_volume }));
}
