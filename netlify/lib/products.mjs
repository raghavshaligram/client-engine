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
