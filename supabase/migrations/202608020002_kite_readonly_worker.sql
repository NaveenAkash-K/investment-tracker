begin;

-- Batch 2: persistent, read-only Kite worker observations. This migration
-- deliberately defines no broker-order function and keeps all automation
-- controls disarmed.

create table if not exists public.swing_broker_account_snapshots (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    worker_id text not null,
    observed_at timestamptz not null,
    broker_user_id text not null,
    account_status text not null
        check (account_status in ('healthy', 'degraded', 'blocked', 'error')),
    available_cash numeric(18, 2),
    utilised_debits numeric(18, 2),
    net_equity numeric(18, 2),
    holdings_count integer not null default 0 check (holdings_count >= 0),
    positions_count integer not null default 0 check (positions_count >= 0),
    orders_count integer not null default 0 check (orders_count >= 0),
    trades_count integer not null default 0 check (trades_count >= 0),
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists swing_broker_account_snapshots_user_time_idx
    on public.swing_broker_account_snapshots(user_id, observed_at desc);
create unique index if not exists swing_broker_account_snapshots_user_worker_idx
    on public.swing_broker_account_snapshots(user_id, worker_id);

create table if not exists public.swing_reconciliation_runs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    worker_id text not null,
    reconciliation_status text not null
        check (reconciliation_status in ('matched', 'mismatch', 'unavailable', 'error')),
    tracker_positions integer not null default 0 check (tracker_positions >= 0),
    broker_positions integer not null default 0 check (broker_positions >= 0),
    matched_positions integer not null default 0 check (matched_positions >= 0),
    mismatch_positions integer not null default 0 check (mismatch_positions >= 0),
    broker_only_positions integer not null default 0 check (broker_only_positions >= 0),
    checked_at timestamptz not null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    check (matched_positions + mismatch_positions <= tracker_positions)
);

create unique index if not exists swing_reconciliation_runs_id_user_idx
    on public.swing_reconciliation_runs(id, user_id);
create index if not exists swing_reconciliation_runs_user_time_idx
    on public.swing_reconciliation_runs(user_id, checked_at desc);
create unique index if not exists swing_reconciliation_runs_user_worker_idx
    on public.swing_reconciliation_runs(user_id, worker_id);

alter table public.swing_position_reconciliations
    add column if not exists reconciliation_run_id uuid;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'swing_position_reconciliations_run_user_fk'
    ) then
        alter table public.swing_position_reconciliations
            add constraint swing_position_reconciliations_run_user_fk
            foreign key (reconciliation_run_id, user_id)
            references public.swing_reconciliation_runs(id, user_id)
            on delete cascade;
    end if;
end;
$$;

-- One row per worker is updated in place. A five-minute daemon must not create
-- hundreds of thousands of heartbeat rows over time.
with ranked as (
    select id, row_number() over (
        partition by user_id, worker_id
        order by heartbeat_at desc, created_at desc, id desc
    ) as row_number
    from public.swing_worker_heartbeats
)
delete from public.swing_worker_heartbeats heartbeat
using ranked
where heartbeat.id = ranked.id and ranked.row_number > 1;

create unique index if not exists swing_worker_heartbeats_user_worker_idx
    on public.swing_worker_heartbeats(user_id, worker_id);

alter table public.swing_broker_account_snapshots enable row level security;
alter table public.swing_reconciliation_runs enable row level security;

drop policy if exists "Users view their swing_broker_account_snapshots"
    on public.swing_broker_account_snapshots;
create policy "Users view their swing_broker_account_snapshots"
    on public.swing_broker_account_snapshots for select
    using (auth.uid() = user_id);

drop policy if exists "Users view their swing_reconciliation_runs"
    on public.swing_reconciliation_runs;
create policy "Users view their swing_reconciliation_runs"
    on public.swing_reconciliation_runs for select
    using (auth.uid() = user_id);

create or replace function public.get_kite_worker_bootstrap(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_connection public.kite_broker_connections%rowtype;
    v_session public.kite_broker_sessions%rowtype;
    v_controls public.swing_automation_controls%rowtype;
begin
    if auth.role() <> 'service_role' then
        raise exception 'Service role required.';
    end if;

    select * into v_connection
    from public.kite_broker_connections
    where user_id = p_user_id;

    select * into v_session
    from public.kite_broker_sessions
    where user_id = p_user_id;

    select * into v_controls
    from public.swing_automation_controls
    where user_id = p_user_id;

    return jsonb_build_object(
        'connection', case when v_connection.id is null then null else jsonb_build_object(
            'id', v_connection.id,
            'status', v_connection.connection_status,
            'broker_user_id', v_connection.broker_user_id,
            'session_expires_at', v_connection.session_expires_at
        ) end,
        'session', case
            when v_session.id is null or v_session.revoked_at is not null then null
            else jsonb_build_object(
                'ciphertext', v_session.encrypted_access_token,
                'iv', v_session.encryption_iv,
                'auth_tag', v_session.encryption_auth_tag,
                'version', v_session.token_version,
                'issued_at', v_session.issued_at,
                'expires_at', v_session.expires_at
            )
        end,
        'controls', jsonb_build_object(
            'automation_mode', coalesce(v_controls.automation_mode, 'advisory'),
            'new_entries_enabled', coalesce(v_controls.new_entries_enabled, false),
            'emergency_stop_active', coalesce(v_controls.emergency_stop_active, false),
            'live_auto_unlocked', coalesce(v_controls.live_auto_unlocked, false)
        )
    );
end;
$$;

create or replace function public.publish_kite_readonly_cycle(
    p_user_id uuid,
    p_cycle jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_worker_id text := nullif(trim(p_cycle->>'worker_id'), '');
    v_worker_version text := nullif(trim(p_cycle->>'worker_version'), '');
    v_observed_at timestamptz := coalesce(nullif(p_cycle->>'observed_at', '')::timestamptz, now());
    v_worker_status text := coalesce(nullif(p_cycle->>'worker_status', ''), 'blocked');
    v_connection_status text := coalesce(nullif(p_cycle->>'connection_status', ''), 'error');
    v_account jsonb := p_cycle->'account';
    v_reconciliation jsonb := p_cycle->'reconciliation';
    v_reconciliation_id uuid;
    v_row jsonb;
    v_trade_id uuid;
    v_previous_worker_status text;
    v_previous_reconciliation_status text;
begin
    if auth.role() <> 'service_role' then
        raise exception 'Service role required.';
    end if;
    if v_worker_id is null or v_worker_id !~ '^[A-Za-z0-9._:-]{3,100}$' then
        raise exception 'Invalid worker id.';
    end if;
    if v_worker_version is null or length(v_worker_version) > 50 then
        raise exception 'Invalid worker version.';
    end if;
    if v_worker_status not in ('starting', 'healthy', 'degraded', 'blocked', 'stopping') then
        raise exception 'Invalid worker status.';
    end if;
    if v_connection_status not in ('disconnected', 'connected', 'expired', 'error') then
        raise exception 'Invalid connection status.';
    end if;
    if coalesce(p_cycle->>'execution_mode', 'observe') <> 'observe' then
        raise exception 'Batch 2 accepts observe mode only.';
    end if;
    if v_observed_at > now() + interval '5 minutes'
       or v_observed_at < now() - interval '1 day' then
        raise exception 'Invalid worker observation time.';
    end if;

    select worker_status into v_previous_worker_status
    from public.swing_worker_heartbeats
    where user_id = p_user_id and worker_id = v_worker_id;

    select reconciliation_status into v_previous_reconciliation_status
    from public.swing_reconciliation_runs
    where user_id = p_user_id
    order by checked_at desc
    limit 1;

    insert into public.swing_worker_heartbeats(
        user_id, worker_id, worker_version, execution_policy_version,
        observed_public_ip, worker_status, execution_mode,
        kite_session_healthy, quote_stream_healthy,
        reconciliation_healthy, heartbeat_at, details
    ) values (
        p_user_id, v_worker_id, v_worker_version,
        nullif(p_cycle->>'execution_policy_version', ''),
        nullif(p_cycle->>'observed_public_ip', '')::inet,
        v_worker_status, 'observe',
        coalesce((p_cycle->>'kite_session_healthy')::boolean, false),
        false,
        coalesce((p_cycle->>'reconciliation_healthy')::boolean, false),
        v_observed_at, coalesce(p_cycle->'details', '{}'::jsonb)
    )
    on conflict (user_id, worker_id) do update set
        worker_version = excluded.worker_version,
        execution_policy_version = excluded.execution_policy_version,
        observed_public_ip = excluded.observed_public_ip,
        worker_status = excluded.worker_status,
        execution_mode = 'observe',
        kite_session_healthy = excluded.kite_session_healthy,
        quote_stream_healthy = false,
        reconciliation_healthy = excluded.reconciliation_healthy,
        heartbeat_at = excluded.heartbeat_at,
        details = excluded.details;

    update public.kite_broker_connections
    set connection_status = v_connection_status,
        last_validated_at = case
            when coalesce((p_cycle->>'kite_session_healthy')::boolean, false)
            then v_observed_at else last_validated_at end,
        error_message = case
            when v_connection_status = 'connected' then null
            else left(coalesce(nullif(p_cycle->>'error_message', ''), 'Kite worker validation failed.'), 500)
        end
    where user_id = p_user_id;

    if jsonb_typeof(v_account) = 'object' then
        insert into public.swing_broker_account_snapshots(
            user_id, worker_id, observed_at, broker_user_id, account_status,
            available_cash, utilised_debits, net_equity, holdings_count,
            positions_count, orders_count, trades_count, details
        ) values (
            p_user_id, v_worker_id, v_observed_at,
            nullif(trim(v_account->>'broker_user_id'), ''),
            coalesce(nullif(v_account->>'status', ''), 'error'),
            nullif(v_account->>'available_cash', '')::numeric,
            nullif(v_account->>'utilised_debits', '')::numeric,
            nullif(v_account->>'net_equity', '')::numeric,
            coalesce((v_account->>'holdings_count')::integer, 0),
            coalesce((v_account->>'positions_count')::integer, 0),
            coalesce((v_account->>'orders_count')::integer, 0),
            coalesce((v_account->>'trades_count')::integer, 0),
            coalesce(v_account->'details', '{}'::jsonb)
        )
        on conflict (user_id, worker_id) do update set
            observed_at = excluded.observed_at,
            broker_user_id = excluded.broker_user_id,
            account_status = excluded.account_status,
            available_cash = excluded.available_cash,
            utilised_debits = excluded.utilised_debits,
            net_equity = excluded.net_equity,
            holdings_count = excluded.holdings_count,
            positions_count = excluded.positions_count,
            orders_count = excluded.orders_count,
            trades_count = excluded.trades_count,
            details = excluded.details;
    end if;

    if jsonb_typeof(v_reconciliation) = 'object' then
        insert into public.swing_reconciliation_runs(
            user_id, worker_id, reconciliation_status, tracker_positions,
            broker_positions, matched_positions, mismatch_positions,
            broker_only_positions, checked_at, details
        ) values (
            p_user_id, v_worker_id,
            coalesce(nullif(v_reconciliation->>'status', ''), 'error'),
            coalesce((v_reconciliation->>'tracker_positions')::integer, 0),
            coalesce((v_reconciliation->>'broker_positions')::integer, 0),
            coalesce((v_reconciliation->>'matched_positions')::integer, 0),
            coalesce((v_reconciliation->>'mismatch_positions')::integer, 0),
            coalesce((v_reconciliation->>'broker_only_positions')::integer, 0),
            v_observed_at,
            coalesce(v_reconciliation->'details', '{}'::jsonb)
        )
        on conflict (user_id, worker_id) do update set
            reconciliation_status = excluded.reconciliation_status,
            tracker_positions = excluded.tracker_positions,
            broker_positions = excluded.broker_positions,
            matched_positions = excluded.matched_positions,
            mismatch_positions = excluded.mismatch_positions,
            broker_only_positions = excluded.broker_only_positions,
            checked_at = excluded.checked_at,
            details = excluded.details
        returning id into v_reconciliation_id;

        delete from public.swing_position_reconciliations
        where user_id = p_user_id and reconciliation_run_id = v_reconciliation_id;

        for v_row in
            select value from jsonb_array_elements(coalesce(v_reconciliation->'rows', '[]'::jsonb))
        loop
            v_trade_id := nullif(v_row->>'trade_id', '')::uuid;
            if v_trade_id is not null and not exists (
                select 1 from public.swing_trades
                where id = v_trade_id and user_id = p_user_id
            ) then
                raise exception 'Reconciliation references an unknown trade.';
            end if;

            insert into public.swing_position_reconciliations(
                user_id, trade_id, reconciliation_run_id, symbol,
                reconciliation_status, tracker_quantity, broker_quantity,
                tracker_average_price, broker_average_price, checked_at, details
            ) values (
                p_user_id, v_trade_id, v_reconciliation_id,
                upper(nullif(trim(v_row->>'symbol'), '')),
                coalesce(nullif(v_row->>'status', ''), 'unavailable'),
                nullif(v_row->>'tracker_quantity', '')::integer,
                nullif(v_row->>'broker_quantity', '')::integer,
                nullif(v_row->>'tracker_average_price', '')::numeric,
                nullif(v_row->>'broker_average_price', '')::numeric,
                v_observed_at, coalesce(v_row->'details', '{}'::jsonb)
            );
        end loop;
    end if;

    if (v_worker_status <> 'healthy'
        or coalesce(v_reconciliation->>'status', 'unavailable') <> 'matched')
       and (
           v_previous_worker_status is distinct from v_worker_status
           or v_previous_reconciliation_status is distinct from coalesce(v_reconciliation->>'status', 'unavailable')
       ) then
        insert into public.swing_execution_audit_events(
            user_id, actor_type, event_type, entity_type, entity_id, details
        ) values (
            p_user_id, 'worker', 'kite_readonly_cycle_attention',
            'worker', v_worker_id,
            jsonb_build_object(
                'worker_status', v_worker_status,
                'connection_status', v_connection_status,
                'reconciliation_status', v_reconciliation->>'status',
                'error_message', nullif(p_cycle->>'error_message', '')
            )
        );
    end if;

    return v_reconciliation_id;
end;
$$;

grant select on table public.swing_broker_account_snapshots to authenticated;
grant select on table public.swing_reconciliation_runs to authenticated;
grant select, insert, update, delete on table public.swing_broker_account_snapshots to service_role;
grant select, insert, update, delete on table public.swing_reconciliation_runs to service_role;

revoke all on function public.get_kite_worker_bootstrap(uuid) from public, anon, authenticated;
revoke all on function public.publish_kite_readonly_cycle(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.get_kite_worker_bootstrap(uuid) to service_role;
grant execute on function public.publish_kite_readonly_cycle(uuid, jsonb) to service_role;

commit;
