-- Rode isso uma vez no seu Postgres (ex: SQL editor do Supabase).

create extension if not exists "pgcrypto"; -- pra gen_random_uuid()

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null,            -- 'telegram' ou 'whatsapp'
  external_id text not null,            -- chat id (telegram) ou telefone (whatsapp)
  created_at  timestamptz default now(),
  unique (channel, external_id)
);

create table if not exists transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  amount      numeric(10,2) not null,
  category    text not null,
  description text,
  raw_message text,                     -- texto original, pra debugar/reprocessar o parser
  occurred_at timestamptz default now(),
  created_at  timestamptz default now()
);

create index if not exists idx_tx_user_date on transactions (user_id, occurred_at);
