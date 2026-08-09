-- Keep timestamptz values correct regardless of the database session timezone.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

alter table public.app_users
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.profiles
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.workspaces
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.workspace_members
  alter column created_at set default now();

alter table public.projects
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.canvases
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.asset_objects
  alter column created_at set default now();

alter table public.brand_kits
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.brand_kit_assets
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.home_example_categories
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.home_example_examples
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.home_discovery_categories
  alter column created_at set default now(),
  alter column updated_at set default now();

alter table public.home_discovery_cases
  alter column created_at set default now(),
  alter column updated_at set default now();

create or replace function private.bootstrap_user_foundation(
  p_user_id uuid,
  p_email text,
  p_user_meta jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_display_name text;
  v_workspace_name text;
begin
  v_display_name := nullif(
    btrim(
      coalesce(
        p_user_meta ->> 'display_name',
        p_user_meta ->> 'full_name',
        p_user_meta ->> 'name',
        split_part(coalesce(p_email, ''), '@', 1)
      )
    ),
    ''
  );

  insert into public.profiles as p (id, email, display_name, avatar_url)
  values (
    p_user_id,
    p_email,
    v_display_name,
    nullif(btrim(coalesce(p_user_meta ->> 'avatar_url', '')), '')
  )
  on conflict (id) do update
    set email = coalesce(excluded.email, p.email),
        display_name = coalesce(p.display_name, excluded.display_name),
        avatar_url = coalesce(p.avatar_url, excluded.avatar_url),
        updated_at = now();

  select w.id
  into v_workspace_id
  from public.workspaces w
  where w.owner_user_id = p_user_id
    and w.type = 'personal'
  order by w.created_at
  limit 1;

  if v_workspace_id is null then
    v_workspace_name := coalesce(v_display_name, 'Personal') || ' Workspace';

    begin
      insert into public.workspaces (type, name, owner_user_id)
      values ('personal', v_workspace_name, p_user_id)
      returning id into v_workspace_id;
    exception
      when unique_violation then
        select w.id
        into v_workspace_id
        from public.workspaces w
        where w.owner_user_id = p_user_id
          and w.type = 'personal'
        order by w.created_at
        limit 1;
    end;
  end if;

  if v_workspace_id is null then
    raise exception 'bootstrap_user_foundation could not resolve personal workspace for user %', p_user_id;
  end if;

  insert into public.workspace_members as wm (workspace_id, user_id, role)
  values (v_workspace_id, p_user_id, 'owner')
  on conflict (workspace_id, user_id) do update
    set role = 'owner';

  return v_workspace_id;
end;
$$;
