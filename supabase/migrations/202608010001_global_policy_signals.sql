begin;

alter table public.global_signal_recommendations
    add column if not exists role text,
    add column if not exists base_weight_percentage numeric,
    add column if not exists adjustment_percentage numeric,
    add column if not exists signal_action text,
    add column if not exists reason text;

alter table public.global_signal_recommendations
    drop constraint if exists global_signal_recommendations_role_check;
alter table public.global_signal_recommendations
    add constraint global_signal_recommendations_role_check
    check (
        role is null
        or role in ('strategic_core', 'growth_satellite', 'em_satellite', 'cash')
    );

do $$
begin
    if to_regprocedure('public.ingest_market_signal_run_v3(uuid,jsonb)') is null then
        execute 'alter function public.ingest_market_signal_run(uuid, jsonb) rename to ingest_market_signal_run_v3';
    end if;
end;
$$;

create or replace function public.ingest_market_signal_run(p_user_id uuid, p_run jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_row jsonb;
begin
    perform public.ingest_market_signal_run_v3(p_user_id, p_run);

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_run->'global_recommendations', '[]'::jsonb))
    loop
        update public.global_signal_recommendations
        set role = nullif(v_row->>'role', ''),
            base_weight_percentage = nullif(v_row->>'base_weight_pct', '')::numeric,
            adjustment_percentage = nullif(v_row->>'adjustment_pct', '')::numeric,
            signal_action = nullif(v_row->>'signal_action', ''),
            reason = nullif(v_row->>'reason', '')
        where user_id = p_user_id
          and run_id = (p_run->>'run_id')::uuid
          and instrument = v_row->>'instrument';
    end loop;
end;
$$;

create or replace function public.restore_global_policy_signal_details(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;

    for v_row in
        select value
        from jsonb_array_elements(
            coalesce(p_backup->'data'->'global_signal_recommendations', '[]'::jsonb)
        )
    loop
        update public.global_signal_recommendations
        set role = nullif(v_row->>'role', ''),
            base_weight_percentage = nullif(v_row->>'base_weight_percentage', '')::numeric,
            adjustment_percentage = nullif(v_row->>'adjustment_percentage', '')::numeric,
            signal_action = nullif(v_row->>'signal_action', ''),
            reason = nullif(v_row->>'reason', '')
        where user_id = v_user_id
          and id = (v_row->>'id')::uuid;
    end loop;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v8(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'Authentication required.';
    end if;
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer, 0) not in (1, 2, 3, 4, 5) then
        raise exception 'Unsupported backup format';
    end if;

    perform public.restore_complete_portfolio_backup_v7(p_backup);
    perform public.restore_global_policy_signal_details(p_backup);
end;
$$;

revoke all on function public.ingest_market_signal_run_v3(uuid, jsonb)
    from public, anon, authenticated;
revoke all on function public.ingest_market_signal_run(uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.ingest_market_signal_run(uuid, jsonb)
    to service_role;

revoke all on function public.restore_global_policy_signal_details(jsonb)
    from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v8(jsonb)
    from public, anon;
grant execute on function public.restore_complete_portfolio_backup_v8(jsonb)
    to authenticated;

commit;
