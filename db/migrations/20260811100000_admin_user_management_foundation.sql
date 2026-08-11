-- User-management state and one-time administrator password reset records.
-- Existing users remain active and keep their current sessions until a later
-- management action increments auth_version.

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_by uuid,
  ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_users_status_check'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT app_users_status_check
      CHECK (status IN ('active', 'suspended', 'disabled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_users_status_reason_check'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT app_users_status_reason_check
      CHECK (
        status_reason IS NULL
        OR char_length(btrim(status_reason)) BETWEEN 3 AND 500
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_users_inactive_reason_check'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT app_users_inactive_reason_check
      CHECK (
        status = 'active'
        OR (
          status_reason IS NOT NULL
          AND status_changed_at IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_users_auth_version_check'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT app_users_auth_version_check
      CHECK (auth_version >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_users_status_changed_by_fkey'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT app_users_status_changed_by_fkey
      FOREIGN KEY (status_changed_by)
      REFERENCES public.app_users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS app_users_status_created_at_idx
  ON public.app_users(status, created_at DESC);

CREATE INDEX IF NOT EXISTS app_users_status_changed_by_idx
  ON public.app_users(status_changed_by)
  WHERE status_changed_by IS NOT NULL;

CREATE TABLE public.admin_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_password_reset_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT admin_password_reset_tokens_token_hash_check
    CHECK (char_length(btrim(token_hash)) >= 32),
  CONSTRAINT admin_password_reset_tokens_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT admin_password_reset_tokens_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT admin_password_reset_tokens_used_at_check
    CHECK (used_at IS NULL OR used_at >= created_at),
  CONSTRAINT admin_password_reset_tokens_revoked_at_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT admin_password_reset_tokens_terminal_state_check
    CHECK (NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX admin_password_reset_tokens_user_created_at_idx
  ON public.admin_password_reset_tokens(user_id, created_at DESC);

CREATE INDEX admin_password_reset_tokens_created_by_created_at_idx
  ON public.admin_password_reset_tokens(created_by, created_at DESC);

CREATE INDEX admin_password_reset_tokens_pending_expiry_idx
  ON public.admin_password_reset_tokens(expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.admin_password_reset_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_password_reset_tokens FROM PUBLIC;

COMMENT ON COLUMN public.app_users.auth_version IS
  'Increment to invalidate access tokens issued with an older auth version.';
COMMENT ON TABLE public.admin_password_reset_tokens IS
  'One-time password reset tokens issued by platform administrators; only token hashes are stored.';
