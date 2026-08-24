-- Update FREE export limit from 2x → 1x per calendar month.
--
-- Run this AFTER supabase/sql/export_usage.sql has already been applied.
-- Do NOT re-run export_usage.sql — this file does not touch the
-- `public.export_usage` table, its RLS, or `public.profiles` in any way.
-- It only replaces the two existing SECURITY DEFINER functions
-- (`get_export_usage`, `increment_export_usage`) with a new `v_limit`
-- of 1 instead of 2. Function signatures, ownership, grants, and the
-- atomic upsert-and-increment logic are all unchanged — only the limit
-- constant differs.

-- 1) Read current usage (no side effects) -------------------------------
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
  v_limit constant int := 1;
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

-- 2) Attempt to consume one export (the actual enforcement point) -------
-- Called right before the export is actually generated/downloaded in
-- src/components/FileMenu.tsx. Returns allowed = false once a FREE
-- account has already used its 1 export for the current UTC month;
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
  v_limit constant int := 1;
begin
  if v_user_id is null then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'used', 0, 'limit', v_limit, 'period', v_period);
  end if;

  select plan into v_plan from public.profiles where id = v_user_id;

  if v_plan = 'pro' then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'used', null, 'limit', null, 'period', v_period);
  end if;

  -- Atomic upsert-and-increment (unchanged from the original migration).
  insert into public.export_usage as eu (user_id, period, count)
  values (v_user_id, v_period, 1)
  on conflict (user_id, period) do update
    set count = eu.count + 1, updated_at = now()
    where eu.count < v_limit
  returning eu.count into v_count;

  if not found then
    -- Limit already reached this period: nothing was written. This read
    -- is purely for reporting the current count back to the client.
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

-- Note: users who already exported once this month under the old 2x
-- limit (i.e. count = 1) will now be at their new 1x limit and blocked
-- from exporting again until next calendar month — no backfill/reset
-- needed, existing counts are reused as-is.
