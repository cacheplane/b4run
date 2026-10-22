create extension if not exists citext;
create extension if not exists pgcrypto;

create or replace function growth_set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table growth_contacts (
  id uuid primary key default gen_random_uuid(),
  email citext unique,
  email_hmac text not null unique,
  display_name text,
  source text not null,
  disclosure_version text not null,
  approved_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  posthog_distinct_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create trigger growth_contacts_set_updated_at
  before update on growth_contacts
  for each row execute function growth_set_updated_at();

create table growth_activity (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  contact_id uuid references growth_contacts (id),
  kind text not null,
  occurred_at timestamptz not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index growth_activity_contact_time on growth_activity (contact_id, occurred_at desc);

create table growth_sends (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references growth_contacts (id),
  step smallint not null check (step between 1 and 3),
  idempotency_key text not null unique,
  status text not null check (status in ('pending', 'leased', 'submitted', 'completed', 'failed', 'cancelled')),
  due_at timestamptz not null,
  lease_until timestamptz,
  lease_token uuid,
  attempts integer not null default 0,
  provider_email_id text unique,
  delivery_status text not null default 'not_submitted'
    check (delivery_status in ('not_submitted', 'submitted', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'unknown')),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index growth_sends_due on growth_sends (due_at, id) where status = 'pending';
create index growth_sends_contact on growth_sends (contact_id, step);

create trigger growth_sends_set_updated_at
  before update on growth_sends
  for each row execute function growth_set_updated_at();
