begin;

-- Honest model terminology and provenance details.
alter table public.market_signal_scores
    add column if not exists data_coverage numeric,
    add column if not exists valuation_source text,
    add column if not exists valuation_as_of date,
    add column if not exists valuation_method text;

update public.market_signal_scores
set data_coverage = confidence
where data_coverage is null;

alter table public.market_signal_scores
    alter column data_coverage set default 0,
    alter column data_coverage set not null;

alter table public.market_signal_scores
    drop constraint if exists market_signal_scores_data_coverage_check;
alter table public.market_signal_scores
    add constraint market_signal_scores_data_coverage_check
    check (data_coverage between 0 and 1);

alter table public.sip_signal_recommendations
    add column if not exists data_coverage numeric;

update public.sip_signal_recommendations
set data_coverage = confidence
where data_coverage is null;

alter table public.sip_signal_recommendations
    alter column data_coverage set default 0,
    alter column data_coverage set not null;

alter table public.sip_signal_recommendations
    drop constraint if exists sip_signal_recommendations_data_coverage_check;
alter table public.sip_signal_recommendations
    add constraint sip_signal_recommendations_data_coverage_check
    check (data_coverage between 0 and 1);

alter table public.market_events
    add column if not exists rule_evidence jsonb not null default '[]'::jsonb;

-- Duplicate display names are valid; recommendation identity is the SIP UUID.
alter table public.sip_signal_recommendations
    drop constraint if exists sip_signal_recommendations_user_id_run_id_fund_name_key;

create unique index if not exists sip_signal_recommendations_run_plan_unique_idx
    on public.sip_signal_recommendations(user_id, run_id, sip_plan_id)
    where sip_plan_id is not null;

create unique index if not exists sip_signal_recommendations_run_legacy_name_unique_idx
    on public.sip_signal_recommendations(user_id, run_id, fund_name)
    where sip_plan_id is null;

-- Store whether a snapshot has a complete monthly review or an explicit waiver.
alter table public.portfolio_snapshots
    add column if not exists monthly_review_status text not null default 'legacy_unknown';

alter table public.portfolio_snapshots
    drop constraint if exists portfolio_snapshots_monthly_review_status_check;
alter table public.portfolio_snapshots
    add constraint portfolio_snapshots_monthly_review_status_check
    check (monthly_review_status in ('complete', 'acknowledged_missing', 'legacy_unknown'));

create or replace function public.create_current_month_snapshot_v2(
    p_allow_without_review boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_month date := date_trunc('month', now() at time zone 'Asia/Kolkata')::date;
    v_category_count integer;
    v_review_count integer;
    v_review_complete boolean;
    v_snapshot_id uuid;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    select count(*) into v_category_count
    from public.asset_categories
    where user_id = v_user_id;

    select count(distinct category_id) into v_review_count
    from public.monthly_category_performance
    where user_id = v_user_id
      and performance_month = v_month;

    v_review_complete := v_category_count > 0 and v_review_count = v_category_count;
    if not v_review_complete and not coalesce(p_allow_without_review, false) then
        raise exception 'Monthly Review is incomplete (% of % categories). Complete it or explicitly acknowledge a snapshot without review.',
            v_review_count, v_category_count;
    end if;

    select public.create_current_month_snapshot() into v_snapshot_id;
    update public.portfolio_snapshots
    set monthly_review_status = case
        when v_review_complete then 'complete'
        else 'acknowledged_missing'
    end
    where id = v_snapshot_id
      and user_id = v_user_id;
    return v_snapshot_id;
end;
$$;

-- Shared Analyzer -> Tracker contract validation. One legacy unversioned
-- publisher remains accepted during staggered deployment; unknown versions fail.
create or replace function public.validate_analyzer_contract(
    p_payload jsonb,
    p_kind text
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
    v_version text;
begin
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
        raise exception 'Analyzer % payload must be a JSON object.', p_kind;
    end if;
    v_version := coalesce(nullif(p_payload->>'contract_version', ''), 'legacy-unversioned');
    if v_version not in ('legacy-unversioned', '2026-07-28.v1') then
        raise exception 'Unsupported Analyzer contract version % for %.', v_version, p_kind;
    end if;
    if p_kind not in ('market_run', 'swing_scan', 'swing_monitor', 'news_run') then
        raise exception 'Unsupported Analyzer payload kind %.', p_kind;
    end if;
    if v_version = '2026-07-28.v1' then
        if nullif(p_payload->>'as_of', '') is null
           or nullif(p_payload->>'status', '') is null
           or nullif(p_payload->>'model_version', '') is null then
            raise exception 'Analyzer % payload is missing required contract fields.', p_kind;
        end if;
        if p_kind = 'market_run' and (
            nullif(p_payload->>'run_id', '') is null
            or coalesce(p_payload->>'run_type', '') not in ('daily', 'weekly', 'monthly')
            or coalesce(p_payload->>'status', '') not in ('successful', 'partial', 'failed')
            or jsonb_typeof(coalesce(p_payload->'market_scores', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'sip_recommendations', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'global_recommendations', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'alerts', 'null'::jsonb)) <> 'array'
        ) then raise exception 'Invalid market-run contract payload.'; end if;
        if p_kind = 'swing_scan' and (
            nullif(p_payload->>'scan_id', '') is null
            or coalesce(p_payload->>'status', '') not in ('successful', 'partial', 'failed', 'no_session')
            or coalesce(p_payload->>'market_regime', '') not in ('GREEN', 'AMBER', 'RED', 'UNKNOWN')
            or coalesce(p_payload->>'session_state', '') not in ('completed', 'no_session', 'before_close', 'unknown')
            or jsonb_typeof(coalesce(p_payload->'session_matches_expected', 'null'::jsonb)) <> 'boolean'
            or jsonb_typeof(coalesce(p_payload->'candidates', 'null'::jsonb)) <> 'array'
        ) then raise exception 'Invalid Swing scan contract payload.'; end if;
        if p_kind = 'swing_monitor' and (
            nullif(p_payload->>'monitor_id', '') is null
            or coalesce(p_payload->>'status', '') not in ('successful', 'partial', 'failed', 'disabled')
            or jsonb_typeof(coalesce(p_payload->'candidate_updates', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'position_updates', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'notifications', 'null'::jsonb)) <> 'array'
        ) then raise exception 'Invalid Swing monitor contract payload.'; end if;
        if p_kind = 'news_run' and (
            nullif(p_payload->>'run_id', '') is null
            or coalesce(p_payload->>'status', '') not in ('successful', 'partial', 'failed')
            or jsonb_typeof(coalesce(p_payload->'sources', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'articles', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'events', 'null'::jsonb)) <> 'array'
            or jsonb_typeof(coalesce(p_payload->'alerts', 'null'::jsonb)) <> 'array'
        ) then raise exception 'Invalid News run contract payload.'; end if;
    end if;
    return v_version;
end;
$$;

-- Wrap the previously deployed transactional ingestion functions.
do $$
begin
    if to_regprocedure('public.ingest_market_signal_run_v2(uuid,jsonb)') is null then
        execute 'alter function public.ingest_market_signal_run(uuid, jsonb) rename to ingest_market_signal_run_v2';
    end if;
    if to_regprocedure('public.ingest_news_event_run_v2(uuid,jsonb)') is null then
        execute 'alter function public.ingest_news_event_run(uuid, jsonb) rename to ingest_news_event_run_v2';
    end if;
    if to_regprocedure('public.ingest_swing_lab_scan_v2(uuid,jsonb)') is null then
        execute 'alter function public.ingest_swing_lab_scan(uuid, jsonb) rename to ingest_swing_lab_scan_v2';
    end if;
    if to_regprocedure('public.ingest_swing_lab_monitor_v2(uuid,jsonb)') is null then
        execute 'alter function public.ingest_swing_lab_monitor(uuid, jsonb) rename to ingest_swing_lab_monitor_v2';
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
    v_version text;
    v_row jsonb;
begin
    v_version := public.validate_analyzer_contract(p_run, 'market_run');
    perform public.ingest_market_signal_run_v2(p_user_id, p_run);

    update public.market_signal_runs
    set contract_version = v_version
    where id = (p_run->>'run_id')::uuid and user_id = p_user_id;

    for v_row in
        select value from jsonb_array_elements(coalesce(p_run->'market_scores', '[]'::jsonb))
    loop
        update public.market_signal_scores
        set data_coverage = coalesce(
                nullif(v_row->'data_quality'->>'coverage', '')::numeric,
                nullif(v_row->'data_quality'->>'confidence', '')::numeric,
                0
            ),
            valuation_source = nullif(v_row->'metrics'->>'valuation_source', ''),
            valuation_as_of = nullif(v_row->'metrics'->>'valuation_as_of', '')::date,
            valuation_method = nullif(v_row->'metrics'->>'valuation_method', '')
        where user_id = p_user_id
          and run_id = (p_run->>'run_id')::uuid
          and market_key = v_row->>'key';
    end loop;

    for v_row in
        select value from jsonb_array_elements(coalesce(p_run->'sip_recommendations', '[]'::jsonb))
    loop
        update public.sip_signal_recommendations
        set data_coverage = coalesce(
            nullif(v_row->>'data_coverage', '')::numeric,
            nullif(v_row->>'confidence', '')::numeric,
            0
        )
        where user_id = p_user_id
          and run_id = (p_run->>'run_id')::uuid
          and (
              (nullif(v_row->>'tracker_sip_plan_id', '') is not null
               and sip_plan_id = (v_row->>'tracker_sip_plan_id')::uuid)
              or
              (nullif(v_row->>'tracker_sip_plan_id', '') is null
               and sip_plan_id is null and fund_name = v_row->>'fund')
          );
    end loop;
end;
$$;

create or replace function public.ingest_news_event_run(p_user_id uuid, p_run jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_version text;
    v_row jsonb;
begin
    v_version := public.validate_analyzer_contract(p_run, 'news_run');
    perform public.ingest_news_event_run_v2(p_user_id, p_run);
    update public.news_pipeline_runs
    set contract_version = v_version
    where id = (p_run->>'run_id')::uuid and user_id = p_user_id;
    for v_row in
        select value from jsonb_array_elements(coalesce(p_run->'events', '[]'::jsonb))
    loop
        update public.market_events
        set rule_evidence = coalesce(v_row->'rule_evidence', '[]'::jsonb)
        where id = (v_row->>'id')::uuid and user_id = p_user_id;
    end loop;
end;
$$;

create or replace function public.ingest_swing_lab_scan(p_user_id uuid, p_scan jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_version text;
begin
    v_version := public.validate_analyzer_contract(p_scan, 'swing_scan');
    perform public.ingest_swing_lab_scan_v2(p_user_id, p_scan);
    update public.swing_scan_runs
    set contract_version = v_version
    where id = (p_scan->>'scan_id')::uuid and user_id = p_user_id;
end;
$$;

create or replace function public.ingest_swing_lab_monitor(p_user_id uuid, p_monitor jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_version text;
begin
    v_version := public.validate_analyzer_contract(p_monitor, 'swing_monitor');
    perform public.ingest_swing_lab_monitor_v2(p_user_id, p_monitor);
    update public.swing_monitor_runs
    set contract_version = v_version
    where id = (p_monitor->>'monitor_id')::uuid and user_id = p_user_id;
end;
$$;

-- Browser users can mutate analyzer-authored data only through these narrow RPCs.
create or replace function public.save_market_signal_decision(
    p_run_id uuid,
    p_decision_status text,
    p_decision_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_decision_status not in ('pending', 'accepted', 'modified', 'skipped') then
        raise exception 'Invalid decision status.';
    end if;
    update public.market_signal_runs
    set decision_status = p_decision_status,
        decision_note = nullif(left(trim(p_decision_note), 4000), '')
    where id = p_run_id and user_id = v_user_id;
    if not found then raise exception 'Signal run not found.'; end if;
end;
$$;

create or replace function public.acknowledge_market_signal_alert(p_alert_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    update public.market_signal_alerts
    set acknowledged_at = coalesce(acknowledged_at, now())
    where id = p_alert_id and user_id = v_user_id;
    if not found then raise exception 'Signal alert not found.'; end if;
end;
$$;

-- Restore new fields after the backward-compatible base restore.
create or replace function public.restore_reliability_hardening_details(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    for v_row in
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'portfolio_snapshots', '[]'::jsonb))
    loop
        update public.portfolio_snapshots
        set monthly_review_status = case
            when v_row->>'monthly_review_status' in ('complete', 'acknowledged_missing', 'legacy_unknown')
                then v_row->>'monthly_review_status'
            else monthly_review_status
        end
        where id = (v_row->>'id')::uuid and user_id = v_user_id;
    end loop;
    for v_row in
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'market_signal_scores', '[]'::jsonb))
    loop
        update public.market_signal_scores
        set data_coverage = coalesce(nullif(v_row->>'data_coverage', '')::numeric, confidence),
            valuation_source = nullif(v_row->>'valuation_source', ''),
            valuation_as_of = nullif(v_row->>'valuation_as_of', '')::date,
            valuation_method = nullif(v_row->>'valuation_method', '')
        where id = (v_row->>'id')::uuid and user_id = v_user_id;
    end loop;
    for v_row in
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'sip_signal_recommendations', '[]'::jsonb))
    loop
        update public.sip_signal_recommendations
        set data_coverage = coalesce(nullif(v_row->>'data_coverage', '')::numeric, confidence)
        where id = (v_row->>'id')::uuid and user_id = v_user_id;
    end loop;
    for v_row in
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'market_events', '[]'::jsonb))
    loop
        update public.market_events
        set rule_evidence = coalesce(v_row->'rule_evidence', '[]'::jsonb)
        where id = (v_row->>'id')::uuid and user_id = v_user_id;
    end loop;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v6(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_compatible_backup jsonb;
begin
    if auth.uid() is null then raise exception 'Authentication required.'; end if;
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer, 0) not in (1, 2, 3, 4)
    then raise exception 'Unsupported backup format'; end if;
    v_compatible_backup := jsonb_set(p_backup, '{version}', '3'::jsonb, true);
    perform public.restore_complete_portfolio_backup_v5(v_compatible_backup);
    perform public.restore_reliability_hardening_details(p_backup);
end;
$$;

-- Existing audited user-transition functions need owner privileges after direct
-- table writes are revoked. They still bind every mutation to auth.uid().
alter function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) security definer;
alter function public.skip_swing_candidate(uuid, text) security definer;
alter function public.update_swing_trade_stop(uuid, numeric, text) security definer;
alter function public.confirm_swing_exit(uuid, date, numeric, numeric, text) security definer;
alter function public.reconcile_swing_corporate_action(uuid, numeric, integer, numeric, numeric, text) security definer;
alter function public.review_news_event(uuid, text, text) security definer;

-- Remove broad browser write policies and grants from analyzer-authored tables.
do $$
declare
    v_table text;
    v_tables text[] := array[
        'market_signal_runs', 'market_signal_scores', 'sip_signal_recommendations',
        'global_signal_recommendations', 'market_signal_alerts',
        'swing_scan_runs', 'swing_monitor_runs', 'swing_candidates',
        'swing_trades', 'swing_trade_events',
        'news_sources', 'news_pipeline_runs', 'news_articles', 'market_events',
        'market_event_articles', 'market_event_impacts', 'market_event_reactions',
        'portfolio_event_impacts', 'news_event_evaluations', 'market_event_alerts'
    ];
begin
    drop policy if exists "Users view their swing monitor runs" on public.swing_monitor_runs;
    foreach v_table in array v_tables loop
        execute format('drop policy if exists %I on public.%I', 'Users manage ' || v_table, v_table);
        execute format('drop policy if exists %I on public.%I', 'Users view generated ' || v_table, v_table);
        execute format(
            'create policy %I on public.%I for select using (auth.uid() = user_id)',
            'Users view generated ' || v_table,
            v_table
        );
        execute format('revoke insert, update, delete on public.%I from authenticated', v_table);
        execute format('grant select on public.%I to authenticated', v_table);
        execute format('grant select, insert, update, delete on public.%I to service_role', v_table);
    end loop;
end;
$$;

revoke all on function public.ingest_market_signal_run_v2(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_news_event_run_v2(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_scan_v2(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_monitor_v2(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_market_signal_run(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_news_event_run(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_scan(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_monitor(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_market_signal_run(uuid, jsonb) to service_role;
grant execute on function public.ingest_news_event_run(uuid, jsonb) to service_role;
grant execute on function public.ingest_swing_lab_scan(uuid, jsonb) to service_role;
grant execute on function public.ingest_swing_lab_monitor(uuid, jsonb) to service_role;

revoke all on function public.save_market_signal_decision(uuid, text, text) from public, anon;
revoke all on function public.acknowledge_market_signal_alert(uuid) from public, anon;
revoke all on function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) from public, anon;
revoke all on function public.skip_swing_candidate(uuid, text) from public, anon;
revoke all on function public.update_swing_trade_stop(uuid, numeric, text) from public, anon;
revoke all on function public.confirm_swing_exit(uuid, date, numeric, numeric, text) from public, anon;
revoke all on function public.reconcile_swing_corporate_action(uuid, numeric, integer, numeric, numeric, text) from public, anon;
revoke all on function public.review_news_event(uuid, text, text) from public, anon;
revoke all on function public.create_current_month_snapshot_v2(boolean) from public, anon;
revoke all on function public.restore_portfolio_backup(jsonb) from public, anon, authenticated;
revoke all on function public.restore_swing_lab_backup(jsonb) from public, anon, authenticated;
revoke all on function public.restore_news_event_backup(jsonb) from public, anon, authenticated;
revoke all on function public.restore_swing_lab_v2_details(jsonb) from public, anon, authenticated;
revoke all on function public.restore_review_correctness_details(jsonb) from public, anon, authenticated;
revoke all on function public.restore_reliability_hardening_details(jsonb) from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup(jsonb) from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v2(jsonb) from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v3(jsonb) from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v4(jsonb) from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v5(jsonb) from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v6(jsonb) from public, anon;

grant execute on function public.save_market_signal_decision(uuid, text, text) to authenticated;
grant execute on function public.acknowledge_market_signal_alert(uuid) to authenticated;
grant execute on function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) to authenticated;
grant execute on function public.skip_swing_candidate(uuid, text) to authenticated;
grant execute on function public.update_swing_trade_stop(uuid, numeric, text) to authenticated;
grant execute on function public.confirm_swing_exit(uuid, date, numeric, numeric, text) to authenticated;
grant execute on function public.reconcile_swing_corporate_action(uuid, numeric, integer, numeric, numeric, text) to authenticated;
grant execute on function public.review_news_event(uuid, text, text) to authenticated;
grant execute on function public.create_current_month_snapshot_v2(boolean) to authenticated;
grant execute on function public.restore_complete_portfolio_backup_v6(jsonb) to authenticated;

commit;
