-- Export limit for FREE accounts (2x per calendar month, PRO unlimited).
-- Run this once in the Supabase SQL editor for this project.
--
-- This does NOT touch `public.profiles` or its RLS policies. It only adds
-- a new table + two SECURITY DEFINER RPC functions, following the exact
-- same pattern already used by `public.check_pro_email` in
-- src/auth/AuthProvider.tsx: the client never reads/writes the counter
-- table directly (RLS on it stays fully closed), it only ever calls these
-- two functions and receives a small JSON result back.
--
--   public.get_export_usage()       -- read-only, no side effects
--   public.increment_export_usage() -- the ONLY way the counter can advance,
--                                       and the ONLY place PRO/FREE + the
--                                       2x/month limit is actually enforced.
--                                       Uses a single atomic
--                                       INSERT ... ON CONFLICT DO UPDATE
--                                       (Postgres' race-safe upsert
--                                       mechanism) so concurrent export
--                                       clicks can never both succeed as
--                                       export #3.
--
-- Both functions compute the current plan by reading `profiles.plan`
-- themselves (as the function owner, bypassing RLS) — the client can never
-- pass its own "plan" or "period" values in, so this can't be bypassed by
-- editing client-side code or calling the API directly with different
-- arguments.

-- 1) Counter table -----------------------------------------------------
create table if not exists public.export_usage (
  user_id    uuid not null references auth.users(id) on delete cascade,
  period     text not null, -- 'YYYY-MM', UTC calendar month
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period)
);

-- RLS is enabled with NO policies for anon/authenticated: the table is
-- only ever touched by the two SECURITY DEFINER functions below (which run
-- as the function owner and therefore bypass RLS). This mirrors the
-- "SECURITY DEFINER RPC instead of a client-facing policy" approach called
-- out in supabase/sql/profiles_policies.sql.
alter table public.export_usage enable row level security;

-- 2) Read current usage (no side effects) -------------------------------
create or replace function public.get_export_usage()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan text;
  v_period text := to_char(timezone('utc', now()), 'YYYY-MM');
  v_count int;
  v_limit constant int := 2;
begin
  if v_user_id is null then
    return jsonb_build_object('unlimited', false, 'used', 0, 'limit', v_limit, 'period', v_period);
  end if;

  select plan into v_plan from public.profiles where id = v_user_id;

  if v_plan = 'pro' then
    -- PRO is never limited or counted.
    return jsonb_build_object('unlimited', true, 'used', null, 'limit', null, 'period', v_period);
  end if;

  select count into v_count
  from public.export_usage
  where user_id = v_user_id and period = v_period;

  return jsonb_build_object('unlimited', false, 'used', coalesce(v_count, 0), 'limit', v_limit, 'period', v_period);
end;
$$;

revoke all on function public.get_export_usage() from public;
grant execute on function public.get_export_usage() to authenticated;

-- 3) Attempt to consume one export (the actual enforcement point) -------
-- Called right before the export is actually generated/downloaded in
-- src/components/FileMenu.tsx. Returns allowed = false once a FREE
-- account has already used its 2 exports for the current UTC month;
-- PRO accounts always get allowed = true and are never counted.
create or replace function public.increment_export_usage()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan text;
  v_period text := to_char(timezone('utc', now()), 'YYYY-MM');
  v_count int;
  v_limit constant int := 2;
begin
  if v_user_id is null then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'used', 0, 'limit', v_limit, 'period', v_period);
  end if;

  select plan into v_plan from public.profiles where id = v_user_id;

  if v_plan = 'pro' then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'used', null, 'limit', null, 'period', v_period);
  end if;

  -- Atomic upsert-and-increment. INSERT ... ON CONFLICT DO UPDATE is a
  -- single statement that Postgres resolves atomically at the row level
  -- (via the unique index on (user_id, period)): if two exports are
  -- clicked at the same moment, the second call's conflicting upsert
  -- waits for the first to finish and then sees its already-incremented
  -- count, so the two can never both "win" as export #2. This replaces a
  -- separate `SELECT ... FOR UPDATE` + `UPDATE` pair with one atomic
  -- upsert, which is the safe, Postgres-recommended way to do a
  -- race-free counter increment.
  --
  -- The `WHERE eu.count < v_limit` guard on the conflict update makes the
  -- increment itself conditional: once the FREE limit is already reached,
  -- the conflicting UPDATE is skipped entirely (no row is written or
  -- returned), which is how the limit-reached case below is detected —
  -- without ever needing a second write.
  insert into public.export_usage as eu (user_id, period, count)
  values (v_user_id, v_period, 1)
  on conflict (user_id, period) do update
    set count = eu.count + 1, updated_at = now()
    where eu.count < v_limit
  returning eu.count into v_count;

  if not found then
    -- Limit already reached this period: the conflicting UPDATE above was
    -- skipped (its WHERE clause was false), so nothing was written. This
    -- read is purely for reporting the current count back to the client.
    select count into v_count
    from public.export_usage
    where user_id = v_user_id and period = v_period;

    return jsonb_build_object('allowed', false, 'unlimited', false, 'used', v_count, 'limit', v_limit, 'period', v_period);
  end if;

  return jsonb_build_object('allowed', true, 'unlimited', false, 'used', v_count, 'limit', v_limit, 'period', v_period);
end;
$$;

revoke all on function public.increment_export_usage() from public;
grant execute on function public.increment_export_usage() to authenticated;
