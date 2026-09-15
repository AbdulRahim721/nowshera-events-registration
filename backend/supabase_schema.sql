-- Nowshera Events Registration schema for Supabase PostgreSQL.
-- Run this in Supabase SQL Editor, or let the FastAPI app create it on startup.
-- The browser frontend does not talk directly to Supabase; it talks to FastAPI.

create table if not exists public.app_users (
  id bigserial primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('attendee', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id bigserial primary key,
  title text not null,
  description text not null,
  start_at timestamptz not null,
  location text not null,
  capacity integer not null check (capacity > 0),
  status text not null check (status in ('draft', 'published', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists public.registrations (
  id bigserial primary key,
  event_id bigint not null references public.events(id) on delete cascade,
  user_id bigint not null references public.app_users(id) on delete cascade,
  status text not null check (status in ('active', 'cancelled')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create unique index if not exists one_active_registration
on public.registrations(event_id, user_id)
where status = 'active';

create index if not exists registrations_event_status_idx
on public.registrations(event_id, status);

create index if not exists registrations_user_status_idx
on public.registrations(user_id, status);

create index if not exists events_status_start_at_idx
on public.events(status, start_at);

alter table public.app_users enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;

-- Keep direct Supabase Data API access closed. FastAPI uses the database connection.
revoke all on public.app_users from anon, authenticated;
revoke all on public.events from anon, authenticated;
revoke all on public.registrations from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'app_users'
      and policyname = 'app_users_no_direct_api_access'
  ) then
    create policy app_users_no_direct_api_access
    on public.app_users
    for all
    to anon, authenticated
    using (false)
    with check (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'events'
      and policyname = 'events_no_direct_api_access'
  ) then
    create policy events_no_direct_api_access
    on public.events
    for all
    to anon, authenticated
    using (false)
    with check (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'registrations'
      and policyname = 'registrations_no_direct_api_access'
  ) then
    create policy registrations_no_direct_api_access
    on public.registrations
    for all
    to anon, authenticated
    using (false)
    with check (false);
  end if;
end $$;

insert into public.app_users (name, email, password_hash, role, created_at)
values
  (
    'Admin User',
    'admin@nowshera.test',
    'QWRtaW4xMjMhLWZpeGVkLQ==:kBD8PcRKcKq39CNxNjPPTHuTeyn3qxP+v9MnWI9MRTw=',
    'admin',
    now()
  ),
  (
    'Amina Khan',
    'amina@example.com',
    'QXR0ZW5kZWUxMjMhLWZpeA==:WDHVZQw+vrm+wSTgpD9Gg7fC8P6veg/cAR8YzENrBOE=',
    'attendee',
    now()
  )
on conflict (email) do nothing;

insert into public.events (title, description, start_at, location, capacity, status, created_at)
select *
from (
  values
    (
      'Community Leadership Workshop',
      'A practical workshop for local volunteers and youth leaders.',
      '2026-10-20T10:00:00+00:00'::timestamptz,
      'Nowshera Community Hall',
      35,
      'published',
      now()
    ),
    (
      'Small Business Seminar',
      'Sessions on budgeting, marketing, and customer service for new businesses.',
      '2026-11-05T14:00:00+00:00'::timestamptz,
      'City Library Auditorium',
      60,
      'published',
      now()
    ),
    (
      'Volunteer Training Day',
      'Draft event for the operations team to prepare before publishing.',
      '2026-12-12T09:30:00+00:00'::timestamptz,
      'Training Center Room 2',
      25,
      'draft',
      now()
    )
) as seed(title, description, start_at, location, capacity, status, created_at)
where not exists (select 1 from public.events);
