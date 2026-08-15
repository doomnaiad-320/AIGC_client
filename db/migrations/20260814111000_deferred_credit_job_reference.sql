-- The atomic generation admission function records the deduction and creates
-- its background job in one transaction. Defer the foreign-key check until
-- commit so the job row can satisfy the reference before the transaction ends.

alter table public.credit_ledger
  alter constraint credit_ledger_job_id_fkey deferrable initially deferred;
