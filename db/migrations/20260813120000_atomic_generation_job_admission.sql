-- Admit generation work and enqueue it atomically. The workspace advisory lock
-- serializes the short capacity decision without holding locks during provider work.

CREATE INDEX IF NOT EXISTS background_jobs_active_workspace_idx
  ON public.background_jobs(workspace_id)
  WHERE status IN ('queued', 'running');

CREATE OR REPLACE FUNCTION public.create_and_enqueue_generation_job(
  p_workspace_id uuid,
  p_project_id uuid,
  p_canvas_id uuid,
  p_session_id uuid,
  p_thread_id text,
  p_job_type public.background_job_type,
  p_payload jsonb
) RETURNS public.background_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active_count integer;
  v_job public.background_jobs;
  v_max_concurrent integer;
  v_queue_name text;
  v_raw_limit jsonb;
  v_user_id uuid;
BEGIN
  v_user_id := private.current_user_id();

  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.workspace_members member
    WHERE member.workspace_id = p_workspace_id
      AND member.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'GENERATION_WORKSPACE_ACCESS_DENIED';
  END IF;

  IF p_job_type = 'image_generation'::public.background_job_type THEN
    v_queue_name := 'image_generation_jobs';
  ELSIF p_job_type = 'video_generation'::public.background_job_type THEN
    v_queue_name := 'video_generation_jobs';
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'GENERATION_JOB_TYPE_INVALID';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'GENERATION_PAYLOAD_INVALID';
  END IF;

  IF p_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.projects project
    WHERE project.id = p_project_id
      AND project.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'GENERATION_PROJECT_WORKSPACE_MISMATCH';
  END IF;

  IF p_canvas_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.canvases canvas
    JOIN public.projects project ON project.id = canvas.project_id
    WHERE canvas.id = p_canvas_id
      AND project.workspace_id = p_workspace_id
      AND (p_project_id IS NULL OR project.id = p_project_id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'GENERATION_CANVAS_WORKSPACE_MISMATCH';
  END IF;

  IF p_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.chat_sessions session
    JOIN public.canvases canvas ON canvas.id = session.canvas_id
    JOIN public.projects project ON project.id = canvas.project_id
    WHERE session.id = p_session_id
      AND project.workspace_id = p_workspace_id
      AND (p_project_id IS NULL OR project.id = p_project_id)
      AND (p_canvas_id IS NULL OR canvas.id = p_canvas_id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'GENERATION_SESSION_WORKSPACE_MISMATCH';
  END IF;

  -- Every admission for one workspace takes the same transaction-scoped lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 0)
  );

  WITH legacy AS (
    SELECT subscription.plan::text AS plan
    FROM public.subscriptions subscription
    WHERE subscription.workspace_id = p_workspace_id
  ), selected_version AS (
    SELECT version.id, plan.code
    FROM public.workspace_billing_subscriptions subscription
    JOIN public.billing_plan_versions version
      ON version.id = subscription.plan_version_id
    JOIN public.billing_plans plan ON plan.id = version.plan_id
    WHERE subscription.workspace_id = p_workspace_id
      AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
      AND (
        subscription.status <> 'canceled'
        OR subscription.current_period_end IS NULL
        OR subscription.current_period_end > pg_catalog.now()
      )
    ORDER BY subscription.created_at DESC
    LIMIT 1
  ), fallback_version AS (
    SELECT version.id, plan.code
    FROM public.billing_plans plan
    JOIN public.billing_plan_versions version
      ON version.plan_id = plan.id
      AND version.status = 'published'
    WHERE plan.code = CASE coalesce((SELECT plan FROM legacy LIMIT 1), 'free')
      WHEN 'free' THEN 'free'
      WHEN 'starter' THEN 'pro'
      WHEN 'pro' THEN 'pro'
      WHEN 'ultra' THEN 'team'
      WHEN 'business' THEN 'team'
      ELSE 'free'
    END
    LIMIT 1
  ), resolved AS (
    SELECT * FROM selected_version
    UNION ALL
    SELECT * FROM fallback_version
    WHERE NOT EXISTS (SELECT 1 FROM selected_version)
    LIMIT 1
  )
  SELECT entitlement.entitlement_value
  INTO v_raw_limit
  FROM resolved
  JOIN public.billing_plan_entitlements entitlement
    ON entitlement.plan_version_id = resolved.id
  WHERE entitlement.entitlement_key = 'generation.max_concurrent_jobs';

  IF v_raw_limit IS NULL
    OR jsonb_typeof(v_raw_limit) <> 'number'
    OR (v_raw_limit #>> '{}') !~ '^[1-9][0-9]*$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'GENERATION_CONCURRENCY_ENTITLEMENT_INVALID';
  END IF;

  v_max_concurrent := (v_raw_limit #>> '{}')::integer;

  SELECT count(*)::integer
  INTO v_active_count
  FROM public.background_jobs job
  WHERE job.workspace_id = p_workspace_id
    AND job.status IN ('queued', 'running');

  IF v_active_count >= v_max_concurrent THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'GENERATION_CONCURRENCY_LIMIT',
      DETAIL = pg_catalog.format(
        'active=%s,max=%s',
        v_active_count,
        v_max_concurrent
      );
  END IF;

  INSERT INTO public.background_jobs (
    workspace_id,
    project_id,
    canvas_id,
    session_id,
    thread_id,
    queue_name,
    job_type,
    payload,
    created_by
  ) VALUES (
    p_workspace_id,
    p_project_id,
    p_canvas_id,
    p_session_id,
    p_thread_id,
    v_queue_name,
    p_job_type,
    p_payload,
    v_user_id
  )
  RETURNING * INTO v_job;

  PERFORM pgmq.send(
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

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb
) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb
) IS 'Atomically validates tenant references, reserves workspace generation capacity, creates a job, and sends its PGMQ message.';
