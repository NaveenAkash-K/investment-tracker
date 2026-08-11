begin;

-- Safety hardening for every broker-writing Swing path. Existing modes remain
-- fail-closed; this migration adds account pinning, claim-time entry checks,
-- reduce-only exits, fill-level realization accounting and honest readiness.

alter table public.kite_broker_connections
    add column if not exists pinned_broker_user_id text,
    add column if not exists broker_identity_pinned_at timestamptz;

update public.kite_broker_connections
set pinned_broker_user_id = broker_user_id,
    broker_identity_pinned_at = coalesce(broker_identity_pinned_at, connected_at, now())
where pinned_broker_user_id is null and nullif(trim(broker_user_id), '') is not null;

create or replace function public.enforce_kite_broker_identity_pin()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if nullif(trim(new.broker_user_id), '') is null then
        return new;
    end if;
    if tg_op = 'INSERT'
       and nullif(trim(new.pinned_broker_user_id), '') is not null
       and trim(new.pinned_broker_user_id) <> trim(new.broker_user_id) then
        raise exception 'The initial Kite account pin must match the authenticated broker account.';
    end if;
    if tg_op = 'UPDATE'
       and nullif(trim(old.pinned_broker_user_id), '') is not null
       and (trim(new.broker_user_id) <> trim(old.pinned_broker_user_id)
            or nullif(trim(new.pinned_broker_user_id), '') is distinct from trim(old.pinned_broker_user_id)) then
        raise exception 'This Tracker is pinned to a different Kite account. Use the audited account-reset workflow before connecting another account.';
    end if;
    if tg_op = 'INSERT' then
        new.pinned_broker_user_id := coalesce(nullif(trim(new.pinned_broker_user_id), ''), trim(new.broker_user_id));
        new.broker_identity_pinned_at := coalesce(new.broker_identity_pinned_at, now());
    else
        new.pinned_broker_user_id := coalesce(nullif(trim(old.pinned_broker_user_id), ''), trim(new.broker_user_id));
        new.broker_identity_pinned_at := coalesce(old.broker_identity_pinned_at, now());
    end if;
    return new;
end;
$$;

drop trigger if exists kite_broker_connections_pin_identity on public.kite_broker_connections;
create trigger kite_broker_connections_pin_identity
before insert or update of broker_user_id, pinned_broker_user_id on public.kite_broker_connections
for each row execute function public.enforce_kite_broker_identity_pin();

create or replace function public.reset_kite_broker_identity()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_controls public.swing_automation_controls%rowtype;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    select * into v_controls from public.swing_automation_controls
    where user_id = v_user_id for update;
    if v_controls.automation_mode <> 'advisory'
       or v_controls.new_entries_enabled
       or v_controls.gtt_assisted_enabled then
        raise exception 'Disarm every execution mode before resetting the Kite account identity.';
    end if;
    if exists (select 1 from public.swing_trades where user_id = v_user_id
               and trade_mode = 'live' and status in ('open','exit_pending'))
       or exists (select 1 from public.swing_gtt_assisted_entries where user_id = v_user_id
                  and status in ('pending_submission','active','triggered','order_open','cancel_requested'))
       or exists (select 1 from public.swing_order_intents where user_id = v_user_id
                  and automation_mode in ('gtt_assisted','assisted_live','live_auto')
                  and status in ('pending','leased','validated','submitted','partially_filled'))
       or exists (select 1 from public.swing_protective_orders where user_id = v_user_id
                  and status in ('pending','active','triggered')) then
        raise exception 'Resolve every live position, order intent and protective GTT before resetting the broker identity.';
    end if;
    delete from public.kite_broker_sessions where user_id = v_user_id;
    delete from public.kite_broker_connections where user_id = v_user_id;
    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (v_user_id, 'user', 'kite_broker_identity_reset', 'kite_account', null, '{}'::jsonb);
end;
$$;

alter table public.swing_broker_orders
    add column if not exists charges_total_inr numeric(18,4) not null default 0,
    add column if not exists charges_status text not null default 'unavailable',
    add column if not exists charges_breakdown jsonb not null default '{}'::jsonb;

alter table public.swing_broker_orders
    drop constraint if exists swing_broker_orders_charges_total_check;
alter table public.swing_broker_orders
    add constraint swing_broker_orders_charges_total_check check (charges_total_inr >= 0);
alter table public.swing_broker_orders
    drop constraint if exists swing_broker_orders_charges_status_check;
alter table public.swing_broker_orders
    add constraint swing_broker_orders_charges_status_check
    check (charges_status in ('unavailable','broker_calculated','estimated'));

alter table public.swing_trades
    add column if not exists original_quantity integer,
    add column if not exists open_quantity integer,
    add column if not exists gross_realized_pnl_inr numeric(18,4),
    add column if not exists broker_charges_inr numeric(18,4) not null default 0,
    add column if not exists net_realized_pnl_inr numeric(18,4);

update public.swing_trades
set original_quantity = coalesce(original_quantity, quantity + coalesce(partial_exit_quantity, 0)),
    open_quantity = coalesce(open_quantity, case when status = 'closed' then 0 else quantity end),
    gross_realized_pnl_inr = coalesce(gross_realized_pnl_inr, realized_pnl_inr + fees_inr),
    broker_charges_inr = greatest(coalesce(broker_charges_inr, fees_inr, 0), 0),
    net_realized_pnl_inr = coalesce(net_realized_pnl_inr, realized_pnl_inr);

alter table public.swing_trades
    drop constraint if exists swing_trades_original_quantity_check;
alter table public.swing_trades
    add constraint swing_trades_original_quantity_check
    check (original_quantity is null or original_quantity > 0);
alter table public.swing_trades
    drop constraint if exists swing_trades_open_quantity_check;
alter table public.swing_trades
    add constraint swing_trades_open_quantity_check
    check (open_quantity is null or open_quantity >= 0);
alter table public.swing_trades
    drop constraint if exists swing_trades_broker_charges_check;
alter table public.swing_trades
    add constraint swing_trades_broker_charges_check check (broker_charges_inr >= 0);

create unique index if not exists swing_broker_fills_id_user_idx
    on public.swing_broker_fills(id, user_id);

create table if not exists public.swing_trade_realizations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    trade_id uuid not null,
    broker_fill_id uuid not null,
    execution_source text not null,
    realized_on date not null,
    quantity integer not null check (quantity > 0),
    entry_price numeric(18,4) not null check (entry_price > 0),
    exit_price numeric(18,4) not null check (exit_price > 0),
    gross_pnl_inr numeric(18,4) not null,
    entry_charges_allocated_inr numeric(18,4) not null default 0 check (entry_charges_allocated_inr >= 0),
    exit_charges_allocated_inr numeric(18,4) not null default 0 check (exit_charges_allocated_inr >= 0),
    net_pnl_inr numeric(18,4) not null,
    charges_status text not null default 'unavailable'
        check (charges_status in ('unavailable','broker_calculated','estimated')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, broker_fill_id),
    constraint swing_trade_realizations_trade_user_fk
        foreign key (trade_id, user_id)
        references public.swing_trades(id, user_id)
        on delete cascade,
    constraint swing_trade_realizations_fill_user_fk
        foreign key (broker_fill_id, user_id)
        references public.swing_broker_fills(id, user_id)
        on delete cascade
);

create index if not exists swing_trade_realizations_user_day_idx
    on public.swing_trade_realizations(user_id, realized_on desc, execution_source);

alter table public.swing_trade_realizations enable row level security;
drop policy if exists "Users view their swing_trade_realizations" on public.swing_trade_realizations;
create policy "Users view their swing_trade_realizations"
    on public.swing_trade_realizations for select using (auth.uid() = user_id);
grant select on table public.swing_trade_realizations to authenticated;
grant select, insert, update, delete on table public.swing_trade_realizations to service_role;

drop trigger if exists swing_trade_realizations_set_updated_at on public.swing_trade_realizations;
create trigger swing_trade_realizations_set_updated_at
before update on public.swing_trade_realizations
for each row execute function public.set_updated_at();

create or replace function public.swing_daily_net_realized(
    p_user_id uuid,
    p_session date
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((
        select sum(r.net_pnl_inr)
        from public.swing_trade_realizations r
        where r.user_id = p_user_id and r.realized_on = p_session
    ), 0) + coalesce((
        select sum(t.realized_pnl_inr)
        from public.swing_trades t
        where t.user_id = p_user_id and t.trade_mode = 'live'
          and t.execution_source = 'manual' and t.status = 'closed'
          and t.exit_date = p_session
    ), 0);
$$;

create or replace function public.refresh_swing_trade_execution_accounting(
    p_user_id uuid,
    p_trade_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_trade public.swing_trades%rowtype;
    v_original integer := 0;
    v_closed integer := 0;
    v_entry_charges numeric := 0;
    v_gross numeric := 0;
    v_charges numeric := 0;
    v_net numeric := 0;
    v_exit_price numeric := null;
    v_exit_date date := null;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    select * into v_trade from public.swing_trades
    where id = p_trade_id and user_id = p_user_id for update;
    if not found or v_trade.execution_source not in ('gtt_assisted','assisted_live','live_auto') then return; end if;

    select coalesce(sum(f.quantity),0)
    into v_original
    from public.swing_broker_fills f
    join public.swing_broker_orders o on o.id = f.order_id and o.user_id = f.user_id
    join public.swing_order_intents i on i.id = o.intent_id and i.user_id = o.user_id
    where f.user_id = p_user_id and i.trade_id = p_trade_id and i.intent_purpose = 'entry';

    select coalesce(sum(o.charges_total_inr),0)
    into v_entry_charges
    from public.swing_broker_orders o
    join public.swing_order_intents i on i.id = o.intent_id and i.user_id = o.user_id
    where o.user_id = p_user_id and i.trade_id = p_trade_id and i.intent_purpose = 'entry';

    if v_original <= 0 then return; end if;

    insert into public.swing_trade_realizations(
        user_id, trade_id, broker_fill_id, execution_source, realized_on,
        quantity, entry_price, exit_price, gross_pnl_inr,
        entry_charges_allocated_inr, exit_charges_allocated_inr,
        net_pnl_inr, charges_status
    )
    select
        p_user_id, p_trade_id, f.id, v_trade.execution_source,
        (f.filled_at at time zone 'Asia/Kolkata')::date,
        f.quantity, v_trade.entry_price, f.price,
        (f.price - v_trade.entry_price) * f.quantity,
        v_entry_charges * f.quantity / greatest(v_original, 1),
        o.charges_total_inr * f.quantity / greatest(o.filled_quantity, 1),
        (f.price - v_trade.entry_price) * f.quantity
            - v_entry_charges * f.quantity / greatest(v_original, 1)
            - o.charges_total_inr * f.quantity / greatest(o.filled_quantity, 1),
        case when o.charges_status = 'broker_calculated' then 'broker_calculated'
             when o.charges_status = 'estimated' then 'estimated' else 'unavailable' end
    from public.swing_broker_fills f
    join public.swing_broker_orders o on o.id = f.order_id and o.user_id = f.user_id
    join public.swing_order_intents i on i.id = o.intent_id and i.user_id = o.user_id
    where f.user_id = p_user_id and i.trade_id = p_trade_id
      and i.intent_purpose in ('exit','protective_stop')
    on conflict(user_id, broker_fill_id) do update set
        quantity = excluded.quantity,
        entry_price = excluded.entry_price,
        exit_price = excluded.exit_price,
        gross_pnl_inr = excluded.gross_pnl_inr,
        entry_charges_allocated_inr = excluded.entry_charges_allocated_inr,
        exit_charges_allocated_inr = excluded.exit_charges_allocated_inr,
        net_pnl_inr = excluded.net_pnl_inr,
        charges_status = excluded.charges_status;

    select coalesce(sum(quantity),0), coalesce(sum(gross_pnl_inr),0),
           coalesce(sum(entry_charges_allocated_inr + exit_charges_allocated_inr),0),
           coalesce(sum(net_pnl_inr),0),
           sum(exit_price * quantity) / nullif(sum(quantity),0),
           max(realized_on)
    into v_closed, v_gross, v_charges, v_net, v_exit_price, v_exit_date
    from public.swing_trade_realizations
    where user_id = p_user_id and trade_id = p_trade_id;

    update public.swing_trades set
        original_quantity = v_original,
        open_quantity = greatest(v_original - v_closed, 0),
        status = case when v_closed >= v_original then 'closed' else status end,
        quantity = case when v_closed >= v_original
            then v_original else greatest(v_original - v_closed, 0) end,
        planned_risk_inr = initial_risk_per_share * case when v_closed >= v_original
            then v_original else greatest(v_original - v_closed, 0) end,
        gross_realized_pnl_inr = v_gross,
        broker_charges_inr = v_charges,
        net_realized_pnl_inr = v_net,
        fees_inr = v_charges,
        partial_exit_quantity = least(v_closed, v_original),
        partial_exit_realized_pnl_inr = case when v_closed < v_original then v_net else 0 end,
        exit_date = case when v_closed >= v_original then v_exit_date else exit_date end,
        exit_price = case when v_closed >= v_original then v_exit_price else exit_price end,
        unrealized_pnl_inr = case when v_closed >= v_original then null else unrealized_pnl_inr end,
        unrealized_r_multiple = case when v_closed >= v_original then null else unrealized_r_multiple end,
        realized_pnl_inr = case when v_closed >= v_original then v_net else null end,
        realized_r_multiple = case when v_closed >= v_original
            then v_net / greatest(initial_risk_per_share * v_original, 0.01)
            else null end
    where id = p_trade_id and user_id = p_user_id;
end;
$$;

-- Rename the previous recorder once, then wrap it with broker-calculated
-- charges and fill-level accounting. The underlying idempotent fill logic is
-- preserved.
do $$
begin
    if to_regprocedure('public.record_swing_broker_execution_pre_hardening_v1(uuid,text,jsonb)') is null
       and to_regprocedure('public.record_swing_broker_execution(uuid,text,jsonb)') is not null then
        execute 'alter function public.record_swing_broker_execution(uuid,text,jsonb) '
             || 'rename to record_swing_broker_execution_pre_hardening_v1';
    end if;
end;
$$;

create or replace function public.record_swing_broker_execution(
    p_user_id uuid,
    p_worker_id text,
    p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_result jsonb;
    v_trade_id uuid;
    v_order_id uuid;
    v_charges jsonb := coalesce(p_payload->'charges','{}'::jsonb);
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    v_result := public.record_swing_broker_execution_pre_hardening_v1(
        p_user_id, p_worker_id, p_payload
    );
    v_order_id := nullif(v_result->>'order_id','')::uuid;
    if v_order_id is not null then
        update public.swing_broker_orders set
            charges_total_inr = greatest(coalesce(nullif(v_charges->>'total','')::numeric, charges_total_inr), 0),
            charges_status = case when nullif(v_charges->>'total','') is not null
                then coalesce(nullif(p_payload->>'charges_status',''),'broker_calculated')
                else charges_status end,
            charges_breakdown = case when v_charges = '{}'::jsonb then charges_breakdown else v_charges end
        where id = v_order_id and user_id = p_user_id;
    end if;
    v_trade_id := nullif(v_result->>'trade_id','')::uuid;
    if v_trade_id is null then
        select trade_id into v_trade_id from public.swing_order_intents
        where id = nullif(p_payload->>'intent_id','')::uuid and user_id = p_user_id;
    end if;
    if v_trade_id is not null then
        perform public.refresh_swing_trade_execution_accounting(p_user_id, v_trade_id);
    end if;
    return v_result || jsonb_build_object(
        'charges_status', case when nullif(v_charges->>'total','') is not null
            then coalesce(nullif(p_payload->>'charges_status',''),'broker_calculated') else 'unavailable' end
    );
end;
$$;

create or replace function public.swing_entry_loss_gate_reason(
    p_user_id uuid,
    p_session date
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_limit numeric;
    v_realized numeric;
begin
    select live_daily_loss_limit_inr into v_limit
    from public.swing_automation_controls where user_id = p_user_id;
    if v_limit is null then return 'Swing execution controls are unavailable.'; end if;
    v_realized := public.swing_daily_net_realized(p_user_id, p_session);
    if v_realized <= -v_limit then
        return format('Daily net realized loss %s INR reached the %s INR new-entry lock.', round(v_realized,2), round(v_limit,2));
    end if;
    return null;
end;
$$;

create or replace function public.enforce_swing_entry_intent_safety()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_candidate public.swing_candidates%rowtype;
    v_controls public.swing_automation_controls%rowtype;
    v_risk_per_share numeric;
    v_risk_limit numeric;
    v_max_quantity integer;
    v_loss_reason text;
begin
    if new.intent_purpose <> 'entry'
       or new.automation_mode not in ('gtt_assisted','assisted_live','live_auto') then
        return new;
    end if;
    select * into v_candidate from public.swing_candidates
    where id = new.candidate_id and user_id = new.user_id;
    select * into v_controls from public.swing_automation_controls
    where user_id = new.user_id;
    if v_candidate.id is null or v_controls.user_id is null then
        raise exception 'Candidate and execution controls are required for a live entry.';
    end if;
    v_risk_per_share := coalesce(new.maximum_entry, new.limit_price) - v_candidate.initial_stop;
    if v_risk_per_share <= 0 then raise exception 'Maximum entry must remain above the initial stop.'; end if;
    v_risk_limit := v_controls.live_max_deployed_inr
        * v_controls.live_risk_per_trade_percentage / 100
        * case when v_candidate.market_regime = 'AMBER'
            then v_controls.live_amber_risk_multiplier else 1 end;
    v_max_quantity := least(
        new.quantity,
        floor(v_controls.live_max_deployed_inr / greatest(coalesce(new.maximum_entry,new.limit_price),0.01))::integer,
        floor(v_risk_limit / v_risk_per_share)::integer
    );
    if v_max_quantity < 1 then
        raise exception 'One share would exceed the maximum-fill stop-risk or deployment cap.';
    end if;
    new.quantity := v_max_quantity;
    new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
        'maximum_fill_risk_per_share', v_risk_per_share,
        'maximum_fill_planned_risk_inr', v_risk_per_share * v_max_quantity,
        'sized_at_maximum_entry', true
    );
    v_loss_reason := public.swing_entry_loss_gate_reason(new.user_id, new.nse_session);
    if v_loss_reason is not null then raise exception '%', v_loss_reason; end if;
    return new;
end;
$$;

drop trigger if exists swing_order_intents_entry_safety on public.swing_order_intents;
create trigger swing_order_intents_entry_safety
before insert on public.swing_order_intents
for each row execute function public.enforce_swing_entry_intent_safety();

create or replace function public.enforce_swing_entry_claim_safety()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_reason text;
begin
    if new.intent_purpose <> 'entry'
       or new.automation_mode not in ('gtt_assisted','assisted_live','live_auto')
       or new.status <> 'leased' or old.status = 'leased' then
        return new;
    end if;
    if exists (select 1 from public.swing_risk_control_activations
               where user_id = new.user_id and status = 'active') then
        raise exception 'An active execution risk lock blocks new entries.';
    end if;
    if not exists (select 1 from public.swing_reconciliation_runs
                   where user_id = new.user_id and reconciliation_status = 'matched'
                     and checked_at > now() - interval '10 minutes') then
        raise exception 'Fresh matched reconciliation is required when an entry is claimed.';
    end if;
    if not exists (select 1 from public.swing_broker_account_snapshots
                   where user_id = new.user_id and account_status = 'healthy'
                     and observed_at > now() - interval '10 minutes') then
        raise exception 'A fresh healthy broker account snapshot is required when an entry is claimed.';
    end if;
    v_reason := public.swing_entry_loss_gate_reason(new.user_id, new.nse_session);
    if v_reason is not null then raise exception '%', v_reason; end if;
    return new;
end;
$$;

drop trigger if exists swing_order_intents_claim_safety on public.swing_order_intents;
create trigger swing_order_intents_claim_safety
before update of status on public.swing_order_intents
for each row execute function public.enforce_swing_entry_claim_safety();

create or replace function public.claim_swing_reduce_only_exit(
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
    v_reconciliation public.swing_position_reconciliations%rowtype;
begin
    if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
    if p_max_mode not in ('assisted_live','live_auto') then raise exception 'Invalid worker execution ceiling.'; end if;
    if p_lease_seconds not between 10 and 120 then raise exception 'Invalid lease duration.'; end if;
    select * into v_controls from public.swing_automation_controls where user_id = p_user_id;
    if v_controls.user_id is null or not v_controls.broker_execution_enabled
       or v_controls.automation_mode not in ('assisted_live','live_auto') then return null; end if;
    if p_max_mode = 'assisted_live' and v_controls.automation_mode = 'live_auto' then return null; end if;
    select * into v_intent from public.swing_order_intents
    where user_id = p_user_id and automation_mode = v_controls.automation_mode
      and intent_purpose = 'exit' and status in ('pending','leased')
      and (status = 'pending' or lease_expires_at <= now())
      and (automation_mode = 'live_auto' or approval_status = 'approved')
    order by requested_at for update skip locked limit 1;
    if not found then return null; end if;
    select * into v_reconciliation from public.swing_position_reconciliations
    where user_id = p_user_id and trade_id = v_intent.trade_id
    order by checked_at desc limit 1;
    if not found or v_reconciliation.reconciliation_status <> 'matched'
       or v_reconciliation.checked_at <= now() - interval '10 minutes'
       or coalesce(v_reconciliation.broker_quantity,0) < v_intent.quantity then
        return jsonb_build_object(
            'blocked_reduce_only_exit', true,
            'intent_id', v_intent.id,
            'reason', 'Fresh matched broker-position evidence is required for a reduce-only exit.'
        );
    end if;
    update public.swing_order_intents set
        status = 'leased', lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        last_validated_at = now(),
        metadata = metadata || jsonb_build_object('reduce_only',true,'priority_claim',true)
    where id = v_intent.id;
    return to_jsonb(v_intent) || jsonb_build_object(
        'status','leased','lease_owner',p_worker_id,
        'lease_expires_at',now() + make_interval(secs => p_lease_seconds),
        'reduce_only',true
    );
end;
$$;

-- Manual entries must have deterministic trigger evidence. Broker-hosted and
-- quote-driven modes may continue to watch ready setups before the crossing.
do $$
begin
    if to_regprocedure('public.confirm_swing_entry_pre_trigger_guard_v1(uuid,date,numeric,integer,text,text)') is null
       and to_regprocedure('public.confirm_swing_entry(uuid,date,numeric,integer,text,text)') is not null then
        execute 'alter function public.confirm_swing_entry(uuid,date,numeric,integer,text,text) '
             || 'rename to confirm_swing_entry_pre_trigger_guard_v1';
    end if;
end;
$$;

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
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_status text;
begin
    if v_user_id is null then raise exception 'Authentication required.'; end if;
    select status into v_status from public.swing_candidates
    where id = p_candidate_id and user_id = v_user_id for update;
    if not found then raise exception 'Candidate not found.'; end if;
    if v_status <> 'triggered' then
        raise exception 'Manual entry requires a monitor-confirmed trigger. A ready setup is only a watchlist item.';
    end if;
    return public.confirm_swing_entry_pre_trigger_guard_v1(
        p_candidate_id, p_entry_date, p_entry_price, p_quantity, p_trade_mode, p_notes
    );
end;
$$;

revoke all on function public.reset_kite_broker_identity() from public, anon;
grant execute on function public.reset_kite_broker_identity() to authenticated;
revoke all on function public.confirm_swing_entry(uuid,date,numeric,integer,text,text) from public, anon;
grant execute on function public.confirm_swing_entry(uuid,date,numeric,integer,text,text) to authenticated;
revoke all on function public.claim_swing_reduce_only_exit(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.claim_swing_reduce_only_exit(uuid,text,text,integer) to service_role;
revoke all on function public.record_swing_broker_execution(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_swing_broker_execution(uuid,text,jsonb) to service_role;
revoke all on function public.refresh_swing_trade_execution_accounting(uuid,uuid) from public,anon,authenticated;
grant execute on function public.refresh_swing_trade_execution_accounting(uuid,uuid) to service_role;

-- Applying a safety migration must never leave execution armed.
update public.swing_automation_controls set
    automation_mode = 'advisory',
    new_entries_enabled = false,
    armed_nse_session = null,
    gtt_assisted_enabled = false,
    assisted_live_unlocked = false,
    live_auto_unlocked = false,
    broker_execution_enabled = false,
    locked_reason = 'Execution safety hardening was applied; behavioral validation and explicit rollout are required.';

insert into public.swing_execution_audit_events(
    user_id, actor_type, event_type, entity_type, entity_id, details
)
select user_id, 'system', 'execution_safety_hardening_applied', 'automation_controls', user_id::text,
       jsonb_build_object('migration','202608110001','execution_disarmed',true)
from public.swing_automation_controls;

commit;
