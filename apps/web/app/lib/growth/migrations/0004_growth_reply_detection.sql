-- Reply detection. A sequence send records the RFC Message-ID Resend gave it, so a reply's
-- In-Reply-To or References can be matched to it. Receipts record the outcome of reply
-- processing as ids and codes only: never a subject, body, sender address, or header value.
alter table growth_sends add column rfc_message_id text unique
  check (rfc_message_id ~ '^<[^<>[:space:]@]+@[a-z0-9.-]+>$' and length(rfc_message_id) <= 998);

-- Receipts admitted before this migration start as pending too, so the next tick processes them.
alter table growth_inbound_receipts
  add column reply_status text not null default 'pending'
    check (reply_status in ('pending', 'matched', 'unmatched', 'ignored')),
  add column contact_id uuid references growth_contacts (id),
  add column matched_send_id uuid references growth_sends (id),
  add column reply_attempts integer not null default 0,
  add column reply_error_code text;

create index growth_inbound_receipts_reply_pending on growth_inbound_receipts (updated_at, id)
  where reply_status = 'pending';

create index growth_sends_unbound on growth_sends (updated_at, id)
  where status = 'submitted' and rfc_message_id is null;
