-- Rulează acest script în Supabase: SQL Editor → New query → paste → Run

create table if not exists fleet_data (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

insert into fleet_data (id, data)
values ('main', '{"cars":[],"drivers":[],"payments":{},"expenses":[],"incomes":[]}'::jsonb)
on conflict (id) do nothing;
