-- Support platform admin Agent Runs views and user detail drilldowns.
CREATE INDEX IF NOT EXISTS agent_runs_created_at_idx
  ON public.agent_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_status_created_at_idx
  ON public.agent_runs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_sessions_created_by_updated_at_idx
  ON public.chat_sessions(created_by, updated_at DESC)
  WHERE created_by IS NOT NULL;
