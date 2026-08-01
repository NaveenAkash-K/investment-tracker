begin;

-- Batch 3: Paper Auto. Live Kite quotes may be observed, but this migration
-- cannot create a broker order, broker fill, order intent or protective order.
-- Every fill below is a simulation recorded in the existing paper journal.

alter table public.swing_automation_controls
    add column if not exists paper_slippage_bps numeric(8, 3) not null default 5
        check (paper_slippage_bps between 0 and 50),
    add column if not exists paper_max_new_entries_per_day integer not null default 1
        check (paper_max_new_entries_per_day between 1 and 5);

alter table public.swing_trades
    add column if not exists execution_source text not null default 'manual'
        check (execution_source in ('manual', 'paper_auto', 'assisted_live', 'live_auto')),
    add column if not exists entry_slippage_inr numeric(18, 2) not null default 0
        check (entry_slippage_inr >= 0),
    add column if not exists exit_slippage_inr numeric(18, 2) not null default 0
        check (exit_slippage_inr >= 0),
    add column if not exists execution_cost_model text,
    add column if not exists last_quote_at timestamptz;

create index if not exists swing_trades_paper_auto_open_idx
    on public.swing_trades(user_id, status, entry_date)
    where trade_mode = 'paper' and execution_source = 'paper_auto';

create table if not exists public.swing_paper_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    event_key text not null,
    worker_id text not null,
    event_type text not null check (event_type in (
        'candidate_invalidated', 'entry_filled', 'entry_and_stop',
        'stop_filled', 'signal_exit_filled', 'cycle_blocked'
    )),
    nse_session date not null,
    candidate_id uuid,
    trade_id uuid,
    symbol text not null,
    quantity integer check (quantity is null or quantity > 0),
    price numeric(18, 4) check (price is null or price > 0),
    slippage_inr numeric(18, 2) not null default 0 check (slippage_inr >= 0),
    fees_inr numeric(18, 2) not null default 0 check (fees_inr >= 0),
    reason text not null,
    observed_at timestamptz not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (user_id, event_key),
    constraint swing_paper_events_candidate_user_fk
        foreign key (candidate_id, user_id)
        references public.swing_candidates(id, user_id)
        on delete set null (candidate_id),
    constraint swing_paper_events_trade_user_fk
        foreign key (trade_id, user_id)
        references public.swing_trades(id, user_id)
        on delete set null (trade_id)
);

create index if not exists swing_paper_events_user_time_idx
    on public.swing_paper_events(user_id, observed_at desc);

alter table public.swing_paper_events enable row level security;
drop policy if exists "Users view their swing_paper_events" on public.swing_paper_events;
create policy "Users view their swing_paper_events"
    on public.swing_paper_events for select
    using (auth.uid() = user_id);

grant select on table public.swing_paper_events to authenticated;
grant select, insert, update, delete on table public.swing_paper_events to service_role;

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
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;
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

    insert into public.swing_automation_controls(user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;

    select * into v_controls
    from public.swing_automation_controls
    where user_id = v_user_id
    for update;

    if p_action = 'enable' then
        if v_controls.emergency_stop_active then
            raise exception 'Clear the emergency stop before enabling Paper Auto.';
        end if;
        select * into v_connection
        from public.kite_broker_connections
        where user_id = v_user_id;

        if not found
           or v_connection.connection_status <> 'connected'
           or v_connection.session_expires_at <= now() then
            raise exception 'Connect Kite for today before enabling Paper Auto.';
        end if;

        update public.swing_automation_controls
        set automation_mode = 'paper_auto',
            new_entries_enabled = true,
            armed_nse_session = v_today,
            paper_slippage_bps = coalesce(p_slippage_bps, paper_slippage_bps),
            paper_max_new_entries_per_day = coalesce(
                p_max_new_entries_per_day, paper_max_new_entries_per_day
            )
        where user_id = v_user_id;
    elsif p_action = 'pause' then
        update public.swing_automation_controls
        set automation_mode = 'paper_auto',
            new_entries_enabled = false,
            paper_slippage_bps = coalesce(p_slippage_bps, paper_slippage_bps),
            paper_max_new_entries_per_day = coalesce(
                p_max_new_entries_per_day, paper_max_new_entries_per_day
            )
        where user_id = v_user_id;
    else
        update public.swing_automation_controls
        set automation_mode = 'advisory',
            new_entries_enabled = false,
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
            'nse_session', v_today,
            'paper_slippage_bps', p_slippage_bps,
            'paper_max_new_entries_per_day', p_max_new_entries_per_day,
            'broker_orders_enabled', false
        )
    );
end;
$$;

create or replace function public.get_swing_paper_worker_state(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_controls public.swing_automation_controls%rowtype;
    v_settings public.swing_lab_settings%rowtype;
    v_latest_scan public.swing_scan_runs%rowtype;
begin
    if auth.role() <> 'service_role' then
        raise exception 'Service role required.';
    end if;

    select * into v_controls
    from public.swing_automation_controls
    where user_id = p_user_id;

    select * into v_settings
    from public.swing_lab_settings
    where user_id = p_user_id;

    select * into v_latest_scan
    from public.swing_scan_runs
    where user_id = p_user_id
    order by as_of desc
    limit 1;

    return jsonb_build_object(
        'controls', jsonb_build_object(
            'automation_mode', coalesce(v_controls.automation_mode, 'advisory'),
            'new_entries_enabled', coalesce(v_controls.new_entries_enabled, false),
            'armed_nse_session', v_controls.armed_nse_session,
            'emergency_stop_active', coalesce(v_controls.emergency_stop_active, false),
            'paper_slippage_bps', coalesce(v_controls.paper_slippage_bps, 5),
            'paper_max_new_entries_per_day', coalesce(v_controls.paper_max_new_entries_per_day, 1)
        ),
        'settings', case when v_settings.user_id is null then null else to_jsonb(v_settings) end,
        'latest_scan', case when v_latest_scan.id is null then null else jsonb_build_object(
            'id', v_latest_scan.id,
            'as_of', v_latest_scan.as_of,
            'status', v_latest_scan.status,
            'model_version', v_latest_scan.model_version,
            'contract_version', v_latest_scan.contract_version,
            'publication_status', v_latest_scan.publication_status,
            'market_regime', v_latest_scan.market_regime,
            'session_state', v_latest_scan.session_state,
            'session_matches_expected', v_latest_scan.session_matches_expected,
            'expected_price_session', v_latest_scan.expected_price_session
        ) end,
        'paper_entries_today', (
            select count(*)
            from public.swing_trades trade
            where trade.user_id = p_user_id
              and trade.trade_mode = 'paper'
              and trade.execution_source = 'paper_auto'
              and trade.entry_date = (now() at time zone 'Asia/Kolkata')::date
        ),
        'candidates', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', candidate.id,
                'scan_id', candidate.scan_id,
                'symbol', candidate.symbol,
                'company_name', candidate.company_name,
                'sector', candidate.sector,
                'setup_type', candidate.setup_type,
                'status', candidate.status,
                'setup_as_of', candidate.setup_as_of,
                'expires_on', candidate.expires_on,
                'entry_trigger', candidate.entry_trigger,
                'maximum_entry', candidate.maximum_entry,
                'initial_stop', candidate.initial_stop,
                'suggested_quantity', candidate.suggested_quantity,
                'risk_percentage_used', candidate.risk_percentage_used,
                'source_scan_status', scan.status,
                'source_scan_model_version', scan.model_version,
                'source_scan_contract_version', scan.contract_version,
                'source_scan_publication_status', scan.publication_status,
                'source_scan_session_state', scan.session_state,
                'source_scan_matches_expected', scan.session_matches_expected
            ) order by candidate.setup_score desc)
            from public.swing_candidates candidate
            join public.swing_scan_runs scan
              on scan.id = candidate.scan_id and scan.user_id = candidate.user_id
            where candidate.user_id = p_user_id
              and candidate.status in ('candidate', 'ready', 'triggered')
              and candidate.expires_on >= (now() at time zone 'Asia/Kolkata')::date
              and candidate.suggested_quantity > 0
              and left(candidate.setup_type, 5) <> 'TEST_'
        ), '[]'::jsonb),
        'positions', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', trade.id,
                'candidate_id', trade.candidate_id,
                'symbol', trade.symbol,
                'status', trade.status,
                'entry_price', trade.entry_price,
                'quantity', trade.quantity,
                'current_stop', trade.current_stop,
                'planned_risk_inr', trade.planned_risk_inr,
                'fees_inr', trade.fees_inr,
                'exit_signal_reason', trade.exit_signal_reason,
                'corporate_action_review_required', trade.corporate_action_review_required
            ) order by trade.entry_date, trade.created_at)
            from public.swing_trades trade
            where trade.user_id = p_user_id
              and trade.trade_mode = 'paper'
              and trade.execution_source = 'paper_auto'
              and trade.status in ('open', 'exit_pending')
        ), '[]'::jsonb)
    );
end;
$$;

create or replace function public.publish_swing_paper_cycle(
    p_user_id uuid,
    p_cycle jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_worker_id text := nullif(trim(p_cycle->>'worker_id'), '');
    v_worker_version text := nullif(trim(p_cycle->>'worker_version'), '');
    v_policy_version text := nullif(trim(p_cycle->>'execution_policy_version'), '');
    v_cost_model text := nullif(trim(p_cycle->>'cost_model_version'), '');
    v_observed_at timestamptz := coalesce(nullif(p_cycle->>'observed_at', '')::timestamptz, now());
    v_session date := nullif(p_cycle->>'nse_session', '')::date;
    v_status text := coalesce(nullif(p_cycle->>'worker_status', ''), 'blocked');
    v_controls public.swing_automation_controls%rowtype;
    v_settings public.swing_lab_settings%rowtype;
    v_candidate public.swing_candidates%rowtype;
    v_source_scan public.swing_scan_runs%rowtype;
    v_latest_scan public.swing_scan_runs%rowtype;
    v_trade public.swing_trades%rowtype;
    v_action jsonb;
    v_action_type text;
    v_event_id uuid;
    v_event_key text;
    v_candidate_id uuid;
    v_trade_id uuid;
    v_quantity integer;
    v_price numeric;
    v_slippage numeric;
    v_fees numeric;
    v_reason text;
    v_risk_per_share numeric;
    v_planned_risk numeric;
    v_risk_budget numeric;
    v_slot_capital numeric;
    v_deployed_capital numeric;
    v_open_count integer;
    v_sector_count integer;
    v_daily_entries integer;
    v_processed integer := 0;
    v_skipped integer := 0;
begin
    if auth.role() <> 'service_role' then
        raise exception 'Service role required.';
    end if;
    if coalesce(p_cycle->>'execution_mode', '') <> 'paper_auto' then
        raise exception 'Paper worker accepts paper_auto mode only.';
    end if;
    if v_worker_id is null or v_worker_id !~ '^[A-Za-z0-9._:-]{3,100}$' then
        raise exception 'Invalid worker id.';
    end if;
    if v_worker_version is null or length(v_worker_version) > 50 then
        raise exception 'Invalid worker version.';
    end if;
    if v_policy_version <> '1.0.0' then
        raise exception 'Unsupported Swing execution policy.';
    end if;
    if v_cost_model is null or length(v_cost_model) > 80 then
        raise exception 'Paper cost model is required.';
    end if;
    if v_status not in ('starting', 'healthy', 'degraded', 'blocked', 'stopping') then
        raise exception 'Invalid worker status.';
    end if;
    if v_session is null
       or v_session <> (v_observed_at at time zone 'Asia/Kolkata')::date
       or v_observed_at > now() + interval '2 minutes'
       or v_observed_at < now() - interval '15 minutes' then
        raise exception 'Paper cycle has an invalid NSE session or observation time.';
    end if;
    if jsonb_typeof(coalesce(p_cycle->'actions', '[]'::jsonb)) <> 'array' then
        raise exception 'Paper cycle actions must be an array.';
    end if;

    insert into public.swing_automation_controls(user_id)
    values (p_user_id)
    on conflict (user_id) do nothing;

    select * into v_controls
    from public.swing_automation_controls
    where user_id = p_user_id
    for update;

    select * into v_settings
    from public.swing_lab_settings
    where user_id = p_user_id;

    select * into v_latest_scan
    from public.swing_scan_runs
    where user_id = p_user_id
    order by as_of desc
    limit 1;

    insert into public.swing_worker_heartbeats(
        user_id, worker_id, worker_version, execution_policy_version,
        worker_status, execution_mode, kite_session_healthy,
        quote_stream_healthy, reconciliation_healthy, heartbeat_at, details
    ) values (
        p_user_id, v_worker_id, v_worker_version, v_policy_version,
        v_status, 'paper_auto',
        coalesce((p_cycle->>'kite_session_healthy')::boolean, false),
        coalesce((p_cycle->>'quote_stream_healthy')::boolean, false),
        true, v_observed_at,
        coalesce(p_cycle->'details', '{}'::jsonb) || jsonb_build_object(
            'quote_count', coalesce((p_cycle->>'quote_count')::integer, 0),
            'broker_orders_enabled', false,
            'cost_model_version', v_cost_model
        )
    )
    on conflict (user_id, worker_id) do update set
        worker_version = excluded.worker_version,
        execution_policy_version = excluded.execution_policy_version,
        worker_status = excluded.worker_status,
        execution_mode = 'paper_auto',
        kite_session_healthy = excluded.kite_session_healthy,
        quote_stream_healthy = excluded.quote_stream_healthy,
        reconciliation_healthy = true,
        heartbeat_at = excluded.heartbeat_at,
        details = excluded.details;

    for v_action in
        select value from jsonb_array_elements(coalesce(p_cycle->'actions', '[]'::jsonb))
    loop
        v_action_type := nullif(v_action->>'type', '');

        if v_action_type = 'mark' then
            v_trade_id := nullif(v_action->>'trade_id', '')::uuid;
            v_price := nullif(v_action->>'price', '')::numeric;
            if v_trade_id is null or v_price is null or v_price <= 0 then
                raise exception 'Invalid paper mark action.';
            end if;
            update public.swing_trades
            set current_price = v_price,
                current_price_as_of = v_session,
                last_quote_at = v_observed_at,
                unrealized_pnl_inr = (v_price - entry_price) * quantity - fees_inr,
                unrealized_r_multiple = ((v_price - entry_price) * quantity - fees_inr)
                    / greatest(planned_risk_inr, 0.01)
            where id = v_trade_id
              and user_id = p_user_id
              and trade_mode = 'paper'
              and execution_source = 'paper_auto'
              and status in ('open', 'exit_pending')
              and not corporate_action_review_required;
            if found then v_processed := v_processed + 1; else v_skipped := v_skipped + 1; end if;
            continue;
        end if;

        if v_action_type not in (
            'candidate_invalidated', 'entry_filled', 'entry_and_stop',
            'stop_filled', 'signal_exit_filled'
        ) then
            raise exception 'Unsupported paper action type: %.', coalesce(v_action_type, 'missing');
        end if;

        v_event_key := nullif(trim(v_action->>'event_key'), '');
        v_candidate_id := nullif(v_action->>'candidate_id', '')::uuid;
        v_trade_id := nullif(v_action->>'trade_id', '')::uuid;
        v_quantity := nullif(v_action->>'quantity', '')::integer;
        v_price := nullif(v_action->>'price', '')::numeric;
        v_slippage := coalesce(nullif(v_action->>'slippage_inr', '')::numeric, 0);
        v_fees := coalesce(nullif(v_action->>'fees_inr', '')::numeric, 0);
        v_reason := nullif(left(trim(coalesce(v_action->>'reason', '')), 1000), '');

        if v_event_key is null or length(v_event_key) > 200
           or v_reason is null or v_slippage < 0 or v_fees < 0 then
            raise exception 'Invalid paper event fields.';
        end if;

        insert into public.swing_paper_events(
            user_id, event_key, worker_id, event_type, nse_session,
            candidate_id, trade_id, symbol, quantity, price,
            slippage_inr, fees_inr, reason, observed_at, metadata
        ) values (
            p_user_id, v_event_key, v_worker_id, v_action_type, v_session,
            v_candidate_id, v_trade_id, upper(nullif(trim(v_action->>'symbol'), '')),
            v_quantity, v_price, v_slippage, v_fees, v_reason,
            v_observed_at, coalesce(v_action->'metadata', '{}'::jsonb)
        )
        on conflict (user_id, event_key) do nothing
        returning id into v_event_id;

        if v_event_id is null then
            v_skipped := v_skipped + 1;
            continue;
        end if;

        if v_action_type = 'candidate_invalidated' then
            if v_controls.automation_mode <> 'paper_auto'
               or not v_controls.new_entries_enabled
               or v_controls.armed_nse_session <> v_session
               or v_controls.emergency_stop_active then
                raise exception 'Paper Auto is not armed for candidate changes.';
            end if;
            update public.swing_candidates
            set status = 'invalidated', invalidation_reason = v_reason
            where id = v_candidate_id and user_id = p_user_id
              and status in ('candidate', 'ready', 'triggered');

        elsif v_action_type in ('entry_filled', 'entry_and_stop') then
            if v_controls.automation_mode <> 'paper_auto'
               or not v_controls.new_entries_enabled
               or v_controls.armed_nse_session <> v_session
               or v_controls.emergency_stop_active then
                raise exception 'Paper Auto is not armed for new entries.';
            end if;
            if v_settings.user_id is null then
                raise exception 'Save Swing Lab risk settings before using Paper Auto.';
            end if;
            if v_latest_scan.id is null
               or v_latest_scan.status not in ('successful', 'partial')
               or v_latest_scan.model_version <> '2.5.0'
               or v_latest_scan.session_state <> 'completed'
               or not v_latest_scan.session_matches_expected
               or v_latest_scan.publication_status <> 'published'
               or coalesce(v_latest_scan.contract_version, '') <> '2026-07-30.v2'
               or v_latest_scan.expected_price_session is null
               or v_session < v_latest_scan.expected_price_session
               or v_session - v_latest_scan.expected_price_session > 3 then
                raise exception 'The latest Swing scan is not supported and fresh.';
            end if;

            perform 1 from public.swing_trades
            where user_id = p_user_id and trade_mode = 'paper'
              and status in ('open', 'exit_pending')
            for update;

            select * into v_candidate
            from public.swing_candidates
            where id = v_candidate_id and user_id = p_user_id
            for update;

            if not found
               or v_candidate.status not in ('candidate', 'ready', 'triggered')
               or left(v_candidate.setup_type, 5) = 'TEST_'
               or v_session < v_candidate.setup_as_of
               or v_session > v_candidate.expires_on
               or v_quantity is null or v_quantity <= 0
               or v_quantity > v_candidate.suggested_quantity
               or v_price is null or v_price <= v_candidate.initial_stop
               or v_price > v_candidate.maximum_entry then
                raise exception 'Paper entry no longer satisfies the candidate contract.';
            end if;

            select * into v_source_scan
            from public.swing_scan_runs
            where id = v_candidate.scan_id and user_id = p_user_id;

            if not found
               or v_source_scan.status not in ('successful', 'partial')
               or v_source_scan.model_version <> '2.5.0'
               or v_source_scan.session_state <> 'completed'
               or not v_source_scan.session_matches_expected
               or v_source_scan.publication_status <> 'published'
               or coalesce(v_source_scan.contract_version, '') <> '2026-07-30.v2' then
                raise exception 'Candidate source scan is not supported.';
            end if;

            v_risk_per_share := v_price - v_candidate.initial_stop;
            v_planned_risk := v_risk_per_share * v_quantity;
            v_risk_budget := v_settings.trading_capital_inr
                * coalesce(v_candidate.risk_percentage_used, v_settings.risk_per_trade_percentage) / 100;
            v_slot_capital := v_settings.trading_capital_inr / greatest(v_settings.max_open_positions, 1);

            select count(*), coalesce(sum(entry_price * quantity), 0)
            into v_open_count, v_deployed_capital
            from public.swing_trades
            where user_id = p_user_id and trade_mode = 'paper'
              and status in ('open', 'exit_pending');

            select count(*) into v_sector_count
            from public.swing_trades
            where user_id = p_user_id and trade_mode = 'paper'
              and status in ('open', 'exit_pending')
              and coalesce(sector, 'Unclassified') = coalesce(v_candidate.sector, 'Unclassified');

            select count(*) into v_daily_entries
            from public.swing_trades
            where user_id = p_user_id and trade_mode = 'paper'
              and execution_source = 'paper_auto' and entry_date = v_session;

            if v_open_count >= v_settings.max_open_positions
               or v_sector_count >= v_settings.max_sector_positions
               or v_daily_entries >= v_controls.paper_max_new_entries_per_day
               or v_planned_risk > v_risk_budget + 0.01
               or v_price * v_quantity > v_slot_capital + 0.01
               or v_deployed_capital + v_price * v_quantity > v_settings.trading_capital_inr + 0.01 then
                raise exception 'Paper entry failed an execution-time capital or risk limit.';
            end if;

            insert into public.swing_trades(
                user_id, candidate_id, symbol, company_name, sector,
                trade_mode, execution_source, status, signal_entry,
                maximum_entry, entry_date, entry_price, quantity,
                initial_stop, current_stop, initial_risk_per_share,
                planned_risk_inr, current_price, current_price_as_of,
                highest_close, unrealized_pnl_inr, unrealized_r_multiple,
                fees_inr, entry_slippage_inr, execution_cost_model,
                last_quote_at, notes
            ) values (
                p_user_id, v_candidate.id, v_candidate.symbol, v_candidate.company_name,
                v_candidate.sector, 'paper', 'paper_auto',
                case when v_action_type = 'entry_and_stop' then 'closed' else 'open' end,
                v_candidate.entry_trigger, v_candidate.maximum_entry, v_session,
                v_price, v_quantity, v_candidate.initial_stop, v_candidate.initial_stop,
                v_risk_per_share, v_planned_risk, v_price, v_session, v_price,
                case when v_action_type = 'entry_and_stop' then
                    (coalesce(nullif(v_action->>'exit_price', '')::numeric, v_candidate.initial_stop) - v_price) * v_quantity - v_fees
                    else -v_fees end,
                case when v_action_type = 'entry_and_stop' then
                    ((coalesce(nullif(v_action->>'exit_price', '')::numeric, v_candidate.initial_stop) - v_price) * v_quantity - v_fees)
                        / greatest(v_planned_risk, 0.01)
                    else -v_fees / greatest(v_planned_risk, 0.01) end,
                v_fees, v_slippage, v_cost_model, v_observed_at,
                'Paper Auto simulated fill. No broker order was placed.'
            ) returning id into v_trade_id;

            update public.swing_candidates set status = 'entered'
            where id = v_candidate.id and user_id = p_user_id;

            update public.swing_paper_events set trade_id = v_trade_id
            where id = v_event_id;

            insert into public.swing_trade_events(
                user_id, trade_id, event_type, event_at, price, stop_price, reason, metadata
            ) values (
                p_user_id, v_trade_id, 'entry_confirmed', v_observed_at,
                v_price, v_candidate.initial_stop, 'Paper Auto simulated entry',
                jsonb_build_object('paper_auto', true, 'broker_order_placed', false)
            );

            if v_action_type = 'entry_and_stop' then
                v_price := coalesce(nullif(v_action->>'exit_price', '')::numeric, v_candidate.initial_stop);
                update public.swing_trades
                set exit_date = v_session, exit_price = v_price,
                    current_price = v_price, current_price_as_of = v_session,
                    exit_slippage_inr = coalesce(nullif(v_action->>'exit_slippage_inr', '')::numeric, 0),
                    realized_pnl_inr = (v_price - entry_price) * quantity - fees_inr,
                    realized_r_multiple = ((v_price - entry_price) * quantity - fees_inr)
                        / greatest(planned_risk_inr, 0.01),
                    exit_signal_reason = v_reason, exit_signal_at = v_observed_at
                where id = v_trade_id and user_id = p_user_id;
                insert into public.swing_trade_events(
                    user_id, trade_id, event_type, event_at, price, stop_price, reason, metadata
                ) values (
                    p_user_id, v_trade_id, 'exit_confirmed', v_observed_at,
                    v_price, v_candidate.initial_stop, v_reason,
                    jsonb_build_object('paper_auto', true, 'same_snapshot_ambiguity', true)
                );
            end if;

        else
            select * into v_trade
            from public.swing_trades
            where id = v_trade_id and user_id = p_user_id
              and trade_mode = 'paper' and execution_source = 'paper_auto'
              and status in ('open', 'exit_pending')
            for update;

            if not found or v_trade.corporate_action_review_required then
                raise exception 'Paper Auto trade is unavailable for an automatic exit.';
            end if;
            if v_quantity is distinct from v_trade.quantity
               or v_price is null or v_price <= 0 then
                raise exception 'Paper exit quantity or price is invalid.';
            end if;

            update public.swing_trades
            set status = 'closed', exit_date = v_session, exit_price = v_price,
                current_price = v_price, current_price_as_of = v_session,
                last_quote_at = v_observed_at,
                fees_inr = v_fees,
                exit_slippage_inr = v_slippage,
                unrealized_pnl_inr = null, unrealized_r_multiple = null,
                realized_pnl_inr = (v_price - entry_price) * quantity - v_fees,
                realized_r_multiple = ((v_price - entry_price) * quantity - v_fees)
                    / greatest(planned_risk_inr, 0.01),
                exit_signal_reason = v_reason, exit_signal_at = v_observed_at
            where id = v_trade.id and user_id = p_user_id;

            insert into public.swing_trade_events(
                user_id, trade_id, event_type, event_at, price, stop_price, reason, metadata
            ) values (
                p_user_id, v_trade.id, 'exit_confirmed', v_observed_at,
                v_price, v_trade.current_stop, v_reason,
                jsonb_build_object('paper_auto', true, 'broker_order_placed', false)
            );
        end if;

        v_processed := v_processed + 1;
        v_event_id := null;
    end loop;

    return jsonb_build_object('processed', v_processed, 'idempotent_skips', v_skipped);
end;
$$;

revoke all on function public.configure_swing_paper_auto(text, numeric, integer)
    from public, anon;
grant execute on function public.configure_swing_paper_auto(text, numeric, integer)
    to authenticated;

revoke all on function public.get_swing_paper_worker_state(uuid)
    from public, anon, authenticated;
revoke all on function public.publish_swing_paper_cycle(uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.get_swing_paper_worker_state(uuid)
    to service_role;
grant execute on function public.publish_swing_paper_cycle(uuid, jsonb)
    to service_role;

-- Preserve Paper Auto journal provenance in the full backup while always
-- restoring automation disarmed. Encrypted Kite sessions and worker state are
-- intentionally outside the backup contract.
create or replace function public.restore_swing_paper_auto_details(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;

    for v_row in
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_trades', '[]'::jsonb))
    loop
        update public.swing_trades
        set execution_source = coalesce(nullif(v_row->>'execution_source', ''), 'manual'),
            entry_slippage_inr = coalesce(nullif(v_row->>'entry_slippage_inr', '')::numeric, 0),
            exit_slippage_inr = coalesce(nullif(v_row->>'exit_slippage_inr', '')::numeric, 0),
            execution_cost_model = nullif(v_row->>'execution_cost_model', ''),
            last_quote_at = nullif(v_row->>'last_quote_at', '')::timestamptz
        where id = (v_row->>'id')::uuid and user_id = v_user_id;
    end loop;

    delete from public.swing_paper_events where user_id = v_user_id;
    for v_row in
        select value from jsonb_array_elements(coalesce(p_backup->'data'->'swing_paper_events', '[]'::jsonb))
    loop
        insert into public.swing_paper_events(
            id, user_id, event_key, worker_id, event_type, nse_session,
            candidate_id, trade_id, symbol, quantity, price, slippage_inr,
            fees_inr, reason, observed_at, metadata, created_at
        ) values (
            (v_row->>'id')::uuid, v_user_id, v_row->>'event_key',
            v_row->>'worker_id', v_row->>'event_type', (v_row->>'nse_session')::date,
            nullif(v_row->>'candidate_id', '')::uuid, nullif(v_row->>'trade_id', '')::uuid,
            v_row->>'symbol', nullif(v_row->>'quantity', '')::integer,
            nullif(v_row->>'price', '')::numeric,
            coalesce(nullif(v_row->>'slippage_inr', '')::numeric, 0),
            coalesce(nullif(v_row->>'fees_inr', '')::numeric, 0),
            v_row->>'reason', (v_row->>'observed_at')::timestamptz,
            coalesce(v_row->'metadata', '{}'::jsonb),
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now())
        );
    end loop;

    v_row := coalesce((p_backup->'data'->'swing_automation_controls')->0, '{}'::jsonb);
    insert into public.swing_automation_controls(
        user_id, automation_mode, new_entries_enabled, armed_nse_session,
        emergency_stop_active, paper_slippage_bps, paper_max_new_entries_per_day
    ) values (
        v_user_id, 'advisory', false, null, false,
        coalesce(nullif(v_row->>'paper_slippage_bps', '')::numeric, 5),
        coalesce(nullif(v_row->>'paper_max_new_entries_per_day', '')::integer, 1)
    )
    on conflict (user_id) do update set
        automation_mode = 'advisory', new_entries_enabled = false,
        armed_nse_session = null, emergency_stop_active = false,
        paper_slippage_bps = excluded.paper_slippage_bps,
        paper_max_new_entries_per_day = excluded.paper_max_new_entries_per_day;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v9(p_backup jsonb)
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
    perform public.restore_complete_portfolio_backup_v8(p_backup);
    perform public.restore_swing_paper_auto_details(p_backup);
end;
$$;

revoke all on function public.restore_swing_paper_auto_details(jsonb)
    from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v9(jsonb)
    from public, anon;
grant execute on function public.restore_complete_portfolio_backup_v9(jsonb)
    to authenticated;

commit;
