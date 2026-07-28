begin;

-- Stable semantic category roles keep investment rules independent of names.
alter table public.asset_categories
    add column if not exists signal_role text not null default 'other';

alter table public.asset_categories
    drop constraint if exists asset_categories_signal_role_check;

alter table public.asset_categories
    add constraint asset_categories_signal_role_check
    check (signal_role in ('india_equity', 'global_equity', 'debt', 'gold', 'crypto', 'cash', 'other'));

update public.asset_categories
set signal_role = case
    when lower(name) ~ '(debt|liquid)' then 'debt'
    when lower(name) ~ '(gold|silver)' then 'gold'
    when lower(name) ~ 'crypto' then 'crypto'
    when lower(name) ~ '(^|[^a-z])(cash|emergency)([^a-z]|$)' then 'cash'
    when tracking_currency = 'USD' then 'global_equity'
    when lower(name) ~ '(india|indian|nifty|sensex)' then 'india_equity'
    else signal_role
end
where signal_role = 'other';

-- Reproducibility and source-session provenance.
alter table public.market_signal_runs
    add column if not exists contract_version text,
    add column if not exists config_version text,
    add column if not exists config_hash text,
    add column if not exists input_hash text,
    add column if not exists source_commit text,
    add column if not exists publication_status text not null default 'published';

alter table public.swing_scan_runs
    add column if not exists expected_price_session date,
    add column if not exists session_matches_expected boolean not null default false,
    add column if not exists session_state text not null default 'unknown',
    add column if not exists contract_version text,
    add column if not exists config_version text,
    add column if not exists config_hash text,
    add column if not exists input_hash text,
    add column if not exists source_commit text,
    add column if not exists publication_status text not null default 'published';

alter table public.swing_scan_runs
    drop constraint if exists swing_scan_runs_status_check;

alter table public.swing_scan_runs
    add constraint swing_scan_runs_status_check
    check (status in ('successful', 'partial', 'failed', 'no_session'));

alter table public.swing_scan_runs
    drop constraint if exists swing_scan_runs_session_state_check;

alter table public.swing_scan_runs
    add constraint swing_scan_runs_session_state_check
    check (session_state in ('completed', 'no_session', 'before_close', 'unknown'));

alter table public.news_pipeline_runs
    add column if not exists contract_version text,
    add column if not exists config_version text,
    add column if not exists config_hash text,
    add column if not exists input_hash text,
    add column if not exists source_commit text,
    add column if not exists publication_status text not null default 'published';

-- Corporate actions suspend automated monitoring until manually reconciled.
alter table public.swing_trades
    add column if not exists corporate_action_review_required boolean not null default false,
    add column if not exists corporate_action_reason text;

create table if not exists public.swing_monitor_runs (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    as_of timestamptz not null,
    status text not null check (status in ('successful', 'partial', 'failed', 'disabled')),
    model_version text not null,
    price_observed_at timestamptz,
    candidates_checked integer not null default 0,
    positions_checked integer not null default 0,
    notification_count integer not null default 0,
    data_issues jsonb not null default '[]'::jsonb,
    contract_version text,
    config_version text,
    config_hash text,
    input_hash text,
    source_commit text,
    publication_status text not null default 'published',
    created_at timestamptz not null default now(),
    unique (user_id, id)
);

create index if not exists swing_monitor_runs_user_as_of_idx
    on public.swing_monitor_runs(user_id, as_of desc);

alter table public.swing_monitor_runs enable row level security;

drop policy if exists "Users view their swing monitor runs" on public.swing_monitor_runs;
create policy "Users view their swing monitor runs"
    on public.swing_monitor_runs
    for select
    using (auth.uid() = user_id);

grant select on public.swing_monitor_runs to authenticated;
grant select, insert, update, delete on public.swing_monitor_runs to service_role;

-- Keep the existing ingestion implementations as transactional foundations.
do $$
begin
    if to_regprocedure('public.ingest_market_signal_run_v1(uuid,jsonb)') is null then
        execute 'alter function public.ingest_market_signal_run(uuid, jsonb) rename to ingest_market_signal_run_v1';
    end if;
    if to_regprocedure('public.ingest_news_event_run_v1(uuid,jsonb)') is null then
        execute 'alter function public.ingest_news_event_run(uuid, jsonb) rename to ingest_news_event_run_v1';
    end if;
    if to_regprocedure('public.confirm_swing_entry_v1(uuid,date,numeric,integer,text,text)') is null then
        execute 'alter function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) rename to confirm_swing_entry_v1';
    end if;
end;
$$;

create or replace function public.ingest_market_signal_run(p_user_id uuid, p_run jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    perform public.ingest_market_signal_run_v1(p_user_id, p_run);
    update public.market_signal_runs
    set contract_version = nullif(p_run->>'contract_version', ''),
        config_version = nullif(p_run->>'config_version', ''),
        config_hash = nullif(p_run->>'config_hash', ''),
        input_hash = nullif(p_run->>'input_hash', ''),
        source_commit = nullif(p_run->>'source_commit', ''),
        publication_status = 'published'
    where id = (p_run->>'run_id')::uuid
      and user_id = p_user_id;
end;
$$;

create or replace function public.ingest_news_event_run(p_user_id uuid, p_run jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    perform public.ingest_news_event_run_v1(p_user_id, p_run);
    update public.news_pipeline_runs
    set contract_version = nullif(p_run->>'contract_version', ''),
        config_version = nullif(p_run->>'config_version', ''),
        config_hash = nullif(p_run->>'config_hash', ''),
        input_hash = nullif(p_run->>'input_hash', ''),
        source_commit = nullif(p_run->>'source_commit', ''),
        publication_status = 'published'
    where id = (p_run->>'run_id')::uuid
      and user_id = p_user_id;
end;
$$;

-- Preserve every terminal candidate state across idempotent scan publication.
create or replace function public.ingest_swing_lab_scan(p_user_id uuid, p_scan jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_row jsonb;
    v_previous jsonb;
    v_terminal jsonb;
begin
    select coalesce(
        jsonb_agg(jsonb_build_object(
            'signal_key', signal_key,
            'status', status,
            'invalidation_reason', invalidation_reason
        )),
        '[]'::jsonb
    )
    into v_terminal
    from public.swing_candidates
    where user_id = p_user_id
      and status in ('entered', 'skipped', 'expired', 'invalidated');

    perform public.ingest_swing_lab_scan_v1(p_user_id, p_scan);

    for v_previous in
        select value from jsonb_array_elements(v_terminal)
    loop
        update public.swing_candidates
        set status = v_previous->>'status',
            invalidation_reason = nullif(v_previous->>'invalidation_reason', '')
        where user_id = p_user_id
          and signal_key = v_previous->>'signal_key';
    end loop;

    update public.swing_scan_runs
    set raw_market_regime = coalesce(nullif(p_scan->>'raw_market_regime', ''), p_scan->>'market_regime', 'UNKNOWN'),
        regime_confirmed = coalesce((p_scan->>'regime_confirmed')::boolean, false),
        regime_reason = nullif(p_scan->>'regime_reason', ''),
        regime_confirmation_reason = nullif(p_scan->>'regime_confirmation_reason', ''),
        benchmark_sma50 = nullif(p_scan->>'benchmark_sma50', '')::numeric,
        benchmark_sma200 = nullif(p_scan->>'benchmark_sma200', '')::numeric,
        benchmark_distance_200_percentage = nullif(p_scan->>'benchmark_distance_200_percentage', '')::numeric,
        benchmark_price_date = nullif(p_scan->>'benchmark_price_date', '')::date,
        expected_price_session = nullif(p_scan->>'expected_price_session', '')::date,
        session_matches_expected = coalesce((p_scan->>'session_matches_expected')::boolean, false),
        session_state = coalesce(nullif(p_scan->>'session_state', ''), 'unknown'),
        breadth_available = coalesce((p_scan->>'breadth_available')::integer, 0),
        breadth_coverage_percentage = nullif(p_scan->>'breadth_coverage_percentage', '')::numeric,
        published_size = coalesce((p_scan->>'published_size')::integer, 0),
        effective_minimum_score = nullif(p_scan->>'effective_minimum_score', '')::numeric,
        effective_risk_percentage = nullif(p_scan->>'effective_risk_percentage', '')::numeric,
        scan_blocked_reason = nullif(p_scan->>'scan_blocked_reason', ''),
        gate_counts = coalesce(p_scan->'gate_counts', '{}'::jsonb),
        contract_version = nullif(p_scan->>'contract_version', ''),
        config_version = nullif(p_scan->>'config_version', ''),
        config_hash = nullif(p_scan->>'config_hash', ''),
        input_hash = nullif(p_scan->>'input_hash', ''),
        source_commit = nullif(p_scan->>'source_commit', ''),
        publication_status = 'published'
    where id = (p_scan->>'scan_id')::uuid
      and user_id = p_user_id;

    for v_row in
        select value from jsonb_array_elements(coalesce(p_scan->'candidates', '[]'::jsonb))
    loop
        update public.swing_candidates
        set risk_percentage_used = nullif(v_row->>'risk_percentage_used', '')::numeric
        where user_id = p_user_id
          and signal_key = v_row->>'signal_key';
    end loop;

    for v_row in
        select value from jsonb_array_elements(coalesce(p_scan->'position_updates', '[]'::jsonb))
    loop
        if coalesce((v_row->>'corporate_action_review_required')::boolean, false) then
            update public.swing_trades
            set corporate_action_review_required = true,
                corporate_action_reason = coalesce(
                    nullif(v_row->>'corporate_action_reason', ''),
                    'Corporate-action reconciliation is required.'
                )
            where id = (v_row->>'trade_id')::uuid
              and user_id = p_user_id
              and corporate_action_review_required = false;

            if found then
                insert into public.swing_trade_events(
                    user_id, trade_id, event_type, reason, metadata
                ) values (
                    p_user_id,
                    (v_row->>'trade_id')::uuid,
                    'note',
                    coalesce(nullif(v_row->>'corporate_action_reason', ''), 'Corporate action detected.'),
                    jsonb_build_object('type', 'corporate_action_review_required')
                );
            end if;
        end if;
    end loop;
end;
$$;

create or replace function public.ingest_swing_lab_monitor(p_user_id uuid, p_monitor jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_as_of timestamptz := coalesce((p_monitor->>'as_of')::timestamptz, now());
    v_row jsonb;
    v_trade public.swing_trades%rowtype;
    v_old_status text;
    v_new_status text;
begin
    if p_user_id is null then
        raise exception 'User id is required.';
    end if;

    insert into public.swing_monitor_runs(
        id, user_id, as_of, status, model_version, price_observed_at,
        candidates_checked, positions_checked, notification_count, data_issues,
        contract_version, config_version, config_hash, input_hash, source_commit, publication_status
    ) values (
        (p_monitor->>'monitor_id')::uuid,
        p_user_id,
        v_as_of,
        p_monitor->>'status',
        p_monitor->>'model_version',
        nullif(p_monitor->>'price_observed_at', '')::timestamptz,
        coalesce((p_monitor->>'candidates_checked')::integer, 0),
        coalesce((p_monitor->>'positions_checked')::integer, 0),
        jsonb_array_length(coalesce(p_monitor->'notifications', '[]'::jsonb)),
        coalesce(p_monitor->'data_issues', '[]'::jsonb),
        nullif(p_monitor->>'contract_version', ''),
        nullif(p_monitor->>'config_version', ''),
        nullif(p_monitor->>'config_hash', ''),
        nullif(p_monitor->>'input_hash', ''),
        nullif(p_monitor->>'source_commit', ''),
        'published'
    ) on conflict (id) do update set
        status = excluded.status,
        price_observed_at = excluded.price_observed_at,
        candidates_checked = excluded.candidates_checked,
        positions_checked = excluded.positions_checked,
        notification_count = excluded.notification_count,
        data_issues = excluded.data_issues,
        contract_version = excluded.contract_version,
        config_version = excluded.config_version,
        config_hash = excluded.config_hash,
        input_hash = excluded.input_hash,
        source_commit = excluded.source_commit,
        publication_status = 'published';

    for v_row in
        select value from jsonb_array_elements(coalesce(p_monitor->'candidate_updates', '[]'::jsonb))
    loop
        update public.swing_candidates
        set status = coalesce(v_row->>'status', status),
            last_price = coalesce(nullif(v_row->>'last_price', '')::numeric, last_price),
            last_price_as_of = coalesce(nullif(v_row->>'last_price_as_of', '')::date, last_price_as_of),
            invalidation_reason = case
                when v_row->>'status' in ('invalidated', 'expired')
                    then coalesce(nullif(v_row->>'reason', ''), invalidation_reason)
                else invalidation_reason
            end
        where user_id = p_user_id
          and signal_key = v_row->>'signal_key'
          and status not in ('entered', 'skipped', 'expired', 'invalidated');
    end loop;

    for v_row in
        select value from jsonb_array_elements(coalesce(p_monitor->'position_updates', '[]'::jsonb))
    loop
        select *
        into v_trade
        from public.swing_trades
        where id = (v_row->>'trade_id')::uuid
          and user_id = p_user_id
          and status in ('open', 'exit_pending')
        for update;

        if not found then
            continue;
        end if;

        if coalesce((v_row->>'corporate_action_review_required')::boolean, false) then
            if not v_trade.corporate_action_review_required then
                update public.swing_trades
                set corporate_action_review_required = true,
                    corporate_action_reason = coalesce(
                        nullif(v_row->>'corporate_action_reason', ''),
                        'Corporate-action reconciliation is required.'
                    )
                where id = v_trade.id and user_id = p_user_id;

                insert into public.swing_trade_events(
                    user_id, trade_id, event_type, reason, metadata
                ) values (
                    p_user_id,
                    v_trade.id,
                    'note',
                    coalesce(nullif(v_row->>'corporate_action_reason', ''), 'Corporate action detected.'),
                    jsonb_build_object('type', 'corporate_action_review_required')
                );
            end if;
            continue;
        end if;

        if v_trade.corporate_action_review_required then
            continue;
        end if;

        v_old_status := v_trade.status;
        v_new_status := case
            when coalesce((v_row->>'exit_pending')::boolean, false) then 'exit_pending'
            else v_trade.status
        end;

        update public.swing_trades
        set current_price = coalesce(nullif(v_row->>'current_price', '')::numeric, current_price),
            current_price_as_of = coalesce(nullif(v_row->>'current_price_as_of', '')::date, current_price_as_of),
            unrealized_pnl_inr = coalesce(nullif(v_row->>'unrealized_pnl_inr', '')::numeric, unrealized_pnl_inr),
            unrealized_r_multiple = coalesce(nullif(v_row->>'unrealized_r_multiple', '')::numeric, unrealized_r_multiple),
            status = v_new_status,
            exit_signal_reason = case
                when v_new_status = 'exit_pending' then nullif(v_row->>'exit_reason', '')
                else exit_signal_reason
            end,
            exit_signal_at = case
                when v_new_status = 'exit_pending' and v_old_status <> 'exit_pending' then v_as_of
                else exit_signal_at
            end
        where id = v_trade.id
          and user_id = p_user_id;

        if v_new_status = 'exit_pending' and v_old_status <> 'exit_pending' then
            insert into public.swing_trade_events(
                user_id, trade_id, event_type, event_at, price, stop_price, reason
            ) values (
                p_user_id,
                v_trade.id,
                'exit_signaled',
                v_as_of,
                nullif(v_row->>'current_price', '')::numeric,
                v_trade.current_stop,
                nullif(v_row->>'exit_reason', '')
            );
        end if;
    end loop;
end;
$$;

-- Current saved risk is always authoritative if it is stricter.
create or replace function public.confirm_swing_entry(
    p_candidate_id uuid,
    p_entry_date date,
    p_entry_price numeric,
    p_quantity integer,
    p_trade_mode text,
    p_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_candidate public.swing_candidates%rowtype;
    v_settings public.swing_lab_settings%rowtype;
    v_effective_risk_percentage numeric;
    v_planned_risk numeric;
    v_risk_budget numeric;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    select * into v_candidate
    from public.swing_candidates
    where id = p_candidate_id and user_id = v_user_id
    for update;
    if not found then raise exception 'Candidate not found.'; end if;

    select * into v_settings
    from public.swing_lab_settings
    where user_id = v_user_id
    for update;
    if not found then raise exception 'Save Swing Lab risk settings before confirming an entry.'; end if;

    v_effective_risk_percentage := case
        when v_candidate.risk_percentage_used is null then v_settings.risk_per_trade_percentage
        else least(v_candidate.risk_percentage_used, v_settings.risk_per_trade_percentage)
    end;
    v_planned_risk := (p_entry_price - v_candidate.initial_stop) * p_quantity;
    v_risk_budget := v_settings.trading_capital_inr * v_effective_risk_percentage / 100;

    if v_planned_risk > v_risk_budget + 0.01 then
        raise exception 'Actual fill would risk % INR, above the stricter current % INR risk budget.',
            round(v_planned_risk, 2), round(v_risk_budget, 2);
    end if;

    return public.confirm_swing_entry_v1(
        p_candidate_id,
        p_entry_date,
        p_entry_price,
        p_quantity,
        p_trade_mode,
        p_notes
    );
end;
$$;

create or replace function public.reconcile_swing_corporate_action(
    p_trade_id uuid,
    p_adjusted_entry_price numeric,
    p_adjusted_quantity integer,
    p_adjusted_initial_stop numeric,
    p_adjusted_current_stop numeric,
    p_note text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_trade public.swing_trades%rowtype;
    v_factor numeric;
    v_initial_risk numeric;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_adjusted_entry_price <= 0 or p_adjusted_quantity <= 0
       or p_adjusted_initial_stop <= 0 or p_adjusted_current_stop <= 0 then
        raise exception 'Adjusted prices and quantity must be positive.';
    end if;
    if p_adjusted_initial_stop >= p_adjusted_entry_price then
        raise exception 'Adjusted initial stop must remain below adjusted entry.';
    end if;

    select * into v_trade
    from public.swing_trades
    where id = p_trade_id
      and user_id = v_user_id
      and status in ('open', 'exit_pending')
    for update;

    if not found then raise exception 'Open trade not found.'; end if;
    if not v_trade.corporate_action_review_required then
        raise exception 'This trade is not awaiting corporate-action reconciliation.';
    end if;

    v_factor := p_adjusted_entry_price / v_trade.entry_price;
    v_initial_risk := p_adjusted_entry_price - p_adjusted_initial_stop;

    update public.swing_trades
    set signal_entry = signal_entry * v_factor,
        maximum_entry = maximum_entry * v_factor,
        entry_price = p_adjusted_entry_price,
        quantity = p_adjusted_quantity,
        initial_stop = p_adjusted_initial_stop,
        current_stop = p_adjusted_current_stop,
        initial_risk_per_share = v_initial_risk,
        planned_risk_inr = v_initial_risk * p_adjusted_quantity,
        current_price = null,
        current_price_as_of = null,
        highest_close = greatest(p_adjusted_entry_price, coalesce(highest_close * v_factor, p_adjusted_entry_price)),
        unrealized_pnl_inr = null,
        unrealized_r_multiple = null,
        corporate_action_review_required = false,
        corporate_action_reason = null,
        notes = concat_ws(E'\n', nullif(notes, ''), nullif(trim(p_note), ''))
    where id = v_trade.id and user_id = v_user_id;

    insert into public.swing_trade_events(
        user_id, trade_id, event_type, price, stop_price, reason, metadata
    ) values (
        v_user_id,
        v_trade.id,
        'note',
        p_adjusted_entry_price,
        p_adjusted_current_stop,
        coalesce(nullif(trim(p_note), ''), 'Corporate action reconciled with broker-adjusted values.'),
        jsonb_build_object(
            'type', 'corporate_action_reconciled',
            'old_entry_price', v_trade.entry_price,
            'old_quantity', v_trade.quantity,
            'adjustment_factor', v_factor
        )
    );
end;
$$;

create or replace function public.add_asset_category_v2(
    p_name text,
    p_sort_order integer,
    p_target_percentage numeric,
    p_tracking_currency text,
    p_signal_role text
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_category_id uuid;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if trim(p_name) = '' then raise exception 'Category name is required.'; end if;
    if p_tracking_currency not in ('INR', 'USD') then raise exception 'Invalid tracking currency.'; end if;
    if p_signal_role not in ('india_equity', 'global_equity', 'debt', 'gold', 'crypto', 'cash', 'other') then
        raise exception 'Invalid signal role.';
    end if;

    insert into public.asset_categories(user_id, name, sort_order, tracking_currency, signal_role)
    values (v_user_id, trim(p_name), p_sort_order, p_tracking_currency, p_signal_role)
    returning id into v_category_id;

    insert into public.portfolio_targets(user_id, category_id, target_percentage)
    values (v_user_id, v_category_id, p_target_percentage);

    return v_category_id;
end;
$$;

create or replace function public.update_asset_category_v2(
    p_category_id uuid,
    p_name text,
    p_sort_order integer,
    p_tracking_currency text,
    p_signal_role text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_existing_currency text;
begin
    select tracking_currency into v_existing_currency
    from public.asset_categories
    where id = p_category_id and user_id = v_user_id
    for update;
    if not found then raise exception 'Invalid category'; end if;
    if trim(p_name) = '' then raise exception 'Category name is required'; end if;
    if p_tracking_currency not in ('INR', 'USD') then raise exception 'Invalid tracking currency'; end if;
    if p_signal_role not in ('india_equity', 'global_equity', 'debt', 'gold', 'crypto', 'cash', 'other') then
        raise exception 'Invalid signal role';
    end if;
    if p_tracking_currency <> v_existing_currency and exists (
        select 1 from public.monthly_category_performance
        where user_id = v_user_id and category_id = p_category_id
    ) then raise exception 'Tracking currency cannot change after monthly performance history exists.'; end if;

    update public.asset_categories
    set name = trim(p_name),
        sort_order = p_sort_order,
        tracking_currency = p_tracking_currency,
        signal_role = p_signal_role
    where id = p_category_id and user_id = v_user_id;
end;
$$;

create or replace function public.restore_review_correctness_details(p_backup jsonb)
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
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'asset_categories', '[]'::jsonb))
    loop
        update public.asset_categories
        set signal_role = coalesce(nullif(v_row->>'signal_role', ''), signal_role)
        where id = (v_row->>'id')::uuid
          and user_id = v_user_id;
    end loop;

    if exists (
        select 1
        from jsonb_array_elements(coalesce(p_backup->'data'->'swing_monitor_runs', '[]'::jsonb)) item
        where nullif(item->>'user_id', '')::uuid is distinct from v_user_id
    ) then
        raise exception 'Swing monitor backup contains rows for another user.';
    end if;

    delete from public.swing_monitor_runs where user_id = v_user_id;
    insert into public.swing_monitor_runs
    select *
    from jsonb_populate_recordset(
        null::public.swing_monitor_runs,
        coalesce(p_backup->'data'->'swing_monitor_runs', '[]'::jsonb)
    );
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v5(p_backup jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_compatible_backup jsonb;
begin
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer, 0) not in (1, 2, 3)
    then
        raise exception 'Unsupported backup format';
    end if;

    -- v4 validates versions 1/2. The data object is backward-compatible and
    -- the v5 detail pass restores fields introduced by version 3.
    v_compatible_backup := jsonb_set(p_backup, '{version}', '2'::jsonb, true);
    perform public.restore_complete_portfolio_backup_v4(v_compatible_backup);
    perform public.restore_review_correctness_details(p_backup);
end;
$$;

revoke all on function public.ingest_market_signal_run_v1(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_news_event_run_v1(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_scan_v1(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.confirm_swing_entry_v1(uuid, date, numeric, integer, text, text) from public, anon, authenticated;

revoke all on function public.ingest_market_signal_run(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_news_event_run(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_scan(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_swing_lab_monitor(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_market_signal_run(uuid, jsonb) to service_role;
grant execute on function public.ingest_news_event_run(uuid, jsonb) to service_role;
grant execute on function public.ingest_swing_lab_scan(uuid, jsonb) to service_role;
grant execute on function public.ingest_swing_lab_monitor(uuid, jsonb) to service_role;

revoke all on function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) from public, anon;
revoke all on function public.reconcile_swing_corporate_action(uuid, numeric, integer, numeric, numeric, text) from public, anon;
revoke all on function public.add_asset_category_v2(text, integer, numeric, text, text) from public, anon;
revoke all on function public.update_asset_category_v2(uuid, text, integer, text, text) from public, anon;
revoke all on function public.restore_review_correctness_details(jsonb) from public, anon;
revoke all on function public.restore_complete_portfolio_backup_v5(jsonb) from public, anon;

grant execute on function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) to authenticated;
grant execute on function public.reconcile_swing_corporate_action(uuid, numeric, integer, numeric, numeric, text) to authenticated;
grant execute on function public.add_asset_category_v2(text, integer, numeric, text, text) to authenticated;
grant execute on function public.update_asset_category_v2(uuid, text, integer, text, text) to authenticated;
grant execute on function public.restore_review_correctness_details(jsonb) to authenticated;
grant execute on function public.restore_complete_portfolio_backup_v5(jsonb) to authenticated;

commit;
