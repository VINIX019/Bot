
create extension if not exists "pgcrypto"; 

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null,           
  external_id text not null,          
  created_at  timestamptz default now(),
  unique (channel, external_id)
);

create table if not exists transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  amount      numeric(10,2) not null,
  category    text not null,
  description text,
  raw_message text,                     
  occurred_at timestamptz default now(),
  created_at  timestamptz default now()
);

create index if not exists idx_tx_user_date on transactions (user_id, occurred_at);
