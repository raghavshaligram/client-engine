// Starting product files. Loaded into the database the first time the app opens.
// After that, edit them on the Products screen; these defaults are never re-applied.
// Every sentence the writer produces must trace back to these fields, so keep them true.

export const SEED_PRODUCTS = [
  {
    id: 'pdfmacro',
    name: 'PDFMacro',
    site: 'https://pdfmacro.com',
    price: '$79 once, no subscription. 3 free uses after sign-up.',
    buyer: 'Solo and small law firms. Start with family law, then immigration, personal injury, estate planning and bankruptcy.',
    pains: [
      'Filings must have account numbers, birth dates and minors\' names blacked out, and a black box drawn over text can leave the text underneath copyable.',
      'Uploading client files to online PDF tools sits badly with the duty of confidentiality.',
      'Acrobat costs a subscription every month for features a small firm uses a few times a week.',
    ].join('\n'),
    proof: [
      'Redaction removes the text and images under the box, then checks the saved file and issues a certificate showing nothing is left underneath.',
      'Files are processed in the browser on the user\'s own computer. Nothing is uploaded.',
      'Works offline after loading.',
      'About 40 PDF tools: merge, split, compress, OCR, forms, signatures, Bates-style workflows.',
    ].join('\n'),
    offer: '$79 once. 3 free uses to try it on a real file first.',
    never_say: [
      'Do not claim any customer count, testimonial, firm name, award or endorsement.',
      'Do not state what any ethics rule or court rule requires beyond: many courts require personal identifiers to be redacted from filings.',
      'Do not say it is "certified", "court-approved" or "compliant".',
      'Do not say "AI".',
    ].join('\n'),
    angles: [
      { id: 'leak', name: 'Redaction that can be proven', hook: 'Black boxes that leave the text underneath are a known embarrassment; PDFMacro removes it and issues a certificate.' },
      { id: 'local', name: 'Client files never uploaded', hook: 'Online PDF tools upload client files; PDFMacro works entirely on their own computer.' },
      { id: 'cost', name: 'One price instead of a subscription', hook: 'Acrobat is a monthly bill; PDFMacro is $79 once.' },
    ],
    segments: [
      { id: 'family', name: 'Family law', ask: 'Worth a 2-minute video showing it on a sample filing?', landing: 'https://pdfmacro.com' },
      { id: 'immigration', name: 'Immigration', ask: 'Worth a 2-minute video showing it on a sample filing?', landing: 'https://pdfmacro.com' },
      { id: 'pi', name: 'Personal injury', ask: 'Worth a 2-minute video showing it on a sample filing?', landing: 'https://pdfmacro.com' },
    ],
    rules: {
      steps: 3, gaps: [0, 3, 7], words: [120, 70, 50],
      links: [0, 0, 1], tracking: false, min_score: 3,
      reason_line: '', need_own_domain_email: false, rest_days: 90,
    },
    from_name: '',
    postal_address: '',
  },
  {
    id: 'keephoa',
    name: 'KeepHOA',
    site: 'https://keephoa.com',
    price: '$149 once for the first 100 associations, then $199. No per-unit fees.',
    buyer: 'Volunteer treasurers of self-managed HOAs and condo associations.',
    pains: [
      'Dues tracked in spreadsheets, with no clear record of what each home owes.',
      'When the treasurer changes, the books and history get lost or arrive as a pile of files.',
      'HOA software is usually a monthly subscription priced per unit.',
    ].join('\n'),
    proof: [
      'Double-entry books with separate operating and reserve funds.',
      'Books live in the HOA\'s own Google Drive or on the treasurer\'s computer. Nothing is stored on KeepHOA\'s servers.',
      'A single handoff file the next treasurer opens with no account.',
      'Owner statements, late letters, board packet and year-end reports as PDFs.',
    ].join('\n'),
    offer: '$149 once (first 100 associations), then $199.',
    never_say: [
      'Do not claim any customer count, testimonial or endorsement.',
      'Do not say it processes payments or autopay: it does not.',
      'Do not say it is reserve-study software.',
      'Outside Colorado, do not assume the HOA is self-managed: say "if your board handles the books yourselves".',
    ].join('\n'),
    angles: [
      { id: 'handoff', name: 'Clean treasurer handoff', hook: 'When the treasurer changes, the next one opens one file with the whole history.' },
      { id: 'spreadsheet', name: 'Out of the spreadsheet', hook: 'Who owes what, per home, without a spreadsheet.' },
      { id: 'once', name: 'Bought once, no per-unit fee', hook: 'One price for the association instead of a monthly per-unit fee.' },
    ],
    segments: [
      { id: 'colorado', name: 'Colorado registry', ask: 'Want to see what the year-end handoff looks like?', landing: 'https://keephoa.com' },
      { id: 'virginia', name: 'Virginia registry', ask: 'Want to see what the year-end handoff looks like?', landing: 'https://keephoa.com' },
      { id: 'managers', name: 'Management companies', ask: 'Would this be useful for the self-managed boards you advise?', landing: 'https://keephoa.com' },
    ],
    rules: {
      steps: 2, gaps: [0, 7], words: [110, 60],
      links: [1, 1], tracking: true, min_score: 0,
      reason_line: 'I found this address on the {state} public HOA registry.',
      need_own_domain_email: false, rest_days: 0,
    },
    from_name: '',
    postal_address: '',
  },
  {
    id: 'ringsparrow',
    name: 'RingSparrow',
    site: 'https://ringsparrow.com',
    price: '$79 once for one business. Agency $158 (3 client workspaces). Agency Pro $237 (10 workspaces, white label). Free level: 100 sends a month.',
    buyer: 'Trades and local businesses that live on phone calls; marketing agencies that resell a CRM to clients.',
    pains: [
      'Trades: calls land while their hands are full, and the caller rings the next company.',
      'Agencies: they pay $97 a month or more for a CRM they resell, for ever.',
    ].join('\n'),
    proof: [
      'Missed-call text-back sends their own message the moment a call goes unanswered.',
      'AI replies to texts and website chat, booking page with Google Calendar sync, campaigns, workflows, review requests.',
      'Customer list stays on their computer or in their own Google Drive. No monthly fee.',
      'Bring your own Twilio, SignalWire, Telnyx or Plivo account; a guide walks through US carrier approval (A2P).',
      'Team members unlimited. Agency licences add client workspaces; Agency Pro adds white label.',
    ].join('\n'),
    offer: 'Free level of 100 sends a month to try it. $79 once for one business; Agency $158; Agency Pro $237.',
    never_say: [
      'Do not claim any customer count, testimonial or endorsement.',
      'Never say "I called you and you did not answer" unless the prospect record says a test call was made.',
      'Do not say texting is free: they pay their carrier\'s rates.',
      'Do not say it builds websites or funnels.',
    ].join('\n'),
    angles: [
      { id: 'missed', name: 'Missed call, instant text', hook: 'The caller gets a text before they ring the next company.' },
      { id: 'nomonthly', name: 'No monthly fee', hook: 'Pay once instead of a monthly inbox tool.' },
      { id: 'resell', name: 'Resell without the monthly bill', hook: 'Client workspaces and white label on a one-time licence, instead of $97+ a month.' },
    ],
    segments: [
      { id: 'trades', name: 'Trades', ask: 'Want me to send a 2-minute walkthrough?', landing: 'https://ringsparrow.com/#calls' },
      { id: 'agencies', name: 'Agencies', ask: 'Want me to send a 2-minute walkthrough of the agency side?', landing: 'https://ringsparrow.com/#compare' },
    ],
    rules: {
      steps: 3, gaps: [0, 4, 9], words: [90, 60, 40],
      links: [0, 0, 1], tracking: false, min_score: 4,
      reason_line: '', need_own_domain_email: true, rest_days: 0,
    },
    from_name: '',
    postal_address: '',
  },
];

// The web design agency. Same pipeline as the products above (find, read, score, write, send),
// plus the agency stages: audit, mockup, closing, payment, intake, build, review, launch, Growth.
export const AGENCY_PRODUCT = {
  id: 'websites',
  name: 'Website Studio',
  site: '',
  price: 'Website: $497 one time. Growth: $149 a month, optional, cancel any time.',
  buyer: 'Owners of established US local businesses (home services, health, beauty, professional services) whose website is old, slow or broken on phones.',
  pains: [
    'Most of their customers find them on a phone, and the site is slow or broken there, so callers go to the next result.',
    'The site looks dated (old copyright year, no HTTPS, old builder), which costs trust before anyone calls.',
    'Agencies quote $3,000 to $10,000 and weeks of meetings for a new site.',
  ].join('\n'),
  proof: [
    'A new site of up to 5 pages: home, services, about, contact and one more page they choose.',
    'Built mobile-first and fast, checked against Google PageSpeed before they see it.',
    'Local SEO basics: one page per main service, Google-friendly structure, business details marked up for Google.',
    'A contact form that emails them each enquiry.',
    'Hosting included with no monthly fee. They own the site files.',
    'Delivered about 7 days after they send their details. Two rounds of changes included.',
    'Before paying anything, they get a free mockup of their new home page.',
    'Growth ($149 a month, optional): 4 new articles a month aimed at local Google searches, small edits within 2 business days, a monthly report of form enquiries. Cancel any time.',
  ].join('\n'),
  offer: 'A free home page mockup first. If they like it: $497 one time for the full site. Growth is optional.',
  never_say: [
    'Do not claim any customer count, portfolio, testimonial, award or past client.',
    'Never promise rankings, traffic, calls or revenue.',
    'Do not say the mockup already exists unless the conversation shows it was sent.',
    'Do not insult the current site or whoever built it: state the measured facts plainly.',
    'Do not mention AI in cold emails.',
    'Never ask for passwords or logins.',
    'Do not name competitors.',
  ].join('\n'),
  angles: [
    { id: 'mobile', name: 'Broken or slow on phones', hook: 'Most of their customers look them up on a phone, and the site is slow or broken there.' },
    { id: 'trust', name: 'Looks unmaintained', hook: 'An old copyright year or "Not secure" warning makes people wonder if the business is still open.' },
    { id: 'free', name: 'See it first, free', hook: 'A free mockup of their new home page, before any money or meetings.' },
  ],
  segments: [
    { id: 'trades', name: 'Home services', ask: 'Want me to put together a free mockup of a new home page for you? No cost and no call needed.', landing: '' },
    { id: 'health', name: 'Health and dental', ask: 'Want me to put together a free mockup of a new home page for your practice? No cost and no call needed.', landing: '' },
    { id: 'beauty', name: 'Salons and spas', ask: 'Want me to put together a free mockup of a new home page for you? No cost and no call needed.', landing: '' },
    { id: 'pro', name: 'Professional services', ask: 'Want me to put together a free mockup of a new home page for your firm? No cost and no call needed.', landing: '' },
  ],
  rules: {
    steps: 3, gaps: [0, 3, 8], words: [95, 60, 45],
    links: [0, 0, 0], tracking: false, min_score: 5,
    reason_line: '', need_own_domain_email: false, rest_days: 90,
    autopilot: 'on',
    agency: {
      packages: [
        { id: 'site', name: 'Website', price: 497, kind: 'once', dodo_product: '', summary: 'Up to 5 pages, mobile-first, local SEO basics, contact form, hosting included, delivered in about 7 days, 2 rounds of changes.' },
        { id: 'growth', name: 'Growth', price: 149, kind: 'monthly', dodo_product: '', summary: '4 local SEO articles a month, small edits within 2 business days, monthly enquiry report. Cancel any time.' },
      ],
      delivery_days: 7,
      revisions: 2,
      review_first: 3,        // the first N finished sites wait for your OK before the client sees them
      max_auto_messages: 10,  // per deal before payment; after that the conversation comes to you
      escalate_on_discount: true,
      faq: [
        'If asked whether AI is used: yes, we use AI tools to design and build faster, which is how the price stays low, and every site is checked against Google\'s speed and mobile tests before the client sees it.',
        'If asked for examples of past work: the mockup is built for their business, which is the best example; do not invent past clients.',
        'Domain: they keep their domain where it is. Going live takes one DNS change we walk them through. Their email is not affected.',
        'If they have no access to their domain: we explain who usually holds it (whoever built the old site, or the registrar account) and offer to wait.',
        'Payment is by card through our checkout. Nothing is charged until they choose to buy.',
        'If they want a call: offer to answer by email, and say a call can be arranged if they prefer.',
      ].join('\n'),
    },
  },
  from_name: '',
  postal_address: '',
};

SEED_PRODUCTS.push(AGENCY_PRODUCT);
