-- One row per Resend received email admitted for brian@b4.run. Holds ids, status and codes
-- only: never a subject, body, or address.
create table growth_inbound_receipts (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  received_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'forwarded', 'failed', 'ignored')),
  attempts integer not null default 0,
  first_attempted_at timestamptz,
  forward_provider_id text unique,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index growth_inbound_receipts_pending on growth_inbound_receipts (updated_at, id)
  where status = 'pending';

create trigger growth_inbound_receipts_set_updated_at
  before update on growth_inbound_receipts
  for each row execute function growth_set_updated_at();
