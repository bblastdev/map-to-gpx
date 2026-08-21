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

-- What each day actually cost, kept after the live counter for it expires.
--
-- The counters above are deliberately short-lived: a day bucket is gone 24
-- hours after its first request, which is right for rate limiting and useless
-- for anything else. Without this table there is no way to answer "how busy
-- did it actually get" -- and that is exactly the evidence HeiGIT asks for
-- when you request a higher quota.
--
-- Note what is NOT archived: only `day:` buckets are copied here. The `ip:`
-- buckets are deleted unrecorded, because a per-visitor request count tied to
-- an IP address is personal data and this project has no business keeping it.
create table if not exists public.usage_history (
  day    date    primary key,
  routes integer not null
);

alter table public.usage_history enable row level security;

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
  -- Sweep expired counters, keeping the daily totals on the way past. A
  -- data-modifying CTE is the only way to see the rows the delete removed.
  --
  -- greatest() on conflict because the sweep can run twice for one day if a
  -- bucket is somehow re-created after archiving; the larger figure is the
  -- true one, never the later one.
  -- `count` has to be aliased: this function declares a return column of that
  -- name, so an unqualified `count` is ambiguous between the column and the
  -- plpgsql variable, and the whole function fails at runtime.
  with swept as (
    delete from public.usage_counters c
     where c.expires_at < now()
    returning c.bucket as bucket, c.count as n
  )
  insert into public.usage_history as h (day, routes)
  select substring(swept.bucket from 5)::date, swept.n
    from swept
   where swept.bucket like 'day:%'
  on conflict (day) do update
     set routes = greatest(h.routes, excluded.routes);

  insert into public.usage_counters as u (bucket, count, expires_at)
       values (p_bucket, 1, now() + make_interval(secs => p_ttl_seconds))
  on conflict (bucket) do update
       set count = u.count + 1
    returning u.count into v_count;

  return query select v_count;
end;
$$;

-- Lock the function down to the one role that should call it.
--
-- Order matters here. Postgres grants EXECUTE on new functions to PUBLIC, and
-- service_role has no grant of its own -- it inherits that one. So revoking
-- from PUBLIC takes the permission away from service_role too, and the proxy
-- gets "42501 permission denied for function bump_counter". Revoke first,
-- then grant back explicitly.
revoke all on function public.bump_counter(text, integer) from public, anon, authenticated;
grant execute on function public.bump_counter(text, integer) to service_role;

-- Every day including today, whose counter has not expired yet and so is not
-- in the history table. security_invoker keeps the view honest: without it a
-- view runs as its owner and hands out rows the table's RLS would refuse.
create or replace view public.usage_daily with (security_invoker = true) as
  select day, routes, false as partial
    from public.usage_history
   union all
  select substring(bucket from 5)::date, count, true
    from public.usage_counters
   where bucket like 'day:%';

revoke all on public.usage_daily from public, anon, authenticated;
grant select on public.usage_daily to service_role;

-- ── reading it back ───────────────────────────────────────────────────────
--
-- Paste these into the SQL editor when you want to know how busy it has been.
-- `partial` marks today, whose counter has not expired into history yet.
--
--   select * from usage_daily order by day desc limit 30;
--
-- The counter is bumped before the limit is checked, so a day that hit the
-- cap records the demand, not the number served. That is the more useful
-- figure: it is how many routes people actually asked for.
--
-- The case for a higher quota, in one row -- substitute your RATE_PER_DAY:
--
--   select count(*) filter (where routes >= 1200) as days_at_the_cap,
--          count(*)                               as days_recorded,
--          max(routes)                            as busiest_day,
--          round(avg(routes))                     as typical_day
--     from usage_daily
--    where day > current_date - 30;
--
-- Until `days_at_the_cap` is more than zero there is nothing to ask for, and
-- HeiGIT will say so -- they already have once.
