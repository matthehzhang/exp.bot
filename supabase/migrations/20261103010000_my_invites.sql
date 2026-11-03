-- The invites waiting for the signed-in person, with the org's name (which they cannot read
-- from orgs until they join) and who invited them.
create function public.my_invites()
returns table (id uuid, org_id uuid, org_name text, role text, invited_by_email text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.org_id, o.name, i.role, p.email, i.created_at
  from public.org_invites i
  join public.orgs o on o.id = i.org_id
  left join public.profiles p on p.id = i.invited_by
  where i.email = public.confirmed_email()
  order by i.created_at desc
$$;
revoke execute on function public.my_invites() from public, anon;
grant execute on function public.my_invites() to authenticated;
