begin;

-- Personal Free GTT Assisted is deliberately separate from quote-driven
-- Assisted Live and Live Auto. The browser records an explicit, current Kite
-- LTP confirmation; the static-IP worker submits only broker-hosted GTTs.

alter table public.swing_automation_controls
    add column if not exists gtt_assisted_enabled boolean not null default false;
alter table public.swing_automation_controls
    drop constraint if exists swing_automation_controls_gtt_plan_check;
alter table public.swing_automation_controls
    add constraint swing_automation_controls_gtt_plan_check
    check (not gtt_assisted_enabled or market_data_plan = 'personal');

alter table public.swing_order_intents
    drop constraint if exists swing_order_intents_automation_mode_check;
alter table public.swing_order_intents
    add constraint swing_order_intents_automation_mode_check
    check (automation_mode in ('paper_auto', 'gtt_assisted', 'assisted_live', 'live_auto'));

alter table public.swing_order_intents
    drop constraint if exists swing_order_intents_approval_window_check;
alter table public.swing_order_intents
    add constraint swing_order_intents_approval_window_check
    check (
        (automation_mode not in ('assisted_live', 'gtt_assisted') and approval_status = 'not_required')
        or (automation_mode = 'assisted_live' and intent_purpose in ('protective_stop','replace_stop','cancel') and approval_status = 'not_required')
        or (automation_mode = 'assisted_live' and intent_purpose in ('entry','exit') and approval_status <> 'not_required')
        or (automation_mode = 'gtt_assisted' and intent_purpose = 'entry' and approval_status = 'approved')
        or (automation_mode = 'gtt_assisted' and intent_purpose in ('protective_stop','replace_stop','cancel') and approval_status = 'not_required')
    );

alter table public.swing_trades
    drop constraint if exists swing_trades_execution_source_check;
alter table public.swing_trades
    add constraint swing_trades_execution_source_check
    check (execution_source in ('manual', 'paper_auto', 'gtt_assisted', 'assisted_live', 'live_auto'));

alter table public.swing_worker_heartbeats
    drop constraint if exists swing_worker_heartbeats_execution_mode_check;
alter table public.swing_worker_heartbeats
    add constraint swing_worker_heartbeats_execution_mode_check
    check (execution_mode in ('observe', 'paper_auto', 'gtt_assisted', 'assisted_live', 'live_auto'));

alter table public.swing_risk_control_activations
    drop constraint if exists swing_risk_control_activations_control_type_check;
alter table public.swing_risk_control_activations
    add constraint swing_risk_control_activations_control_type_check
    check (control_type in (
        'emergency_stop', 'daily_loss', 'drawdown', 'stale_quote',
        'session_invalid', 'reconciliation', 'broker_order',
        'protective_order', 'funds', 'corporate_action'
    ));

create table if not exists public.swing_gtt_assisted_entries (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    intent_id uuid not null,
    candidate_id uuid,
    symbol text not null,
    broker_trigger_id text,
    broker_order_id text,
    status text not null default 'pending_submission'
        check (status in (
            'pending_submission', 'active', 'triggered', 'order_open',
            'cancel_requested', 'filled', 'cancelled', 'expired', 'rejected', 'failed'
        )),
    reference_last_price numeric(18,4) not null check (reference_last_price > 0),
    entry_trigger numeric(18,4) not null check (entry_trigger > 0),
    maximum_entry numeric(18,4) not null check (maximum_entry >= entry_trigger),
    initial_stop numeric(18,4) not null check (initial_stop > 0),
    quantity integer not null check (quantity > 0),
    target_r_multiple numeric(8,4) not null default 2 check (target_r_multiple between 1 and 10),
    armed_nse_session date not null,
    cancel_after timestamptz not null,
    submitted_at timestamptz,
    triggered_at timestamptz,
    completed_at timestamptz,
    last_verified_at timestamptz,
    failure_reason text,
    raw_snapshot jsonb not null default '{}'::jsonb,
    lease_owner text,
    lease_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, intent_id),
    constraint swing_gtt_assisted_entries_intent_user_fk
        foreign key (intent_id, user_id)
        references public.swing_order_intents(id, user_id)
        on delete cascade,
    constraint swing_gtt_assisted_entries_candidate_user_fk
        foreign key (candidate_id, user_id)
        references public.swing_candidates(id, user_id)
        on delete set null (candidate_id)
);

create unique index if not exists swing_gtt_assisted_entries_user_trigger_idx
    on public.swing_gtt_assisted_entries(user_id, broker_trigger_id)
    where broker_trigger_id is not null;
create index if not exists swing_gtt_assisted_entries_user_status_idx
    on public.swing_gtt_assisted_entries(user_id, status, created_at desc);
create unique index if not exists swing_gtt_assisted_entries_open_candidate_idx
    on public.swing_gtt_assisted_entries(user_id, candidate_id)
    where candidate_id is not null and status in (
        'pending_submission', 'active', 'triggered', 'order_open', 'cancel_requested'
    );

alter table public.swing_gtt_assisted_entries enable row level security;
drop policy if exists "Users view their swing_gtt_assisted_entries"
    on public.swing_gtt_assisted_entries;
create policy "Users view their swing_gtt_assisted_entries"
    on public.swing_gtt_assisted_entries for select
    using (auth.uid() = user_id);

drop trigger if exists swing_gtt_assisted_entries_set_updated_at
    on public.swing_gtt_assisted_entries;
create trigger swing_gtt_assisted_entries_set_updated_at
before update on public.swing_gtt_assisted_entries
for each row execute function public.set_updated_at();

grant select on table public.swing_gtt_assisted_entries to authenticated;
grant select, insert, update, delete on table public.swing_gtt_assisted_entries to service_role;

create or replace function public.configure_swing_gtt_assisted(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_controls public.swing_automation_controls%rowtype;
    v_connection public.kite_broker_connections%rowtype;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    insert into public.swing_automation_controls(user_id) values (v_user_id)
    on conflict (user_id) do nothing;
    select * into v_controls from public.swing_automation_controls
    where user_id = v_user_id for update;

    if p_enabled then
        if v_controls.market_data_plan <> 'personal' then
            raise exception 'GTT Assisted is intended for Kite Personal Free. Use Assisted Live with Connect.';
        end if;
        if v_controls.ddpi_confirmed_at is null then
            raise exception 'Confirm DDPI before enabling automatic CNC protection.';
        end if;
        if v_controls.emergency_stop_active then
            raise exception 'Clear the emergency stop before enabling GTT Assisted.';
        end if;
        if v_controls.automation_mode <> 'advisory' or v_controls.new_entries_enabled then
            raise exception 'Return Paper Auto or live execution to Advisory before enabling GTT Assisted.';
        end if;
        select * into v_connection from public.kite_broker_connections
        where user_id = v_user_id;
        if not found or v_connection.connection_status <> 'connected'
           or v_connection.session_expires_at <= now() then
            raise exception 'Connect Kite for today before enabling GTT Assisted.';
        end if;
    else
        update public.swing_gtt_assisted_entries
        set status = case when broker_trigger_id is null then 'cancelled' else 'cancel_requested' end,
            completed_at = case when broker_trigger_id is null then now() else completed_at end,
            failure_reason = 'GTT Assisted was disabled by the user.'
        where user_id = v_user_id
          and status in ('pending_submission','active','triggered','order_open');
        update public.swing_order_intents i
        set status = 'cancelled', completed_at = now(),
            failure_reason = 'GTT Assisted was disabled before broker submission.'
        where i.user_id = v_user_id and i.automation_mode = 'gtt_assisted'
          and i.status in ('pending','leased')
          and not exists (
              select 1 from public.swing_gtt_assisted_entries g
              where g.intent_id = i.id and g.user_id = i.user_id and g.broker_trigger_id is not null
          );
    end if;

    update public.swing_automation_controls
    set gtt_assisted_enabled = p_enabled
    where user_id = v_user_id;

    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', case when p_enabled then 'gtt_assisted_enabled' else 'gtt_assisted_disabled' end,
        'automation_control', v_user_id::text,
        jsonb_build_object('personal_free', true, 'live_auto_unchanged', true)
    );
end;
$$;

create or replace function public.configure_swing_paper_auto(
    p_action text,
    p_slippage_bps numeric default null,
    p_max_new_entries_per_day integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_today date := (now() at time zone 'Asia/Kolkata')::date;
    v_connection public.kite_broker_connections%rowtype;
    v_controls public.swing_automation_controls%rowtype;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_action not in ('enable', 'pause', 'advisory') then
        raise exception 'Paper Auto action must be enable, pause or advisory.';
    end if;
    if p_slippage_bps is not null and p_slippage_bps not between 0 and 50 then
        raise exception 'Paper slippage must be between 0 and 50 basis points.';
    end if;
    if p_max_new_entries_per_day is not null
       and p_max_new_entries_per_day not between 1 and 5 then
        raise exception 'Daily Paper Auto entries must be between 1 and 5.';
    end if;
    insert into public.swing_automation_controls(user_id) values (v_user_id)
    on conflict (user_id) do nothing;
    select * into v_controls from public.swing_automation_controls
    where user_id = v_user_id for update;
    if p_action = 'enable' then
        if v_controls.market_data_plan <> 'connect' then
            raise exception 'Kite Connect market data is required for Paper Auto.';
        end if;
        if v_controls.gtt_assisted_enabled or exists (
            select 1 from public.swing_gtt_assisted_entries
            where user_id = v_user_id and status in (
                'pending_submission','active','triggered','order_open','cancel_requested'
            )
        ) then raise exception 'Disable GTT Assisted and confirm entry cancellation before enabling Paper Auto.'; end if;
        if v_controls.emergency_stop_active then
            raise exception 'Clear the emergency stop before enabling Paper Auto.';
        end if;
        select * into v_connection from public.kite_broker_connections
        where user_id = v_user_id;
        if not found or v_connection.connection_status <> 'connected'
           or v_connection.session_expires_at <= now() then
            raise exception 'Connect Kite for today before enabling Paper Auto.';
        end if;
        update public.swing_automation_controls set
            automation_mode = 'paper_auto', new_entries_enabled = true,
            armed_nse_session = v_today,
            paper_slippage_bps = coalesce(p_slippage_bps, paper_slippage_bps),
            paper_max_new_entries_per_day = coalesce(
                p_max_new_entries_per_day, paper_max_new_entries_per_day
            )
        where user_id = v_user_id;
    elsif p_action = 'pause' then
        update public.swing_automation_controls set
            automation_mode = 'paper_auto', new_entries_enabled = false,
            paper_slippage_bps = coalesce(p_slippage_bps, paper_slippage_bps),
            paper_max_new_entries_per_day = coalesce(
                p_max_new_entries_per_day, paper_max_new_entries_per_day
            )
        where user_id = v_user_id;
    else
        update public.swing_automation_controls set
            automation_mode = 'advisory', new_entries_enabled = false,
            armed_nse_session = null,
            paper_slippage_bps = coalesce(p_slippage_bps, paper_slippage_bps),
            paper_max_new_entries_per_day = coalesce(
                p_max_new_entries_per_day, paper_max_new_entries_per_day
            )
        where user_id = v_user_id;
    end if;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', 'paper_auto_' || p_action,
        'automation_control', v_user_id::text,
        jsonb_build_object(
            'nse_session',v_today,'paper_slippage_bps',p_slippage_bps,
            'paper_max_new_entries_per_day',p_max_new_entries_per_day,
            'broker_orders_enabled',false,'market_data_plan',v_controls.market_data_plan
        )
    );
end;
$$;

create or replace function public.create_swing_gtt_assisted_entry(
    p_candidate_id uuid,
    p_current_ltp numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_now_ist timestamp := now() at time zone 'Asia/Kolkata';
    v_session date := (now() at time zone 'Asia/Kolkata')::date;
    v_controls public.swing_automation_controls%rowtype;
    v_connection public.kite_broker_connections%rowtype;
    v_candidate public.swing_candidates%rowtype;
    v_scan public.swing_scan_runs%rowtype;
    v_latest_scan_id uuid;
    v_available_cash numeric;
    v_open_count integer;
    v_sector_count integer;
    v_daily_entries integer;
    v_deployed numeric;
    v_quantity integer;
    v_risk numeric;
    v_risk_limit numeric;
    v_intent_id uuid;
    v_gtt_id uuid;
    v_key text;
    v_cancel_after timestamptz;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if p_current_ltp is null or p_current_ltp <= 0 then
        raise exception 'Enter the current LTP displayed in Kite.';
    end if;
    if extract(isodow from v_now_ist) not between 1 and 5
       or v_now_ist::time < time '09:20' or v_now_ist::time >= time '15:05' then
        raise exception 'Entry GTTs can be armed only from 09:20 to 15:05 IST on a trading weekday.';
    end if;

    select * into v_controls from public.swing_automation_controls
    where user_id = v_user_id for update;
    if not found or not v_controls.gtt_assisted_enabled
       or v_controls.market_data_plan <> 'personal' then
        raise exception 'Enable Personal Free GTT Assisted before creating an entry.';
    end if;
    if v_controls.ddpi_confirmed_at is null then
        raise exception 'DDPI confirmation is required for automatic sell protection.';
    end if;
    if v_controls.emergency_stop_active then
        raise exception 'The emergency stop blocks new GTT entries.';
    end if;
    if exists (
        select 1 from public.swing_risk_control_activations
        where user_id = v_user_id and status = 'active'
    ) then raise exception 'Resolve active execution risk locks before creating an entry GTT.'; end if;

    select * into v_connection from public.kite_broker_connections
    where user_id = v_user_id;
    if not found or v_connection.connection_status <> 'connected'
       or v_connection.session_expires_at <= now() then
        raise exception 'Connect Kite for today before creating an entry GTT.';
    end if;

    select id into v_latest_scan_id from public.swing_scan_runs
    where user_id = v_user_id order by as_of desc limit 1;
    select * into v_candidate from public.swing_candidates
    where id = p_candidate_id and user_id = v_user_id for update;
    if not found or v_candidate.scan_id <> v_latest_scan_id
       or v_candidate.status not in ('candidate','ready','triggered')
       or v_candidate.expires_on < v_session or v_candidate.suggested_quantity <= 0
       or left(v_candidate.setup_type, 5) = 'TEST_' then
        raise exception 'This candidate is not eligible for a real GTT entry.';
    end if;
    select * into v_scan from public.swing_scan_runs
    where id = v_candidate.scan_id and user_id = v_user_id;
    if not found or v_scan.status not in ('successful','partial')
       or v_scan.publication_status <> 'published'
       or v_scan.contract_version <> '2026-07-30.v2'
       or v_scan.session_state <> 'completed' or not v_scan.session_matches_expected
       or v_scan.market_regime not in ('GREEN','AMBER') then
        raise exception 'The latest completed Swing scan is not valid for a GTT entry.';
    end if;
    if p_current_ltp >= v_candidate.entry_trigger then
        raise exception 'Current LTP must still be below the entry trigger. Do not invent an already-crossed entry.';
    end if;
    if p_current_ltp <= v_candidate.initial_stop then
        raise exception 'Current LTP is already at or below the planned stop.';
    end if;
    if exists (
        select 1 from public.swing_gtt_assisted_entries
        where user_id = v_user_id and candidate_id = v_candidate.id
          and status in ('pending_submission','active','triggered','order_open','cancel_requested')
    ) then raise exception 'This candidate already has an active GTT Assisted entry.'; end if;

    select available_cash into v_available_cash
    from public.swing_broker_account_snapshots
    where user_id = v_user_id and account_status = 'healthy'
      and observed_at > now() - interval '10 minutes'
    order by observed_at desc limit 1;
    if v_available_cash is null then
        raise exception 'A fresh healthy Kite funds snapshot is required.';
    end if;
    if not exists (
        select 1 from public.swing_reconciliation_runs
        where user_id = v_user_id and reconciliation_status = 'matched'
          and checked_at > now() - interval '10 minutes'
    ) then raise exception 'Fresh broker and Tracker reconciliation is required.'; end if;

    select count(*), coalesce(sum(entry_price * quantity), 0)
    into v_open_count, v_deployed
    from public.swing_trades
    where user_id = v_user_id and trade_mode = 'live'
      and status in ('open','exit_pending');
    select count(*) into v_sector_count from public.swing_trades
    where user_id = v_user_id and trade_mode = 'live'
      and status in ('open','exit_pending')
      and coalesce(sector,'Unclassified') = coalesce(v_candidate.sector,'Unclassified');
    select count(*) into v_daily_entries from public.swing_order_intents
    where user_id = v_user_id and intent_purpose = 'entry'
      and automation_mode in ('gtt_assisted','assisted_live','live_auto')
      and nse_session = v_session
      and status not in ('cancelled','rejected','blocked','failed');

    v_quantity := least(
        v_candidate.suggested_quantity,
        floor(v_controls.live_max_deployed_inr / v_candidate.maximum_entry)::integer,
        floor(v_available_cash / v_candidate.maximum_entry)::integer
    );
    v_risk := (v_candidate.maximum_entry - v_candidate.initial_stop) * v_quantity;
    v_risk_limit := v_controls.live_max_deployed_inr
        * v_controls.live_risk_per_trade_percentage / 100
        * case when v_scan.market_regime = 'AMBER'
            then v_controls.live_amber_risk_multiplier else 1 end;
    if v_quantity < 1 then
        raise exception 'Available cash or the deployment cap cannot fund one share at the maximum entry.';
    end if;
    if v_open_count >= v_controls.live_max_open_positions then
        raise exception 'The maximum live-position count is already reached.';
    end if;
    if v_sector_count >= 1 then
        raise exception 'The initial one-position-per-sector limit blocks this candidate.';
    end if;
    if v_daily_entries >= v_controls.live_max_new_entries_per_day then
        raise exception 'The daily new-entry limit is already reached.';
    end if;
    if v_deployed + v_candidate.maximum_entry * v_quantity > v_controls.live_max_deployed_inr + 0.01
       or v_risk > v_risk_limit + 0.01 then
        raise exception 'The candidate exceeds the configured deployment or stop-risk limit.';
    end if;

    v_cancel_after := (v_session + time '15:20') at time zone 'Asia/Kolkata';
    v_key := 'gtt:assisted:' || v_candidate.signal_key || ':' || v_session::text || ':entry';
    insert into public.swing_order_intents(
        user_id, candidate_id, intent_key, intent_purpose, automation_mode, status,
        strategy_model_version, execution_policy_version, nse_session, exchange, product,
        symbol, transaction_type, order_type, quantity, limit_price, trigger_price,
        maximum_entry, approval_status, approval_requested_at, approved_at, approved_by,
        broker_tag, last_validated_at, metadata
    ) values (
        v_user_id, v_candidate.id, v_key, 'entry', 'gtt_assisted', 'pending',
        v_scan.model_version, '1.1.0', v_session, 'NSE', 'CNC', v_candidate.symbol,
        'BUY', 'LIMIT', v_quantity, v_candidate.maximum_entry, v_candidate.entry_trigger,
        v_candidate.maximum_entry, 'approved', now(), now(), v_user_id,
        substring(md5(v_key) from 1 for 20), now(),
        jsonb_build_object(
            'entry_trigger', v_candidate.entry_trigger,
            'initial_stop', v_candidate.initial_stop,
            'reference_last_price', p_current_ltp,
            'planned_risk_inr', v_risk,
            'regime', v_scan.market_regime,
            'target_r_multiple', 2,
            'cancel_after', v_cancel_after
        )
    ) returning id into v_intent_id;

    insert into public.swing_gtt_assisted_entries(
        user_id, intent_id, candidate_id, symbol, status, reference_last_price,
        entry_trigger, maximum_entry, initial_stop, quantity,
        target_r_multiple, armed_nse_session, cancel_after
    ) values (
        v_user_id, v_intent_id, v_candidate.id, v_candidate.symbol, 'pending_submission', p_current_ltp,
        v_candidate.entry_trigger, v_candidate.maximum_entry, v_candidate.initial_stop,
        v_quantity, 2, v_session, v_cancel_after
    ) returning id into v_gtt_id;

    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', 'gtt_assisted_entry_approved', 'gtt_assisted_entry', v_gtt_id::text,
        jsonb_build_object(
            'symbol', v_candidate.symbol, 'quantity', v_quantity,
            'manual_ltp', p_current_ltp, 'entry_trigger', v_candidate.entry_trigger,
            'maximum_entry', v_candidate.maximum_entry, 'cancel_after', v_cancel_after
        )
    );
    return v_gtt_id;
end;
$$;

create or replace function public.cancel_swing_gtt_assisted_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_row public.swing_gtt_assisted_entries%rowtype;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    select * into v_row from public.swing_gtt_assisted_entries
    where id = p_entry_id and user_id = v_user_id for update;
    if not found or v_row.status in ('filled','cancelled','expired','rejected','failed') then
        raise exception 'This entry GTT is no longer cancellable.';
    end if;
    if v_row.broker_trigger_id is null then
        update public.swing_gtt_assisted_entries
        set status = 'cancelled', completed_at = now(), failure_reason = 'Cancelled by user.'
        where id = v_row.id;
        update public.swing_order_intents
        set status = 'cancelled', completed_at = now(), failure_reason = 'Cancelled by user.'
        where id = v_row.intent_id and user_id = v_user_id;
    else
        update public.swing_gtt_assisted_entries
        set status = 'cancel_requested', failure_reason = 'Cancellation requested by user.'
        where id = v_row.id;
    end if;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (v_user_id, 'user', 'gtt_assisted_cancel_requested',
        'gtt_assisted_entry', v_row.id::text, jsonb_build_object('status', v_row.status));
end;
$$;

create or replace function public.get_swing_gtt_worker_state(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_session public.kite_broker_sessions%rowtype;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    select * into v_controls from public.swing_automation_controls where user_id = p_user_id;
    select * into v_session from public.kite_broker_sessions where user_id = p_user_id;
    return jsonb_build_object(
        'controls', case when v_controls.user_id is null then null else to_jsonb(v_controls) end,
        'session', case when v_session.id is null or v_session.revoked_at is not null
            or v_session.expires_at <= now() then null else jsonb_build_object(
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
        'entries', coalesce((select jsonb_agg(
            to_jsonb(g) || jsonb_build_object(
                'symbol', i.symbol, 'transaction_type', i.transaction_type,
                'order_type', i.order_type, 'limit_price', i.limit_price,
                'trigger_price', i.trigger_price, 'broker_tag', i.broker_tag,
                'intent_status', i.status, 'metadata', i.metadata
            ) order by g.created_at
        ) from public.swing_gtt_assisted_entries g
        join public.swing_order_intents i on i.id = g.intent_id and i.user_id = g.user_id
        where g.user_id = p_user_id
          and g.status in ('pending_submission','active','triggered','order_open','cancel_requested')), '[]'::jsonb),
        'positions', coalesce((select jsonb_agg(to_jsonb(t) order by t.entry_date, t.created_at)
            from public.swing_trades t where t.user_id = p_user_id and t.trade_mode = 'live'
              and t.execution_source = 'gtt_assisted' and t.status in ('open','exit_pending')), '[]'::jsonb),
        'broker_orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at desc)
            from public.swing_broker_orders o join public.swing_order_intents i
              on i.id = o.intent_id and i.user_id = o.user_id
            where o.user_id = p_user_id and i.automation_mode = 'gtt_assisted'), '[]'::jsonb),
        'protective_orders', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc)
            from public.swing_protective_orders p join public.swing_trades t
              on t.id = p.trade_id and t.user_id = p.user_id
            where p.user_id = p_user_id and t.execution_source = 'gtt_assisted'
              and p.status in ('pending','active','triggered','failed','rejected')), '[]'::jsonb)
    );
end;
$$;

create or replace function public.publish_swing_gtt_heartbeat(
    p_user_id uuid,
    p_cycle jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_worker_id text := nullif(trim(p_cycle->>'worker_id'), '');
    v_observed_at timestamptz := coalesce(nullif(p_cycle->>'observed_at','')::timestamptz, now());
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if v_worker_id is null or v_worker_id !~ '^[A-Za-z0-9._:-]{3,100}$' then
        raise exception 'Invalid GTT worker id.';
    end if;
    if v_observed_at < now() - interval '5 minutes' or v_observed_at > now() + interval '2 minutes' then
        raise exception 'Invalid GTT worker heartbeat time.';
    end if;
    insert into public.swing_worker_heartbeats(
        user_id, worker_id, worker_version, execution_policy_version,
        observed_public_ip, worker_status, execution_mode, kite_session_healthy,
        quote_stream_healthy, reconciliation_healthy, heartbeat_at, details
    ) values (
        p_user_id, v_worker_id, coalesce(nullif(p_cycle->>'worker_version',''),'unknown'),
        nullif(p_cycle->>'execution_policy_version',''),
        nullif(p_cycle->>'observed_public_ip','')::inet,
        coalesce(nullif(p_cycle->>'worker_status',''),'blocked'), 'gtt_assisted',
        coalesce((p_cycle->>'kite_session_healthy')::boolean,false), false,
        coalesce((p_cycle->>'reconciliation_healthy')::boolean,false),
        v_observed_at, coalesce(p_cycle->'details','{}'::jsonb)
    ) on conflict (user_id, worker_id) do update set
        worker_version = excluded.worker_version,
        execution_policy_version = excluded.execution_policy_version,
        observed_public_ip = excluded.observed_public_ip,
        worker_status = excluded.worker_status,
        execution_mode = excluded.execution_mode,
        kite_session_healthy = excluded.kite_session_healthy,
        quote_stream_healthy = false,
        reconciliation_healthy = excluded.reconciliation_healthy,
        heartbeat_at = excluded.heartbeat_at,
        details = excluded.details;
end;
$$;

create or replace function public.claim_swing_gtt_assisted_entry(
    p_user_id uuid,
    p_worker_id text,
    p_lease_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_row public.swing_gtt_assisted_entries%rowtype;
    v_intent public.swing_order_intents%rowtype;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if p_lease_seconds not between 10 and 120 then raise exception 'Invalid lease duration.'; end if;
    select * into v_controls from public.swing_automation_controls where user_id = p_user_id for update;
    if v_controls.emergency_stop_active or not v_controls.gtt_assisted_enabled then
        update public.swing_gtt_assisted_entries
        set status = 'cancel_requested', failure_reason = case
            when v_controls.emergency_stop_active then 'Emergency stop requested cancellation.'
            else 'GTT Assisted is disabled.' end
        where user_id = p_user_id and status in ('active','triggered','order_open');
    end if;
    update public.swing_gtt_assisted_entries
    set status = 'cancel_requested', failure_reason = 'Automatic same-session expiry reached.'
    where user_id = p_user_id and status in ('active','triggered','order_open')
      and cancel_after <= now();
    update public.swing_gtt_assisted_entries g
    set status = 'cancelled', completed_at = now(),
        failure_reason = coalesce(g.failure_reason, 'Entry expired before broker submission.')
    where g.user_id = p_user_id and g.status = 'pending_submission' and g.cancel_after <= now();
    update public.swing_order_intents i
    set status = 'cancelled', completed_at = now(),
        failure_reason = 'Entry expired before broker submission.'
    where i.user_id = p_user_id and i.automation_mode = 'gtt_assisted'
      and i.status in ('pending','leased')
      and exists (select 1 from public.swing_gtt_assisted_entries g
          where g.intent_id = i.id and g.status = 'cancelled');

    select * into v_row from public.swing_gtt_assisted_entries
    where user_id = p_user_id
      and status in ('pending_submission','active','triggered','order_open','cancel_requested')
      and (lease_owner is null or lease_expires_at <= now())
      and (status <> 'pending_submission' or (
          v_controls.gtt_assisted_enabled and not v_controls.emergency_stop_active
          and v_controls.market_data_plan = 'personal'
          and cancel_after > now()
          and not exists (select 1 from public.swing_risk_control_activations
              where user_id = p_user_id and status = 'active')
      ))
    order by case when status = 'cancel_requested' then 0 else 1 end, created_at
    for update skip locked limit 1;
    if not found then return null; end if;
    select * into v_intent from public.swing_order_intents
    where id = v_row.intent_id and user_id = p_user_id for update;
    if not found then
        update public.swing_gtt_assisted_entries set status = 'failed', completed_at = now(),
            failure_reason = 'The linked order intent is missing.' where id = v_row.id;
        return null;
    end if;
    update public.swing_gtt_assisted_entries
    set lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        last_verified_at = now()
    where id = v_row.id;
    update public.swing_order_intents
    set status = case when status = 'pending' then 'leased' else status end,
        lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        last_validated_at = now()
    where id = v_intent.id;
    return to_jsonb(v_row) || jsonb_build_object(
        'symbol', v_intent.symbol, 'transaction_type', v_intent.transaction_type,
        'order_type', v_intent.order_type, 'limit_price', v_intent.limit_price,
        'trigger_price', v_intent.trigger_price, 'broker_tag', v_intent.broker_tag,
        'metadata', v_intent.metadata, 'intent_status', v_intent.status,
        'lease_owner', p_worker_id
    );
end;
$$;

create or replace function public.record_swing_gtt_assisted_state(
    p_user_id uuid,
    p_worker_id text,
    p_entry_id uuid,
    p_status text,
    p_broker_trigger_id text default null,
    p_broker_order_id text default null,
    p_failure_reason text default null,
    p_snapshot jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.swing_gtt_assisted_entries%rowtype;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if p_status not in ('active','triggered','order_open','filled','cancelled','expired','rejected','failed') then
        raise exception 'Invalid GTT Assisted state.';
    end if;
    select * into v_row from public.swing_gtt_assisted_entries
    where id = p_entry_id and user_id = p_user_id for update;
    if not found or (v_row.lease_owner is not null and v_row.lease_owner <> p_worker_id) then
        raise exception 'Worker does not own this GTT Assisted lease.';
    end if;
    update public.swing_gtt_assisted_entries set
        status = p_status,
        broker_trigger_id = coalesce(nullif(trim(p_broker_trigger_id),''), broker_trigger_id),
        broker_order_id = coalesce(nullif(trim(p_broker_order_id),''), broker_order_id),
        submitted_at = case when p_status = 'active' then coalesce(submitted_at, now()) else submitted_at end,
        triggered_at = case when p_status in ('triggered','order_open','filled') then coalesce(triggered_at, now()) else triggered_at end,
        completed_at = case when p_status in ('filled','cancelled','expired','rejected','failed') then now() else null end,
        last_verified_at = now(),
        failure_reason = nullif(left(p_failure_reason,500),''),
        raw_snapshot = coalesce(p_snapshot,'{}'::jsonb),
        lease_owner = null,
        lease_expires_at = null
    where id = v_row.id;
    update public.swing_order_intents set
        status = case
            when p_status = 'active' then 'submitted'
            when p_status in ('triggered','order_open') then status
            when p_status = 'filled' then 'filled'
            when p_status in ('cancelled','expired') then 'cancelled'
            when p_status = 'rejected' then 'rejected'
            when p_status = 'failed' then 'failed'
            else status end,
        completed_at = case when p_status in ('filled','cancelled','expired','rejected','failed')
            then coalesce(completed_at, now()) else completed_at end,
        failure_reason = case when p_status in ('cancelled','expired','rejected','failed')
            then nullif(left(p_failure_reason,500),'') else failure_reason end,
        lease_owner = null,
        lease_expires_at = null
    where id = v_row.intent_id and user_id = p_user_id;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        p_user_id, 'worker', 'gtt_assisted_' || p_status,
        'gtt_assisted_entry', v_row.id::text,
        jsonb_build_object('broker_trigger_id', p_broker_trigger_id,
            'broker_order_id', p_broker_order_id, 'reason', p_failure_reason)
    );
end;
$$;

create or replace function public.record_swing_gtt_assisted_protection(
    p_user_id uuid,
    p_worker_id text,
    p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
    v_trade public.swing_trades%rowtype;
    v_stop numeric := nullif(p_payload->>'trigger_price','')::numeric;
    v_target numeric := nullif(p_payload->>'target_price','')::numeric;
    v_status text := coalesce(nullif(p_payload->>'status',''),'pending');
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    select * into v_trade from public.swing_trades
    where id = nullif(p_payload->>'trade_id','')::uuid and user_id = p_user_id
      and trade_mode = 'live' and execution_source = 'gtt_assisted'
      and status in ('open','exit_pending') for update;
    if not found then raise exception 'GTT Assisted live trade is unavailable for protection.'; end if;
    if v_stop < v_trade.current_stop then raise exception 'Protective stop cannot move downward.'; end if;
    if v_target is null or v_target <= greatest(v_trade.entry_price, v_stop) then
        raise exception 'A valid OCO profit target is required.';
    end if;
    insert into public.swing_protective_orders(
        user_id, trade_id, entry_order_id, broker_trigger_id, protection_type,
        status, protected_quantity, trigger_price, limit_price,
        highest_protected_stop, last_verified_at, failure_reason, metadata
    ) values (
        p_user_id, v_trade.id, nullif(p_payload->>'entry_order_id','')::uuid,
        nullif(p_payload->>'broker_trigger_id',''), 'gtt_oco', v_status,
        (p_payload->>'protected_quantity')::integer, v_stop,
        nullif(p_payload->>'limit_price','')::numeric, v_stop, now(),
        nullif(left(p_payload->>'failure_reason',500),''),
        coalesce(p_payload->'metadata','{}'::jsonb) || jsonb_build_object('target_price',v_target)
    ) on conflict(user_id,broker_trigger_id) where broker_trigger_id is not null do update set
        status = excluded.status,
        protected_quantity = excluded.protected_quantity,
        trigger_price = greatest(swing_protective_orders.trigger_price, excluded.trigger_price),
        limit_price = excluded.limit_price,
        highest_protected_stop = greatest(swing_protective_orders.highest_protected_stop, excluded.highest_protected_stop),
        last_verified_at = now(),
        failure_reason = excluded.failure_reason,
        metadata = excluded.metadata
    returning id into v_id;
    update public.swing_trades set current_stop = greatest(current_stop, v_stop)
    where id = v_trade.id;
    if v_status in ('rejected','failed') then
        insert into public.swing_risk_control_activations(
            user_id, control_type, status, reason, details
        ) values (
            p_user_id, 'protective_order', 'active',
            'A GTT Assisted position is missing broker-side OCO protection.',
            jsonb_build_object('trade_id',v_trade.id,'protective_order_id',v_id)
        );
        update public.swing_automation_controls
        set gtt_assisted_enabled = false where user_id = p_user_id;
    end if;
    return v_id;
end;
$$;

create or replace function public.report_swing_execution_failure(
    p_user_id uuid,
    p_control_type text,
    p_reason text,
    p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if p_control_type not in (
        'stale_quote','session_invalid','reconciliation','broker_order',
        'protective_order','funds','corporate_action'
    ) or nullif(trim(p_reason),'') is null then
        raise exception 'Invalid execution failure report.';
    end if;
    if not exists (
        select 1 from public.swing_risk_control_activations
        where user_id = p_user_id and control_type = p_control_type and status = 'active'
    ) then
        insert into public.swing_risk_control_activations(
            user_id, control_type, status, reason, details
        ) values (
            p_user_id, p_control_type, 'active', left(trim(p_reason),500),
            coalesce(p_details,'{}'::jsonb)
        );
    end if;
    update public.swing_automation_controls set new_entries_enabled = false
    where user_id = p_user_id;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        p_user_id, 'worker', 'execution_failure_locked_entries',
        'risk_control', p_control_type,
        jsonb_build_object('reason',left(trim(p_reason),500)) || coalesce(p_details,'{}'::jsonb)
    );
end;
$$;

-- An active entry trigger must be cancelled before its daily API session is
-- removed; otherwise a later broker-hosted fill could be temporarily unprotected.
create or replace function public.disconnect_kite_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_connection_id uuid;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    if exists (
        select 1 from public.swing_gtt_assisted_entries
        where user_id = v_user_id and status in ('active','triggered','order_open','cancel_requested')
    ) then
        raise exception 'Cancel the active GTT Assisted entry and wait for broker confirmation before removing the Kite session.';
    end if;
    select id into v_connection_id from public.kite_broker_connections
    where user_id = v_user_id for update;
    delete from public.kite_broker_sessions where user_id = v_user_id;
    update public.kite_broker_connections set
        connection_status = 'disconnected', session_expires_at = null,
        disconnected_at = now(), error_message = null
    where user_id = v_user_id;
    insert into public.swing_automation_controls(user_id) values (v_user_id)
    on conflict (user_id) do nothing;
    update public.swing_automation_controls set
        automation_mode = 'advisory', new_entries_enabled = false,
        armed_nse_session = null, gtt_assisted_enabled = false
    where user_id = v_user_id;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', 'kite_session_disconnected', 'kite_connection',
        v_connection_id::text, jsonb_build_object('active_entry_gtt',false)
    );
end;
$$;

-- Preserve the existing restore API while ensuring that broker-hosted entry
-- state and the Personal Free write switch are never restored as armed state.
create or replace function public.restore_complete_portfolio_backup_v11(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    perform public.restore_complete_portfolio_backup_v10(p_backup);
    delete from public.swing_gtt_assisted_entries where user_id = v_user_id;
    delete from public.swing_candidate_execution_states where user_id = v_user_id;
    delete from public.swing_protective_orders where user_id = v_user_id;
    delete from public.swing_broker_fills where user_id = v_user_id;
    delete from public.swing_broker_orders where user_id = v_user_id;
    delete from public.swing_order_intents where user_id = v_user_id;
    delete from public.swing_processing_leases where user_id = v_user_id;
    delete from public.swing_risk_control_activations where user_id = v_user_id;
    delete from public.swing_execution_audit_events where user_id = v_user_id;
    delete from public.swing_worker_heartbeats where user_id = v_user_id;
    delete from public.swing_broker_account_snapshots where user_id = v_user_id;
    delete from public.swing_position_reconciliations where user_id = v_user_id;
    delete from public.swing_reconciliation_runs where user_id = v_user_id;
    delete from public.kite_broker_sessions where user_id = v_user_id;
    update public.kite_broker_connections set
        connection_status = 'disconnected', session_expires_at = null,
        disconnected_at = now(), error_message = null
    where user_id = v_user_id;
    update public.swing_automation_controls set
        automation_mode = 'advisory', new_entries_enabled = false,
        armed_nse_session = null, gtt_assisted_enabled = false,
        assisted_live_unlocked = false, live_auto_unlocked = false,
        broker_execution_enabled = false
    where user_id = v_user_id;
end;
$$;

revoke all on function public.configure_swing_gtt_assisted(boolean) from public, anon;
grant execute on function public.configure_swing_gtt_assisted(boolean) to authenticated;
revoke all on function public.create_swing_gtt_assisted_entry(uuid,numeric) from public, anon;
grant execute on function public.create_swing_gtt_assisted_entry(uuid,numeric) to authenticated;
revoke all on function public.cancel_swing_gtt_assisted_entry(uuid) from public, anon;
grant execute on function public.cancel_swing_gtt_assisted_entry(uuid) to authenticated;

revoke all on function public.get_swing_gtt_worker_state(uuid) from public, anon, authenticated;
revoke all on function public.publish_swing_gtt_heartbeat(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.claim_swing_gtt_assisted_entry(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.record_swing_gtt_assisted_state(uuid,text,uuid,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.record_swing_gtt_assisted_protection(uuid,text,jsonb) from public, anon, authenticated;

grant execute on function public.get_swing_gtt_worker_state(uuid) to service_role;
grant execute on function public.publish_swing_gtt_heartbeat(uuid,jsonb) to service_role;
grant execute on function public.claim_swing_gtt_assisted_entry(uuid,text,integer) to service_role;
grant execute on function public.record_swing_gtt_assisted_state(uuid,text,uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.record_swing_gtt_assisted_protection(uuid,text,jsonb) to service_role;

commit;
