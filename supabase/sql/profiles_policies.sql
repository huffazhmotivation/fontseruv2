-- Recommended RLS policies for public.profiles used by the FontSeru login
-- popup. Run this once in the Supabase SQL editor for this project.
--
-- Table shape (already created):
--   id uuid primary key references auth.users(id)
--   email text
--   plan text check (plan in ('free','pro')) default 'free'
--   created_at timestamptz default now()

alter table public.profiles enable row level security;

-- 1) A signed-in user can read their own profile (used to show Free/Pro
--    status in the account menu after login).
create policy if not exists "profiles: read own row"
on public.profiles for select
to authenticated
using (auth.uid() = id);

-- 2) A signed-in user may create their own row exactly once, and only ever
--    as 'free'. This is the safety net the app uses right after a brand-new
--    user's first magic-link login, in case no DB trigger already does it.
create policy if not exists "profiles: insert own row as free"
on public.profiles for insert
to authenticated
with check (auth.uid() = id and plan = 'free');

-- 3) Anonymous (pre-login) lookup of plan by email, needed for the "PRO"
--    button to check `plan = 'pro'` before a session exists. Only `plan`
--    is selected by the client, but RLS is row-based, not column-based, so
--    this policy exposes full rows to anon SELECT queries on this table.
--    If you'd rather not do that, replace this policy with a SECURITY
--    DEFINER RPC function (e.g. `is_pro_email(email text) returns boolean`)
--    and call `supabase.rpc('is_pro_email', { email })` from
--    src/auth/AuthProvider.tsx instead.
create policy if not exists "profiles: anon can check plan by email"
on public.profiles for select
to anon
using (true);

-- Never grant anon/authenticated UPDATE or DELETE on this table from the
-- client — plan changes (free -> pro) should only happen from a trusted
-- server context (e.g. Supabase dashboard, an admin RPC, or a webhook),
-- never from frontend code using the publishable key.
