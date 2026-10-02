# Supabase security checklist

The publishable key in `index.html` is public by design. What actually protects the
dealership data is Row Level Security (RLS) in Supabase. Check these in the Supabase
dashboard (SQL editor) before relying on the app.

## 1. RLS is on for every table

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('vehicles', 'expenses', 'acquisitions');
```

Every row must say `true`. If not:

```sql
alter table public.vehicles     enable row level security;
alter table public.expenses     enable row level security;
alter table public.acquisitions enable row level security;
```

## 2. Signed-out visitors get nothing

```sql
revoke all on public.vehicles, public.expenses, public.acquisitions from anon;
```

(On 2026-10-01 an unauthenticated write to `expenses` was rejected with
`permission denied ... code 42501`, so this already looks right for that table.
Confirm the other two.)

## 3. Only your team can read and write

The app treats all signed-in users as one dealership. If that's right, the
simplest safe policy is "any signed-in user", **with public sign-ups turned off**
(Authentication → Providers → Email → disable "Allow new users to sign up"):

```sql
-- repeat for expenses and acquisitions
create policy "team can read"   on public.vehicles for select to authenticated using (true);
create policy "team can insert" on public.vehicles for insert to authenticated with check (true);
create policy "team can update" on public.vehicles for update to authenticated using (true) with check (true);
create policy "team can delete" on public.vehicles for delete to authenticated using (true);
```

If sign-ups are open, anyone could make an account and see everything. In that
case restrict policies to a list of allowed user IDs or a `dealership_members` table.

## 4. Password reset link

For "Forgot password?" to work, add the site URL (for example
`https://<you>.github.io/automedusa/`) under
Authentication → URL Configuration → Redirect URLs.
