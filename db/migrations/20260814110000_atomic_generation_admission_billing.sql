-- Atomic generation admission.
--
-- Workspace capacity, credit deduction, job creation and PGMQ enqueue must
-- commit or roll back together. A provider is never called by this function;
-- the worker owns provider execution after the queued row is committed.

drop function if exists public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb
);

create or replace function public.create_and_enqueue_generation_job(
  p_workspace_id uuid,
  p_project_id uuid,
  p_canvas_id uuid,
  p_session_id uuid,
  p_thread_id text,
  p_job_type public.background_job_type,
  p_payload jsonb,
  p_user_id uuid,
  p_credits_cost integer default 0,
  p_credit_description text default null
) returns public.background_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active_count integer;
  v_job public.background_jobs;
  v_max_concurrent integer;
  v_queue_name text;
  v_raw_limit jsonb;
  v_request_user_id uuid;
  v_job_id uuid := gen_random_uuid();
  v_credit_transaction_id uuid;
begin
  v_request_user_id := private.current_user_id();

  if v_request_user_id is null or p_user_id is null or v_request_user_id <> p_user_id then
    raise exception using
      errcode = '42501',
      message = 'GENERATION_AUTHENTICATION_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = p_workspace_id
      and member.user_id = v_request_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'GENERATION_WORKSPACE_ACCESS_DENIED';
  end if;

  if p_job_type = 'image_generation'::public.background_job_type then
    v_queue_name := 'image_generation_jobs';
  elsif p_job_type = 'video_generation'::public.background_job_type then
    v_queue_name := 'video_generation_jobs';
  else
    raise exception using
      errcode = '22023',
      message = 'GENERATION_JOB_TYPE_INVALID';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'GENERATION_PAYLOAD_INVALID';
  end if;

  if coalesce(p_credits_cost, 0) < 0 then
    raise exception using
      errcode = '22023',
      message = 'CREDIT_AMOUNT_INVALID';
  end if;

  if p_project_id is not null and not exists (
    select 1
    from public.projects project
    where project.id = p_project_id
      and project.workspace_id = p_workspace_id
  ) then
    raise exception using
      errcode = '22023',
      message = 'GENERATION_PROJECT_WORKSPACE_MISMATCH';
  end if;

  if p_canvas_id is not null and not exists (
    select 1
    from public.canvases canvas
    join public.projects project on project.id = canvas.project_id
    where canvas.id = p_canvas_id
      and project.workspace_id = p_workspace_id
      and (p_project_id is null or project.id = p_project_id)
  ) then
    raise exception using
      errcode = '22023',
      message = 'GENERATION_CANVAS_WORKSPACE_MISMATCH';
  end if;

  if p_session_id is not null and not exists (
    select 1
    from public.chat_sessions session
    join public.canvases canvas on canvas.id = session.canvas_id
    join public.projects project on project.id = canvas.project_id
    where session.id = p_session_id
      and project.workspace_id = p_workspace_id
      and (p_project_id is null or project.id = p_project_id)
      and (p_canvas_id is null or canvas.id = p_canvas_id)
  ) then
    raise exception using
      errcode = '22023',
      message = 'GENERATION_SESSION_WORKSPACE_MISMATCH';
  end if;

  -- Serialize the capacity decision and the credit reservation for a
  -- workspace. No provider work runs while this short transaction is open.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 0)
  );

  with legacy as (
    select subscription.plan::text as plan
    from public.subscriptions subscription
    where subscription.workspace_id = p_workspace_id
  ), selected_version as (
    select version.id, plan.code
    from public.workspace_billing_subscriptions subscription
    join public.billing_plan_versions version
      on version.id = subscription.plan_version_id
    join public.billing_plans plan on plan.id = version.plan_id
    where subscription.workspace_id = p_workspace_id
      and subscription.status in ('trialing', 'active', 'past_due', 'canceled')
      and (
        subscription.status <> 'canceled'
        or subscription.current_period_end is null
        or subscription.current_period_end > now()
      )
    order by subscription.created_at desc
    limit 1
  ), fallback_version as (
    select version.id, plan.code
    from public.billing_plans plan
    join public.billing_plan_versions version
      on version.plan_id = plan.id
      and version.status = 'published'
    where plan.code = case coalesce((select plan from legacy limit 1), 'free')
      when 'free' then 'free'
      when 'starter' then 'pro'
      when 'pro' then 'pro'
      when 'ultra' then 'team'
      when 'business' then 'team'
      else 'free'
    end
    limit 1
  ), resolved as (
    select * from selected_version
    union all
    select * from fallback_version
    where not exists (select 1 from selected_version)
    limit 1
  )
  select entitlement.entitlement_value
  into v_raw_limit
  from resolved
  join public.billing_plan_entitlements entitlement
    on entitlement.plan_version_id = resolved.id
  where entitlement.entitlement_key = 'generation.max_concurrent_jobs';

  if v_raw_limit is null
    or jsonb_typeof(v_raw_limit) <> 'number'
    or (v_raw_limit #>> '{}') !~ '^[1-9][0-9]*$'
  then
    raise exception using
      errcode = '22023',
      message = 'GENERATION_CONCURRENCY_ENTITLEMENT_INVALID';
  end if;

  v_max_concurrent := (v_raw_limit #>> '{}')::integer;

  select count(*)::integer
  into v_active_count
  from public.background_jobs job
  where job.workspace_id = p_workspace_id
    and job.status in ('queued', 'running');

  if v_active_count >= v_max_concurrent then
    raise exception using
      errcode = 'P0001',
      message = 'GENERATION_CONCURRENCY_LIMIT',
      detail = format('active=%s,max=%s', v_active_count, v_max_concurrent);
  end if;

  if coalesce(p_credits_cost, 0) > 0 then
    v_credit_transaction_id := public.billing_deduct_credits(
      p_workspace_id,
      p_user_id,
      p_credits_cost,
      v_job_id,
      p_credit_description,
      'job:' || v_job_id::text || ':deduct'
    );
  end if;

  insert into public.background_jobs (
    id,
    workspace_id,
    project_id,
    canvas_id,
    session_id,
    thread_id,
    queue_name,
    job_type,
    payload,
    created_by,
    credits_cost,
    credits_transaction_id
  ) values (
    v_job_id,
    p_workspace_id,
    p_project_id,
    p_canvas_id,
    p_session_id,
    p_thread_id,
    v_queue_name,
    p_job_type,
    p_payload,
    p_user_id,
    nullif(p_credits_cost, 0),
    v_credit_transaction_id
  ) returning * into v_job;

  perform pgmq.send(
    v_queue_name,
    jsonb_strip_nulls(jsonb_build_object(
      'job_id', v_job.id,
      'job_type', v_job.job_type,
      'workspace_id', v_job.workspace_id,
      'canvas_id', v_job.canvas_id,
      'session_id', v_job.session_id
    )),
    0
  );

  return v_job;
end;
$$;

revoke all on function public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb,
  uuid, integer, text
) from public, anon;
grant execute on function public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb,
  uuid, integer, text
) to authenticated, service_role;

comment on function public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb,
  uuid, integer, text
) is 'Atomically validates tenant references, reserves generation capacity, deducts credits, creates a job, and enqueues its PGMQ message.';
