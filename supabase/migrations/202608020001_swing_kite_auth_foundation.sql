begin;

-- Swing Live Auto foundation. This migration deliberately creates no function
-- that can submit, modify, or cancel a broker order. Authentication and all
-- automation controls start fail-closed in advisory/disarmed mode.

create table if not exists public.kite_broker_connections (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    broker text not null default 'kite' check (broker = 'kite'),
    broker_user_id text,
    user_name text,
    connection_status text not null default 'disconnected'
        check (connection_status in ('disconnected', 'connected', 'expired', 'error')),
    connected_at timestamptz,
    last_validated_at timestamptz,
    session_expires_at timestamptz,
    disconnected_at timestamptz,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists kite_broker_connections_id_user_idx
    on public.kite_broker_connections(id, user_id);

-- Ciphertext is isolated from browser-readable connection metadata. There is
-- intentionally no authenticated RLS policy or table grant for this table.
create table if not exists public.kite_broker_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    connection_id uuid not null unique,
    encrypted_access_token text not null,
    encryption_iv text not null,
    encryption_auth_tag text not null,
    token_version integer not null default 1 check (token_version = 1),
    issued_at timestamptz not null,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (expires_at > issued_at),
    constraint kite_broker_sessions_connection_user_fk
        foreign key (connection_id, user_id)
        references public.kite_broker_connections(id, user_id)
        on delete cascade
);

-- Only a SHA-256 digest of the browser state nonce is stored. Attempts are
-- single-use, user-bound, and short-lived.
create table if not exists public.kite_auth_attempts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
    return_to text not null default '/swing-lab',
    expires_at timestamptz not null,
    consumed_at timestamptz,
    failure_reason text,
    created_at timestamptz not null default now()
);

create index if not exists kite_auth_attempts_user_created_idx
    on public.kite_auth_attempts(user_id, created_at desc);

create table if not exists public.swing_automation_controls (
    user_id uuid primary key references auth.users(id) on delete cascade,
    automation_mode text not null default 'advisory'
        check (automation_mode in ('advisory', 'paper_auto', 'assisted_live', 'live_auto')),
    new_entries_enabled boolean not null default false,
    armed_nse_session date,
    emergency_stop_active boolean not null default false,
    live_auto_unlocked boolean not null default false,
    locked_reason text not null default 'Live Auto is locked until every rollout gate passes.',
    updated_at timestamptz not null default now(),
    check (automation_mode <> 'live_auto' or live_auto_unlocked),
    check (new_entries_enabled = false or automation_mode <> 'advisory'),
    check (new_entries_enabled = false or emergency_stop_active = false)
);

insert into public.swing_automation_controls(user_id)
select id from auth.users
on conflict (user_id) do nothing;

create unique index if not exists swing_candidates_id_user_idx
    on public.swing_candidates(id, user_id);
create unique index if not exists swing_trades_id_user_idx
    on public.swing_trades(id, user_id);

create table if not exists public.swing_order_intents (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    candidate_id uuid,
    trade_id uuid,
    intent_key text not null,
    intent_purpose text not null
        check (intent_purpose in ('entry', 'exit', 'protective_stop', 'replace_stop', 'cancel')),
    automation_mode text not null
        check (automation_mode in ('paper_auto', 'assisted_live', 'live_auto')),
    status text not null default 'pending'
        check (status in ('pending', 'leased', 'validated', 'submitted', 'partially_filled', 'filled', 'cancelled', 'rejected', 'blocked', 'failed')),
    strategy_model_version text not null,
    execution_policy_version text not null,
    nse_session date not null,
    exchange text not null default 'NSE' check (exchange = 'NSE'),
    product text not null default 'CNC' check (product = 'CNC'),
    symbol text not null,
    transaction_type text not null check (transaction_type in ('BUY', 'SELL')),
    order_type text not null check (order_type in ('LIMIT', 'MARKET', 'SL', 'SL-M')),
    quantity integer not null check (quantity > 0),
    limit_price numeric(18, 4),
    trigger_price numeric(18, 4),
    maximum_entry numeric(18, 4),
    requested_at timestamptz not null default now(),
    completed_at timestamptz,
    failure_reason text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, intent_key),
    check (limit_price is null or limit_price > 0),
    check (trigger_price is null or trigger_price > 0),
    check (maximum_entry is null or maximum_entry > 0),
    constraint swing_order_intents_candidate_user_fk
        foreign key (candidate_id, user_id)
        references public.swing_candidates(id, user_id)
        on delete set null (candidate_id),
    constraint swing_order_intents_trade_user_fk
        foreign key (trade_id, user_id)
        references public.swing_trades(id, user_id)
        on delete set null (trade_id)
);

create index if not exists swing_order_intents_user_status_idx
    on public.swing_order_intents(user_id, status, requested_at desc);
create unique index if not exists swing_order_intents_id_user_idx
    on public.swing_order_intents(id, user_id);

create table if not exists public.swing_broker_orders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    intent_id uuid not null,
    broker text not null default 'kite' check (broker = 'kite'),
    broker_order_id text not null,
    status text not null,
    exchange_order_id text,
    quantity integer not null check (quantity > 0),
    filled_quantity integer not null default 0 check (filled_quantity >= 0 and filled_quantity <= quantity),
    pending_quantity integer not null default 0 check (pending_quantity >= 0 and pending_quantity <= quantity),
    average_price numeric(18, 4),
    limit_price numeric(18, 4),
    trigger_price numeric(18, 4),
    status_message text,
    placed_at timestamptz,
    exchange_updated_at timestamptz,
    raw_snapshot jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, broker_order_id),
    constraint swing_broker_orders_intent_user_fk
        foreign key (intent_id, user_id)
        references public.swing_order_intents(id, user_id)
        on delete cascade
);

create index if not exists swing_broker_orders_user_intent_idx
    on public.swing_broker_orders(user_id, intent_id, created_at desc);
create unique index if not exists swing_broker_orders_id_user_idx
    on public.swing_broker_orders(id, user_id);

create table if not exists public.swing_broker_fills (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    order_id uuid not null,
    broker_trade_id text not null,
    quantity integer not null check (quantity > 0),
    price numeric(18, 4) not null check (price > 0),
    filled_at timestamptz not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (user_id, broker_trade_id),
    constraint swing_broker_fills_order_user_fk
        foreign key (order_id, user_id)
        references public.swing_broker_orders(id, user_id)
        on delete cascade
);

create table if not exists public.swing_protective_orders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    trade_id uuid not null,
    entry_order_id uuid,
    broker_trigger_id text,
    protection_type text not null check (protection_type in ('regular_stop', 'gtt_stop', 'gtt_oco')),
    status text not null default 'pending'
        check (status in ('pending', 'active', 'triggered', 'completed', 'cancelled', 'rejected', 'failed')),
    protected_quantity integer not null check (protected_quantity > 0),
    trigger_price numeric(18, 4) not null check (trigger_price > 0),
    limit_price numeric(18, 4),
    highest_protected_stop numeric(18, 4) not null check (highest_protected_stop > 0),
    last_verified_at timestamptz,
    failure_reason text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (limit_price is null or limit_price > 0),
    check (trigger_price >= highest_protected_stop),
    constraint swing_protective_orders_trade_user_fk
        foreign key (trade_id, user_id)
        references public.swing_trades(id, user_id)
        on delete cascade,
    constraint swing_protective_orders_entry_order_user_fk
        foreign key (entry_order_id, user_id)
        references public.swing_broker_orders(id, user_id)
        on delete set null (entry_order_id)
);

create index if not exists swing_protective_orders_user_trade_idx
    on public.swing_protective_orders(user_id, trade_id, created_at desc);

create table if not exists public.swing_position_reconciliations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    trade_id uuid,
    symbol text not null,
    reconciliation_status text not null
        check (reconciliation_status in ('matched', 'mismatch', 'blocked', 'unavailable')),
    tracker_quantity integer,
    broker_quantity integer,
    tracker_average_price numeric(18, 4),
    broker_average_price numeric(18, 4),
    checked_at timestamptz not null default now(),
    resolved_at timestamptz,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint swing_position_reconciliations_trade_user_fk
        foreign key (trade_id, user_id)
        references public.swing_trades(id, user_id)
        on delete set null (trade_id)
);

create index if not exists swing_position_reconciliations_user_checked_idx
    on public.swing_position_reconciliations(user_id, checked_at desc);

create table if not exists public.swing_worker_heartbeats (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    worker_id text not null,
    worker_version text not null,
    execution_policy_version text,
    observed_public_ip inet,
    worker_status text not null
        check (worker_status in ('starting', 'healthy', 'degraded', 'blocked', 'stopping')),
    execution_mode text not null default 'observe'
        check (execution_mode in ('observe', 'paper_auto', 'assisted_live', 'live_auto')),
    kite_session_healthy boolean not null default false,
    quote_stream_healthy boolean not null default false,
    reconciliation_healthy boolean not null default false,
    heartbeat_at timestamptz not null default now(),
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists swing_worker_heartbeats_user_time_idx
    on public.swing_worker_heartbeats(user_id, heartbeat_at desc);

create table if not exists public.swing_risk_control_activations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    control_type text not null
        check (control_type in ('emergency_stop', 'daily_loss', 'drawdown', 'stale_quote', 'session_invalid', 'reconciliation', 'protective_order', 'funds', 'corporate_action')),
    status text not null default 'active' check (status in ('active', 'cleared')),
    reason text not null,
    activated_at timestamptz not null default now(),
    cleared_at timestamptz,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists swing_risk_control_activations_user_status_idx
    on public.swing_risk_control_activations(user_id, status, activated_at desc);

create table if not exists public.swing_execution_audit_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    actor_type text not null check (actor_type in ('user', 'tracker', 'worker', 'kite', 'system')),
    event_type text not null,
    entity_type text,
    entity_id text,
    occurred_at timestamptz not null default now(),
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists swing_execution_audit_events_user_time_idx
    on public.swing_execution_audit_events(user_id, occurred_at desc);

create table if not exists public.swing_processing_leases (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    lease_key text not null,
    holder_id text not null,
    acquired_at timestamptz not null default now(),
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, lease_key),
    check (expires_at > acquired_at)
);

do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'kite_broker_connections', 'kite_broker_sessions', 'kite_auth_attempts',
        'swing_automation_controls', 'swing_order_intents', 'swing_broker_orders',
        'swing_broker_fills', 'swing_protective_orders',
        'swing_position_reconciliations', 'swing_worker_heartbeats',
        'swing_risk_control_activations', 'swing_execution_audit_events',
        'swing_processing_leases'
    ] loop
        execute format('alter table public.%I enable row level security', v_table);
    end loop;
end;
$$;

-- Browser users may read only non-secret operational records belonging to
-- themselves. All writes go through narrowly scoped RPCs or service_role.
do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'kite_broker_connections', 'swing_automation_controls',
        'swing_order_intents', 'swing_broker_orders', 'swing_broker_fills',
        'swing_protective_orders', 'swing_position_reconciliations',
        'swing_worker_heartbeats', 'swing_risk_control_activations',
        'swing_execution_audit_events', 'swing_processing_leases'
    ] loop
        execute format('drop policy if exists "Users view their %1$s" on public.%1$I', v_table);
        execute format(
            'create policy "Users view their %1$s" on public.%1$I for select using (auth.uid() = user_id)',
            v_table
        );
    end loop;
end;
$$;

do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'kite_broker_connections', 'kite_broker_sessions',
        'swing_automation_controls', 'swing_order_intents',
        'swing_broker_orders', 'swing_protective_orders',
        'swing_processing_leases'
    ] loop
        execute format('drop trigger if exists %1$s_set_updated_at on public.%1$I', v_table);
        execute format(
            'create trigger %1$s_set_updated_at before update on public.%1$I for each row execute function public.set_updated_at()',
            v_table
        );
    end loop;
end;
$$;

create or replace function public.begin_kite_auth_attempt(
    p_state_hash text,
    p_return_to text,
    p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_attempt_id uuid;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;
    if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid Kite authentication state.';
    end if;
    if p_return_to is null
       or length(p_return_to) > 200
       or left(p_return_to, 1) <> '/'
       or left(p_return_to, 2) = '//' then
        raise exception 'Invalid Kite authentication return path.';
    end if;
    if p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
        raise exception 'Kite authentication expiry must be within 15 minutes.';
    end if;

    delete from public.kite_auth_attempts
    where user_id = v_user_id
      and (expires_at < now() - interval '1 day' or consumed_at is not null);

    insert into public.kite_auth_attempts(user_id, state_hash, return_to, expires_at)
    values (v_user_id, p_state_hash, p_return_to, p_expires_at)
    returning id into v_attempt_id;

    return v_attempt_id;
end;
$$;

create or replace function public.complete_kite_auth_attempt(
    p_state_hash text,
    p_broker_user_id text,
    p_user_name text,
    p_encrypted_access_token text,
    p_encryption_iv text,
    p_encryption_auth_tag text,
    p_token_version integer,
    p_issued_at timestamptz,
    p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_attempt public.kite_auth_attempts%rowtype;
    v_connection_id uuid;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;
    if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid Kite authentication state.';
    end if;

    select * into v_attempt
    from public.kite_auth_attempts
    where user_id = v_user_id and state_hash = p_state_hash
    for update;

    if not found then
        raise exception 'Kite authentication attempt was not found.';
    end if;
    if v_attempt.consumed_at is not null then
        raise exception 'Kite authentication attempt was already used.';
    end if;
    if v_attempt.expires_at <= now() then
        raise exception 'Kite authentication attempt expired.';
    end if;
    if nullif(trim(p_broker_user_id), '') is null
       or nullif(p_encrypted_access_token, '') is null
       or nullif(p_encryption_iv, '') is null
       or nullif(p_encryption_auth_tag, '') is null
       or p_token_version <> 1 then
        raise exception 'Incomplete encrypted Kite session.';
    end if;
    if p_issued_at > now() + interval '1 minute'
       or p_expires_at <= now()
       or p_expires_at > now() + interval '2 days' then
        raise exception 'Invalid Kite session validity.';
    end if;

    insert into public.kite_broker_connections(
        user_id, broker_user_id, user_name, connection_status,
        connected_at, last_validated_at, session_expires_at,
        disconnected_at, error_message
    ) values (
        v_user_id, trim(p_broker_user_id), nullif(trim(p_user_name), ''), 'connected',
        p_issued_at, p_issued_at, p_expires_at, null, null
    )
    on conflict (user_id) do update set
        broker_user_id = excluded.broker_user_id,
        user_name = excluded.user_name,
        connection_status = 'connected',
        connected_at = excluded.connected_at,
        last_validated_at = excluded.last_validated_at,
        session_expires_at = excluded.session_expires_at,
        disconnected_at = null,
        error_message = null
    returning id into v_connection_id;

    insert into public.kite_broker_sessions(
        user_id, connection_id, encrypted_access_token, encryption_iv,
        encryption_auth_tag, token_version, issued_at, expires_at, revoked_at
    ) values (
        v_user_id, v_connection_id, p_encrypted_access_token, p_encryption_iv,
        p_encryption_auth_tag, p_token_version, p_issued_at, p_expires_at, null
    )
    on conflict (user_id) do update set
        connection_id = excluded.connection_id,
        encrypted_access_token = excluded.encrypted_access_token,
        encryption_iv = excluded.encryption_iv,
        encryption_auth_tag = excluded.encryption_auth_tag,
        token_version = excluded.token_version,
        issued_at = excluded.issued_at,
        expires_at = excluded.expires_at,
        revoked_at = null;

    insert into public.swing_automation_controls(user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;

    update public.kite_auth_attempts
    set consumed_at = now(), failure_reason = null
    where id = v_attempt.id;

    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'tracker', 'kite_session_connected', 'kite_connection', v_connection_id::text,
        jsonb_build_object('broker_user_id', trim(p_broker_user_id), 'expires_at', p_expires_at)
    );
end;
$$;

create or replace function public.fail_kite_auth_attempt(
    p_state_hash text,
    p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_attempt_id uuid;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;
    if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid Kite authentication state.';
    end if;

    update public.kite_auth_attempts
    set consumed_at = now(),
        failure_reason = left(coalesce(nullif(trim(p_reason), ''), 'Kite login did not complete.'), 500)
    where user_id = v_user_id
      and state_hash = p_state_hash
      and consumed_at is null
    returning id into v_attempt_id;

    if v_attempt_id is not null then
        insert into public.swing_execution_audit_events(
            user_id, actor_type, event_type, entity_type, entity_id, details
        ) values (
            v_user_id, 'tracker', 'kite_authentication_failed', 'kite_auth_attempt', v_attempt_id::text,
            jsonb_build_object('reason', left(coalesce(nullif(trim(p_reason), ''), 'Kite login did not complete.'), 500))
        );
    end if;
end;
$$;

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
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;

    select id into v_connection_id
    from public.kite_broker_connections
    where user_id = v_user_id
    for update;

    delete from public.kite_broker_sessions where user_id = v_user_id;

    update public.kite_broker_connections
    set connection_status = 'disconnected',
        session_expires_at = null,
        disconnected_at = now(),
        error_message = null
    where user_id = v_user_id;

    insert into public.swing_automation_controls(user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;

    update public.swing_automation_controls
    set automation_mode = 'advisory',
        new_entries_enabled = false,
        armed_nse_session = null
    where user_id = v_user_id;

    insert into public.swing_execution_audit_events(
        user_id, actor_type, event_type, entity_type, entity_id, details
    ) values (
        v_user_id, 'user', 'kite_session_disconnected', 'kite_connection', v_connection_id::text,
        '{}'::jsonb
    );
end;
$$;

create or replace function public.get_kite_connection_status()
returns table (
    connection_status text,
    broker_user_id text,
    user_name text,
    connected_at timestamptz,
    last_validated_at timestamptz,
    session_expires_at timestamptz,
    disconnected_at timestamptz,
    error_message text,
    has_active_session boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;

    return query
    select
        case
            when c.id is null then 'disconnected'::text
            when s.id is null then 'disconnected'::text
            when s.revoked_at is not null then 'disconnected'::text
            when s.expires_at <= now() then 'expired'::text
            else c.connection_status
        end,
        c.broker_user_id,
        c.user_name,
        c.connected_at,
        c.last_validated_at,
        s.expires_at,
        c.disconnected_at,
        c.error_message,
        coalesce(s.revoked_at is null and s.expires_at > now(), false)
    from (select 1) seed
    left join public.kite_broker_connections c on c.user_id = v_user_id
    left join public.kite_broker_sessions s on s.user_id = v_user_id;
end;
$$;

revoke all on table public.kite_auth_attempts from public, anon, authenticated;
revoke all on table public.kite_broker_sessions from public, anon, authenticated;

grant select on table public.kite_broker_connections to authenticated;
grant select on table public.swing_automation_controls to authenticated;
grant select on table public.swing_order_intents to authenticated;
grant select on table public.swing_broker_orders to authenticated;
grant select on table public.swing_broker_fills to authenticated;
grant select on table public.swing_protective_orders to authenticated;
grant select on table public.swing_position_reconciliations to authenticated;
grant select on table public.swing_worker_heartbeats to authenticated;
grant select on table public.swing_risk_control_activations to authenticated;
grant select on table public.swing_execution_audit_events to authenticated;
grant select on table public.swing_processing_leases to authenticated;

grant select, insert, update, delete on table public.kite_broker_connections to service_role;
grant select, insert, update, delete on table public.kite_broker_sessions to service_role;
grant select, insert, update, delete on table public.kite_auth_attempts to service_role;
grant select, insert, update, delete on table public.swing_automation_controls to service_role;
grant select, insert, update, delete on table public.swing_order_intents to service_role;
grant select, insert, update, delete on table public.swing_broker_orders to service_role;
grant select, insert, update, delete on table public.swing_broker_fills to service_role;
grant select, insert, update, delete on table public.swing_protective_orders to service_role;
grant select, insert, update, delete on table public.swing_position_reconciliations to service_role;
grant select, insert, update, delete on table public.swing_worker_heartbeats to service_role;
grant select, insert, update, delete on table public.swing_risk_control_activations to service_role;
grant select, insert, update, delete on table public.swing_execution_audit_events to service_role;
grant select, insert, update, delete on table public.swing_processing_leases to service_role;

revoke all on function public.begin_kite_auth_attempt(text, text, timestamptz) from public, anon;
revoke all on function public.complete_kite_auth_attempt(text, text, text, text, text, text, integer, timestamptz, timestamptz) from public, anon;
revoke all on function public.fail_kite_auth_attempt(text, text) from public, anon;
revoke all on function public.disconnect_kite_account() from public, anon;
revoke all on function public.get_kite_connection_status() from public, anon;

grant execute on function public.begin_kite_auth_attempt(text, text, timestamptz) to authenticated;
grant execute on function public.complete_kite_auth_attempt(text, text, text, text, text, text, integer, timestamptz, timestamptz) to authenticated;
grant execute on function public.fail_kite_auth_attempt(text, text) to authenticated;
grant execute on function public.disconnect_kite_account() to authenticated;
grant execute on function public.get_kite_connection_status() to authenticated;

commit;
