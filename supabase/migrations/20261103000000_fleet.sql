-- exp.bot fleet: people, orgs (invite-only), machines that check in with their own token,
-- machine events and an org file store. Row-level security decides who sees what; every
-- write beyond what a policy allows goes through a function below.

create extension if not exists pgcrypto with schema extensions;

-- People -------------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, coalesce(new.email, ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

create trigger on_auth_user_created after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

-- Orgs ---------------------------------------------------------------------------------

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id);

create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role text not null check (role in ('admin', 'member')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, email)
);
create index org_invites_email_idx on public.org_invites (email);

-- The caller's role in an org, or null. Security definer so policies on org_members can use
-- it without recursing into themselves.
create function public.org_role(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.org_members where org_id = p_org and user_id = (select auth.uid())
$$;

create function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.org_members where org_id = p_org and user_id = (select auth.uid()))
$$;

create function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.org_members
                 where org_id = p_org and user_id = (select auth.uid()) and role in ('owner', 'admin'))
$$;

-- The caller's email, only once confirmed.
create function public.confirmed_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(email) from auth.users where id = (select auth.uid()) and email_confirmed_at is not null
$$;

-- Machines -----------------------------------------------------------------------------

create table public.machines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
  kind text not null default 'rig' check (kind in ('rig', 'gpu', 'other')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  hostname text,
  version text,
  status jsonb not null default '{}'::jsonb,
  unique (org_id, name)
);

-- Only a hash of each token; no policy, so nobody reads it through the API.
create table public.machine_tokens (
  machine_id uuid primary key references public.machines (id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now()
);

create table public.machine_events (
  id bigint generated always as identity primary key,
  machine_id uuid not null references public.machines (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (char_length(kind) between 1 and 40),
  message text not null default '' check (char_length(message) <= 2000),
  data jsonb not null default '{}'::jsonb
);
create index machine_events_machine_idx on public.machine_events (machine_id, id desc);
create index machine_events_org_idx on public.machine_events (org_id, id desc);

-- A person may rename a machine; everything else is the machine's own check-in.
create function public.machines_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.id is distinct from old.id or new.org_id is distinct from old.org_id
       or new.kind is distinct from old.kind or new.created_at is distinct from old.created_at
       or new.last_seen_at is distinct from old.last_seen_at or new.hostname is distinct from old.hostname
       or new.version is distinct from old.version or new.status is distinct from old.status) then
    raise exception 'only a machine''s name can be changed here';
  end if;
  return new;
end $$;

create trigger machines_guard before update on public.machines
  for each row execute function public.machines_guard();

-- Row-level security -------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.org_invites enable row level security;
alter table public.machines enable row level security;
alter table public.machine_tokens enable row level security;
alter table public.machine_events enable row level security;

create policy "profiles: self and org mates" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or exists (
    select 1 from public.org_members a join public.org_members b on a.org_id = b.org_id
    where a.user_id = (select auth.uid()) and b.user_id = profiles.id));
create policy "profiles: edit self" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "orgs: members read" on public.orgs for select to authenticated
  using ((select public.is_org_member(id)));
create policy "orgs: admins rename" on public.orgs for update to authenticated
  using ((select public.is_org_admin(id))) with check ((select public.is_org_admin(id)));
create policy "orgs: owners delete" on public.orgs for delete to authenticated
  using ((select public.org_role(id)) = 'owner');

create policy "members: members read" on public.org_members for select to authenticated
  using ((select public.is_org_member(org_id)));

create policy "invites: admins and the invited read" on public.org_invites for select to authenticated
  using ((select public.is_org_admin(org_id)) or email = (select public.confirmed_email()));
create policy "invites: admins and the invited delete" on public.org_invites for delete to authenticated
  using ((select public.is_org_admin(org_id)) or email = (select public.confirmed_email()));

create policy "machines: members read" on public.machines for select to authenticated
  using ((select public.is_org_member(org_id)));
create policy "machines: admins rename" on public.machines for update to authenticated
  using ((select public.is_org_admin(org_id))) with check ((select public.is_org_admin(org_id)));
create policy "machines: admins delete" on public.machines for delete to authenticated
  using ((select public.is_org_admin(org_id)));

create policy "events: members read" on public.machine_events for select to authenticated
  using ((select public.is_org_member(org_id)));

-- Grants: the API sees only what the policies allow, and writes only through functions.
revoke all on public.profiles, public.orgs, public.org_members, public.org_invites,
  public.machines, public.machine_tokens, public.machine_events from anon, authenticated;
grant select, update (display_name) on public.profiles to authenticated;
grant select, update (name), delete on public.orgs to authenticated;
grant select on public.org_members to authenticated;
grant select, delete on public.org_invites to authenticated;
grant select, update (name), delete on public.machines to authenticated;
grant select on public.machine_events to authenticated;

-- Functions people call ----------------------------------------------------------------

create function public.create_org(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.orgs (name, created_by) values (trim(p_name), auth.uid()) returning id into v_org;
  insert into public.org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');
  return v_org;
end $$;

create function public.invite_member(p_org uuid, p_email text, p_role text default 'member') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_email text := lower(trim(p_email));
begin
  if not public.is_org_admin(p_org) then raise exception 'only an org''s owners and admins invite'; end if;
  if p_role = 'admin' and public.org_role(p_org) <> 'owner' then
    raise exception 'only an owner invites an admin';
  end if;
  if exists (select 1 from public.org_members m join auth.users u on u.id = m.user_id
             where m.org_id = p_org and lower(u.email) = v_email) then
    raise exception '% is already in this org', v_email;
  end if;
  insert into public.org_invites (org_id, email, role, invited_by) values (p_org, v_email, p_role, auth.uid())
  on conflict (org_id, email) do update set role = excluded.role, invited_by = excluded.invited_by,
    created_at = now()
  returning id into v_id;
  return v_id;
end $$;

create function public.accept_invite(p_invite uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_inv public.org_invites;
begin
  select * into v_inv from public.org_invites where id = p_invite;
  if v_inv.id is null or v_inv.email is distinct from public.confirmed_email() then
    raise exception 'no such invite for this account (is its email confirmed?)';
  end if;
  insert into public.org_members (org_id, user_id, role) values (v_inv.org_id, auth.uid(), v_inv.role)
  on conflict (org_id, user_id) do nothing;
  delete from public.org_invites where id = p_invite;
  return v_inv.org_id;
end $$;

create function public.set_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  if public.org_role(p_org) is distinct from 'owner' then raise exception 'only an owner changes roles'; end if;
  if p_role not in ('owner', 'admin', 'member') then raise exception 'unknown role %', p_role; end if;
  select role into v_old from public.org_members where org_id = p_org and user_id = p_user for update;
  if v_old is null then raise exception 'not a member'; end if;
  if v_old = 'owner' and p_role <> 'owner' and
     (select count(*) from public.org_members where org_id = p_org and role = 'owner') = 1 then
    raise exception 'an org keeps at least one owner';
  end if;
  update public.org_members set role = p_role where org_id = p_org and user_id = p_user;
end $$;

-- An admin removes a member, an owner anyone, and anyone may leave; never the last owner.
create function public.remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me text := public.org_role(p_org); v_them text;
begin
  select role into v_them from public.org_members where org_id = p_org and user_id = p_user for update;
  if v_them is null then raise exception 'not a member'; end if;
  if not (p_user = auth.uid() or v_me = 'owner' or (v_me = 'admin' and v_them = 'member')) then
    raise exception 'not allowed';
  end if;
  if v_them = 'owner' and
     (select count(*) from public.org_members where org_id = p_org and role = 'owner') = 1 then
    raise exception 'an org keeps at least one owner';
  end if;
  delete from public.org_members where org_id = p_org and user_id = p_user;
end $$;

create function public.new_machine_token(p_machine uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text := 'exb_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  insert into public.machine_tokens (machine_id, token_hash)
  values (p_machine, extensions.digest(v_token, 'sha256'))
  on conflict (machine_id) do update set token_hash = excluded.token_hash, created_at = now();
  return v_token;
end $$;

-- Returns the machine's token: shown once, never stored in the clear.
create function public.create_machine(p_org uuid, p_name text, p_kind text default 'rig')
returns table (machine_id uuid, token text)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_org_admin(p_org) then raise exception 'only an org''s owners and admins add machines'; end if;
  insert into public.machines (org_id, name, kind) values (p_org, trim(p_name), p_kind) returning id into v_id;
  return query select v_id, public.new_machine_token(v_id);
end $$;

create function public.rotate_machine_token(p_machine uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select org_id into v_org from public.machines where id = p_machine;
  if v_org is null or not public.is_org_admin(v_org) then raise exception 'not allowed'; end if;
  return public.new_machine_token(p_machine);
end $$;

-- Functions machines call (with the anon key and their own token) ----------------------

create function public.machine_from_token(p_token text) returns public.machines
language sql stable security definer set search_path = '' as $$
  select m.* from public.machines m join public.machine_tokens t on t.machine_id = m.id
  where t.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
$$;

create function public.machine_checkin(p_token text, p_status jsonb default '{}'::jsonb,
                                       p_hostname text default null, p_version text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_m public.machines;
begin
  v_m := public.machine_from_token(p_token);
  if v_m.id is null then raise exception 'unknown machine token' using errcode = '28000'; end if;
  if pg_column_size(p_status) > 65536 then raise exception 'status over 64 kB'; end if;
  update public.machines set last_seen_at = now(), status = coalesce(p_status, '{}'::jsonb),
    hostname = left(p_hostname, 120), version = left(p_version, 120)
  where id = v_m.id;
  return jsonb_build_object('machine_id', v_m.id, 'org_id', v_m.org_id, 'name', v_m.name,
                            'kind', v_m.kind);
end $$;

create function public.machine_event(p_token text, p_kind text, p_message text default '',
                                     p_data jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_m public.machines; v_id bigint;
begin
  v_m := public.machine_from_token(p_token);
  if v_m.id is null then raise exception 'unknown machine token' using errcode = '28000'; end if;
  if pg_column_size(p_data) > 16384 then raise exception 'event data over 16 kB'; end if;
  insert into public.machine_events (machine_id, org_id, kind, message, data)
  values (v_m.id, v_m.org_id, left(p_kind, 40), left(coalesce(p_message, ''), 2000), coalesce(p_data, '{}'::jsonb))
  returning id into v_id;
  -- Keep the latest 2000 per machine.
  delete from public.machine_events where machine_id = v_m.id
    and id <= (select id from public.machine_events where machine_id = v_m.id
               order by id desc offset 2000 limit 1);
  return v_id;
end $$;

-- Function grants: nothing by default, then each to whom it is for.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.create_org(text), public.invite_member(uuid, text, text),
  public.accept_invite(uuid), public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid),
  public.create_machine(uuid, text, text), public.rotate_machine_token(uuid) to authenticated;
grant execute on function public.org_role(uuid), public.is_org_member(uuid), public.is_org_admin(uuid),
  public.confirmed_email() to authenticated;
grant execute on function public.machine_checkin(text, jsonb, text, text),
  public.machine_event(text, text, text, jsonb) to anon, authenticated;

-- Live updates for the fleet page --------------------------------------------------------

alter publication supabase_realtime add table public.machines, public.machine_events;

-- Files: private bucket, paths <org_id>/<machine name>/... ------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('org-files', 'org-files', false, 524288000)
on conflict (id) do nothing;

create function public.org_of_path(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;
grant execute on function public.org_of_path(text) to authenticated;

create policy "org files: members read" on storage.objects for select to authenticated
  using (bucket_id = 'org-files' and (select public.is_org_member(public.org_of_path(name))));
create policy "org files: members upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'org-files' and (select public.is_org_member(public.org_of_path(name))));
create policy "org files: admins delete" on storage.objects for delete to authenticated
  using (bucket_id = 'org-files' and (select public.is_org_admin(public.org_of_path(name))));
