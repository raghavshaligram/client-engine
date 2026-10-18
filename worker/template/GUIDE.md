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
- Where a design skill says to fill gaps with sample content (sample names, prices, projects) or to show a live thing built on assumed data, this guide overrides it: client sites carry only real facts. The live thing uses real facts from BRIEF.md (their hours, their service towns, their services) or is left out.

## Design

The look comes from the design skills in `.claude/skills`, led by design-taste-frontend: its art direction, house rules and laws, checked by its inspector. The worker runs that inspector after you finish and sends every FAIL back to you, so treat its rules as hard requirements: no eyebrow labels, no 01/02/03 numbering, no hairline rules, no gradients, no shadows at rest, no icon-topped card rows, headlines of two lines or fewer at every width, at least four real pictures on the home page and on service pages, and a real motion layer.

What the skills cannot know about local business sites:

- The visitor's first question is "can they help me, and how do I reach them". The first screen answers it in large type: what they do, where, and the phone number or booking action. For trades and clinics, a call button stays within thumb reach on phones (a slim sticky bar is a real overlay, so a shadow on it is fine).
- Every page is a real page of the same site: one direction carried through home, every service page, about and contact. Service pages are not stripped-down templates; each gets its own picture and its own composition from the direction.
- Mobile first: tap targets at least 44px, no sideways scroll at 360px, forms usable with a thumb.
- Accessibility: visible keyboard focus, real buttons and links, labels on every form field, alt text on every meaningful picture, one h1 per page, AA contrast.

## Pictures

In order of preference:

1. The client's own photos and logo in `site/assets/img` (files starting `upload-` or `current-`). Always use the client's own photos where they fit; a logo goes in the header.
2. Generated pictures from IMAGES.json (the worker makes them).
3. Real pictures of the place from open collections via the taste skill's `assets.mjs`, credited in the footer.
4. Drawings in code from the subject itself.

Never hotlink, never reference a file that is not in `site/assets/img`. Set `width` and `height` on every image, `loading="lazy"` below the fold, `fetchpriority="high"` on the hero picture.

### Generated pictures (rules for IMAGES.json)

Generated pictures show the world around the business, never fake evidence of the business itself. This matters: a visitor must not be misled.

- Allowed: the trade's materials and tools in close-up (a copper fitting, a water heater's valve, scissors and combs on a station), the kind of place the service happens in (a sunlit Austin bungalow kitchen, a clean dental chair under daylight, a quiet salon interior), the town and its streets, hands at work with no face shown.
- Not allowed: anything presented as the client's own staff, owners, vans, uniforms, premises, finished jobs, before-and-after shots or customers; recognisable faces; real people; text, signs, logos, prices or watermarks in the picture.
- Alt text describes what is shown plainly ("Copper pipe fittings on a workbench"), never "our team" or "our work".
- Prompts: photographic, natural light, a named lens and angle, the direction's palette mood, specific to this trade and town. One clear subject per picture. Aspect chosen for where it sits on the page.

## Motion

Required, and built last on a finished still page (taste-skill references/motion.md, impeccable reference/animate.md):

- One signature move from the direction, done well (the hero line reveal, an image shutter, a scroll-linked picture).
- Section entrances choreographed per section (heading, text, picture), varied by content, once each.
- Press, hover and focus feedback on every control.
- One moving picture (a slow drift or scale on a large photograph, or a scroll-linked move).
- Transform, opacity and clip-path only. Vanilla CSS and a small script with IntersectionObserver; no libraries, no external scripts.
- Every move has a `prefers-reduced-motion` fallback, and all content is visible with JavaScript off (hide-then-reveal only under an `html.js` class set by a one-line inline script).

## Speed (we check with Google PageSpeed on mobile: 80+ performance, 90+ SEO, 85+ accessibility)

- CSS under 60 KB, JavaScript under 20 KB loaded with `defer`. At most one or two font families from Google Fonts with `display=swap`, or self-hosted.
- No layout shift: dimensions on every image, font fallbacks of similar size.
- Pictures as WebP, hero under 250 KB, others under 200 KB. No file over 600 KB.

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
