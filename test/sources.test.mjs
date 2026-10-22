// State registry sources for KeepHOA: Virginia weekly list, Texas certificates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeOpenAI, installFetch } from './fakes.mjs';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k' });
const db = fakeDb(), ai = fakeOpenAI();
let vaResponse = null;
installFetch({ db, ai });
const inner = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).includes('dpor.virginia.gov') ? (vaResponse ? vaResponse() : new Response('nope', { status: 403 })) : inner(url, init);

const { actions: A } = await import('../netlify/lib/actions.mjs');
const S = await import('../netlify/lib/sources.mjs');
const { score } = await import('../netlify/lib/score.mjs');

const H = ['BOARD', 'OCCUPATION', 'CERTIFICATE #', 'INDIVIDUAL NAME', 'BUSINESS NAME', 'FIRST LINE ADDRESS', 'SECOND LINE ADDRESS', 'P O BOX #', 'CITY', 'STATE', 'FIVE DIGIT ZIP CODE', 'ZIP CODE EXTENSION', 'PROVINCE', 'COUNTRY', 'POSTAL CODE', 'EXPIRATION DATE', 'CERTIFICATION DATE', 'LICENSE RANK', 'LICENSE SPECIALTY', 'EMAILADDRESS'];
const row = (name, city, state, cert, email) => ['05', '50', '1', '', name, '1 Main', '', '', city, state, '23000', '0000', '', '', '', '12/31/2027', cert, 'ASSN', '', email].join('\t');
const lastMonth = new Date(Date.now() - 30 * 86400000);
const recent = `${String(lastMonth.getMonth() + 1).padStart(2, '0')}/${String(lastMonth.getDate()).padStart(2, '0')}/${lastMonth.getFullYear()}`;
const FILE = [H.join('\t'),
  row('BELMONT SHORES ASSOCIATION INC', 'MINERAL', 'VA', '01/08/2004', 'epcsunrise@msn.com'),
  row('NEW MEADOW HOA', 'RICHMOND', 'VA', recent, 'Treasurer.NewMeadow@Gmail.com'),
  row('COLESON CLUSTER ASSOCIATION', 'RESTON', 'VA', '07/14/1993', 'treasurer@colesoncluster.org'),
  row('HUNTINGTON WALK UNIT OWNERS', 'ALEXANDRIA', 'VA', '07/08/1993', 'joe@csimanagement.com'),
  row('COLECROFT CONDOMINIUM', 'ALEXANDRIA', 'VA', '07/08/1993', 'joe@csimanagement.com'),
  row('CANAL WAY HOA', 'LONGWOOD', 'FL', '07/08/1993', 'INFORMATION@SENTRYMGT.COM'),
  row('LONE OUT OF STATE', 'BETHESDA', 'MD', '07/08/1993', 'aebert@dreyfuss.net'),
  row('NO EMAIL CONDO', 'NORFOLK', 'VA', '07/08/1993', ''),
  row('SHARED VOLUNTEER TWO', 'MINERAL', 'VA', '01/08/2004', 'epcsunrise@msn.com'),
].join('\r\n');

test('Virginia filter keeps volunteers and drops management companies', () => {
  const v = S.virginiaRows(FILE);
  assert.equal(v.total, 9);
  assert.deepEqual(v.rows.map(r => r.email).sort(), ['epcsunrise@msn.com', 'epcsunrise@msn.com', 'treasurer.newmeadow@gmail.com', 'treasurer@colesoncluster.org']);
  assert.equal(v.skipped['management company address'], 4, 'shared domain, manager word, out-of-state company');
  assert.equal(v.skipped['no email listed'], 1);
  const nm = v.rows.find(r => r.email.startsWith('treasurer.new'));
  assert.equal(nm.new_registration, true);
  assert.equal(nm.name, 'New Meadow HOA');
  assert.throws(() => S.virginiaRows('a\tb\n1\t2'), /not the Virginia DPOR/);
});

test('Virginia import: server download failing is recorded, uploaded text works, reruns add nothing new', async () => {
  await A['setup.status']();
  assert.ok(db.T.products.find(p => p.id === 'keephoa').segments.some(s => s.id === 'texas'), 'texas segment present');
  await assert.rejects(A['source.virginia']({}), /Could not download the Virginia list: Virginia answered 403/);
  let st = await A['source.status']();
  assert.equal(st.virginia.needsUpload, true, 'tells the nightly job to upload it');
  const r = await A['source.virginia']({ text: FILE });
  assert.equal(r.volunteers, 4); assert.equal(r.added, 3, 'the shared address becomes one prospect');
  assert.equal(r.how, 'uploaded from your computer');
  st = await A['source.status']();
  assert.equal(st.virginia.needsUpload, false);
  const nm = db.T.prospects.find(p => p.email === 'treasurer.newmeadow@gmail.com');
  assert.equal(nm.segment, 'virginia'); assert.equal(nm.state, 'VA'); assert.equal(nm.status, 'scanned');
  assert.equal(nm.extra.new_registration, true);
  assert.match(nm.score_why, /registered with the state in the last year/);
  const old = db.T.prospects.find(p => p.email === 'epcsunrise@msn.com');
  assert.ok(nm.score > old.score, 'new boards come first');
  vaResponse = () => new Response(FILE, { status: 200 });
  const again = await A['source.virginia']({});
  assert.equal(again.added, 0); assert.equal(again.how, 'downloaded by the server');
});

test('Texas: only personal addresses from certificates become prospects', async () => {
  assert.equal(S.texasRow({ name: 'Oak Hills POA', emails: ['info@goodwintx.com', 'contact@spectrumam.com'] }), null);
  const r = await A['source.texas']({ offset: 200, done: 3, certs: [
    { name: 'Canyon Corner Property Owners Association', city: 'Canyon Lake', county: 'TX', zip: '78133', type: 'POA', emails: ['_tgsystems14@gmail.com.'] },
    { name: 'Chimney Hill Community Association Inc.', city: 'houston', county: 'Harris', type: 'POA', emails: ['managementcertificate@nmitx.com'] },
    { name: 'Lakeview Condo', city: 'Austin', county: 'Travis', type: 'Condo', emails: [] },
  ] });
  assert.equal(r.volunteers, 1); assert.equal(r.added, 1);
  const p = db.T.prospects.find(x => x.segment === 'texas');
  assert.equal(p.email, '_tgsystems14@gmail.com'); assert.equal(p.state, 'TX'); assert.equal(p.city, 'Canyon Lake');
  const st = (await A['source.status']()).texas;
  assert.deepEqual([st.offset, st.read, st.volunteers, st.added], [200, 3, 1, 1]);
});

test('KeepHOA footer names the right state registry', async () => {
  const { footer } = await import('../netlify/lib/brain.mjs');
  const kp = db.T.products.find(p => p.id === 'keephoa');
  assert.match(footer({ ...kp, from_name: 'R', postal_address: 'PO' }, { state: 'TX' }), /Texas public HOA registry/);
  void score;
});
