-- Client Engine database. Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run again: it only creates what is missing.

create extension if not exists pgcrypto;

-- One row per product (PDFMacro, KeepHOA, RingSparrow). The "product file" the writer obeys.
create table if not exists products (
  id text primary key,
  name text not null,
  site text,
  price text,
  buyer text,
  pains text,
  proof text,
  offer text,
  never_say text,
  angles jsonb not null default '[]',      -- [{id, name, hook}]
  segments jsonb not null default '[]',    -- [{id, name, ask, landing}]
  rules jsonb not null default '{}',       -- steps, gaps, word limits, links, reason line, tracking, min score
  from_name text,
  postal_address text,
  paused boolean not null default false,
  paused_reason text,
  updated_at timestamptz not null default now()
);

create table if not exists prospects (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(id) on delete cascade,
  segment text,
  source text,                 -- maps | registry | manual
  source_file text,
  name text,
  email text not null,
  website text,
  phone text,
  category text,
  city text,
  state text,
  rating numeric,
  reviews int,
  units int,
  self_managed boolean,
  extra jsonb not null default '{}',
  signals jsonb not null default '{}',
  site_text text,              -- short extract the writer may quote from
  detail text,                 -- the one real detail chosen for the opener
  score int not null default 0,
  score_why text,
  status text not null default 'new', -- new | scanned | skipped | drafted | contacted | replied | interested | won | done | rest
  skip_reason text,
  step int not null default 0, -- emails sent so far
  angle text,
  sender text,
  thread_id text,
  last_message_id text,        -- RFC Message-ID of the last email we sent, for threading
  last_sent_at timestamptz,
  next_due_at timestamptz,
  rest_until timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, email)
);
create index if not exists prospects_status on prospects(product_id, status);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id) on delete cascade,
  product_id text not null,
  step int not null,
  angle text,
  subject text,
  body text,
  status text not null default 'draft', -- draft | approved | rejected | sent | failed
  check_score int,
  check_notes text,
  edited boolean not null default false,
  sender text,
  gmail_id text,
  thread_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_status on messages(product_id, status);

create table if not exists replies (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete cascade,
  product_id text,
  gmail_id text unique,
  from_addr text,
  subject text,
  body text,
  label text,                  -- interested | question | not_now | unsubscribe | wrong_person | bounce | auto_reply | angry
  answer text,
  handled boolean not null default false,
  received_at timestamptz,
  created_at timestamptz not null default now()
);

-- Opt-outs and hard bounces. Shared by every product, for ever.
create table if not exists suppression (
  email text primary key,
  reason text,
  created_at timestamptz not null default now()
);

-- Sending inboxes and other settings, as key/value.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Autopilot additions (safe on an existing database).
alter table prospects add column if not exists replies_checked_at timestamptz;
alter table messages add column if not exists auto_approved boolean not null default false;
alter table messages add column if not exists approved_at timestamptz;

-- The nightly scraper's search plan: one row per search, so each runs at most once every 90 days.
create table if not exists scrape_queries (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(id) on delete cascade,
  segment text,
  query text not null,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, query)
);
alter table scrape_queries enable row level security;

-- The server uses the service key, so Row Level Security stays on with no public policies:
-- nobody can read these tables with the public anon key.
alter table products enable row level security;
alter table prospects enable row level security;
alter table messages enable row level security;
alter table replies enable row level security;
alter table suppression enable row level security;
alter table settings enable row level security;

-- Domain warm-up: emails the sending inboxes trade with each other.
create table if not exists warmup (
  id uuid primary key default gen_random_uuid(),
  from_addr text not null,
  to_addr text not null,
  subject text,
  message_id text,
  thread_id text,
  sent_at timestamptz not null default now(),
  reply_after timestamptz,
  replied_at timestamptz,
  landed_spam boolean,
  cleaned boolean not null default false,
  error text
);
create index if not exists warmup_from on warmup(from_addr, sent_at);
alter table warmup enable row level security;
