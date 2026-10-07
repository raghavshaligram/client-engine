// The thinking parts: writer, checker, reply reader and learner.

const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4.1-mini';

export async function ai(system, user, { temperature = 0.4 } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set in Netlify environment variables');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL(), temperature, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('OpenAI: ' + (data.error?.message || res.status));
  try { return JSON.parse(data.choices[0].message.content); } catch { throw new Error('OpenAI returned something that was not JSON'); }
}

export const words = s => (String(s).trim().match(/\S+/g) || []).length;

export function landingLink(product, segment) {
  const seg = (product.segments || []).find(s => s.id === segment) || {};
  const url = seg.landing || product.site || '';
  if (!url || !product.rules?.tracking) return url;
  const u = new URL(url);
  u.searchParams.set('utm_source', 'email');
  u.searchParams.set('utm_campaign', segment || 'outreach');
  return u.toString();
}

function productFile(p) {
  return `PRODUCT: ${p.name} (${p.site})
PRICE: ${p.price}
WHO BUYS: ${p.buyer}
THEIR PAINS:
${p.pains}
WHAT IS TRUE ABOUT THE PRODUCT (the only claims you may make):
${p.proof}
OFFER: ${p.offer}
NEVER SAY:
${p.never_say}`;
}

function prospectFacts(pr) {
  const x = pr.extra || {}, s = pr.signals || {};
  const lines = [
    `Name: ${pr.name}`, pr.category && `Category: ${pr.category}`,
    (pr.city || pr.state) && `Location: ${[pr.city, pr.state].filter(Boolean).join(', ')}`,
    pr.units && `Units: ${pr.units}`, x.county && `County: ${x.county}`, x.manager && `Management company: ${x.manager}`,
    pr.self_managed === true && 'Listed as self-managed on the state registry',
    pr.rating && `Google rating: ${pr.rating} from ${pr.reviews} reviews`,
    pr.source === 'registry' && `Source: ${pr.state} public HOA registry`,
    Object.keys(s).length && `Website check: text chat ${s.chat ? 'yes' : 'no'}, online booking ${s.booking ? 'yes' : 'no'}, click-to-call ${s.click_to_call ? 'yes' : 'no'}${s.practice?.length ? ', practice areas: ' + s.practice.join(', ') : ''}`,
    x.test_call && `Test call made: ${x.test_call}`,
    x.contact && `Contact name on file: ${x.contact}`,
  ].filter(Boolean);
  return lines.join('\n') + (pr.site_text ? `\n\nTEXT FROM THEIR WEBSITE (the only source for a personal detail):\n${pr.site_text}` : '') +
    (x.about ? `\n\nTHEIR GOOGLE PROFILE ABOUT TEXT:\n${x.about}` : '');
}

// Deterministic checks the email must pass, whatever the model thinks.
export function lint(draft, { maxWords, maxLinks, step, link }) {
  const problems = [];
  const body = draft.body || '', subject = draft.subject || '';
  if (!subject.trim() && step === 1) problems.push('no subject');
  if (subject.length > 60) problems.push('subject over 60 characters');
  if (step === 1 && /^\s*(re|fw|fwd)\s*:/i.test(subject)) problems.push('fake Re:/Fwd: subject');
  if (subject === subject.toUpperCase() && /[A-Z]{4}/.test(subject)) problems.push('subject in capitals');
  const w = words(body);
  if (w > Math.ceil(maxWords * 1.1)) problems.push(`${w} words, limit ${maxWords}`);
  const links = (body.match(/https?:\/\/\S+/g) || []);
  if (links.length > maxLinks) problems.push(`${links.length} links, limit ${maxLinks}`);
  if (links.some(l => link && !l.replace(/[).,]+$/, '').startsWith(link.split('?')[0]))) problems.push('link to a page other than the landing page');
  if (/[\[\]{}]|\bXX\b|\bTODO\b/.test(body + subject)) problems.push('placeholder left in');
  if (/hope (this|you)|finds you well|loved your|big fan|game[- ]chang|revolutionar|cutting[- ]edge|guarantee|100%|!!|act now|limited time/i.test(body + ' ' + subject))
    problems.push('salesy or fake-familiar phrase');
  if (/\b\d[\d,]*\+?\s+(happy\s+)?(customers|clients|firms|users|businesses|associations|hoas|lawyers|attorneys|treasurers)\b/i.test(body))
    problems.push('claims a customer count');
  if (step === 1 && !body.includes('?')) problems.push('first email must end in a question');
  return problems;
}

const WRITER = `You write short, plain, honest cold emails for a solo founder. Rules:
- Every claim about the product must come from the product file. Never invent customers, results, numbers or features.
- A personal detail may only come from the prospect facts or the website text given. Never pretend familiarity ("loved your post").
- If you cannot find one real, specific detail to mention in a first email, return {"skip": true, "skip_reason": "..."}.
- Plain text. No bullet points, no bold, no emojis, no em dashes. Short sentences. Sounds like a person, not a brochure.
- Greeting: "Hi" plus the contact's first name only if a contact name is given, otherwise "Hi" plus the business name, or just "Hi there".
- End the body with a one-line sign-off using the sender's first name. Do not add an address, opt-out or signature block: the app adds those.
- Use the link only where told, written exactly as {{LINK}}.
Return JSON: {"skip": false, "detail": "the one real detail you used", "subject": "...", "body": "..."}`;

export async function writeEmail({ product, prospect, step, angle, previous = [], fromName, problems }) {
  const r = product.rules || {};
  const seg = (product.segments || []).find(s => s.id === prospect.segment) || {};
  const maxWords = r.words?.[step - 1] ?? 90, maxLinks = r.links?.[step - 1] ?? 0;
  const ang = (product.angles || []).find(a => a.id === angle) || product.angles?.[0] || {};
  const task = prospect.status === 'rest'
    ? `They replied earlier that the timing was wrong, and it has been about three months. Write one short, friendly check-in in the same thread asking if now is a better time. No pressure, no new pitch. ${maxLinks ? 'You may include {{LINK}} once.' : ''}`
    : step === 1
    ? `Write email 1 of ${r.steps}. One observation about them (the real detail), one sentence on what the product does for that, then this question as the last line: "${seg.ask || 'Worth a quick look?'}". Angle: ${ang.name}: ${ang.hook}`
    : step === r.steps
      ? `Write email ${step} of ${r.steps}, the last one. Say plainly this is the last note. ${maxLinks ? 'Include {{LINK}} once.' : ''} Keep it kind and short.`
      : `Write follow-up ${step} of ${r.steps}. Add one new fact the earlier emails did not use, from the product file, tied to their situation. End with a one-line question. Angle: ${ang.name}: ${ang.hook}`;
  const user = `${productFile(product)}

SEGMENT: ${seg.name || prospect.segment}
SENDER FIRST NAME: ${(fromName || '').split(' ')[0] || 'the founder'}

PROSPECT:
${prospectFacts(prospect)}
${previous.length ? `\nEARLIER EMAILS IN THIS THREAD (do not repeat them):\n${previous.map((m, i) => `--- Email ${i + 1}\n${m.body}`).join('\n')}` : ''}

TASK: ${task}
Body at most ${maxWords} words. Links allowed: ${maxLinks} (as {{LINK}}).${step > 1 ? ' Subject: leave empty, the email replies in the same thread.' : ' Subject: under 7 words, says what the email is about, lower case is fine.'}
${problems?.length ? `\nYOUR LAST DRAFT FAILED THESE CHECKS, FIX THEM:\n- ${problems.join('\n- ')}` : ''}`;
  const out = await ai(WRITER, user, { temperature: 0.5 });
  if (out.skip) return { skip: true, skip_reason: out.skip_reason || 'no real detail to mention' };
  const link = landingLink(product, prospect.segment);
  let body = String(out.body || '').replace(/\{\{\s*LINK\s*\}\}/g, link).replace(/\s*[—–]\s*/g, ', ').trim();
  const subject = step === 1 ? String(out.subject || '').replace(/[—–]/g, '-').trim() : '';
  return { subject, body, detail: out.detail || '', lintProblems: lint({ subject, body }, { maxWords, maxLinks, step, link }) };
}

const CHECKER = `You are a strict editor checking a cold email before a founder sends it under their own name.
Score 1-10. Deduct heavily for: any claim not supported by the product file; any personal detail not found in the prospect facts or website text; anything on the NEVER SAY list; hype; vagueness; sounding like a template; more than one question; being longer than needed.
Return JSON: {"score": n, "problems": ["short, specific problem", ...]}`;

export async function checkEmail({ product, prospect, draft }) {
  const user = `${productFile(product)}\n\nPROSPECT:\n${prospectFacts(prospect)}\n\nDRAFT SUBJECT: ${draft.subject}\nDRAFT BODY:\n${draft.body}`;
  const out = await ai(CHECKER, user, { temperature: 0 });
  return { score: Math.max(1, Math.min(10, Number(out.score) || 1)), problems: Array.isArray(out.problems) ? out.problems.map(String) : [] };
}

export const PASS_SCORE = 7;

// One write + check pass. The server calls it at most twice per email (rewrite once, then give up),
// one pass per request so no request runs past Netlify's time limit.
export async function draftOnce(args) {
  const d = await writeEmail(args);
  if (d.skip) return d;
  const c = await checkEmail({ product: args.product, prospect: args.prospect, draft: d });
  const problems = [...d.lintProblems, ...(c.score < PASS_SCORE ? c.problems : [])];
  if (!problems.length) return { ...d, check_score: c.score, check_notes: c.problems.join('; ') };
  return { failed: true, problems, check_score: c.score };
}

// The footer every email carries. CAN-SPAM: who it is from, a postal address, a working opt-out.
export function footer(product, prospect) {
  const reason = (product.rules?.reason_line || '').replace('{state}', prospect.state || 'state');
  const lines = ['', '--'];
  if (reason) lines.push(reason);
  lines.push(`${product.from_name}, ${product.name}`);
  if (product.postal_address) lines.push(product.postal_address);
  lines.push(`Reply "no" and I won't email you again.`);
  return lines.join('\n');
}

// ---- Replies ----------------------------------------------------------------

export function quickLabel({ from = '', subject = '', body = '' }) {
  if (/mailer-daemon|postmaster|mail delivery subsystem/i.test(from) || /delivery status notification|undeliver|mail delivery failed|returned mail|address not found/i.test(subject))
    return 'bounce';
  if (/out of (the )?office|automatic reply|auto-?reply|away from (my|the) (desk|office)|on vacation/i.test(subject + ' ' + body.slice(0, 300)))
    return 'auto_reply';
  const first = body.trim().split('\n')[0].trim();
  if (/^(no\.?|stop\.?|unsubscribe|remove( me)?|take me off|please remove|do not (email|contact)|don't (email|contact)|not interested)\b/i.test(first))
    return 'unsubscribe';
  return '';
}

const READER = `You read replies to a founder's cold email and help answer them.
Labels: interested (wants to see more, asks for the video/demo/link, asks price), question (asks something before deciding), not_now (maybe later, busy, wrong time), unsubscribe (asks not to be emailed, any wording), wrong_person (not them, try someone else), angry (complains, calls it spam), auto_reply.
Draft an answer for interested, question and wrong_person only, under 90 words, plain, honest, using only facts from the product file. For interested, include the product link. Never promise features not in the product file.
Return JSON: {"label": "...", "summary": "one line", "answer": "..." }`;

export async function readReply({ product, prospect, reply }) {
  const quick = quickLabel(reply);
  if (quick) return { label: quick, summary: '', answer: '' };
  const out = await ai(READER, `${productFile(product)}\nPRODUCT LINK: ${landingLink(product, prospect.segment)}\n\nPROSPECT:\n${prospectFacts(prospect)}\n\nTHEIR REPLY:\n${reply.body.slice(0, 3000)}`, { temperature: 0.2 });
  const labels = ['interested', 'question', 'not_now', 'unsubscribe', 'wrong_person', 'angry', 'auto_reply'];
  return { label: labels.includes(out.label) ? out.label : 'question', summary: out.summary || '', answer: out.answer || '' };
}

// ---- Learner ----------------------------------------------------------------
// Until every angle has 100 sends, rotate evenly. After that, mostly send the best one.
export function pickAngle(angles, stats, rand = Math.random) {
  if (!angles.length) return '';
  const s = id => stats[id] || { sent: 0, positive: 0 };
  const under = angles.filter(a => s(a.id).sent < 100);
  if (under.length) return under.sort((a, b) => s(a.id).sent - s(b.id).sent)[0].id;
  if (rand() < 0.2) return angles[Math.floor(rand() * angles.length)].id;
  const rate = a => (s(a.id).positive + 1) / (s(a.id).sent + 2);
  return [...angles].sort((a, b) => rate(b) - rate(a))[0].id;
}
