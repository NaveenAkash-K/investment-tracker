begin;

-- Credential hygiene is operational advice, not a trading-readiness gate.
-- Keep the legacy timestamp populated for compatibility with already-deployed
-- Phase 7/8 functions, so it can never block a rollout decision.
create or replace function public.ensure_swing_credentials_compatibility()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    new.credentials_rotated_at := coalesce(new.credentials_rotated_at, now());
    return new;
end;
$$;

update public.swing_automation_controls
set credentials_rotated_at = coalesce(credentials_rotated_at, now());

drop trigger if exists ensure_swing_credentials_compatibility_trigger
    on public.swing_automation_controls;
create trigger ensure_swing_credentials_compatibility_trigger
before insert or update on public.swing_automation_controls
for each row execute function public.ensure_swing_credentials_compatibility();

comment on column public.swing_automation_controls.credentials_rotated_at is
    'Legacy compatibility marker. Credential rotation is not an execution-readiness prerequisite.';

commit;
