begin;

-- R-01: distinguish records requested by the monitor from records actually
-- evaluated using fresh intraday data.
alter table public.swing_monitor_runs
    add column if not exists candidates_requested integer not null default 0,
    add column if not exists positions_requested integer not null default 0,
    add column if not exists candidates_evaluated integer not null default 0,
    add column if not exists positions_evaluated integer not null default 0,
    add column if not exists failed_candidate_ids jsonb not null default '[]'::jsonb,
    add column if not exists failed_trade_ids jsonb not null default '[]'::jsonb;

update public.swing_monitor_runs
set candidates_requested = candidates_checked,
    positions_requested = positions_checked,
    candidates_evaluated = candidates_checked,
    positions_evaluated = positions_checked
where candidates_requested = 0
  and positions_requested = 0
  and candidates_evaluated = 0
  and positions_evaluated = 0
  and (candidates_checked > 0 or positions_checked > 0);

create or replace function public.ingest_swing_lab_monitor(p_user_id uuid, p_monitor jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_version text;
begin
    v_version := public.validate_analyzer_contract(p_monitor, 'swing_monitor');

    if jsonb_typeof(coalesce(p_monitor->'failed_candidate_ids', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(p_monitor->'failed_trade_ids', '[]'::jsonb)) <> 'array' then
        raise exception 'Swing monitor failed-record identifiers must be arrays.';
    end if;

    perform public.ingest_swing_lab_monitor_v2(p_user_id, p_monitor);

    update public.swing_monitor_runs
    set contract_version = v_version,
        candidates_requested = coalesce(
            nullif(p_monitor->>'candidates_requested', '')::integer,
            nullif(p_monitor->>'candidates_checked', '')::integer,
            0
        ),
        positions_requested = coalesce(
            nullif(p_monitor->>'positions_requested', '')::integer,
            nullif(p_monitor->>'positions_checked', '')::integer,
            0
        ),
        candidates_evaluated = coalesce(
            nullif(p_monitor->>'candidates_evaluated', '')::integer,
            nullif(p_monitor->>'candidates_checked', '')::integer,
            0
        ),
        positions_evaluated = coalesce(
            nullif(p_monitor->>'positions_evaluated', '')::integer,
            nullif(p_monitor->>'positions_checked', '')::integer,
            0
        ),
        failed_candidate_ids = coalesce(p_monitor->'failed_candidate_ids', '[]'::jsonb),
        failed_trade_ids = coalesce(p_monitor->'failed_trade_ids', '[]'::jsonb)
    where id = (p_monitor->>'monitor_id')::uuid
      and user_id = p_user_id;
end;
$$;

-- R-04: publication happens before email. This durable claim makes workflow
-- retries at-most-once for each logical notification.
create table if not exists public.analyzer_notification_deliveries (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    delivery_key text not null,
    channel text not null,
    run_id uuid not null,
    status text not null check (status in ('claimed', 'sent', 'failed', 'uncertain')),
    attempt_count integer not null default 1 check (attempt_count > 0),
    claimed_at timestamptz not null default now(),
    last_attempt_at timestamptz not null default now(),
    sent_at timestamptz,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, delivery_key)
);

create index if not exists analyzer_notification_deliveries_user_created_idx
    on public.analyzer_notification_deliveries(user_id, created_at desc);

alter table public.analyzer_notification_deliveries enable row level security;

drop policy if exists "Users view generated analyzer_notification_deliveries"
    on public.analyzer_notification_deliveries;
create policy "Users view generated analyzer_notification_deliveries"
    on public.analyzer_notification_deliveries
    for select
    using (auth.uid() = user_id);

revoke insert, update, delete on public.analyzer_notification_deliveries from authenticated;
grant select on public.analyzer_notification_deliveries to authenticated;
grant select, insert, update, delete on public.analyzer_notification_deliveries to service_role;

create or replace function public.claim_analyzer_notification_delivery(
    p_user_id uuid,
    p_delivery_key text,
    p_channel text,
    p_run_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare v_status text;
begin
    if p_user_id is null or p_run_id is null then
        raise exception 'User id and run id are required.';
    end if;
    if nullif(trim(p_delivery_key), '') is null or length(p_delivery_key) > 128 then
        raise exception 'A valid delivery key is required.';
    end if;
    if nullif(trim(p_channel), '') is null or length(p_channel) > 64 then
        raise exception 'A valid delivery channel is required.';
    end if;

    insert into public.analyzer_notification_deliveries(
        user_id, delivery_key, channel, run_id, status
    ) values (
        p_user_id, p_delivery_key, p_channel, p_run_id, 'claimed'
    )
    on conflict (user_id, delivery_key) do nothing;

    if found then
        return 'acquired';
    end if;

    select status
    into v_status
    from public.analyzer_notification_deliveries
    where user_id = p_user_id
      and delivery_key = p_delivery_key
    for update;

    if v_status = 'failed' then
        update public.analyzer_notification_deliveries
        set status = 'claimed',
            run_id = p_run_id,
            attempt_count = attempt_count + 1,
            claimed_at = now(),
            last_attempt_at = now(),
            error_message = null,
            updated_at = now()
        where user_id = p_user_id
          and delivery_key = p_delivery_key;
        return 'acquired';
    end if;

    if v_status = 'sent' then
        update public.market_signal_alerts
        set email_delivered = true
        where user_id = p_user_id
          and run_id = p_run_id;
    end if;

    return coalesce(v_status, 'uncertain');
end;
$$;

create or replace function public.complete_analyzer_notification_delivery(
    p_user_id uuid,
    p_delivery_key text,
    p_run_id uuid,
    p_status text,
    p_error_message text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_existing_status text;
begin
    if p_status not in ('sent', 'failed', 'uncertain') then
        raise exception 'Invalid notification delivery status: %', p_status;
    end if;

    update public.analyzer_notification_deliveries
    set status = p_status,
        run_id = p_run_id,
        last_attempt_at = now(),
        sent_at = case when p_status = 'sent' then now() else sent_at end,
        error_message = nullif(left(coalesce(p_error_message, ''), 2000), ''),
        updated_at = now()
    where user_id = p_user_id
      and delivery_key = p_delivery_key
      and status = 'claimed';

    if not found then
        select status
        into v_existing_status
        from public.analyzer_notification_deliveries
        where user_id = p_user_id
          and delivery_key = p_delivery_key;

        if v_existing_status is distinct from p_status then
            raise exception 'Notification delivery claim was not found.';
        end if;
    end if;

    if p_status = 'sent' then
        update public.market_signal_alerts
        set email_delivered = true
        where user_id = p_user_id
          and run_id = p_run_id;
    end if;
end;
$$;

revoke all on function public.ingest_swing_lab_monitor(uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.ingest_swing_lab_monitor(uuid, jsonb)
    to service_role;

revoke all on function public.claim_analyzer_notification_delivery(uuid, text, text, uuid)
    from public, anon, authenticated;
revoke all on function public.complete_analyzer_notification_delivery(uuid, text, uuid, text, text)
    from public, anon, authenticated;
grant execute on function public.claim_analyzer_notification_delivery(uuid, text, text, uuid)
    to service_role;
grant execute on function public.complete_analyzer_notification_delivery(uuid, text, uuid, text, text)
    to service_role;

-- Preserve the new monitor and delivery fields in complete backups.
create or replace function public.restore_rereview_fixes_details(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row jsonb;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_backup->'data'->'swing_monitor_runs', '[]'::jsonb))
    loop
        update public.swing_monitor_runs
        set candidates_requested = coalesce(nullif(v_row->>'candidates_requested', '')::integer, candidates_checked),
            positions_requested = coalesce(nullif(v_row->>'positions_requested', '')::integer, positions_checked),
            candidates_evaluated = coalesce(nullif(v_row->>'candidates_evaluated', '')::integer, candidates_checked),
            positions_evaluated = coalesce(nullif(v_row->>'positions_evaluated', '')::integer, positions_checked),
            failed_candidate_ids = coalesce(v_row->'failed_candidate_ids', '[]'::jsonb),
            failed_trade_ids = coalesce(v_row->'failed_trade_ids', '[]'::jsonb)
        where id = (v_row->>'id')::uuid
          and user_id = v_user_id;
    end loop;

    delete from public.analyzer_notification_deliveries
    where user_id = v_user_id;

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_backup->'data'->'analyzer_notification_deliveries', '[]'::jsonb))
    loop
        insert into public.analyzer_notification_deliveries(
            id, user_id, delivery_key, channel, run_id, status, attempt_count,
            claimed_at, last_attempt_at, sent_at, error_message, created_at, updated_at
        ) values (
            coalesce(nullif(v_row->>'id', '')::uuid, gen_random_uuid()),
            v_user_id,
            v_row->>'delivery_key',
            v_row->>'channel',
            (v_row->>'run_id')::uuid,
            case when v_row->>'status' in ('claimed', 'sent', 'failed', 'uncertain')
                then v_row->>'status' else 'uncertain' end,
            greatest(coalesce(nullif(v_row->>'attempt_count', '')::integer, 1), 1),
            coalesce(nullif(v_row->>'claimed_at', '')::timestamptz, now()),
            coalesce(nullif(v_row->>'last_attempt_at', '')::timestamptz, now()),
            nullif(v_row->>'sent_at', '')::timestamptz,
            nullif(v_row->>'error_message', ''),
            coalesce(nullif(v_row->>'created_at', '')::timestamptz, now()),
            coalesce(nullif(v_row->>'updated_at', '')::timestamptz, now())
        );
    end loop;
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v7(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_compatible_backup jsonb;
begin
    if auth.uid() is null then
        raise exception 'Authentication required.';
    end if;
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer, 0) not in (1, 2, 3, 4, 5) then
        raise exception 'Unsupported backup format';
    end if;

    v_compatible_backup := jsonb_set(p_backup, '{version}', '4'::jsonb, true);
    perform public.restore_complete_portfolio_backup_v6(v_compatible_backup);
    perform public.restore_rereview_fixes_details(p_backup);
end;
$$;

revoke all on function public.restore_rereview_fixes_details(jsonb)
    from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v7(jsonb)
    from public, anon;
grant execute on function public.restore_complete_portfolio_backup_v7(jsonb)
    to authenticated;

commit;
