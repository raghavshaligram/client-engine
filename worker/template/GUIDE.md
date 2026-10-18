# How we build client sites

You are building or changing a real local business's website. It must be fast on a phone, honest, and look like it was designed for this business, not from a template. BRIEF.md has the facts. This guide is the quality bar. Work only with the files in this folder; the deployable site is the `site` folder.

## Output

- Plain static HTML, one CSS file (`site/assets/css/site.css`), and at most a little JavaScript. No frameworks, no build step, no npm, no external scripts or trackers.
- Clean URLs as folders: `site/services/water-heaters/index.html` is served at `/services/water-heaters/`. Link with root-relative paths (`/services/water-heaters/`).
- Pages: whatever BRIEF.md asks for. Default: Home, one page per service, About, Contact. Also `site/404.html`, `site/sitemap.xml` (every page, absolute URLs on `https://<www domain>`), `site/robots.txt` (allow all, with the sitemap line).
- Every page carries `<meta name="x-site-id" content="SITE ID">` (the id is in BRIEF.md). Keep it on every page you create or edit.

## Facts: the one rule that matters most

- Use only facts in BRIEF.md: services, phone, address, hours, service area, years, rating, and what the business says about itself.
- Never invent: testimonials or quotes, reviewer names, years in business, licences, certifications, insurance, awards, guarantees, warranties, prices, response times, staff names, statistics, or "serving since". If the brief doesn't say it, the site doesn't say it.
- You may show the Google rating exactly as given ("4.8 from 88 Google reviews"). Do not mark it up as review schema.
- If BRIEF.md says to hide the street address, show the city only, everywhere, including structured data.
- No placeholder text of any kind. If a fact is missing, write around it.

## Design

- Start from the mockup direction in BRIEF.md (style family, headline, structure) and the client's own preferences. Make it feel specific to this trade and town: the hero should open with what a customer of this business most needs (for trades usually the phone number and the main service; for clinics booking and reassurance; for salons the look and booking; for firms credibility and a clear first step).
- Pick a deliberate palette (4 to 6 colours, AA contrast for text) and at most one Google Font family in at most two weights, loaded with `display=swap`, or a good system font stack. Use the client's brand colours if given.
- Avoid template tells: identical rounded cards with soft grey shadows everywhere, gradient blobs, ALL-CAPS eyebrow labels over every heading, emoji icons, stock-photo looks. One memorable element; everything else calm.
- Mobile first. Tap targets at least 44px. On phones, a call button stays easy to reach (a slim sticky bar for trades and clinics).
- Visible keyboard focus, `prefers-reduced-motion` respected, real `<button>`/`<a>` elements, labels on every form field, `alt` text on every meaningful image (empty alt for decorative ones), one `<h1>` per page.

## Images

- Only images in `site/assets/img` (the client's uploads and photos from their current site). Never hotlink, never use stock or AI images, never reference an image that isn't in that folder.
- Always set `width` and `height`, use `loading="lazy"` below the fold, and `fetchpriority="high"` on the hero image if there is one. If there are no photos, design without them (type, colour, shapes); that is fine.
- A logo file named `current-logo` or an upload with "logo" in its name is their logo; use it in the header if it looks like a logo.

## Speed (we check with Google PageSpeed on mobile: 80+ performance, 90+ SEO, 85+ accessibility)

- One CSS file, under 40 KB. JavaScript only if needed, under 10 KB, loaded with `defer`.
- No layout shift: dimensions on images, fonts with fallbacks of similar size.
- No file over 600 KB.

## Local SEO

- Titles: `Service in City | Business` style, under 60 characters, unique per page. Meta descriptions: under 155 characters, unique, plain.
- `<link rel="canonical">` on every page with the absolute `https://www.<domain>` URL.
- Each service page: what the service is, when people need it, what the business does (from the brief), the service area, and a clear call to action. 300 to 600 words, written for people first. Link services to each other where it helps.
- Home page and Contact page: `LocalBusiness` JSON-LD (use the most specific schema.org type, e.g. `Plumber`, `Dentist`, `HairSalon`) with name, url, telephone, address (or just locality if hidden), areaServed, openingHoursSpecification if hours are known, and logo/image if available. No `aggregateRating`, no `review`.
- Name, phone and address written the same way everywhere.

## Contact form

- On the Contact page (and optionally the home page): a form with `method="post"`, `action` set to the endpoint in BRIEF.md, and `data-form`. Fields: `name`, `email`, `phone`, `message`, a hidden `page` field with the page path, and a honeypot field named `company` that is visually hidden (`class="hp"`, `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"`).
- Include `<script src="/assets/form.js" defer></script>` on pages with a form. It sends the form without leaving the page and shows the thank-you message in the element with `data-form-status`.
- Next to the form, the phone number as a `tel:` link, and the hours.

## Footer

- Business name, phone (`tel:` link), address or city, hours, links to main pages, and the current year. A small "Website by <studio name from BRIEF.md>" line is fine; no link.

## Blog articles (Growth clients)

- One article per job at `site/blog/<slug>/index.html`, plus `site/blog/index.html` listing all articles newest first. Same design as the rest of the site.
- Aim at the target search in BRIEF.md. 900 to 1,400 words. Practical and specific to the business's services and area: what it is, signs you need it, what affects cost (no invented prices), how to choose, what the business does. Write for a homeowner or customer, not for Google.
- No invented statistics, prices, quotes or studies. If you state a general fact, keep it general and true.
- A short FAQ section (3 questions) at the end, internal links to 1 to 3 relevant service pages, and a call to action with the phone number.
- `Article` JSON-LD with headline, datePublished (today), author as the business. Add the page to `sitemap.xml`.
- Do not rewrite or delete other articles.

## Changes and edits

- When the brief lists changes, make exactly those changes and keep everything else as it is. Don't redesign what nobody asked to change.

## Finish

- Re-read every page you touched for broken links, missing files, placeholders and invented facts.
- Write `SUMMARY.md` as the job asks.
