begin;

alter table public.swing_scan_runs
    drop constraint if exists swing_scan_runs_market_regime_check;

alter table public.swing_scan_runs
    add constraint swing_scan_runs_market_regime_check
    check (market_regime in ('GREEN', 'AMBER', 'NEUTRAL', 'RED', 'UNKNOWN'));

alter table public.swing_scan_runs
    add column if not exists raw_market_regime text not null default 'UNKNOWN',
    add column if not exists regime_confirmed boolean not null default false,
    add column if not exists regime_reason text,
    add column if not exists regime_confirmation_reason text,
    add column if not exists benchmark_sma50 numeric,
    add column if not exists benchmark_sma200 numeric,
    add column if not exists benchmark_distance_200_percentage numeric,
    add column if not exists benchmark_price_date date,
    add column if not exists breadth_available integer not null default 0,
    add column if not exists breadth_coverage_percentage numeric,
    add column if not exists published_size integer not null default 0,
    add column if not exists effective_minimum_score numeric,
    add column if not exists effective_risk_percentage numeric,
    add column if not exists scan_blocked_reason text,
    add column if not exists gate_counts jsonb not null default '{}'::jsonb;

alter table public.swing_scan_runs
    drop constraint if exists swing_scan_runs_raw_market_regime_check;

alter table public.swing_scan_runs
    add constraint swing_scan_runs_raw_market_regime_check
    check (raw_market_regime in ('GREEN', 'AMBER', 'NEUTRAL', 'RED', 'UNKNOWN'));

update public.swing_scan_runs
set raw_market_regime = market_regime
where raw_market_regime = 'UNKNOWN' and market_regime <> 'UNKNOWN';

alter table public.swing_lab_settings
    alter column max_open_positions set default 2,
    alter column max_sector_positions set default 1;

-- This tracker is personal. Correct the original starter values only for the
-- approved INR 10,000 configuration; deliberate custom settings are preserved.
update public.swing_lab_settings
set max_open_positions = 2,
    max_sector_positions = least(max_sector_positions, 1),
    updated_at = now()
where trading_capital_inr <= 10000
  and max_open_positions = 5;

do $$
begin
    if to_regprocedure('public.ingest_swing_lab_scan_v1(uuid,jsonb)') is null then
        execute 'alter function public.ingest_swing_lab_scan(uuid, jsonb) rename to ingest_swing_lab_scan_v1';
    end if;
end;
$$;

create or replace function public.ingest_swing_lab_scan(p_user_id uuid, p_scan jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    perform public.ingest_swing_lab_scan_v1(p_user_id, p_scan);

    update public.swing_scan_runs
    set raw_market_regime = coalesce(nullif(p_scan->>'raw_market_regime', ''), p_scan->>'market_regime', 'UNKNOWN'),
        regime_confirmed = coalesce((p_scan->>'regime_confirmed')::boolean, false),
        regime_reason = nullif(p_scan->>'regime_reason', ''),
        regime_confirmation_reason = nullif(p_scan->>'regime_confirmation_reason', ''),
        benchmark_sma50 = nullif(p_scan->>'benchmark_sma50', '')::numeric,
        benchmark_sma200 = nullif(p_scan->>'benchmark_sma200', '')::numeric,
        benchmark_distance_200_percentage = nullif(p_scan->>'benchmark_distance_200_percentage', '')::numeric,
        benchmark_price_date = nullif(p_scan->>'benchmark_price_date', '')::date,
        breadth_available = coalesce((p_scan->>'breadth_available')::integer, 0),
        breadth_coverage_percentage = nullif(p_scan->>'breadth_coverage_percentage', '')::numeric,
        published_size = coalesce((p_scan->>'published_size')::integer, 0),
        effective_minimum_score = nullif(p_scan->>'effective_minimum_score', '')::numeric,
        effective_risk_percentage = nullif(p_scan->>'effective_risk_percentage', '')::numeric,
        scan_blocked_reason = nullif(p_scan->>'scan_blocked_reason', ''),
        gate_counts = coalesce(p_scan->'gate_counts', '{}'::jsonb)
    where id = (p_scan->>'scan_id')::uuid
      and user_id = p_user_id;
end;
$$;

create or replace function public.restore_swing_lab_v2_details(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_backup->'data'->'swing_scan_runs', '[]'::jsonb))
    loop
        update public.swing_scan_runs
        set raw_market_regime = coalesce(nullif(v_row->>'raw_market_regime', ''), v_row->>'market_regime', 'UNKNOWN'),
            regime_confirmed = coalesce((v_row->>'regime_confirmed')::boolean, false),
            regime_reason = nullif(v_row->>'regime_reason', ''),
            regime_confirmation_reason = nullif(v_row->>'regime_confirmation_reason', ''),
            benchmark_sma50 = nullif(v_row->>'benchmark_sma50', '')::numeric,
            benchmark_sma200 = nullif(v_row->>'benchmark_sma200', '')::numeric,
            benchmark_distance_200_percentage = nullif(v_row->>'benchmark_distance_200_percentage', '')::numeric,
            benchmark_price_date = nullif(v_row->>'benchmark_price_date', '')::date,
            breadth_available = coalesce((v_row->>'breadth_available')::integer, 0),
            breadth_coverage_percentage = nullif(v_row->>'breadth_coverage_percentage', '')::numeric,
            published_size = coalesce((v_row->>'published_size')::integer, 0),
            effective_minimum_score = nullif(v_row->>'effective_minimum_score', '')::numeric,
            effective_risk_percentage = nullif(v_row->>'effective_risk_percentage', '')::numeric,
            scan_blocked_reason = nullif(v_row->>'scan_blocked_reason', ''),
            gate_counts = coalesce(v_row->'gate_counts', '{}'::jsonb)
        where id = (v_row->>'id')::uuid
          and user_id = v_user_id;
    end loop;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v4(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    perform public.restore_complete_portfolio_backup_v3(p_backup);
    perform public.restore_swing_lab_v2_details(p_backup);
end;
$$;

revoke all on function public.ingest_swing_lab_scan_v1(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_scan(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_swing_lab_scan(uuid, jsonb) to service_role;

revoke all on function public.restore_swing_lab_v2_details(jsonb) from public, anon;
revoke all on function public.restore_complete_portfolio_backup_v4(jsonb) from public, anon;
grant execute on function public.restore_swing_lab_v2_details(jsonb) to authenticated;
grant execute on function public.restore_complete_portfolio_backup_v4(jsonb) to authenticated;

commit;
