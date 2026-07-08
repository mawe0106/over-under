-- Over/Under — Supabase schema.
-- Paste this whole file into your Supabase project's SQL Editor and run it once.
--
-- Design: one row per room, with the whole game state as a jsonb document.
-- All writes go through the RPCs below (SECURITY DEFINER), which keeps the
-- racy bits (joining, betting, grabbing the stopwatch) atomic. Clients only
-- have SELECT on the table itself, which Realtime needs to broadcast changes.

create table if not exists public.rooms (
  code       text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

drop policy if exists "anyone can read rooms" on public.rooms;
create policy "anyone can read rooms"
  on public.rooms for select
  to anon, authenticated
  using (true);

-- Broadcast row changes to subscribed phones.
do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then
  null;
end $$;

-- Shared clock: every phone computes its offset against this once, so the
-- stopwatch is elapsed = serverNow - startAt on all devices, immune to drift.
create or replace function public.server_now_ms()
returns bigint
language sql stable
as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- Create a room; opportunistically sweeps rooms idle for 24h+.
-- Returns false on a code collision so the client can retry with a new code.
create or replace function public.create_room(p_code text, p_state jsonb)
returns boolean
language plpgsql security definer
as $$
begin
  delete from public.rooms where updated_at < now() - interval '24 hours';
  insert into public.rooms (code, state) values (p_code, p_state);
  return true;
exception when unique_violation then
  return false;
end $$;

create or replace function public.get_room(p_code text)
returns jsonb
language sql stable security definer
as $$
  select state from public.rooms where code = p_code;
$$;

-- Full-document save, used for phase transitions (start round, lock
-- prediction, record result, next round).
create or replace function public.save_state(p_code text, p_state jsonb)
returns void
language sql security definer
as $$
  update public.rooms
     set state = p_state, updated_at = now()
   where code = p_code;
$$;

-- Atomic player append: no-ops if a player with this id is already in.
-- Returns the (possibly updated) room state, or null if the room is gone.
create or replace function public.join_room(p_code text, p_player jsonb)
returns jsonb
language plpgsql security definer
as $$
declare
  v_state jsonb;
begin
  update public.rooms
     set state = jsonb_set(state, '{players}',
                   (state->'players') || jsonb_build_array(p_player)),
         updated_at = now()
   where code = p_code
     and not (state->'players') @>
             jsonb_build_array(jsonb_build_object('id', p_player->>'id'));
  select state into v_state from public.rooms where code = p_code;
  return v_state;
end $$;

-- Atomic per-player bet write: many phones can bet at the same instant
-- without clobbering each other (each statement is atomic in Postgres).
-- 'betting' = Over/Under calls, 'guessing' = Chugstradamus predictions.
create or replace function public.set_bet(p_code text, p_player_id text, p_bet jsonb)
returns void
language sql security definer
as $$
  update public.rooms
     set state = jsonb_set(state, array['round','bets',p_player_id], p_bet),
         updated_at = now()
   where code = p_code
     and state->>'phase' in ('betting', 'guessing');
$$;

-- Phase-only transition (e.g. betting → ready) that can't clobber a bet
-- landing in the same instant. No-ops unless the room is still in p_from.
create or replace function public.set_phase(p_code text, p_from text, p_to text)
returns void
language sql security definer
as $$
  update public.rooms
     set state = jsonb_set(state, '{phase}', to_jsonb(p_to)),
         updated_at = now()
   where code = p_code
     and state->>'phase' = p_from;
$$;

-- Stopwatch start: first phone to run this claims the clock, gets the server
-- start timestamp back, and the round flips from 'ready' to 'running'.
-- Everyone else gets null. This is the lock that stops two phones fighting
-- over Start/Stop.
create or replace function public.claim_timer(p_code text, p_player_id text, p_player_name text)
returns bigint
language plpgsql security definer
as $$
declare
  v_now  bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_rows int;
begin
  update public.rooms
     set state = jsonb_set(jsonb_set(jsonb_set(jsonb_set(state,
                   '{round,timerOwner}',     to_jsonb(p_player_id)),
                   '{round,timerOwnerName}', to_jsonb(p_player_name)),
                   '{round,startAt}',        to_jsonb(v_now)),
                   '{phase}',                '"running"'::jsonb),
         updated_at = now()
   where code = p_code
     and state->>'phase' = 'ready'
     and (state->'round'->>'timerOwner') is null;
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return v_now;
  end if;
  return null;
end $$;

grant execute on function
  public.server_now_ms(),
  public.create_room(text, jsonb),
  public.get_room(text),
  public.save_state(text, jsonb),
  public.join_room(text, jsonb),
  public.set_bet(text, text, jsonb),
  public.set_phase(text, text, text),
  public.claim_timer(text, text, text)
to anon, authenticated;
