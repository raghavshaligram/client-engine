// Who gets the day's limited email slots. Points are a starting guess from the outreach plans;
// the dashboard shows reply rates by score band so they can be tuned after ~100 sends.

const CALL_TRADES = /plumb|hvac|heating|air condition|electric|roof|tile|floor|locksmith|salon|barber|dental|dentist|clinic|chiropract|garage door|pest|landscap|lawn|handyman|contractor|remodel|cleaning|towing|auto repair|mechanic|appliance|septic|pool|painter|painting|gutter|fence|moving|movers|spa|massage|veterinar|med spa|physical therap/i;
const AGENCY = /marketing|advertising|web design|website design|seo|digital agency|lead gen|media agency|branding/i;
const PRACTICE = { family: /family|divorce|custody/i, immigration: /immigration/i, pi: /personal injury|accident|injury/i };

export function score(p, product) {
  const s = p.signals || {}, x = p.extra || {}, why = [];
  let n = 0;
  const add = (pts, reason) => { n += pts; why.push(`${pts > 0 ? '+' : ''}${pts} ${reason}`); };
  const scanned = !!p.site_text || Object.keys(s).length > 0;

  if (product.id === 'ringsparrow') {
    if (p.segment === 'agencies') {
      if (s.crm) add(4, 'site mentions CRM, white label, GoHighLevel or automation');
      if (s.serves_local || AGENCY.test(p.category || '')) add(2, 'serves local businesses');
    } else {
      if (p.phone && CALL_TRADES.test(`${p.category} ${p.name}`)) add(3, 'phone-driven trade');
      if ((p.rating || 0) >= 4 && (p.reviews || 0) >= 30) add(2, `busy: ${p.rating} stars, ${p.reviews} reviews`);
      if (scanned && !s.chat && !s.booking && !s.click_to_call) add(3, 'no text chat, booking or click-to-call on site');
    }
    if (s.small) add(1, 'small team');
  } else if (product.id === 'pdfmacro') {
    const area = PRACTICE[p.segment];
    const practice = (s.practice || []).join(' ') + ' ' + (p.category || '');
    if (area ? area.test(practice) : /law|attorney|lawyer/i.test(practice)) add(3, 'practice area matches');
    if (s.small) add(1, 'solo or small firm');
    if (x.generic_email === false) add(1, 'named person, not info@');
    if (p.site_text) add(1, 'site has something real to mention');
  } else if (product.id === 'keephoa') {
    if (p.self_managed === true) add(3, 'listed as self-managed');
    if (p.segment !== 'managers') {
      if (!x.manager || /self/i.test(x.manager)) add(2, 'no management company listed');
      if (x.manager_email) add(-3, 'email looks like a management company');
    }
    if (p.units && p.units <= 150) add(2, `small association (${p.units} units)`);
  }
  if (x.generic_email && product.id !== 'keephoa') add(-1, 'generic address');
  return { score: n, score_why: why.join('; ') || 'no signals yet' };
}
