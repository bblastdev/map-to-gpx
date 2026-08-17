-- Map to GPX — rate-limit counters for the shared-key routing proxy.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Then set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the hosting
-- environment. Without them the proxy still works, but its limiter is
-- per-instance memory and so leakier across serverless instances.

create table if not exists public.usage_counters (
  bucket     text        primary key,
  count      integer     not null default 0,
  expires_at timestamptz not null
);

create index if not exists usage_counters_expires_idx
  on public.usage_counters (expires_at);

-- Nothing but the service role should ever see these. RLS with no policy
-- denies every anon/authenticated request; the service role bypasses RLS.
alter table public.usage_counters enable row level security;

-- Increment a bucket and return its new value.
--
-- Atomic on purpose: two serverless instances bumping the same bucket at once
-- would otherwise read-modify-write over each other and let the limit drift
-- upward, which is precisely the case rate limiting exists to stop.
create or replace function public.bump_counter(p_bucket text, p_ttl_seconds integer)
returns table (count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.usage_counters where expires_at < now();

  insert into public.usage_counters as u (bucket, count, expires_at)
       values (p_bucket, 1, now() + make_interval(secs => p_ttl_seconds))
  on conflict (bucket) do update
       set count = u.count + 1
    returning u.count into v_count;

  return query select v_count;
end;
$$;

revoke all on function public.bump_counter(text, integer) from public, anon, authenticated;
