-- The legacy credit transaction projection is written by the same atomic
-- deduction function and therefore needs the same commit-time job check.

alter table public.credit_transactions
  alter constraint credit_transactions_job_id_fkey deferrable initially deferred;
