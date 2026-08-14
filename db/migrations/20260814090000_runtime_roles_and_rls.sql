-- Runtime database roles and least-privilege grants.
--
-- The application may connect with the table owner for migrations, but every
-- request-scoped query switches to one of these NOLOGIN roles. This prevents
-- the table-owner connection from bypassing tenant RLS policies.

grant authenticated, service_role to current_user;
alter role authenticated nobypassrls;
alter role service_role bypassrls;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on all functions in schema pgmq from public, anon, authenticated;

grant usage on schema public, private to authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.canvases to authenticated;
grant select, insert, update, delete on public.asset_objects to authenticated;

grant select, update (status, canceled_at) on public.background_jobs to authenticated;
grant select, insert, update, delete on public.brand_kits to authenticated;
grant select, insert, update, delete on public.brand_kit_assets to authenticated;
grant select, insert, update, delete on public.chat_sessions to authenticated;
grant select, insert, delete on public.chat_messages to authenticated;
grant select, insert, update on public.workspace_settings to authenticated;
grant select, insert, update, delete on public.skills to authenticated;
grant select, insert, update, delete on public.skill_files to authenticated;
grant select, insert, update, delete on public.workspace_skills to authenticated;

grant select on public.credit_balances to authenticated;
grant select on public.credit_grant_batches to authenticated;
grant select on public.credit_ledger to authenticated;
grant select on public.credit_ledger_allocations to authenticated;
grant select on public.credit_transactions to authenticated;
grant select on public.daily_credit_claims to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.billing_payment_orders to authenticated;
grant select on public.billing_plans to authenticated;
grant select on public.billing_plan_versions to authenticated;
grant select on public.billing_plan_entitlements to authenticated;
grant select on public.billing_top_up_packs to authenticated;
grant select on public.workspace_billing_subscriptions to authenticated;
grant select on public.workspace_entitlement_overrides to authenticated;
grant select on public.payment_events to authenticated;

grant select on public.home_example_categories to authenticated;
grant select on public.home_example_examples to authenticated;
grant select on public.home_discovery_categories to authenticated;
grant select on public.home_discovery_cases to authenticated;

grant execute on function private.current_user_id() to authenticated;
grant execute on function private.try_parse_uuid(text) to authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.is_workspace_owner(uuid) to authenticated;
grant execute on function private.is_workspace_admin_or_owner(uuid) to authenticated;
grant execute on function private.is_project_member(uuid) to authenticated;
grant execute on function private.is_project_admin_or_owner(uuid) to authenticated;
grant execute on function private.asset_object_project_matches_workspace(uuid, uuid)
  to authenticated;

grant execute on function public.create_project_with_canvas(
  uuid, text, text, text, text
) to authenticated;
grant execute on function public.create_and_enqueue_generation_job(
  uuid, uuid, uuid, uuid, text, public.background_job_type, jsonb
) to authenticated;

grant usage on schema public, private, extensions, pgmq, langgraph to service_role;
grant create on schema langgraph to service_role;
grant all privileges on all tables in schema public, langgraph, pgmq to service_role;
grant all privileges on all sequences in schema public, langgraph, pgmq to service_role;
grant execute on all functions in schema public, private, pgmq, langgraph to service_role;

-- Future server-owned objects remain unavailable to PUBLIC and are usable by
-- the trusted service role without adding broad grants to authenticated.
alter default privileges in schema public, private, pgmq, langgraph
  revoke execute on functions from public;
alter default privileges in schema public, langgraph, pgmq
  grant all privileges on tables to service_role;
alter default privileges in schema public, langgraph, pgmq
  grant all privileges on sequences to service_role;
alter default privileges in schema public, private, pgmq, langgraph
  grant execute on functions to service_role;

