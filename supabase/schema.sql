-- Enable PostGIS for geospatial queries (optional, for future radius search)
-- create extension if not exists postgis;

-- Places table
create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  category text not null default 'other'
    check (category in ('restaurant','cafe','bar','shop','museum','attraction','other')),
  address text not null default '',
  city text not null default '',
  country text not null default '',
  lat double precision not null,
  lng double precision not null,
  thumbnail_url text,
  source_url text not null,
  google_place_id text,
  visited_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

-- Processing jobs table (tracks async video→place pipeline)
create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  status text not null default 'pending'
    check (status in ('pending','processing','done','failed')),
  error text,
  place_id uuid references public.places(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Row Level Security: users can only see and modify their own data
alter table public.places enable row level security;
alter table public.processing_jobs enable row level security;

create policy "Users can manage their own places"
  on public.places for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can manage their own jobs"
  on public.processing_jobs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Indexes for common queries
create index if not exists places_user_id_idx on public.places(user_id);
create index if not exists places_city_idx on public.places(city);
create index if not exists places_created_at_idx on public.places(created_at desc);
create index if not exists jobs_user_status_idx on public.processing_jobs(user_id, status);
