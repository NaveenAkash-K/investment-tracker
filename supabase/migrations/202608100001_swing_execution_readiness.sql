begin;

-- Phase 7 records forward Paper Auto evidence and the prerequisites required
-- by later Assisted Live and Live Auto phases. This migration deliberately
-- creates no broker-order submission function. Both live modes remain locked.

alter table public.swing_automation_controls
    add column if not exists assisted_live_unlocked boolean not null default false,
    add column if not exists broker_execution_enabled boolean not null default false,
    add column if not exists ddpi_confirmed_at timestamptz,
    add column if not exists credentials_rotated_at timestamptz,
    add column if not exists market_data_plan text not null default 'personal',
    add column if not exists live_max_open_positions integer not null default 1,
    add column if not exists live_max_new_entries_per_day integer not null default 1,
    add column if not exists live_max_deployed_inr numeric not null default 5000,
    add column if not exists live_daily_loss_limit_inr numeric not null default 100,
    add column if not exists live_risk_per_trade_percentage numeric not null default 0.5,
    add column if not exists live_amber_risk_multiplier numeric not null default 0.5;

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_market_data_plan_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_market_data_plan_check
    check (market_data_plan in ('personal', 'connect'));

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_live_max_open_positions_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_live_max_open_positions_check
    check (live_max_open_positions between 1 and 2);

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_live_max_new_entries_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_live_max_new_entries_check
    check (live_max_new_entries_per_day between 1 and 2);

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_live_deployed_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_live_deployed_check
    check (live_max_deployed_inr > 0);

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_live_loss_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_live_loss_check
    check (live_daily_loss_limit_inr > 0);

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_live_risk_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_live_risk_check
    check (live_risk_per_trade_percentage > 0 and live_risk_per_trade_percentage <= 0.5);

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_amber_multiplier_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_amber_multiplier_check
    check (live_amber_risk_multiplier > 0 and live_amber_risk_multiplier <= 0.5);

-- A live mode can never be armed merely by restoring data or changing the UI.
alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_assisted_execution_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_assisted_execution_check
    check (
        automation_mode <> 'assisted_live'
        or (assisted_live_unlocked and broker_execution_enabled)
    );

alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_live_execution_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_live_execution_check
    check (
        automation_mode <> 'live_auto'
        or (live_auto_unlocked and broker_execution_enabled)
    );

create table if not exists public.swing_execution_validation_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    nse_session date not null,
    execution_mode text not null check (execution_mode in ('paper_auto', 'assisted_live', 'live_auto')),
    first_observed_at timestamptz not null,
    last_observed_at timestamptz not null,
    cycle_count integer not null default 0 check (cycle_count >= 0),
    healthy_cycle_count integer not null default 0 check (healthy_cycle_count >= 0),
    degraded_cycle_count integer not null default 0 check (degraded_cycle_count >= 0),
    blocked_cycle_count integer not null default 0 check (blocked_cycle_count >= 0),
    fresh_quote_cycle_count integer not null default 0 check (fresh_quote_cycle_count >= 0),
    material_event_count integer not null default 0 check (material_event_count >= 0),
    entry_event_count integer not null default 0 check (entry_event_count >= 0),
    exit_event_count integer not null default 0 check (exit_event_count >= 0),
    latest_worker_version text,
    latest_policy_version text,
    latest_cost_model_version text,
    latest_status text not null default 'blocked'
        check (latest_status in ('starting', 'healthy', 'degraded', 'blocked', 'stopping')),
    latest_quote_count integer not null default 0 check (latest_quote_count >= 0),
    latest_details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, nse_session, execution_mode)
);

create index if not exists swing_execution_validation_user_session_idx
    on public.swing_execution_validation_sessions(user_id, nse_session desc, execution_mode);

create table if not exists public.swing_execution_readiness_checks (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    check_key text not null check (check_key ~ '^[a-z0-9_]{3,80}$'),
    check_status text not null check (check_status in ('pending', 'passed', 'failed', 'blocked')),
    source text not null check (source in ('user', 'tracker', 'worker', 'system')),
    reason text not null,
    observed_at timestamptz not null default now(),
    expires_at timestamptz,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, check_key),
    check (expires_at is null or expires_at > observed_at)
);

create index if not exists swing_execution_readiness_user_status_idx
    on public.swing_execution_readiness_checks(user_id, check_status, observed_at desc);

alter table public.swing_execution_validation_sessions enable row level security;
alter table public.swing_execution_readiness_checks enable row level security;

drop policy if exists "Users view their swing_execution_validation_sessions"
    on public.swing_execution_validation_sessions;
create policy "Users view their swing_execution_validation_sessions"
    on public.swing_execution_validation_sessions for select
    using (auth.uid() = user_id);

drop policy if exists "Users view their swing_execution_readiness_checks"
    on public.swing_execution_readiness_checks;
create policy "Users view their swing_execution_readiness_checks"
    on public.swing_execution_readiness_checks for select
    using (auth.uid() = user_id);

drop trigger if exists swing_execution_validation_sessions_set_updated_at
    on public.swing_execution_validation_sessions;
create trigger swing_execution_validation_sessions_set_updated_at
before update on public.swing_execution_validation_sessions
for each row execute function public.set_updated_at();

drop trigger if exists swing_execution_readiness_checks_set_updated_at
    on public.swing_execution_readiness_checks;
create trigger swing_execution_readiness_checks_set_updated_at
before update on public.swing_execution_readiness_checks
for each row execute function public.set_updated_at();

create or replace function public.accumulate_swing_execution_validation_heartbeat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session date := (new.heartbeat_at at time zone 'Asia/Kolkata')::date;
    v_quote_count integer := greatest(coalesce(nullif(new.details->>'quote_count', '')::integer, 0), 0);
begin
    if new.execution_mode not in ('paper_auto', 'assisted_live', 'live_auto') then
        return new;
    end if;

    insert into public.swing_execution_validation_sessions(
        user_id, nse_session, execution_mode, first_observed_at, last_observed_at,
        cycle_count, healthy_cycle_count, degraded_cycle_count, blocked_cycle_count,
        fresh_quote_cycle_count, latest_worker_version, latest_policy_version,
        latest_cost_model_version, latest_status, latest_quote_count, latest_details
    ) values (
        new.user_id, v_session, new.execution_mode, new.heartbeat_at, new.heartbeat_at,
        1,
        case when new.worker_status = 'healthy' then 1 else 0 end,
        case when new.worker_status = 'degraded' then 1 else 0 end,
        case when new.worker_status = 'blocked' then 1 else 0 end,
        case when new.quote_stream_healthy and v_quote_count > 0 then 1 else 0 end,
        new.worker_version, new.execution_policy_version,
        nullif(new.details->>'cost_model_version', ''), new.worker_status,
        v_quote_count, coalesce(new.details, '{}'::jsonb)
    )
    on conflict (user_id, nse_session, execution_mode) do update set
        last_observed_at = excluded.last_observed_at,
        cycle_count = public.swing_execution_validation_sessions.cycle_count + 1,
        healthy_cycle_count = public.swing_execution_validation_sessions.healthy_cycle_count
            + case when excluded.latest_status = 'healthy' then 1 else 0 end,
        degraded_cycle_count = public.swing_execution_validation_sessions.degraded_cycle_count
            + case when excluded.latest_status = 'degraded' then 1 else 0 end,
        blocked_cycle_count = public.swing_execution_validation_sessions.blocked_cycle_count
            + case when excluded.latest_status = 'blocked' then 1 else 0 end,
        fresh_quote_cycle_count = public.swing_execution_validation_sessions.fresh_quote_cycle_count
            + case when new.quote_stream_healthy and v_quote_count > 0 then 1 else 0 end,
        latest_worker_version = excluded.latest_worker_version,
        latest_policy_version = excluded.latest_policy_version,
        latest_cost_model_version = excluded.latest_cost_model_version,
        latest_status = excluded.latest_status,
        latest_quote_count = excluded.latest_quote_count,
        latest_details = excluded.latest_details;

    return new;
end;
$$;

drop trigger if exists accumulate_swing_execution_validation_heartbeat_trigger
    on public.swing_worker_heartbeats;
create trigger accumulate_swing_execution_validation_heartbeat_trigger
after insert or update on public.swing_worker_heartbeats
for each row execute function public.accumulate_swing_execution_validation_heartbeat();

create or replace function public.accumulate_swing_paper_validation_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.swing_execution_validation_sessions(
        user_id, nse_session, execution_mode, first_observed_at, last_observed_at,
        material_event_count, entry_event_count, exit_event_count,
        latest_status, latest_details
    ) values (
        new.user_id, new.nse_session, 'paper_auto', new.observed_at, new.observed_at,
        1,
        case when new.event_type in ('entry_filled', 'entry_and_stop') then 1 else 0 end,
        case when new.event_type in ('entry_and_stop', 'stop_filled', 'signal_exit_filled') then 1 else 0 end,
        'healthy', jsonb_build_object('latest_event_type', new.event_type)
    )
    on conflict (user_id, nse_session, execution_mode) do update set
        last_observed_at = greatest(public.swing_execution_validation_sessions.last_observed_at, excluded.last_observed_at),
        material_event_count = public.swing_execution_validation_sessions.material_event_count + 1,
        entry_event_count = public.swing_execution_validation_sessions.entry_event_count
            + case when new.event_type in ('entry_filled', 'entry_and_stop') then 1 else 0 end,
        exit_event_count = public.swing_execution_validation_sessions.exit_event_count
            + case when new.event_type in ('entry_and_stop', 'stop_filled', 'signal_exit_filled') then 1 else 0 end,
        latest_details = public.swing_execution_validation_sessions.latest_details
            || jsonb_build_object('latest_event_type', new.event_type);
    return new;
end;
$$;

drop trigger if exists accumulate_swing_paper_validation_event_trigger
    on public.swing_paper_events;
create trigger accumulate_swing_paper_validation_event_trigger
after insert on public.swing_paper_events
for each row execute function public.accumulate_swing_paper_validation_event();

create or replace function public.configure_swing_live_readiness(
    p_ddpi_confirmed boolean,
    p_credentials_rotated boolean,
    p_market_data_plan text,
    p_max_open_positions integer,
    p_max_new_entries_per_day integer,
    p_max_deployed_inr numeric,
    p_daily_loss_limit_inr numeric,
    p_risk_per_trade_percentage numeric,
    p_amber_risk_multiplier numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_market_data_plan not in ('personal', 'connect') then
        raise exception 'Kite market-data plan must be personal or connect.';
    end if;
    if p_max_open_positions not between 1 and 2
       or p_max_new_entries_per_day not between 1 and 2 then
        raise exception 'Initial live position and daily-entry limits must be one or two.';
    end if;
    if p_max_deployed_inr <= 0 or p_daily_loss_limit_inr <= 0 then
        raise exception 'Live capital and loss limits must be positive.';
    end if;
    if p_risk_per_trade_percentage <= 0 or p_risk_per_trade_percentage > 0.5 then
        raise exception 'Initial live risk must be greater than zero and no more than 0.5 percent.';
    end if;
    if p_amber_risk_multiplier <= 0 or p_amber_risk_multiplier > 0.5 then
        raise exception 'AMBER risk multiplier must be greater than zero and no more than 0.5.';
    end if;

    insert into public.swing_automation_controls(
        user_id, ddpi_confirmed_at, credentials_rotated_at, market_data_plan,
        live_max_open_positions, live_max_new_entries_per_day,
        live_max_deployed_inr, live_daily_loss_limit_inr,
        live_risk_per_trade_percentage, live_amber_risk_multiplier
    ) values (
        v_user_id,
        case when p_ddpi_confirmed then now() else null end,
        case when p_credentials_rotated then now() else null end,
        p_market_data_plan, p_max_open_positions, p_max_new_entries_per_day,
        p_max_deployed_inr, p_daily_loss_limit_inr,
        p_risk_per_trade_percentage, p_amber_risk_multiplier
    )
    on conflict (user_id) do update set
        ddpi_confirmed_at = case when p_ddpi_confirmed then now() else null end,
        credentials_rotated_at = case when p_credentials_rotated then now() else null end,
        market_data_plan = excluded.market_data_plan,
        live_max_open_positions = excluded.live_max_open_positions,
        live_max_new_entries_per_day = excluded.live_max_new_entries_per_day,
        live_max_deployed_inr = excluded.live_max_deployed_inr,
        live_daily_loss_limit_inr = excluded.live_daily_loss_limit_inr,
        live_risk_per_trade_percentage = excluded.live_risk_per_trade_percentage,
        live_amber_risk_multiplier = excluded.live_amber_risk_multiplier;

    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', 'live_readiness_configuration_updated',
        'swing_automation_controls', v_user_id::text,
        jsonb_build_object(
            'ddpi_confirmed', p_ddpi_confirmed,
            'credentials_rotated', p_credentials_rotated,
            'market_data_plan', p_market_data_plan,
            'live_max_open_positions', p_max_open_positions,
            'live_max_new_entries_per_day', p_max_new_entries_per_day,
            'live_max_deployed_inr', p_max_deployed_inr,
            'live_daily_loss_limit_inr', p_daily_loss_limit_inr,
            'live_risk_per_trade_percentage', p_risk_per_trade_percentage,
            'live_amber_risk_multiplier', p_amber_risk_multiplier
        )
    );
end;
$$;

create or replace function public.set_swing_emergency_stop(p_action text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_action not in ('activate', 'clear') then
        raise exception 'Emergency-stop action must be activate or clear.';
    end if;

    insert into public.swing_automation_controls(user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;

    if p_action = 'activate' then
        update public.swing_automation_controls
        set emergency_stop_active = true,
            new_entries_enabled = false,
            armed_nse_session = null
        where user_id = v_user_id;

        insert into public.swing_risk_control_activations(
            user_id, control_type, status, reason, details
        ) values (
            v_user_id, 'emergency_stop', 'active',
            'The user activated the Swing Lab emergency stop.',
            jsonb_build_object('source', 'swing_lab')
        );
    else
        update public.swing_automation_controls
        set emergency_stop_active = false,
            new_entries_enabled = false,
            armed_nse_session = null
        where user_id = v_user_id;

        update public.swing_risk_control_activations
        set status = 'cleared', cleared_at = now()
        where user_id = v_user_id
          and control_type = 'emergency_stop'
          and status = 'active';
    end if;

    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', 'emergency_stop_' || p_action,
        'swing_automation_controls', v_user_id::text,
        jsonb_build_object(
            'new_entries_disabled', true,
            'existing_protection_unchanged', true
        )
    );
end;
$$;

create or replace function public.get_swing_rollout_readiness()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_controls public.swing_automation_controls%rowtype;
    v_connection public.kite_broker_connections%rowtype;
    v_readonly public.swing_worker_heartbeats%rowtype;
    v_paper public.swing_worker_heartbeats%rowtype;
    v_reconciliation public.swing_reconciliation_runs%rowtype;
    v_quote_sessions integer := 0;
    v_paper_entries integer := 0;
    v_paper_exits integer := 0;
    v_active_risk_locks integer := 0;
    v_assisted_closed integer := 0;
    v_session_active boolean := false;
    v_readonly_ready boolean := false;
    v_paper_ready boolean := false;
    v_reconciled boolean := false;
    v_phase7 boolean := false;
    v_phase8 boolean := false;
    v_phase9 boolean := false;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    insert into public.swing_automation_controls(user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;

    select * into v_controls
    from public.swing_automation_controls where user_id = v_user_id;

    select * into v_connection
    from public.kite_broker_connections where user_id = v_user_id;

    select * into v_readonly
    from public.swing_worker_heartbeats
    where user_id = v_user_id and execution_mode = 'observe'
    order by heartbeat_at desc limit 1;

    select * into v_paper
    from public.swing_worker_heartbeats
    where user_id = v_user_id and execution_mode = 'paper_auto'
    order by heartbeat_at desc limit 1;

    select * into v_reconciliation
    from public.swing_reconciliation_runs
    where user_id = v_user_id
    order by checked_at desc limit 1;

    select count(*), coalesce(sum(entry_event_count), 0), coalesce(sum(exit_event_count), 0)
    into v_quote_sessions, v_paper_entries, v_paper_exits
    from public.swing_execution_validation_sessions
    where user_id = v_user_id
      and execution_mode = 'paper_auto'
      and fresh_quote_cycle_count > 0;

    select count(*) into v_active_risk_locks
    from public.swing_risk_control_activations
    where user_id = v_user_id and status = 'active';

    select count(*) into v_assisted_closed
    from public.swing_trades
    where user_id = v_user_id
      and execution_source = 'assisted_live'
      and trade_mode = 'live'
      and status = 'closed';

    v_session_active := v_connection.id is not null
        and v_connection.connection_status = 'connected'
        and v_connection.session_expires_at > now();
    v_readonly_ready := v_readonly.id is not null
        and v_readonly.heartbeat_at > now() - interval '10 minutes'
        and v_readonly.worker_status = 'healthy'
        and v_readonly.kite_session_healthy;
    v_paper_ready := v_paper.id is not null
        and v_paper.heartbeat_at > now() - interval '10 minutes'
        and v_paper.worker_status in ('healthy', 'degraded')
        and coalesce((v_paper.details->>'scenario_suite_passed')::boolean, false);
    v_reconciled := v_reconciliation.id is not null
        and v_reconciliation.checked_at > now() - interval '10 minutes'
        and v_reconciliation.reconciliation_status = 'matched';

    v_phase7 := v_controls.ddpi_confirmed_at is not null
        and v_controls.credentials_rotated_at is not null
        and v_controls.market_data_plan = 'connect'
        and v_session_active and v_readonly_ready and v_paper_ready and v_reconciled
        and v_quote_sessions >= 5 and v_paper_entries >= 3 and v_paper_exits >= 2
        and v_active_risk_locks = 0;
    v_phase8 := v_phase7
        and v_controls.assisted_live_unlocked
        and v_controls.broker_execution_enabled;
    v_phase9 := v_phase8
        and v_controls.live_auto_unlocked
        and v_assisted_closed >= 3;

    return jsonb_build_object(
        'phase7_ready', v_phase7,
        'phase8_ready', v_phase8,
        'phase9_ready', v_phase9,
        'live_modes_locked', not v_controls.broker_execution_enabled,
        'counts', jsonb_build_object(
            'paper_quote_sessions', v_quote_sessions,
            'paper_entry_events', v_paper_entries,
            'paper_exit_events', v_paper_exits,
            'assisted_live_closed_trades', v_assisted_closed,
            'active_risk_locks', v_active_risk_locks
        ),
        'limits', jsonb_build_object(
            'max_open_positions', v_controls.live_max_open_positions,
            'max_new_entries_per_day', v_controls.live_max_new_entries_per_day,
            'max_deployed_inr', v_controls.live_max_deployed_inr,
            'daily_loss_limit_inr', v_controls.live_daily_loss_limit_inr,
            'risk_per_trade_percentage', v_controls.live_risk_per_trade_percentage,
            'amber_risk_multiplier', v_controls.live_amber_risk_multiplier
        ),
        'checks', jsonb_build_array(
            jsonb_build_object('key', 'ddpi', 'passed', v_controls.ddpi_confirmed_at is not null, 'reason', case when v_controls.ddpi_confirmed_at is not null then 'DDPI confirmed.' else 'Confirm DDPI before live exits.' end),
            jsonb_build_object('key', 'credentials', 'passed', v_controls.credentials_rotated_at is not null, 'reason', case when v_controls.credentials_rotated_at is not null then 'Credential rotation confirmed.' else 'Rotate the previously exposed service-role key.' end),
            jsonb_build_object('key', 'market_data', 'passed', v_controls.market_data_plan = 'connect', 'reason', case when v_controls.market_data_plan = 'connect' then 'Kite Connect market data selected.' else 'Personal Free has no live market-data entitlement.' end),
            jsonb_build_object('key', 'kite_session', 'passed', v_session_active, 'reason', case when v_session_active then 'Daily Kite session is active.' else 'Connect Kite for the current day.' end),
            jsonb_build_object('key', 'readonly_worker', 'passed', v_readonly_ready, 'reason', case when v_readonly_ready then 'Read-only worker is current.' else 'Read-only worker is stale or unhealthy.' end),
            jsonb_build_object('key', 'paper_worker', 'passed', v_paper_ready, 'reason', case when v_paper_ready then 'Paper worker and scenario suite are current.' else 'Paper worker or scenario suite is not current.' end),
            jsonb_build_object('key', 'reconciliation', 'passed', v_reconciled, 'reason', case when v_reconciled then 'Broker and Tracker are reconciled.' else 'A fresh matched reconciliation is required.' end),
            jsonb_build_object('key', 'paper_sessions', 'passed', v_quote_sessions >= 5, 'reason', format('%s/5 fresh-quote paper sessions observed.', v_quote_sessions)),
            jsonb_build_object('key', 'paper_entries', 'passed', v_paper_entries >= 3, 'reason', format('%s/3 Paper Auto entry events observed.', v_paper_entries)),
            jsonb_build_object('key', 'paper_exits', 'passed', v_paper_exits >= 2, 'reason', format('%s/2 Paper Auto exit events observed.', v_paper_exits)),
            jsonb_build_object('key', 'risk_locks', 'passed', v_active_risk_locks = 0, 'reason', case when v_active_risk_locks = 0 then 'No active risk lock.' else format('%s active risk lock(s) require review.', v_active_risk_locks) end),
            jsonb_build_object('key', 'assisted_sample', 'passed', v_assisted_closed >= 3, 'reason', format('%s/3 Assisted Live trades completed.', v_assisted_closed))
        )
    );
end;
$$;

-- Full backups preserve observational validation history and numeric rollout
-- limits. Restores always return to Advisory, keep broker execution disabled,
-- and require DDPI/credential/market-data prerequisites to be confirmed again.
create or replace function public.restore_swing_execution_readiness_details(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;

    delete from public.swing_execution_validation_sessions where user_id = v_user_id;
    for v_row in
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_execution_validation_sessions', '[]'::jsonb))
    loop
        insert into public.swing_execution_validation_sessions(
            id, user_id, nse_session, execution_mode, first_observed_at, last_observed_at,
            cycle_count, healthy_cycle_count, degraded_cycle_count, blocked_cycle_count,
            fresh_quote_cycle_count, material_event_count, entry_event_count, exit_event_count,
            latest_worker_version, latest_policy_version, latest_cost_model_version,
            latest_status, latest_quote_count, latest_details, created_at
        ) values (
            (v_row->>'id')::uuid, v_user_id, (v_row->>'nse_session')::date,
            v_row->>'execution_mode', (v_row->>'first_observed_at')::timestamptz,
            (v_row->>'last_observed_at')::timestamptz,
            coalesce((v_row->>'cycle_count')::integer, 0),
            coalesce((v_row->>'healthy_cycle_count')::integer, 0),
            coalesce((v_row->>'degraded_cycle_count')::integer, 0),
            coalesce((v_row->>'blocked_cycle_count')::integer, 0),
            coalesce((v_row->>'fresh_quote_cycle_count')::integer, 0),
            coalesce((v_row->>'material_event_count')::integer, 0),
            coalesce((v_row->>'entry_event_count')::integer, 0),
            coalesce((v_row->>'exit_event_count')::integer, 0),
            nullif(v_row->>'latest_worker_version', ''),
            nullif(v_row->>'latest_policy_version', ''),
            nullif(v_row->>'latest_cost_model_version', ''),
            coalesce(nullif(v_row->>'latest_status', ''), 'blocked'),
            coalesce((v_row->>'latest_quote_count')::integer, 0),
            coalesce(v_row->'latest_details', '{}'::jsonb),
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now())
        );
    end loop;

    v_row := coalesce((p_backup->'data'->'swing_automation_controls')->0, '{}'::jsonb);
    update public.swing_automation_controls
    set automation_mode = 'advisory', new_entries_enabled = false,
        armed_nse_session = null, emergency_stop_active = false,
        assisted_live_unlocked = false, live_auto_unlocked = false,
        broker_execution_enabled = false, ddpi_confirmed_at = null,
        credentials_rotated_at = null, market_data_plan = 'personal',
        live_max_open_positions = least(greatest(coalesce(nullif(v_row->>'live_max_open_positions', '')::integer, 1), 1), 2),
        live_max_new_entries_per_day = least(greatest(coalesce(nullif(v_row->>'live_max_new_entries_per_day', '')::integer, 1), 1), 2),
        live_max_deployed_inr = greatest(coalesce(nullif(v_row->>'live_max_deployed_inr', '')::numeric, 5000), 1),
        live_daily_loss_limit_inr = greatest(coalesce(nullif(v_row->>'live_daily_loss_limit_inr', '')::numeric, 100), 1),
        live_risk_per_trade_percentage = least(greatest(coalesce(nullif(v_row->>'live_risk_per_trade_percentage', '')::numeric, 0.5), 0.01), 0.5),
        live_amber_risk_multiplier = least(greatest(coalesce(nullif(v_row->>'live_amber_risk_multiplier', '')::numeric, 0.5), 0.01), 0.5)
    where user_id = v_user_id;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v10(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then raise exception 'Authentication required.'; end if;
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer, 0) not in (1, 2, 3, 4, 5) then
        raise exception 'Unsupported backup format';
    end if;
    perform public.restore_complete_portfolio_backup_v9(p_backup);
    perform public.restore_swing_execution_readiness_details(p_backup);
end;
$$;

revoke all on table public.swing_execution_validation_sessions from public, anon;
revoke all on table public.swing_execution_readiness_checks from public, anon;
grant select on table public.swing_execution_validation_sessions to authenticated;
grant select on table public.swing_execution_readiness_checks to authenticated;
grant select, insert, update, delete on table public.swing_execution_validation_sessions to service_role;
grant select, insert, update, delete on table public.swing_execution_readiness_checks to service_role;

revoke all on function public.configure_swing_live_readiness(boolean, boolean, text, integer, integer, numeric, numeric, numeric, numeric)
    from public, anon;
grant execute on function public.configure_swing_live_readiness(boolean, boolean, text, integer, integer, numeric, numeric, numeric, numeric)
    to authenticated;

revoke all on function public.set_swing_emergency_stop(text) from public, anon;
grant execute on function public.set_swing_emergency_stop(text) to authenticated;

revoke all on function public.get_swing_rollout_readiness() from public, anon;
grant execute on function public.get_swing_rollout_readiness() to authenticated;

revoke all on function public.restore_swing_execution_readiness_details(jsonb)
    from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v10(jsonb)
    from public, anon;
grant execute on function public.restore_complete_portfolio_backup_v10(jsonb)
    to authenticated;

commit;
