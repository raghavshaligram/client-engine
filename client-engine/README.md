# Client Engine

Finds prospects for PDFMacro, KeepHOA and RingSparrow, reads their websites, writes one checked email at a time, sends from your Google Workspace inboxes, follows up, reads replies and learns which angle wins. Once set up it runs on its own: you answer interested replies and read a 9am summary.

## How the autopilot runs

| What | Where | When |
|---|---|---|
| Find businesses (Google Maps scraper) | Your computer, Windows scheduled task | 1:30am nightly, only for products with fewer than 150 people ready |
| Read websites, write and check drafts | Netlify, `autopilot-research` | Every 10 minutes |
| Approve drafts | Netlify | You approve the first 50 first emails per product. After that, once you're editing fewer than 15%, drafts scored 8+ go out on their own |
| Warm up new inboxes | Netlify, `autopilot-send` | 14 days of inbox-to-inbox emails and replies, then it keeps going at 8 a day |
| Send and follow up | Netlify, `autopilot-send` | Every 10 minutes, weekdays 8am to 5pm US Central. Cold email starts at 5 a day after warm-up and rises by 2 every 3 days up to your maximum |
| Read replies | Netlify, `autopilot-send` | Every 10 minutes. Opt-outs, bounces and "not now" are handled; interested replies email you straight away |
| Morning summary | Netlify, `autopilot-digest` | 9:00am India time |
| Mark customers | Your products' licence servers call `purchase.record` | On each purchase |

- **Netlify** hosts the app (`public/index.html`) and its server (`netlify/functions/api.mjs`).
- **Supabase** is its memory: prospects, emails, replies, the do-not-contact list.
- **OpenAI** writes and checks the emails and reads the replies.
- **Gmail** sends, from your browser, through inboxes on separate sending domains. Nothing sends unless you approved it.
- **The Google Maps scraper** runs on your computer with Docker (it can't run on Netlify). KeepHOA uses state registry files instead.

## Setup (about 30 minutes, once)

### 1. Supabase
1. Create a new project (separate from RingSparrow's and PDFMacro's).
2. SQL Editor → New query → paste all of `schema.sql` → Run.
3. Project settings → API: copy the **Project URL** and the **service_role** key. The service key is secret; it only ever goes into Netlify.

### 2. Google Workspace (sending on its own)
Use **one Workspace account per product** (for example getpdfmacro.com, getkeephoa.com, getringsparrow.co), each with one or two inboxes in your own name. Separate accounts matter for two reasons: warm-up emails between them travel the normal way, so they build real reputation (mail inside one Workspace account barely counts), and a problem on one product's domain can't hurt the others.

For each sending domain:
- Point the website at the product's real site (a redirect at your registrar or on Netlify), so anyone who checks the domain sees who you are.
- Add the DNS records Workspace asks for, then use **Settings → Sending domains → Check DNS** in the app. It lists anything missing (MX, SPF, DKIM, DMARC) with the exact record to add.

1. Google Cloud console → new project → APIs & Services → Library → enable **Gmail API**.
2. IAM & Admin → Service accounts → Create. Open it → Keys → Add key → JSON. Keep the file safe.
3. On the service account's Details tab, copy its **Unique ID** (a long number).
4. In **each** Workspace account's Admin console (admin.google.com) → Security → Access and data control → API controls → **Manage domain-wide delegation** → Add new. Client ID: the Unique ID. Scopes (all three, one line):
   `https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify`

   `gmail.modify` lets warm-up move its own emails out of spam and archive them. The same service account works for all three accounts.
5. From the JSON key file you need `client_email` (→ `GOOGLE_SA_EMAIL`) and `private_key` (→ `GOOGLE_SA_KEY`, paste it exactly as it appears in the file, including the `\n`s).

This lets the app send as your inboxes with no sign-in that expires and no Google app review. It can only act for users in your own Workspace.

*Optional, only for inboxes set to "From this browser":* create an OAuth client ID (Web application, your Netlify address as an authorised JavaScript origin) and set `GOOGLE_CLIENT_ID`.

### 3. GitHub and Netlify
1. Create a **private** GitHub repository and push this folder to it. `.gitignore` already keeps the scraper's `config.json`, logs and result files out.
2. Netlify → Add new site → Import an existing project → GitHub → pick the repo. Leave the build command empty; the publish directory (`public`) and functions come from `netlify.toml`. Every push to `main` then redeploys.
2. Site configuration → Environment variables. Add these, with scope including **Functions**:

| Variable | Value |
|---|---|
| `APP_KEY` | A long password you make up. You type it once per browser. |
| `SUPABASE_URL` | From step 1 |
| `SUPABASE_SERVICE_KEY` | From step 1 |
| `OPENAI_API_KEY` | Reuse LinkScout's or create one |
| `GOOGLE_SA_EMAIL` | From step 2 |
| `GOOGLE_SA_KEY` | From step 2 |
| `DIGEST_TO` | Your own email address, for the 9am summary and hot-lead alerts |
| `PURCHASE_SECRET` | Another long password you make up, for purchase reports (step 6) |
| `OPENAI_MODEL` | Optional. Defaults to `gpt-4.1-mini`; set any chat model your key can use. |
| `GOOGLE_CLIENT_ID` | Optional, only for browser-sending inboxes |

3. Deploys → Trigger deploy → Deploy site (variables only apply after a new deploy).
4. Open the site, enter the app key. Settings → Setup check shows anything missing.
5. Check the **Functions** tab lists `autopilot-send`, `autopilot-research` and `autopilot-digest` as **Scheduled**.

### 4. In the app
1. **Products**: add your name and postal address to each product (every email must carry them), and read each product file. The writer may only say what's written there.
2. **Settings → Sending inboxes**: add each inbox, which product it sends for, an optional segment (RingSparrow: one inbox for trades, one for agencies) and a maximum a day (25 is safe). Warm-up starts the moment they're saved and the Google variables are set. Tick "Already warmed elsewhere" only for inboxes that have been sending normally for weeks.

### 5. The nightly scraper (PDFMacro and RingSparrow)
1. Install Docker Desktop. In its settings, turn on **Start Docker Desktop when you sign in**.
2. Keep the `scraper` folder somewhere permanent, for example `Documents\client-engine-scraper`.
3. Copy `config.example.json` to `config.json` and fill in your Netlify address and app key.
4. Right-click `install-schedule.ps1` → Run with PowerShell. It runs every night at 1:30am, and catches up when the computer is next on if it was off.
5. In the app, Find people → pick a segment, list business types and cities → **Add these to the nightly plan**.

Each night it asks the app which searches are due, runs them, and uploads the results. Logs are in `scraper\logs`. To run it now: `Start-ScheduledTask -TaskName "Client Engine scraper"`.

KeepHOA uses state registry files instead: import them once on the Find people screen.

### 6. Purchases (so the learner knows what sells)
In each product's licence server, after a successful payment, add:
```js
await fetch('https://YOUR-CLIENT-ENGINE.netlify.app/api', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-purchase-secret': process.env.CLIENT_ENGINE_PURCHASE_SECRET },
  body: JSON.stringify({ action: 'purchase.record', email: buyerEmail, product: 'pdfmacro' }), // or 'keephoa' / 'ringsparrow'
}).catch(() => {}); // never let this block a sale
```
That secret can only mark purchases; it opens nothing else.

The scraper is [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) (MIT). Scraping Google Maps breaks Google's terms; the practical risk is Google blocking your IP for a while, so keep runs small.

## Warm-up, in detail
- Day 1 to 14: each inbox writes 3 emails a day, rising to 15, to inboxes on your other domains, during US business hours. Plain, varied notes with no links and no product talk.
- Every warm-up email gets a reply 20 to 120 minutes later. If one landed in spam, the receiving inbox moves it to the inbox and marks it important first. Both sides are then marked read and archived, so your inboxes stay clean.
- From day 15: cold email starts at 5 a day, adding 2 every 3 days up to your maximum. Warm-up continues at 8 a day.
- Settings shows each inbox's day, today's cap and how many warm-up emails were rescued from spam. A rising spam count means hold off raising the maximum.

## Your part
- **First weeks:** approve drafts in the Queue (edit freely; edits teach it your voice). After 50 approvals per product with few edits, autopilot switches on by itself. Today → Autopilot lets you force it on or off.
- **Every day:** answer the replies in your 9am email (answers are drafted). Hot leads also email you the moment they reply.
- **When sending pauses** (a complaint, or bounces over 3%): you get an email. Read it, fix the cause, press Resume on Today.

## What the brain enforces
- Drafts never send until you approve them. Every email has your name, postal address and a one-line opt-out.
- Opt-outs, bounces and complaints go on one do-not-contact list shared by all products, for ever.
- Sending pauses by itself if bounces pass 3% or anyone complains, until you resume it.
- Cold email can't be sent from pdfmacro.com, keephoa.com or ringsparrow.com.
- Sequences: PDFMacro 3 emails (days 0, 3, 7), then a 90-day rest. KeepHOA 1 email plus 1 follow-up (day 7), then stop. RingSparrow 3 emails (days 0, 4, 9), then stop. Any reply ends the sequence. Edit these under Products → Rules.
- EU/UK addresses, chains and franchises, no-reply and placeholder addresses are dropped on import. RingSparrow also requires an email on the business's own domain.
- RingSparrow emails carry no tracking. KeepHOA links carry a `utm_campaign` tag per state, as in its plan.

## Tests
```
node --test test/flow.test.mjs test/autopilot.test.mjs   # server, including the autopilot, Workspace sending and digest
python3 test/browser_test.py /tmp     # clicks through the whole app with Google and Gmail mocked
```
