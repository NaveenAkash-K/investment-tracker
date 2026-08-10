begin;

-- Phases 8 and 9: Assisted Live and capped Live Auto. The database is the
-- authority for arming, approval, idempotency, risk limits and audit history.
-- Broker transport is service-role only and remains locked by default.

alter table public.swing_order_intents
    add column if not exists approval_status text not null default 'not_required',
    add column if not exists approval_requested_at timestamptz,
    add column if not exists approval_expires_at timestamptz,
    add column if not exists approved_at timestamptz,
    add column if not exists approved_by uuid references auth.users(id) on delete set null,
    add column if not exists broker_tag text,
    add column if not exists lease_owner text,
    add column if not exists lease_expires_at timestamptz,
    add column if not exists last_validated_at timestamptz;

alter table public.swing_order_intents
    drop constraint if exists swing_order_intents_approval_status_check;
alter table public.swing_order_intents
    add constraint swing_order_intents_approval_status_check
    check (approval_status in ('not_required', 'pending', 'approved', 'rejected', 'expired'));

alter table public.swing_order_intents
    drop constraint if exists swing_order_intents_approval_window_check;
alter table public.swing_order_intents
    add constraint swing_order_intents_approval_window_check
    check (
        (automation_mode <> 'assisted_live' and approval_status = 'not_required')
        or (automation_mode = 'assisted_live' and intent_purpose in ('protective_stop','replace_stop','cancel') and approval_status = 'not_required')
        or (automation_mode = 'assisted_live' and intent_purpose in ('entry','exit') and approval_status <> 'not_required')
    );

create unique index if not exists swing_order_intents_user_broker_tag_idx
    on public.swing_order_intents(user_id, broker_tag)
    where broker_tag is not null;

alter table public.swing_broker_orders
    add column if not exists broker_tag text,
    add column if not exists last_reconciled_at timestamptz;

alter table public.swing_trades
    add column if not exists partial_exit_quantity integer not null default 0,
    add column if not exists partial_exit_realized_pnl_inr numeric(18,2) not null default 0;

alter table public.swing_trades
    drop constraint if exists swing_trades_partial_exit_quantity_check;
alter table public.swing_trades
    add constraint swing_trades_partial_exit_quantity_check check (partial_exit_quantity>=0);

create unique index if not exists swing_broker_orders_user_tag_idx
    on public.swing_broker_orders(user_id, broker_tag)
    where broker_tag is not null;

create unique index if not exists swing_protective_orders_user_trigger_idx
    on public.swing_protective_orders(user_id, broker_trigger_id)
    where broker_trigger_id is not null;

create table if not exists public.swing_candidate_execution_states (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    candidate_id uuid not null,
    nse_session date not null,
    state text not null default 'watching'
        check (state in ('watching', 'armed', 'invalidated', 'intent_created')),
    observed_below_trigger boolean not null default false,
    first_observed_at timestamptz not null,
    last_observed_at timestamptz not null,
    session_open numeric(18, 4) not null check (session_open > 0),
    session_high numeric(18, 4) not null check (session_high > 0),
    session_low numeric(18, 4) not null check (session_low > 0),
    last_price numeric(18, 4) not null check (last_price > 0),
    quote_observed_at timestamptz not null,
    reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, candidate_id, nse_session),
    constraint swing_candidate_execution_state_candidate_user_fk
        foreign key (candidate_id, user_id)
        references public.swing_candidates(id, user_id)
        on delete cascade
);

create index if not exists swing_candidate_execution_states_user_session_idx
    on public.swing_candidate_execution_states(user_id, nse_session desc, state);

alter table public.swing_candidate_execution_states enable row level security;
drop policy if exists "Users view their swing_candidate_execution_states"
    on public.swing_candidate_execution_states;
create policy "Users view their swing_candidate_execution_states"
    on public.swing_candidate_execution_states for select
    using (auth.uid() = user_id);

drop trigger if exists swing_candidate_execution_states_set_updated_at
    on public.swing_candidate_execution_states;
create trigger swing_candidate_execution_states_set_updated_at
before update on public.swing_candidate_execution_states
for each row execute function public.set_updated_at();

grant select on table public.swing_candidate_execution_states to authenticated;
grant select, insert, update, delete on table public.swing_candidate_execution_states to service_role;

create or replace function public.configure_swing_live_mode(
    p_action text,
    p_mode text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_today date := (now() at time zone 'Asia/Kolkata')::date;
    v_controls public.swing_automation_controls%rowtype;
    v_connection public.kite_broker_connections%rowtype;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_action not in ('arm', 'pause', 'advisory') then
        raise exception 'Live action must be arm, pause or advisory.';
    end if;
    if p_mode not in ('assisted_live', 'live_auto') then
        raise exception 'Live mode must be assisted_live or live_auto.';
    end if;

    insert into public.swing_automation_controls(user_id) values (v_user_id)
    on conflict (user_id) do nothing;
    select * into v_controls from public.swing_automation_controls
    where user_id = v_user_id for update;

    if p_action = 'arm' then
        if v_controls.emergency_stop_active then
            raise exception 'Clear the emergency stop before arming live execution.';
        end if;
        if not v_controls.broker_execution_enabled
           or (p_mode = 'assisted_live' and not v_controls.assisted_live_unlocked)
           or (p_mode = 'live_auto' and not v_controls.live_auto_unlocked) then
            raise exception 'This live execution mode is still locked.';
        end if;
        if v_controls.market_data_plan <> 'connect' then
            raise exception 'Kite Connect market data is required for live execution.';
        end if;
        if v_controls.ddpi_confirmed_at is null or v_controls.credentials_rotated_at is null then
            raise exception 'DDPI and credential rotation must be confirmed before live execution.';
        end if;
        select * into v_connection from public.kite_broker_connections
        where user_id = v_user_id;
        if not found or v_connection.connection_status <> 'connected'
           or v_connection.session_expires_at <= now() then
            raise exception 'Connect Kite for today before arming live execution.';
        end if;
        if exists (
            select 1 from public.swing_risk_control_activations
            where user_id = v_user_id and status = 'active'
        ) then
            raise exception 'Resolve active execution risk locks before arming.';
        end if;
        update public.swing_automation_controls set
            automation_mode = p_mode,
            new_entries_enabled = true,
            armed_nse_session = v_today
        where user_id = v_user_id;
    elsif p_action = 'pause' then
        update public.swing_automation_controls set
            automation_mode = p_mode,
            new_entries_enabled = false
        where user_id = v_user_id;
    else
        update public.swing_automation_controls set
            automation_mode = 'advisory',
            new_entries_enabled = false,
            armed_nse_session = null
        where user_id = v_user_id;
    end if;

    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', p_mode || '_' || p_action,
        'automation_control', v_user_id::text,
        jsonb_build_object('mode', p_mode, 'action', p_action, 'nse_session', v_today)
    );
end;
$$;

create or replace function public.decide_swing_assisted_intent(
    p_intent_id uuid,
    p_action text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_intent public.swing_order_intents%rowtype;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_action not in ('approve', 'reject') then
        raise exception 'Assisted intent action must be approve or reject.';
    end if;
    select * into v_intent from public.swing_order_intents
    where id = p_intent_id and user_id = v_user_id for update;
    if not found or v_intent.automation_mode <> 'assisted_live'
       or v_intent.status <> 'pending' or v_intent.approval_status <> 'pending' then
        raise exception 'This Assisted Live proposal is no longer awaiting a decision.';
    end if;
    if v_intent.approval_expires_at <= now() then
        update public.swing_order_intents set
            approval_status = 'expired', status = 'blocked',
            failure_reason = 'Assisted Live approval window expired.', completed_at = now()
        where id = v_intent.id;
        raise exception 'This Assisted Live proposal has expired.';
    end if;
    if p_action = 'approve' then
        update public.swing_order_intents set
            approval_status = 'approved', approved_at = now(), approved_by = v_user_id
        where id = v_intent.id;
    else
        update public.swing_order_intents set
            approval_status = 'rejected', status = 'cancelled',
            completed_at = now(), failure_reason = 'Rejected by user.'
        where id = v_intent.id;
    end if;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', 'assisted_intent_' || p_action,
        'order_intent', v_intent.id::text,
        jsonb_build_object('symbol', v_intent.symbol, 'quantity', v_intent.quantity)
    );
end;
$$;

create or replace function public.set_swing_execution_rollout_lock(
    p_user_id uuid,
    p_assisted_live_unlocked boolean,
    p_live_auto_unlocked boolean,
    p_broker_execution_enabled boolean,
    p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_quote_sessions integer;
    v_paper_entries integer;
    v_paper_exits integer;
    v_assisted_closed integer;
    v_phase7_ready boolean;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if nullif(trim(p_reason), '') is null then raise exception 'An unlock reason is required.'; end if;
    insert into public.swing_automation_controls(user_id) values (p_user_id)
    on conflict (user_id) do nothing;
    select * into v_controls from public.swing_automation_controls
    where user_id = p_user_id for update;
    if p_broker_execution_enabled and (
        v_controls.market_data_plan <> 'connect'
        or v_controls.ddpi_confirmed_at is null
        or v_controls.credentials_rotated_at is null
    ) then
        raise exception 'Connect market data, DDPI and rotated credentials are required.';
    end if;
    if p_live_auto_unlocked and not p_assisted_live_unlocked then
        raise exception 'Live Auto cannot unlock before Assisted Live.';
    end if;
    if p_broker_execution_enabled and not p_assisted_live_unlocked then
        raise exception 'Broker execution cannot enable before Assisted Live is unlocked.';
    end if;
    select count(*),coalesce(sum(entry_event_count),0),coalesce(sum(exit_event_count),0)
    into v_quote_sessions,v_paper_entries,v_paper_exits
    from public.swing_execution_validation_sessions where user_id=p_user_id
      and execution_mode='paper_auto' and fresh_quote_cycle_count>0;
    select count(*) into v_assisted_closed from public.swing_trades where user_id=p_user_id
      and trade_mode='live' and execution_source='assisted_live' and status='closed';
    v_phase7_ready := v_controls.market_data_plan='connect'
      and v_controls.ddpi_confirmed_at is not null and v_controls.credentials_rotated_at is not null
      and v_quote_sessions>=5 and v_paper_entries>=3 and v_paper_exits>=2
      and exists(select 1 from public.kite_broker_connections where user_id=p_user_id
          and connection_status='connected' and session_expires_at>now())
      and exists(select 1 from public.swing_worker_heartbeats where user_id=p_user_id
          and execution_mode='observe' and worker_status='healthy' and kite_session_healthy
          and heartbeat_at>now()-interval '10 minutes')
      and exists(select 1 from public.swing_worker_heartbeats where user_id=p_user_id
          and execution_mode='paper_auto' and worker_status in ('healthy','degraded')
          and coalesce((details->>'scenario_suite_passed')::boolean,false)
          and heartbeat_at>now()-interval '10 minutes')
      and exists(select 1 from public.swing_reconciliation_runs where user_id=p_user_id
          and reconciliation_status='matched' and checked_at>now()-interval '10 minutes')
      and not exists(select 1 from public.swing_risk_control_activations
          where user_id=p_user_id and status='active');
    if (p_assisted_live_unlocked or p_broker_execution_enabled) and not v_phase7_ready then
        raise exception 'Phase 7 evidence and current broker health are not ready.';
    end if;
    if p_live_auto_unlocked and v_assisted_closed<3 then
        raise exception 'Complete at least three reconciled Assisted Live trades before unlocking Live Auto.';
    end if;
    update public.swing_automation_controls set
        assisted_live_unlocked = p_assisted_live_unlocked,
        live_auto_unlocked = p_live_auto_unlocked,
        broker_execution_enabled = p_broker_execution_enabled,
        locked_reason = left(trim(p_reason), 500),
        automation_mode = case when p_broker_execution_enabled then automation_mode else 'advisory' end,
        new_entries_enabled = case when p_broker_execution_enabled then new_entries_enabled else false end,
        armed_nse_session = case when p_broker_execution_enabled then armed_nse_session else null end
    where user_id = p_user_id;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        p_user_id, 'system', 'execution_rollout_lock_changed',
        'automation_control', p_user_id::text,
        jsonb_build_object(
            'assisted_live_unlocked', p_assisted_live_unlocked,
            'live_auto_unlocked', p_live_auto_unlocked,
            'broker_execution_enabled', p_broker_execution_enabled,
            'reason', left(trim(p_reason), 500)
        )
    );
end;
$$;

create or replace function public.get_swing_live_worker_state(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_connection public.kite_broker_connections%rowtype;
    v_session public.kite_broker_sessions%rowtype;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    select * into v_controls from public.swing_automation_controls where user_id = p_user_id;
    select * into v_connection from public.kite_broker_connections where user_id = p_user_id;
    select * into v_session from public.kite_broker_sessions where user_id = p_user_id;
    return jsonb_build_object(
        'controls', case when v_controls.user_id is null then null else to_jsonb(v_controls) end,
        'connection', case when v_connection.id is null then null else jsonb_build_object(
            'status', v_connection.connection_status,
            'broker_user_id', v_connection.broker_user_id,
            'session_expires_at', v_connection.session_expires_at
        ) end,
        'session', case when v_session.id is null or v_session.revoked_at is not null then null else jsonb_build_object(
            'ciphertext', v_session.encrypted_access_token,
            'iv', v_session.encryption_iv,
            'auth_tag', v_session.encryption_auth_tag,
            'version', v_session.token_version,
            'expires_at', v_session.expires_at
        ) end,
        'account', (select to_jsonb(a) from public.swing_broker_account_snapshots a
            where a.user_id = p_user_id order by a.observed_at desc limit 1),
        'reconciliation', (select to_jsonb(r) from public.swing_reconciliation_runs r
            where r.user_id = p_user_id order by r.checked_at desc limit 1),
        'candidates', coalesce((select jsonb_agg(jsonb_build_object(
            'id', c.id, 'scan_id', c.scan_id, 'signal_key', c.signal_key,
            'symbol', c.symbol, 'company_name', c.company_name, 'sector', c.sector,
            'status', c.status, 'setup_as_of', c.setup_as_of, 'expires_on', c.expires_on,
            'entry_trigger', c.entry_trigger, 'maximum_entry', c.maximum_entry,
            'initial_stop', c.initial_stop, 'suggested_quantity', c.suggested_quantity,
            'market_regime', c.market_regime, 'model_version', s.model_version,
            'scan_status', s.status, 'publication_status', s.publication_status,
            'session_state', s.session_state, 'session_matches_expected', s.session_matches_expected,
            'contract_version', s.contract_version, 'expected_price_session', s.expected_price_session,
            'execution_state', (select to_jsonb(es) from public.swing_candidate_execution_states es
                where es.user_id = p_user_id and es.candidate_id = c.id
                  and es.nse_session = (now() at time zone 'Asia/Kolkata')::date)
        ) order by c.setup_score desc) from public.swing_candidates c
        join public.swing_scan_runs s on s.id = c.scan_id and s.user_id = c.user_id
        where c.user_id = p_user_id and c.status in ('candidate','ready','triggered')
          and c.expires_on >= (now() at time zone 'Asia/Kolkata')::date
          and c.suggested_quantity > 0 and left(c.setup_type, 5) <> 'TEST_'), '[]'::jsonb),
        'positions', coalesce((select jsonb_agg(to_jsonb(t) order by t.entry_date, t.created_at)
            from public.swing_trades t where t.user_id = p_user_id and t.trade_mode = 'live'
              and t.status in ('open','exit_pending')), '[]'::jsonb),
        'executable_intents', coalesce((select jsonb_agg(to_jsonb(i) order by i.requested_at)
            from public.swing_order_intents i where i.user_id = p_user_id
              and i.status in ('pending','leased','validated','submitted','partially_filled')), '[]'::jsonb),
        'recent_intents', coalesce((select jsonb_agg(to_jsonb(i) order by i.requested_at desc)
            from public.swing_order_intents i where i.user_id = p_user_id), '[]'::jsonb),
        'broker_orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at desc)
            from public.swing_broker_orders o where o.user_id = p_user_id), '[]'::jsonb),
        'protective_orders', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc)
            from public.swing_protective_orders p where p.user_id = p_user_id
              and p.status in ('pending','active','triggered','failed','rejected')), '[]'::jsonb)
    );
end;
$$;

create or replace function public.publish_swing_live_observation(
    p_user_id uuid,
    p_cycle jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_candidate public.swing_candidates%rowtype;
    v_scan public.swing_scan_runs%rowtype;
    v_latest_scan public.swing_scan_runs%rowtype;
    v_observation jsonb;
    v_state public.swing_candidate_execution_states%rowtype;
    v_mode text := nullif(p_cycle->>'execution_mode', '');
    v_worker_id text := nullif(trim(p_cycle->>'worker_id'), '');
    v_observed_at timestamptz := coalesce(nullif(p_cycle->>'observed_at', '')::timestamptz, now());
    v_session date := nullif(p_cycle->>'nse_session', '')::date;
    v_candidate_id uuid;
    v_last numeric;
    v_open numeric;
    v_high numeric;
    v_low numeric;
    v_quote_at timestamptz;
    v_fresh boolean;
    v_was_armed boolean;
    v_intent_id uuid;
    v_intent_key text;
    v_quantity integer;
    v_risk numeric;
    v_deployed numeric;
    v_open_count integer;
    v_sector_count integer;
    v_daily_entries integer;
    v_available_cash numeric;
    v_daily_realized numeric;
    v_reconciliation_ok boolean;
    v_created integer := 0;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if v_mode not in ('assisted_live','live_auto') then raise exception 'Invalid live execution mode.'; end if;
    if v_worker_id is null or v_worker_id !~ '^[A-Za-z0-9._:-]{3,100}$' then raise exception 'Invalid worker id.'; end if;
    if v_session is null or v_session <> (v_observed_at at time zone 'Asia/Kolkata')::date
       or v_observed_at < now() - interval '5 minutes' or v_observed_at > now() + interval '2 minutes' then
        raise exception 'Invalid live observation time.';
    end if;
    if jsonb_typeof(coalesce(p_cycle->'observations','[]'::jsonb)) <> 'array' then
        raise exception 'Live observations must be an array.';
    end if;

    select * into v_controls from public.swing_automation_controls
    where user_id = p_user_id for update;

    select * into v_latest_scan from public.swing_scan_runs
    where user_id=p_user_id order by as_of desc limit 1;

    insert into public.swing_worker_heartbeats(
        user_id, worker_id, worker_version, execution_policy_version,
        observed_public_ip, worker_status, execution_mode, kite_session_healthy,
        quote_stream_healthy, reconciliation_healthy, heartbeat_at, details
    ) values (
        p_user_id, v_worker_id, coalesce(nullif(p_cycle->>'worker_version',''),'unknown'),
        nullif(p_cycle->>'execution_policy_version',''), nullif(p_cycle->>'observed_public_ip','')::inet,
        coalesce(nullif(p_cycle->>'worker_status',''),'blocked'), v_mode,
        coalesce((p_cycle->>'kite_session_healthy')::boolean,false),
        coalesce((p_cycle->>'quote_stream_healthy')::boolean,false),
        coalesce((p_cycle->>'reconciliation_healthy')::boolean,false),
        v_observed_at, coalesce(p_cycle->'details','{}'::jsonb)
    ) on conflict (user_id, worker_id) do update set
        worker_version=excluded.worker_version, execution_policy_version=excluded.execution_policy_version,
        observed_public_ip=excluded.observed_public_ip, worker_status=excluded.worker_status,
        execution_mode=excluded.execution_mode, kite_session_healthy=excluded.kite_session_healthy,
        quote_stream_healthy=excluded.quote_stream_healthy,
        reconciliation_healthy=excluded.reconciliation_healthy,
        heartbeat_at=excluded.heartbeat_at, details=excluded.details;

    if v_controls.user_id is null or v_controls.automation_mode <> v_mode
       or not v_controls.new_entries_enabled or v_controls.armed_nse_session <> v_session
       or v_controls.emergency_stop_active or not v_controls.broker_execution_enabled
       or v_controls.market_data_plan <> 'connect'
       or (v_mode='assisted_live' and not v_controls.assisted_live_unlocked)
       or (v_mode='live_auto' and not v_controls.live_auto_unlocked) then
        return jsonb_build_object('created',0,'blocked','Live execution is not armed and unlocked.');
    end if;
    if v_latest_scan.id is null or v_latest_scan.status not in ('successful','partial')
       or v_latest_scan.publication_status<>'published' or v_latest_scan.model_version<>'2.5.0'
       or v_latest_scan.contract_version<>'2026-07-30.v2' or v_latest_scan.session_state<>'completed'
       or not v_latest_scan.session_matches_expected or v_latest_scan.market_regime not in ('GREEN','AMBER')
       or v_latest_scan.expected_price_session is null
       or v_session<v_latest_scan.expected_price_session or v_session-v_latest_scan.expected_price_session>4 then
        return jsonb_build_object('created',0,'blocked','The latest completed Swing scan is stale, failed or unsupported.');
    end if;

    select available_cash into v_available_cash from public.swing_broker_account_snapshots
    where user_id=p_user_id and account_status='healthy' and observed_at > now()-interval '10 minutes'
    order by observed_at desc limit 1;
    select exists(select 1 from public.swing_reconciliation_runs where user_id=p_user_id
        and reconciliation_status='matched' and checked_at > now()-interval '10 minutes')
    into v_reconciliation_ok;
    if v_available_cash is null or not v_reconciliation_ok then
        return jsonb_build_object('created',0,'blocked','Fresh funds and reconciliation evidence are required.');
    end if;
    if exists(select 1 from public.swing_risk_control_activations
        where user_id=p_user_id and status='active') then
        return jsonb_build_object('created',0,'blocked','An active execution risk lock blocks new entries.');
    end if;
    select coalesce(sum(realized_pnl_inr),0) into v_daily_realized
    from public.swing_trades where user_id=p_user_id and trade_mode='live'
      and exit_date=v_session and status='closed';
    if v_daily_realized <= -v_controls.live_daily_loss_limit_inr then
        if not exists(select 1 from public.swing_risk_control_activations
            where user_id=p_user_id and control_type='daily_loss' and status='active') then
            insert into public.swing_risk_control_activations(user_id,control_type,status,reason,details)
            values(p_user_id,'daily_loss','active','Daily live loss limit reached.',
                jsonb_build_object('nse_session',v_session,'realized_pnl_inr',v_daily_realized,
                    'limit_inr',v_controls.live_daily_loss_limit_inr));
        end if;
        update public.swing_automation_controls set new_entries_enabled=false where user_id=p_user_id;
        return jsonb_build_object('created',0,'blocked','Daily live loss limit reached.');
    end if;

    for v_observation in select value from jsonb_array_elements(coalesce(p_cycle->'observations','[]'::jsonb)) loop
        v_candidate_id := nullif(v_observation->>'candidate_id','')::uuid;
        v_last := nullif(v_observation->>'last_price','')::numeric;
        v_open := nullif(v_observation->>'session_open','')::numeric;
        v_high := nullif(v_observation->>'session_high','')::numeric;
        v_low := nullif(v_observation->>'session_low','')::numeric;
        v_quote_at := nullif(v_observation->>'quote_observed_at','')::timestamptz;
        v_fresh := coalesce((v_observation->>'quote_fresh')::boolean,false);
        if v_candidate_id is null or least(v_last,v_open,v_high,v_low) <= 0 or not v_fresh
           or v_quote_at < now()-interval '2 minutes' or v_quote_at > now()+interval '30 seconds' then
            continue;
        end if;
        select * into v_candidate from public.swing_candidates
        where id=v_candidate_id and user_id=p_user_id for update;
        if not found then continue; end if;
        select * into v_scan from public.swing_scan_runs
        where id=v_candidate.scan_id and user_id=p_user_id;
        if not found or v_candidate.status not in ('candidate','ready','triggered')
           or v_session > v_candidate.expires_on or v_candidate.suggested_quantity <= 0
           or v_scan.model_version <> '2.5.0' or v_scan.contract_version <> '2026-07-30.v2'
           or v_scan.status not in ('successful','partial') or v_scan.publication_status <> 'published'
           or v_scan.session_state <> 'completed' or not v_scan.session_matches_expected
           or v_scan.market_regime not in ('GREEN','AMBER') then continue; end if;

        select * into v_state from public.swing_candidate_execution_states
        where user_id=p_user_id and candidate_id=v_candidate.id and nse_session=v_session for update;
        v_was_armed := found and v_state.observed_below_trigger and v_state.state='armed';

        insert into public.swing_candidate_execution_states(
            user_id,candidate_id,nse_session,state,observed_below_trigger,
            first_observed_at,last_observed_at,session_open,session_high,session_low,
            last_price,quote_observed_at,reason
        ) values (
            p_user_id,v_candidate.id,v_session,
            case when v_open>v_candidate.maximum_entry or v_high>v_candidate.maximum_entry
                       or v_open<=v_candidate.initial_stop or v_low<=v_candidate.initial_stop
                 then 'invalidated'
                 when v_last<v_candidate.entry_trigger then 'armed' else 'watching' end,
            v_last<v_candidate.entry_trigger,v_observed_at,v_observed_at,v_open,v_high,v_low,
            v_last,v_quote_at,null
        ) on conflict(user_id,candidate_id,nse_session) do update set
            state=case when swing_candidate_execution_states.state in ('invalidated','intent_created')
                       then swing_candidate_execution_states.state
                       when excluded.session_open>v_candidate.maximum_entry or excluded.session_high>v_candidate.maximum_entry
                            or excluded.session_open<=v_candidate.initial_stop or excluded.session_low<=v_candidate.initial_stop
                       then 'invalidated'
                       when swing_candidate_execution_states.observed_below_trigger or excluded.last_price<v_candidate.entry_trigger
                       then 'armed' else 'watching' end,
            observed_below_trigger=swing_candidate_execution_states.observed_below_trigger
                or excluded.last_price<v_candidate.entry_trigger,
            last_observed_at=excluded.last_observed_at, session_open=excluded.session_open,
            session_high=excluded.session_high, session_low=excluded.session_low,
            last_price=excluded.last_price, quote_observed_at=excluded.quote_observed_at;

        update public.swing_order_intents set last_validated_at=now(),
            metadata=metadata||jsonb_build_object('observed_price',v_last,'quote_observed_at',v_quote_at)
        where user_id=p_user_id and candidate_id=v_candidate.id and intent_purpose='entry'
          and nse_session=v_session and status in ('pending','leased','validated');

        if not v_was_armed or v_last < v_candidate.entry_trigger
           or v_last > v_candidate.maximum_entry or v_low <= v_candidate.initial_stop
           or (v_observed_at at time zone 'Asia/Kolkata')::time < time '09:20' then continue; end if;

        select count(*),coalesce(sum(entry_price*quantity),0) into v_open_count,v_deployed
        from public.swing_trades where user_id=p_user_id and trade_mode='live' and status in ('open','exit_pending');
        select count(*) into v_sector_count from public.swing_trades where user_id=p_user_id
          and trade_mode='live' and status in ('open','exit_pending')
          and coalesce(sector,'Unclassified')=coalesce(v_candidate.sector,'Unclassified');
        select count(*) into v_daily_entries from public.swing_order_intents where user_id=p_user_id
          and intent_purpose='entry' and automation_mode in ('assisted_live','live_auto')
          and nse_session=v_session and status not in ('cancelled','rejected','blocked','failed');
        v_quantity := least(v_candidate.suggested_quantity,
            floor(v_controls.live_max_deployed_inr/greatest(v_last,0.01))::integer,
            floor(v_available_cash/greatest(v_last,0.01))::integer);
        v_risk := (v_last-v_candidate.initial_stop)*v_quantity;
        if v_quantity<1 or v_open_count>=v_controls.live_max_open_positions
           or v_sector_count>=1 or v_daily_entries>=v_controls.live_max_new_entries_per_day
           or v_deployed+v_last*v_quantity>v_controls.live_max_deployed_inr+0.01
           or v_risk > (v_controls.live_max_deployed_inr*v_controls.live_risk_per_trade_percentage/100
              * case when v_scan.market_regime='AMBER' then v_controls.live_amber_risk_multiplier else 1 end)+0.01 then
            continue;
        end if;

        v_intent_key := 'live:'||v_mode||':'||v_candidate.signal_key||':'||v_session::text||':entry';
        insert into public.swing_order_intents(
            user_id,candidate_id,intent_key,intent_purpose,automation_mode,status,
            strategy_model_version,execution_policy_version,nse_session,exchange,product,
            symbol,transaction_type,order_type,quantity,limit_price,maximum_entry,
            approval_status,approval_requested_at,approval_expires_at,broker_tag,last_validated_at,metadata
        ) values (
            p_user_id,v_candidate.id,v_intent_key,'entry',v_mode,'pending','2.5.0','1.0.0',
            v_session,'NSE','CNC',v_candidate.symbol,'BUY','LIMIT',v_quantity,
            v_candidate.maximum_entry,v_candidate.maximum_entry,
            case when v_mode='assisted_live' then 'pending' else 'not_required' end,
            case when v_mode='assisted_live' then now() else null end,
            case when v_mode='assisted_live' then now()+interval '5 minutes' else null end,
            substring(md5(v_intent_key) from 1 for 20),now(),
            jsonb_build_object('entry_trigger',v_candidate.entry_trigger,'initial_stop',v_candidate.initial_stop,
                'observed_price',v_last,'planned_risk_inr',v_risk,'regime',v_scan.market_regime)
        ) on conflict(user_id,intent_key) do nothing returning id into v_intent_id;
        if v_intent_id is not null then
            update public.swing_candidate_execution_states set state='intent_created',reason='Live entry intent created.'
            where user_id=p_user_id and candidate_id=v_candidate.id and nse_session=v_session;
            insert into public.swing_execution_audit_events(user_id,actor_type,event_type,entity_type,entity_id,details)
            values(p_user_id,'worker','live_entry_intent_created','order_intent',v_intent_id::text,
                jsonb_build_object('mode',v_mode,'symbol',v_candidate.symbol,'quantity',v_quantity));
            v_created := v_created+1;
        end if;
        v_intent_id := null;
    end loop;
    return jsonb_build_object('created',v_created);
end;
$$;

create or replace function public.create_swing_live_exit_intent(
    p_user_id uuid,p_worker_id text,p_trade_id uuid,p_nse_session date,
    p_last_price numeric,p_quote_observed_at timestamptz
)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_trade public.swing_trades%rowtype;
    v_mode text;
    v_key text;
    v_id uuid;
begin
    if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
    if p_nse_session<>(p_quote_observed_at at time zone 'Asia/Kolkata')::date
       or p_quote_observed_at<now()-interval '2 minutes' or p_quote_observed_at>now()+interval '30 seconds'
       or (p_quote_observed_at at time zone 'Asia/Kolkata')::time<time '09:20'
       or p_last_price<=0 then raise exception 'A fresh post-09:20 current-session quote is required for a live exit.'; end if;
    select * into v_controls from public.swing_automation_controls where user_id=p_user_id;
    select * into v_trade from public.swing_trades where id=p_trade_id and user_id=p_user_id
      and trade_mode='live' and status='exit_pending' and not corporate_action_review_required for update;
    if not found then return null; end if;
    v_mode := case when v_controls.automation_mode in ('assisted_live','live_auto')
        then v_controls.automation_mode else v_trade.execution_source end;
    if v_mode not in ('assisted_live','live_auto') or not v_controls.broker_execution_enabled then return null; end if;
    v_key := 'live:'||v_mode||':'||v_trade.id::text||':'||p_nse_session::text||':exit';
    insert into public.swing_order_intents(user_id,trade_id,intent_key,intent_purpose,
        automation_mode,status,strategy_model_version,execution_policy_version,nse_session,
        exchange,product,symbol,transaction_type,order_type,quantity,limit_price,
        approval_status,approval_requested_at,approval_expires_at,broker_tag,last_validated_at,metadata)
    values(p_user_id,v_trade.id,v_key,'exit',v_mode,'pending','2.5.0','1.0.0',p_nse_session,
        'NSE','CNC',v_trade.symbol,'SELL','LIMIT',v_trade.quantity,
        round(p_last_price*0.995/0.05)*0.05,
        case when v_mode='assisted_live' then 'pending' else 'not_required' end,
        case when v_mode='assisted_live' then now() else null end,
        case when v_mode='assisted_live' then now()+interval '5 minutes' else null end,
        substring(md5(v_key) from 1 for 20),now(),
        jsonb_build_object('exit_reason',v_trade.exit_signal_reason,'observed_price',p_last_price,
            'protective_stop',v_trade.current_stop))
    on conflict(user_id,intent_key) do update set last_validated_at=excluded.last_validated_at
    returning id into v_id;
    return v_id;
end; $$;

create or replace function public.register_swing_gtt_exit(
    p_user_id uuid,p_worker_id text,p_trade_id uuid,p_broker_order_id text,p_nse_session date
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
    v_trade public.swing_trades%rowtype;
    v_key text;
    v_intent_id uuid;
begin
    if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
    select * into v_trade from public.swing_trades where id=p_trade_id and user_id=p_user_id
      and trade_mode='live' and status in ('open','exit_pending') for update;
    if not found then raise exception 'Protected live trade is unavailable.'; end if;
    v_key := 'kite:gtt:'||trim(p_broker_order_id);
    insert into public.swing_order_intents(user_id,trade_id,intent_key,intent_purpose,
        automation_mode,status,strategy_model_version,execution_policy_version,nse_session,
        exchange,product,symbol,transaction_type,order_type,quantity,approval_status,
        broker_tag,lease_owner,lease_expires_at,last_validated_at,metadata)
    values(p_user_id,v_trade.id,v_key,'protective_stop',v_trade.execution_source,'leased',
        '2.5.0','1.0.0',p_nse_session,'NSE','CNC',v_trade.symbol,'SELL','LIMIT',v_trade.quantity,
        'not_required',substring(md5(v_key) from 1 for 20),p_worker_id,now()+interval '30 seconds',now(),
        jsonb_build_object('broker_order_id',trim(p_broker_order_id),'protective_stop',v_trade.current_stop))
    on conflict(user_id,intent_key) do update set lease_owner=p_worker_id,
        lease_expires_at=now()+interval '30 seconds',last_validated_at=now()
    returning id into v_intent_id;
    update public.swing_protective_orders set status='triggered',last_verified_at=now()
    where user_id=p_user_id and trade_id=v_trade.id and status='active';
    return jsonb_build_object('id',v_intent_id,'trade_id',v_trade.id,'intent_purpose','protective_stop',
        'automation_mode',v_trade.execution_source,'symbol',v_trade.symbol,'transaction_type','SELL',
        'order_type','LIMIT','quantity',v_trade.quantity,'broker_tag',substring(md5(v_key) from 1 for 20));
end; $$;

create or replace function public.claim_swing_order_intent(
    p_user_id uuid,
    p_worker_id text,
    p_max_mode text,
    p_lease_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_intent public.swing_order_intents%rowtype;
    v_candidate public.swing_candidates%rowtype;
    v_state public.swing_candidate_execution_states%rowtype;
    v_available_cash numeric;
    v_open_count integer;
    v_daily_entries integer;
    v_deployed numeric;
    v_sector_count integer;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if p_max_mode not in ('assisted_live','live_auto') then raise exception 'Invalid worker execution ceiling.'; end if;
    if p_lease_seconds not between 10 and 120 then raise exception 'Invalid lease duration.'; end if;
    select * into v_controls from public.swing_automation_controls where user_id=p_user_id for update;
    if v_controls.user_id is null or not v_controls.broker_execution_enabled
       or v_controls.automation_mode not in ('assisted_live','live_auto') then return null; end if;
    if p_max_mode='assisted_live' and v_controls.automation_mode='live_auto' then return null; end if;

    update public.swing_order_intents set approval_status='expired',status='blocked',
        failure_reason='Assisted Live approval window expired.',completed_at=now()
    where user_id=p_user_id and automation_mode='assisted_live' and status='pending'
      and approval_status='pending' and approval_expires_at<=now();

    select * into v_intent from public.swing_order_intents
    where user_id=p_user_id and status in ('pending','leased')
      and nse_session=(now() at time zone 'Asia/Kolkata')::date
      and automation_mode=v_controls.automation_mode
      and (status='pending' or lease_expires_at<=now())
      and (automation_mode='live_auto' or approval_status='approved')
      and (intent_purpose<>'entry' or (
          v_controls.new_entries_enabled and not v_controls.emergency_stop_active
          and v_controls.armed_nse_session=(now() at time zone 'Asia/Kolkata')::date
      ))
    order by requested_at for update skip locked limit 1;
    if not found then return null; end if;
    if v_intent.last_validated_at is null or v_intent.last_validated_at<now()-interval '2 minutes'
       or exists(select 1 from public.swing_risk_control_activations
            where user_id=p_user_id and status='active')
       or not exists(select 1 from public.swing_reconciliation_runs where user_id=p_user_id
            and reconciliation_status='matched' and checked_at>now()-interval '10 minutes') then
        update public.swing_order_intents set status='blocked',failure_reason='Execution-time state is stale or risk-locked.',
            completed_at=now(),lease_owner=null,lease_expires_at=null where id=v_intent.id;
        return null;
    end if;
    if v_intent.intent_purpose='entry' then
        select * into v_candidate from public.swing_candidates where id=v_intent.candidate_id and user_id=p_user_id;
        select * into v_state from public.swing_candidate_execution_states where user_id=p_user_id
          and candidate_id=v_intent.candidate_id and nse_session=v_intent.nse_session;
        select available_cash into v_available_cash from public.swing_broker_account_snapshots
          where user_id=p_user_id and account_status='healthy' and observed_at>now()-interval '10 minutes'
          order by observed_at desc limit 1;
        select count(*),coalesce(sum(entry_price*quantity),0) into v_open_count,v_deployed
          from public.swing_trades where user_id=p_user_id and trade_mode='live' and status in ('open','exit_pending');
        select count(*) into v_daily_entries from public.swing_order_intents where user_id=p_user_id
          and intent_purpose='entry' and nse_session=v_intent.nse_session and id<>v_intent.id
          and status not in ('cancelled','rejected','blocked','failed');
        select count(*) into v_sector_count from public.swing_trades where user_id=p_user_id
          and trade_mode='live' and status in ('open','exit_pending')
          and coalesce(sector,'Unclassified')=coalesce(v_candidate.sector,'Unclassified');
        if v_candidate.id is null or v_candidate.status not in ('candidate','ready','triggered')
           or v_state.id is null or v_state.state<>'intent_created'
           or v_state.quote_observed_at<now()-interval '2 minutes'
           or v_state.last_price<v_candidate.entry_trigger or v_state.last_price>v_candidate.maximum_entry
           or v_state.session_high>v_candidate.maximum_entry or v_state.session_low<=v_candidate.initial_stop
           or v_available_cash<v_intent.quantity*v_intent.limit_price
           or v_open_count>=v_controls.live_max_open_positions
           or v_sector_count>=1
           or v_daily_entries>=v_controls.live_max_new_entries_per_day
           or v_deployed+v_intent.quantity*v_intent.limit_price>v_controls.live_max_deployed_inr+0.01 then
            update public.swing_order_intents set status='blocked',failure_reason='Final entry revalidation failed.',
                completed_at=now(),lease_owner=null,lease_expires_at=null where id=v_intent.id;
            return null;
        end if;
    end if;
    update public.swing_order_intents set status='leased',lease_owner=p_worker_id,
        lease_expires_at=now()+make_interval(secs=>p_lease_seconds),last_validated_at=now()
    where id=v_intent.id;
    return to_jsonb(v_intent)||jsonb_build_object('status','leased','lease_owner',p_worker_id,
        'lease_expires_at',now()+make_interval(secs=>p_lease_seconds));
end;
$$;

create or replace function public.release_swing_order_intent(
    p_user_id uuid,p_intent_id uuid,p_worker_id text,p_status text,p_reason text
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
    if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
    if p_status not in ('pending','validated','blocked','failed','cancelled') then raise exception 'Invalid release status.'; end if;
    update public.swing_order_intents set status=p_status,lease_owner=null,lease_expires_at=null,
        failure_reason=case when p_status in ('blocked','failed','cancelled') then left(p_reason,500) else null end,
        completed_at=case when p_status in ('blocked','failed','cancelled') then now() else null end
    where id=p_intent_id and user_id=p_user_id and lease_owner=p_worker_id;
end; $$;

create or replace function public.report_swing_execution_failure(
    p_user_id uuid,p_control_type text,p_reason text,p_details jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
    if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
    if p_control_type not in ('stale_quote','session_invalid','reconciliation','protective_order','funds','corporate_action')
       or nullif(trim(p_reason),'') is null then raise exception 'Invalid execution failure report.'; end if;
    if not exists(select 1 from public.swing_risk_control_activations
        where user_id=p_user_id and control_type=p_control_type and status='active') then
        insert into public.swing_risk_control_activations(user_id,control_type,status,reason,details)
        values(p_user_id,p_control_type,'active',left(trim(p_reason),500),coalesce(p_details,'{}'::jsonb));
    end if;
    update public.swing_automation_controls set new_entries_enabled=false where user_id=p_user_id;
    insert into public.swing_execution_audit_events(user_id,actor_type,event_type,entity_type,entity_id,details)
    values(p_user_id,'worker','execution_failure_locked_entries','risk_control',p_control_type,
        jsonb_build_object('reason',left(trim(p_reason),500))||coalesce(p_details,'{}'::jsonb));
end; $$;

create or replace function public.clear_swing_risk_control(p_activation_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user_id uuid:=auth.uid(); v_row public.swing_risk_control_activations%rowtype;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    select * into v_row from public.swing_risk_control_activations
    where id=p_activation_id and user_id=v_user_id and status='active' for update;
    if not found then raise exception 'This risk lock is no longer active.'; end if;
    if v_row.control_type='daily_loss'
       and coalesce(v_row.details->>'nse_session','')=(now() at time zone 'Asia/Kolkata')::date::text then
        raise exception 'The daily loss lock cannot be cleared during the same NSE session.';
    end if;
    update public.swing_risk_control_activations set status='cleared',cleared_at=now()
    where id=v_row.id;
    insert into public.swing_execution_audit_events(user_id,actor_type,event_type,entity_type,entity_id,details)
    values(v_user_id,'user','risk_control_cleared','risk_control',v_row.id::text,
        jsonb_build_object('control_type',v_row.control_type,'new_entries_rearmed',false));
end; $$;

create or replace function public.record_swing_broker_execution(
    p_user_id uuid,p_worker_id text,p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
    v_intent public.swing_order_intents%rowtype;
    v_candidate public.swing_candidates%rowtype;
    v_trade public.swing_trades%rowtype;
    v_order_id uuid;
    v_broker_order_id text:=nullif(trim(p_payload->>'broker_order_id'),'');
    v_status text:=upper(coalesce(nullif(p_payload->>'status',''),'UNKNOWN'));
    v_quantity integer:=nullif(p_payload->>'quantity','')::integer;
    v_filled integer:=coalesce(nullif(p_payload->>'filled_quantity','')::integer,0);
    v_average numeric:=nullif(p_payload->>'average_price','')::numeric;
    v_fill jsonb;
    v_previous_filled integer:=0;
    v_fill_delta integer:=0;
begin
    if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
    select * into v_intent from public.swing_order_intents
    where id=nullif(p_payload->>'intent_id','')::uuid and user_id=p_user_id for update;
    if not found or v_intent.lease_owner is distinct from p_worker_id then raise exception 'Worker does not own this intent lease.'; end if;
    if v_broker_order_id is null or v_quantity<>v_intent.quantity or v_filled<0 or v_filled>v_quantity then
        raise exception 'Invalid broker order snapshot.';
    end if;
    select filled_quantity into v_previous_filled from public.swing_broker_orders
    where user_id=p_user_id and broker_order_id=v_broker_order_id;
    v_previous_filled:=coalesce(v_previous_filled,0);
    if v_filled<v_previous_filled then raise exception 'Broker filled quantity cannot decrease.'; end if;
    v_fill_delta:=v_filled-v_previous_filled;
    insert into public.swing_broker_orders(user_id,intent_id,broker_order_id,broker_tag,status,
        exchange_order_id,quantity,filled_quantity,pending_quantity,average_price,limit_price,trigger_price,
        status_message,placed_at,exchange_updated_at,last_reconciled_at,raw_snapshot)
    values(p_user_id,v_intent.id,v_broker_order_id,v_intent.broker_tag,v_status,
        nullif(p_payload->>'exchange_order_id',''),v_quantity,v_filled,greatest(v_quantity-v_filled,0),v_average,
        v_intent.limit_price,v_intent.trigger_price,left(p_payload->>'status_message',500),
        coalesce(nullif(p_payload->>'placed_at','')::timestamptz,now()),
        nullif(p_payload->>'exchange_updated_at','')::timestamptz,now(),coalesce(p_payload->'raw_snapshot','{}'::jsonb))
    on conflict(user_id,broker_order_id) do update set status=excluded.status,
        exchange_order_id=excluded.exchange_order_id,filled_quantity=excluded.filled_quantity,
        pending_quantity=excluded.pending_quantity,average_price=excluded.average_price,
        status_message=excluded.status_message,exchange_updated_at=excluded.exchange_updated_at,
        last_reconciled_at=now(),raw_snapshot=excluded.raw_snapshot returning id into v_order_id;
    for v_fill in select value from jsonb_array_elements(coalesce(p_payload->'fills','[]'::jsonb)) loop
        insert into public.swing_broker_fills(user_id,order_id,broker_trade_id,quantity,price,filled_at,metadata)
        values(p_user_id,v_order_id,nullif(v_fill->>'broker_trade_id',''),(v_fill->>'quantity')::integer,
            (v_fill->>'price')::numeric,(v_fill->>'filled_at')::timestamptz,coalesce(v_fill->'metadata','{}'::jsonb))
        on conflict(user_id,broker_trade_id) do nothing;
    end loop;
    update public.swing_order_intents set status=case
        when v_status='COMPLETE' and v_filled=v_quantity then 'filled'
        when v_status in ('REJECTED') then 'rejected'
        when v_status in ('CANCELLED') then 'cancelled'
        when v_filled>0 then 'partially_filled'
        else 'submitted' end,
        lease_owner=case when v_status in ('COMPLETE','REJECTED','CANCELLED') then null else lease_owner end,
        lease_expires_at=case when v_status in ('COMPLETE','REJECTED','CANCELLED') then null else lease_expires_at end,
        completed_at=case when v_status in ('COMPLETE','REJECTED','CANCELLED') then now() else null end,
        failure_reason=case when v_status='REJECTED' then left(p_payload->>'status_message',500) else null end
    where id=v_intent.id;

    if v_intent.intent_purpose='entry' and v_filled>0 then
        select * into v_candidate from public.swing_candidates where id=v_intent.candidate_id and user_id=p_user_id;
        select * into v_trade from public.swing_trades where user_id=p_user_id and candidate_id=v_candidate.id
          and trade_mode='live' and execution_source=v_intent.automation_mode order by created_at desc limit 1 for update;
        if not found then
            insert into public.swing_trades(user_id,candidate_id,symbol,company_name,sector,trade_mode,execution_source,
                status,signal_entry,maximum_entry,entry_date,entry_price,quantity,initial_stop,current_stop,
                initial_risk_per_share,planned_risk_inr,current_price,current_price_as_of,highest_close,
                unrealized_pnl_inr,unrealized_r_multiple,last_quote_at,notes)
            values(p_user_id,v_candidate.id,v_candidate.symbol,v_candidate.company_name,v_candidate.sector,'live',
                v_intent.automation_mode,'open',v_candidate.entry_trigger,v_candidate.maximum_entry,v_intent.nse_session,
                v_average,v_filled,v_candidate.initial_stop,v_candidate.initial_stop,v_average-v_candidate.initial_stop,
                (v_average-v_candidate.initial_stop)*v_filled,v_average,v_intent.nse_session,v_average,0,0,now(),
                'Created from reconciled Kite fill.') returning * into v_trade;
            update public.swing_candidates set status='entered' where id=v_candidate.id and user_id=p_user_id;
        else
            update public.swing_trades set quantity=v_filled,entry_price=v_average,
                initial_risk_per_share=v_average-initial_stop,
                planned_risk_inr=(v_average-initial_stop)*v_filled where id=v_trade.id;
        end if;
        update public.swing_order_intents set trade_id=v_trade.id where id=v_intent.id;
    elsif v_intent.intent_purpose in ('exit','protective_stop') and v_filled>0 then
        if v_filled=v_quantity then
            update public.swing_trades set status='closed',exit_date=v_intent.nse_session,exit_price=v_average,
                quantity=v_intent.quantity,
                realized_pnl_inr=(v_average-entry_price)*v_intent.quantity-fees_inr,
                realized_r_multiple=((v_average-entry_price)*v_intent.quantity-fees_inr)
                    /greatest(initial_risk_per_share*v_intent.quantity,0.01),
                partial_exit_quantity=0,partial_exit_realized_pnl_inr=0,
                unrealized_pnl_inr=null,unrealized_r_multiple=null where id=v_intent.trade_id and user_id=p_user_id;
        elsif v_fill_delta>0 then
            update public.swing_trades set
                quantity=greatest(quantity-v_fill_delta,0),
                planned_risk_inr=initial_risk_per_share*greatest(quantity-v_fill_delta,0),
                partial_exit_quantity=partial_exit_quantity+v_fill_delta,
                partial_exit_realized_pnl_inr=partial_exit_realized_pnl_inr
                    +(v_average-entry_price)*v_fill_delta,
                notes=concat_ws(E'\n',notes,format('Partial Kite exit: %s shares at %s.',v_fill_delta,v_average))
            where id=v_intent.trade_id and user_id=p_user_id;
        end if;
        if v_intent.intent_purpose='protective_stop' then
            update public.swing_protective_orders set status='completed',last_verified_at=now()
            where user_id=p_user_id and trade_id=v_intent.trade_id and status in ('active','triggered');
        end if;
    end if;
    insert into public.swing_execution_audit_events(user_id,actor_type,event_type,entity_type,entity_id,details)
    values(p_user_id,'kite','broker_order_reconciled','broker_order',v_order_id::text,
        jsonb_build_object('broker_order_id',v_broker_order_id,'status',v_status,'filled_quantity',v_filled));
    return jsonb_build_object('order_id',v_order_id,'trade_id',v_trade.id,'status',v_status);
end; $$;

create or replace function public.record_swing_protective_order(
    p_user_id uuid,p_worker_id text,p_payload jsonb
)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_trade public.swing_trades%rowtype; v_stop numeric:=nullif(p_payload->>'trigger_price','')::numeric;
begin
    if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
    select * into v_trade from public.swing_trades where id=nullif(p_payload->>'trade_id','')::uuid
      and user_id=p_user_id and trade_mode='live' and status in ('open','exit_pending') for update;
    if not found then raise exception 'Live trade is unavailable for protection.'; end if;
    if v_stop<v_trade.current_stop then raise exception 'An automatic protective stop cannot move downward.'; end if;
    insert into public.swing_protective_orders(user_id,trade_id,entry_order_id,broker_trigger_id,
        protection_type,status,protected_quantity,trigger_price,limit_price,highest_protected_stop,
        last_verified_at,failure_reason,metadata)
    values(p_user_id,v_trade.id,nullif(p_payload->>'entry_order_id','')::uuid,
        nullif(p_payload->>'broker_trigger_id',''),'gtt_stop',
        coalesce(nullif(p_payload->>'status',''),'pending'),(p_payload->>'protected_quantity')::integer,
        v_stop,nullif(p_payload->>'limit_price','')::numeric,v_stop,now(),
        nullif(left(p_payload->>'failure_reason',500),''),coalesce(p_payload->'metadata','{}'::jsonb))
    on conflict(user_id,broker_trigger_id) where broker_trigger_id is not null do update set
        status=excluded.status,protected_quantity=excluded.protected_quantity,
        trigger_price=greatest(swing_protective_orders.trigger_price,excluded.trigger_price),
        limit_price=excluded.limit_price,
        highest_protected_stop=greatest(swing_protective_orders.highest_protected_stop,excluded.highest_protected_stop),
        last_verified_at=now(),failure_reason=excluded.failure_reason,metadata=excluded.metadata
    returning id into v_id;
    update public.swing_trades set current_stop=greatest(current_stop,v_stop) where id=v_trade.id;
    if coalesce(p_payload->>'status','') in ('rejected','failed') then
        insert into public.swing_risk_control_activations(user_id,control_type,status,reason,details)
        values(p_user_id,'protective_order','active','A live protective order is unavailable.',
            jsonb_build_object('trade_id',v_trade.id,'protective_order_id',v_id));
        update public.swing_automation_controls set new_entries_enabled=false where user_id=p_user_id;
    end if;
    return v_id;
end; $$;

revoke all on function public.configure_swing_live_mode(text,text) from public,anon;
grant execute on function public.configure_swing_live_mode(text,text) to authenticated;
revoke all on function public.decide_swing_assisted_intent(uuid,text) from public,anon;
grant execute on function public.decide_swing_assisted_intent(uuid,text) to authenticated;
revoke all on function public.clear_swing_risk_control(uuid) from public,anon;
grant execute on function public.clear_swing_risk_control(uuid) to authenticated;

revoke all on function public.set_swing_execution_rollout_lock(uuid,boolean,boolean,boolean,text) from public,anon,authenticated;
revoke all on function public.get_swing_live_worker_state(uuid) from public,anon,authenticated;
revoke all on function public.publish_swing_live_observation(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.claim_swing_order_intent(uuid,text,text,integer) from public,anon,authenticated;
revoke all on function public.create_swing_live_exit_intent(uuid,text,uuid,date,numeric,timestamptz) from public,anon,authenticated;
revoke all on function public.release_swing_order_intent(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.register_swing_gtt_exit(uuid,text,uuid,text,date) from public,anon,authenticated;
revoke all on function public.report_swing_execution_failure(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.record_swing_broker_execution(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.record_swing_protective_order(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.set_swing_execution_rollout_lock(uuid,boolean,boolean,boolean,text) to service_role;
grant execute on function public.get_swing_live_worker_state(uuid) to service_role;
grant execute on function public.publish_swing_live_observation(uuid,jsonb) to service_role;
grant execute on function public.claim_swing_order_intent(uuid,text,text,integer) to service_role;
grant execute on function public.create_swing_live_exit_intent(uuid,text,uuid,date,numeric,timestamptz) to service_role;
grant execute on function public.release_swing_order_intent(uuid,uuid,text,text,text) to service_role;
grant execute on function public.register_swing_gtt_exit(uuid,text,uuid,text,date) to service_role;
grant execute on function public.report_swing_execution_failure(uuid,text,text,jsonb) to service_role;
grant execute on function public.record_swing_broker_execution(uuid,text,jsonb) to service_role;
grant execute on function public.record_swing_protective_order(uuid,text,jsonb) to service_role;

-- Restores are always safe: never restore approvals, leases, live arming,
-- broker execution unlocks or a cleared emergency state.
update public.swing_automation_controls set automation_mode='advisory',new_entries_enabled=false,
    armed_nse_session=null,assisted_live_unlocked=false,live_auto_unlocked=false,
    broker_execution_enabled=false;

create or replace function public.restore_complete_portfolio_backup_v11(p_backup jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user_id uuid:=auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    perform public.restore_complete_portfolio_backup_v10(p_backup);
    delete from public.swing_candidate_execution_states where user_id=v_user_id;
    delete from public.swing_protective_orders where user_id=v_user_id;
    delete from public.swing_broker_fills where user_id=v_user_id;
    delete from public.swing_broker_orders where user_id=v_user_id;
    delete from public.swing_order_intents where user_id=v_user_id;
    delete from public.swing_processing_leases where user_id=v_user_id;
    delete from public.swing_risk_control_activations where user_id=v_user_id;
    delete from public.swing_execution_audit_events where user_id=v_user_id;
    delete from public.swing_worker_heartbeats where user_id=v_user_id;
    delete from public.swing_broker_account_snapshots where user_id=v_user_id;
    delete from public.swing_position_reconciliations where user_id=v_user_id;
    delete from public.swing_reconciliation_runs where user_id=v_user_id;
    delete from public.kite_broker_sessions where user_id=v_user_id;
    update public.kite_broker_connections set connection_status='disconnected',session_expires_at=null,
        disconnected_at=now(),error_message=null where user_id=v_user_id;
    update public.swing_automation_controls set automation_mode='advisory',new_entries_enabled=false,
        armed_nse_session=null,assisted_live_unlocked=false,live_auto_unlocked=false,
        broker_execution_enabled=false where user_id=v_user_id;
end; $$;

revoke all on function public.restore_complete_portfolio_backup_v11(jsonb) from public,anon;
grant execute on function public.restore_complete_portfolio_backup_v11(jsonb) to authenticated;

commit;
