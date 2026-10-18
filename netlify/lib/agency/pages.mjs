// The pages clients see: the offer (/start), the details form (/intake), the review page (/review).
// Plain server-rendered HTML with a little script; one shared look for the studio.
import { esc } from './mockup.mjs';
import { links, conf } from './deals.mjs';
import { checkoutLink } from './dodo.mjs';

const CSS = `
:root{--bg:#F4F6F3;--surface:#FFFFFF;--ink:#14231C;--soft:#506158;--line:#D9E0DA;--accent:#0E7C5B;--accent-ink:#FFFFFF;--tint:#E3F1EA;--warn:#9A3412;--r:10px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.6 'Instrument Sans',system-ui,sans-serif}
a{color:var(--accent)}h1,h2,h3{font-family:'Instrument Serif',Georgia,serif;font-weight:400;letter-spacing:-.01em}
h1{font-size:clamp(36px,6vw,58px);line-height:1.05;margin:0 0 14px}h2{font-size:32px;line-height:1.15;margin:0 0 12px}h3{font-size:24px;margin:0 0 6px}
.wrap{max-width:980px;margin:0 auto;padding:0 20px}.narrow{max-width:720px}
.top{padding:22px 0;border-bottom:1px solid var(--line)}.top .wrap{display:flex;justify-content:space-between;align-items:center;gap:12px}
.studio{font:600 17px/1 'Instrument Sans',system-ui,sans-serif;letter-spacing:.01em}
main{padding:48px 0 72px}.lead{color:var(--soft);font-size:19px;max-width:58ch;margin:0 0 30px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--accent-ink);border:0;border-radius:var(--r);padding:14px 22px;font:600 16px/1 'Instrument Sans',system-ui,sans-serif;text-decoration:none;cursor:pointer}
.btn.quiet{background:transparent;color:var(--ink);border:1.5px solid var(--ink)}.btn[disabled]{opacity:.5;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:28px}
.card.main{border:2px solid var(--accent)}
.price{font:400 52px/1 'Instrument Serif',Georgia,serif;margin:12px 0 4px}.price small{font:500 16px 'Instrument Sans',sans-serif;color:var(--soft)}
.card ul{padding-left:20px;margin:16px 0 24px;color:var(--soft)}.card li{margin:6px 0}
.preview{display:flex;gap:18px;align-items:center;background:var(--tint);border-radius:var(--r);padding:18px 20px;margin:0 0 36px;text-decoration:none;color:var(--ink)}
.preview b{display:block}
ol.steps{counter-reset:s;list-style:none;padding:0;margin:0;display:grid;gap:18px}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:44px 1fr;gap:14px;align-items:start}
ol.steps li::before{content:counter(s);width:36px;height:36px;border-radius:50%;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-weight:600}
section{margin-top:56px}details{border-top:1px solid var(--line);padding:14px 0}details summary{cursor:pointer;font-weight:600}details p{color:var(--soft);margin:8px 0 0}
label{display:block;font-weight:600;margin:22px 0 6px}label small{font-weight:400;color:var(--soft)}
input[type=text],input[type=email],input[type=tel],textarea{width:100%;font:inherit;padding:12px 14px;border:1.5px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
textarea{min-height:110px;resize:vertical}input:focus,textarea:focus{outline:none;border-color:var(--accent)}
.checks{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:6px}.checks label{display:flex;align-items:center;gap:8px;margin:0;font-weight:400}
.note{background:var(--tint);border-radius:var(--r);padding:14px 18px;margin:0 0 24px}.note.warn{background:#FDECE3;color:var(--warn)}
.files{display:grid;gap:6px;margin-top:8px;font-size:15px;color:var(--soft)}
.frame{width:100%;height:640px;border:1px solid var(--line);border-radius:var(--r);background:#fff}
footer{border-top:1px solid var(--line);padding:26px 0 40px;color:var(--soft);font-size:14px}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
@media (max-width:640px){.frame{display:none}main{padding:32px 0 56px}}
`;

export function shell({ title, body, studio, footer = '', script = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Instrument+Serif&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header class="top"><div class="wrap"><span class="studio">${esc(studio)}</span></div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap">${footer}</div></footer>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const footerFor = product => `${esc(product.from_name || product.name)}, ${esc(product.name)}${product.postal_address ? '<br>' + esc(product.postal_address) : ''}<br>Questions? Reply to my email, any time.`;

export function messagePage(product, title, text) {
  return shell({ title, studio: product.name, footer: footerFor(product), body: `<div class="narrow"><h1>${esc(title)}</h1><p class="lead">${esc(text)}</p></div>` });
}

// ---- /start/<slug>: the packages and checkout -------------------------------------------
export function offerPage({ deal, prospect, product }) {
  const c = conf(product), L = links(deal);
  const site = c.packages.find(p => p.kind === 'once'), growth = c.packages.find(p => p.kind === 'monthly');
  const paid = !!deal.paid_at;
  const buy = (pkg, label, cls = 'btn') => pkg?.dodo_product
    ? `<a class="${cls}" href="${esc(checkoutLink(pkg.dodo_product, { email: deal.customer_email || prospect.email, name: '', deal: deal.slug, redirect: pkg.kind === 'once' ? L.intake + '?paid=1' : L.offer + '?growth=1' }))}">${esc(label)}</a>`
    : `<span class="note">Reply to my email and I'll send you a payment link.</span>`;
  const body = `
<h1>${esc(prospect.name)}'s new website</h1>
<p class="lead">${paid ? 'Your website is paid for. Growth is optional and can start any time.' : `One price, no monthly fee, live in about ${c.delivery_days} days. You review everything before it goes live.`}</p>
${deal.mockup ? `<a class="preview" href="${esc(L.mockup)}"><span><b>Your home page mockup</b>See the direction we'd start from</span></a>` : ''}
<div class="grid">
  ${site ? `<div class="card ${paid ? '' : 'main'}"><h3>${esc(site.name)}</h3><div class="price">$${site.price}<small> one time</small></div>
    <ul><li>Up to 5 pages: home, services, about, contact and one more</li><li>Built for phones first, and fast (checked with Google PageSpeed)</li><li>Local SEO basics: a page per main service, details marked up for Google</li><li>Contact form that emails you each enquiry</li><li>Hosting included, no monthly fee. You own the site</li><li>${c.revisions} rounds of changes</li></ul>
    ${paid ? '<p class="note">Paid. Thank you.</p>' : buy(site, `Get my website for $${site.price}`)}</div>` : ''}
  ${growth ? `<div class="card" id="growth"><h3>${esc(growth.name)} <small style="font:400 15px 'Instrument Sans',sans-serif;color:var(--soft)">optional</small></h3><div class="price">$${growth.price}<small> a month</small></div>
    <ul><li>4 new articles a month aimed at local Google searches</li><li>Small edits (hours, prices, photos) within 2 business days</li><li>A monthly report of the enquiries your site sent you</li><li>Cancel any time</li></ul>
    ${deal.growth_status === 'active' ? '<p class="note">Active. Thank you.</p>' : paid ? buy(growth, `Start ${growth.name}`, 'btn quiet') : '<p style="color:var(--soft);margin:0">You can add this after your site is live.</p>'}</div>` : ''}
</div>
<section><h2>How it works</h2><ol class="steps">
  <li><div><b>Pay securely.</b> Card checkout. Nothing else to sign.</div></li>
  <li><div><b>Send your details.</b> A short form for your services, hours, logo and photos. About 10 minutes.</div></li>
  <li><div><b>Review your site.</b> In about ${c.delivery_days} days you get a private link. Ask for changes or approve it.</div></li>
  <li><div><b>Go live.</b> We walk you through one DNS change at your domain company. Your email isn't affected.</div></li>
</ol></section>
<section><h2>Questions</h2>
  <details><summary>Do I keep my domain and email?</summary><p>Yes. Your domain stays where it is, and the one change we ask for only affects the website. Email keeps working as it does now.</p></details>
  <details><summary>Is there a monthly fee?</summary><p>No. Hosting is included. Growth is the only monthly option, and it's optional.</p></details>
  <details><summary>Who owns the site?</summary><p>You do. If you ever want the files, ask and we send them.</p></details>
  <details><summary>What if I don't like the first version?</summary><p>Tell us what's wrong on the review page. ${c.revisions} rounds of changes are included before you approve anything.</p></details>
  <details><summary>Can I talk to someone?</summary><p>Reply to my email with any question. If you'd rather talk, say so and we'll arrange a call.</p></details>
</section>`;
  return shell({ title: `${prospect.name}: new website`, studio: product.name, footer: footerFor(product), body });
}

// ---- /intake/<slug>: the details form -------------------------------------------------------
export function intakePage({ deal, prospect, product, justPaid }) {
  const i = deal.intake || {}, m = deal.mockup || {}, x = prospect.extra || {};
  const v = (k, d = '') => esc(i[k] ?? d);
  const services = i.services || (m.services || []).map(s => s.name).join('\n');
  const pages = i.pages || ['Home', 'Services', 'About', 'Contact'];
  const pageBox = n => `<label><input type="checkbox" name="pages" value="${n}" ${[].concat(pages).includes(n) ? 'checked' : ''}> ${n}</label>`;
  const body = `<div class="narrow">
${justPaid || deal.paid_at ? '<div class="note"><b>Payment received.</b> Thank you. This form is the last thing we need before we start.</div>' : ''}
${deal.intake_at ? '<div class="note">We have your details. You can update them here any time before we finish.</div>' : ''}
<h1>Your site details</h1>
<p class="lead">We've filled in what we already know. Fix anything that's wrong, add what's missing. Everything is optional except your services.</p>
<form id="f">
<label>Business name<input type="text" name="business_name" value="${v('business_name', prospect.name)}"></label>
<label>Phone shown on the site<input type="tel" name="phone" value="${v('phone', prospect.phone || '')}"></label>
<label>Email that should receive enquiries<input type="email" name="enquiry_email" value="${v('enquiry_email', deal.customer_email || prospect.email)}"></label>
<label>Address<input type="text" name="address" value="${v('address', x.address || '')}"></label>
<div class="checks"><label><input type="checkbox" name="hide_address" ${i.hide_address ? 'checked' : ''}> Don't show my street address (show the city only)</label></div>
<label>Areas you serve <small>(towns, neighborhoods, or a radius)</small><input type="text" name="service_area" value="${v('service_area', m.area || '')}"></label>
<label>Opening hours<input type="text" name="hours" value="${v('hours', '')}" placeholder="Mon to Fri 8 to 5, Sat 9 to 1"></label>
<label>Your services <small>(one per line; each gets its own page)</small><textarea name="services" required>${esc(services)}</textarea></label>
<label>In business since <small>(year)</small><input type="text" name="since" value="${v('since', x.audit?.since_year || '')}"></label>
<label>About you <small>(your story, who runs it, anything people should know)</small><textarea name="about">${v('about')}</textarea></label>
<label>What makes you different from others nearby?<textarea name="different">${v('different')}</textarea></label>
<label>Pages you want</label><div class="checks">${['Home', 'Services', 'About', 'Contact', 'Reviews', 'Gallery', 'FAQ', 'Service areas'].map(pageBox).join('')}</div>
<label>What did you think of the mockup? <small>(what to keep, what to change)</small><textarea name="mockup_feedback">${v('mockup_feedback')}</textarea></label>
<label>Colors or brand guidelines<input type="text" name="colors" value="${v('colors')}"></label>
<label>Websites you like the look of<input type="text" name="likes" value="${v('likes')}"></label>
<label>Your domain <small>(where the site will live)</small><input type="text" name="domain" value="${v('domain', prospect.website || '')}"></label>
<label>Your photos <small>(the more real photos, the better your site looks)</small></label>
<div class="note">Phone photos are perfect. We retouch every one (light, colour, straightening, tidying the background) without changing what's in it. The ones that work best:
<ul style="margin:8px 0 0;padding-left:20px"><li>You and your team at work</li><li>Your vans or trucks</li><li>Finished jobs you're proud of</li><li>Your shop, office or premises, inside and out</li><li>Your logo (any file is fine)</li></ul></div>
<input type="file" id="files" multiple accept="image/*,.pdf,.svg" aria-label="Choose photos to upload"><small style="color:var(--soft)">JPG, PNG, HEIC, SVG or PDF. Up to 20 files, 15 MB each.</small>
<div class="files" id="fileList"></div>
<label>Anything else?<textarea name="notes">${v('notes')}</textarea></label>
<p style="margin-top:28px"><button class="btn" id="go" type="submit">Send my details</button></p>
<p id="msg" role="status"></p>
</form></div>`;
  const script = `
const slug=${JSON.stringify(deal.slug)};const f=document.getElementById('f'),msg=document.getElementById('msg'),go=document.getElementById('go');
const files=document.getElementById('files'),list=document.getElementById('fileList');let uploaded=[];
files.onchange=async()=>{for(const file of [...files.files].slice(0,20)){if(file.size>15e6){list.insertAdjacentHTML('beforeend','<div>'+file.name+': too large (15 MB max)</div>');continue}
const row=document.createElement('div');row.textContent=file.name+': uploading';list.append(row);
try{const r=await fetch('/intake/'+slug+'/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,type:file.type,size:file.size})});const u=await r.json();if(!r.ok)throw new Error(u.error);
const put=await fetch(u.url,{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream','x-upsert':'true'},body:file});if(!put.ok)throw new Error('upload failed');uploaded.push(u.path);row.textContent=file.name+': uploaded'}catch(e){row.textContent=file.name+': '+e.message}}files.value=''};
f.onsubmit=async e=>{e.preventDefault();go.disabled=true;msg.textContent='Sending';const d=Object.fromEntries(new FormData(f));d.pages=[...f.querySelectorAll('[name=pages]:checked')].map(x=>x.value);d.hide_address=!!f.querySelector('[name=hide_address]').checked;d.files=uploaded;
try{const r=await fetch('/intake/'+slug,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json();if(!r.ok)throw new Error(j.error);msg.textContent='Thank you. We have everything we need and will email you when your site is ready to review.';}catch(err){msg.textContent='That did not send: '+err.message+'. Please try again.';go.disabled=false}};`;
  return shell({ title: `${prospect.name}: site details`, studio: product.name, footer: footerFor(product), body, script });
}

// ---- /review/<slug>: approve or ask for changes ------------------------------------------------
export function reviewPage({ deal, prospect, product }) {
  const c = conf(product);
  const left = Math.max(0, c.revisions - deal.revisions_used);
  const ready = deal.stage === 'client_review' && deal.preview_url;
  const body = !ready
    ? `<div class="narrow"><h1>${['domain', 'live'].includes(deal.stage) ? 'Approved' : 'Your site is being worked on'}</h1><p class="lead">${deal.stage === 'live' ? `It's live at https://${esc(deal.domain)}.` : deal.stage === 'domain' ? 'Thank you. The last step is the domain change we emailed you.' : "We'll email you as soon as it's ready to review."}</p></div>`
    : `<h1>Your new site</h1>
<p class="lead">Click through it on your phone and computer. Then approve it, or tell us what to change.</p>
<p><a class="btn" href="${esc(deal.preview_url)}" target="_blank" rel="noopener">Open your site</a></p>
<iframe class="frame" src="${esc(deal.preview_url)}" title="Your new site" loading="lazy"></iframe>
<div class="grid" style="margin-top:28px">
  <div class="card"><h3>Ask for changes</h3><p style="color:var(--soft);margin:0">${left ? `${left} round${left === 1 ? '' : 's'} of changes left. Put everything in one list.` : 'The included rounds are used. Send your list and we will get back to you about it.'}</p>
  <form id="ch"><label for="changes">What should change? <small>(page and what to do)</small></label><textarea id="changes" required></textarea><p><button class="btn quiet" type="submit">Send changes</button></p></form></div>
  <div class="card main"><h3>Happy with it?</h3><p style="color:var(--soft)">Approving means we move on to putting it live on your domain.</p><button class="btn" id="ok">Approve my site</button></div>
</div><p id="msg" role="status"></p>`;
  const script = ready ? `
const slug=${JSON.stringify(deal.slug)},msg=document.getElementById('msg');
async function send(d){const r=await fetch('/review/'+slug,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json();if(!r.ok)throw new Error(j.error);return j}
document.getElementById('ok').onclick=async e=>{if(!confirm('Approve your site and move on to going live?'))return;e.target.disabled=true;try{await send({approve:true});msg.textContent='Approved. Check your email for the last step.';}catch(err){msg.textContent=err.message;e.target.disabled=false}};
document.getElementById('ch').onsubmit=async e=>{e.preventDefault();const t=document.getElementById('changes').value.trim();if(!t)return;try{await send({changes:t});msg.textContent="Got it. We'll email you when the changes are ready.";e.target.querySelector('button').disabled=true}catch(err){msg.textContent=err.message}};` : '';
  return shell({ title: `${prospect.name}: review your site`, studio: product.name, footer: footerFor(product), body, script });
}
