begin;

-- RR-02: the current monitor contract must prove that every requested record
-- was either evaluated or explicitly reported as failed.
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
    v_candidates_requested integer;
    v_positions_requested integer;
    v_candidates_evaluated integer;
    v_positions_evaluated integer;
    v_failed_candidates integer;
    v_failed_trades integer;
    v_total_requested integer;
    v_total_evaluated integer;
    v_total_failed integer;
begin
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
        raise exception 'Analyzer % payload must be a JSON object.', p_kind;
    end if;

    v_version := coalesce(nullif(p_payload->>'contract_version', ''), 'legacy-unversioned');
    if v_version not in ('legacy-unversioned', '2026-07-28.v1', '2026-07-30.v2') then
        raise exception 'Unsupported Analyzer contract version % for %.', v_version, p_kind;
    end if;
    if p_kind not in ('market_run', 'swing_scan', 'swing_monitor', 'news_run') then
        raise exception 'Unsupported Analyzer payload kind %.', p_kind;
    end if;

    if v_version in ('2026-07-28.v1', '2026-07-30.v2') then
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

    if v_version = '2026-07-30.v2' and p_kind = 'swing_monitor' then
        if coalesce(p_payload->>'candidates_requested', '') !~ '^[0-9]+$'
           or coalesce(p_payload->>'positions_requested', '') !~ '^[0-9]+$'
           or coalesce(p_payload->>'candidates_evaluated', '') !~ '^[0-9]+$'
           or coalesce(p_payload->>'positions_evaluated', '') !~ '^[0-9]+$'
           or jsonb_typeof(coalesce(p_payload->'failed_candidate_ids', 'null'::jsonb)) <> 'array'
           or jsonb_typeof(coalesce(p_payload->'failed_trade_ids', 'null'::jsonb)) <> 'array' then
            raise exception 'Current Swing monitor payload is missing valid truth fields.';
        end if;
        if exists (
            select 1
            from jsonb_array_elements(p_payload->'failed_candidate_ids') item
            where jsonb_typeof(item) <> 'string' or nullif(trim(item #>> '{}'), '') is null
        ) or exists (
            select 1
            from jsonb_array_elements(p_payload->'failed_trade_ids') item
            where jsonb_typeof(item) <> 'string' or nullif(trim(item #>> '{}'), '') is null
        ) then
            raise exception 'Swing monitor failed-record identifiers must be non-empty strings.';
        end if;

        v_candidates_requested := (p_payload->>'candidates_requested')::integer;
        v_positions_requested := (p_payload->>'positions_requested')::integer;
        v_candidates_evaluated := (p_payload->>'candidates_evaluated')::integer;
        v_positions_evaluated := (p_payload->>'positions_evaluated')::integer;
        v_failed_candidates := jsonb_array_length(p_payload->'failed_candidate_ids');
        v_failed_trades := jsonb_array_length(p_payload->'failed_trade_ids');

        if v_candidates_evaluated > v_candidates_requested
           or v_positions_evaluated > v_positions_requested then
            raise exception 'Swing monitor evaluated counts cannot exceed requested counts.';
        end if;
        if v_failed_candidates <> (
            select count(distinct value)
            from jsonb_array_elements_text(p_payload->'failed_candidate_ids')
        ) or v_failed_trades <> (
            select count(distinct value)
            from jsonb_array_elements_text(p_payload->'failed_trade_ids')
        ) then
            raise exception 'Swing monitor failed-record identifiers must be unique.';
        end if;
        if p_payload->>'status' <> 'disabled'
           and (
               v_candidates_evaluated + v_failed_candidates <> v_candidates_requested
               or v_positions_evaluated + v_failed_trades <> v_positions_requested
               or jsonb_array_length(p_payload->'candidate_updates') <> v_candidates_evaluated
               or jsonb_array_length(p_payload->'position_updates') <> v_positions_evaluated
           ) then
            raise exception 'Swing monitor requested, evaluated and failed counts do not reconcile.';
        end if;

        v_total_requested := v_candidates_requested + v_positions_requested;
        v_total_evaluated := v_candidates_evaluated + v_positions_evaluated;
        v_total_failed := v_failed_candidates + v_failed_trades;
        if p_payload->>'status' = 'successful'
           and (v_total_evaluated <> v_total_requested or v_total_failed <> 0) then
            raise exception 'A successful Swing monitor must evaluate every requested record.';
        end if;
        if p_payload->>'status' = 'partial'
           and (v_total_evaluated = 0 or v_total_failed = 0) then
            raise exception 'A partial Swing monitor must contain both evaluated and failed records.';
        end if;
        if p_payload->>'status' = 'failed'
           and v_total_evaluated <> 0 then
            raise exception 'A failed Swing monitor cannot report evaluated records.';
        end if;
    end if;

    return v_version;
end;
$$;

create or replace function public.ingest_swing_lab_monitor(p_user_id uuid, p_monitor jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_version text;
    v_legacy_issue jsonb := jsonb_build_object(
        'severity', 'warning',
        'source', 'analyzer_contract',
        'message', 'Legacy Swing monitor coverage was not validated under the current reconciliation contract.'
    );
begin
    v_version := public.validate_analyzer_contract(p_monitor, 'swing_monitor');
    perform public.ingest_swing_lab_monitor_v2(p_user_id, p_monitor);

    update public.swing_monitor_runs
    set contract_version = v_version,
        status = case
            when v_version = '2026-07-30.v2' then status
            when status = 'disabled' then 'disabled'
            else 'partial'
        end,
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
        failed_trade_ids = coalesce(p_monitor->'failed_trade_ids', '[]'::jsonb),
        data_issues = case
            when v_version = '2026-07-30.v2' then data_issues
            else coalesce(data_issues, '[]'::jsonb) || jsonb_build_array(v_legacy_issue)
        end
    where id = (p_monitor->>'monitor_id')::uuid
      and user_id = p_user_id;
end;
$$;

-- Existing v1 monitor records remain useful history, but cannot continue to
-- present an unverified successful/green state after the stricter boundary is
-- installed.
update public.swing_monitor_runs
set status = 'partial',
    data_issues = coalesce(data_issues, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
            'severity', 'warning',
            'source', 'analyzer_contract',
            'message', 'This historical monitor predates strict requested/evaluated/failed reconciliation.'
        )
    )
where status = 'successful'
  and coalesce(contract_version, 'legacy-unversioned') <> '2026-07-30.v2'
  and not coalesce(data_issues, '[]'::jsonb) @> jsonb_build_array(
      jsonb_build_object(
          'severity', 'warning',
          'source', 'analyzer_contract',
          'message', 'This historical monitor predates strict requested/evaluated/failed reconciliation.'
      )
  );

-- Keep entry confirmation compatible with the new current contract while
-- preserving the preceding scan/session/risk checks.
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
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_candidate_scan public.swing_scan_runs%rowtype;
    v_latest_scan public.swing_scan_runs%rowtype;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;

    select scan.*
    into v_candidate_scan
    from public.swing_candidates candidate
    join public.swing_scan_runs scan
      on scan.id = candidate.scan_id
     and scan.user_id = candidate.user_id
    where candidate.id = p_candidate_id
      and candidate.user_id = v_user_id;

    if not found then
        raise exception 'Candidate or its source scan was not found.';
    end if;

    select *
    into v_latest_scan
    from public.swing_scan_runs
    where user_id = v_user_id
    order by as_of desc
    limit 1;

    if not found then
        raise exception 'A valid Swing Lab scan is required before confirming an entry.';
    end if;

    if v_candidate_scan.status not in ('successful', 'partial')
       or v_candidate_scan.session_state <> 'completed'
       or not v_candidate_scan.session_matches_expected
       or v_candidate_scan.publication_status <> 'published'
       or coalesce(v_candidate_scan.contract_version, 'legacy-unversioned')
            not in ('2026-07-30.v2', '2026-07-28.v1', 'legacy-unversioned') then
        raise exception 'This candidate came from a failed, stale, unpublished, or unsupported scan.';
    end if;

    if v_latest_scan.status not in ('successful', 'partial')
       or v_latest_scan.session_state <> 'completed'
       or not v_latest_scan.session_matches_expected
       or v_latest_scan.publication_status <> 'published'
       or v_latest_scan.expected_price_session is null
       or p_entry_date < v_latest_scan.expected_price_session
       or p_entry_date - v_latest_scan.expected_price_session > 3
       or coalesce(v_latest_scan.contract_version, 'legacy-unversioned')
            not in ('2026-07-30.v2', '2026-07-28.v1', 'legacy-unversioned') then
        raise exception 'The latest Swing Lab scan is not valid. Wait for a successful fresh scan before entering.';
    end if;

    return public.confirm_swing_entry_review_v2(
        p_candidate_id,
        p_entry_date,
        p_entry_price,
        p_quantity,
        p_trade_mode,
        p_notes
    );
end;
$$;

-- RR-03: preserve at-most-once automatic delivery, but make abandoned claims
-- auditable and recoverable by the authenticated portfolio owner.
alter table public.analyzer_notification_deliveries
    drop constraint if exists analyzer_notification_deliveries_status_check;
alter table public.analyzer_notification_deliveries
    add constraint analyzer_notification_deliveries_status_check
    check (status in ('claimed', 'sent', 'failed', 'uncertain', 'dismissed'));

alter table public.analyzer_notification_deliveries
    add column if not exists resolved_at timestamptz,
    add column if not exists resolved_by uuid references auth.users(id) on delete set null,
    add column if not exists resolution_action text
        check (resolution_action in ('retry_allowed', 'dismissed')),
    add column if not exists resolution_note text;

create or replace function public.resolve_analyzer_notification_delivery(
    p_delivery_id uuid,
    p_action text,
    p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_delivery public.analyzer_notification_deliveries%rowtype;
begin
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;
    if p_action not in ('retry', 'dismiss') then
        raise exception 'Notification resolution must be retry or dismiss.';
    end if;
    if length(coalesce(p_note, '')) > 1000 then
        raise exception 'Resolution note must be 1000 characters or fewer.';
    end if;

    select *
    into v_delivery
    from public.analyzer_notification_deliveries
    where id = p_delivery_id
      and user_id = v_user_id
    for update;

    if not found then
        raise exception 'Notification delivery was not found.';
    end if;
    if v_delivery.status not in ('claimed', 'uncertain') then
        raise exception 'Only unresolved notification deliveries can be resolved.';
    end if;
    if v_delivery.status = 'claimed'
       and v_delivery.claimed_at > now() - interval '15 minutes' then
        raise exception 'This delivery claim may still be active. Wait 15 minutes before resolving it.';
    end if;

    update public.analyzer_notification_deliveries
    set status = case when p_action = 'retry' then 'failed' else 'dismissed' end,
        resolved_at = now(),
        resolved_by = v_user_id,
        resolution_action = case when p_action = 'retry' then 'retry_allowed' else 'dismissed' end,
        resolution_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''),
        error_message = case
            when p_action = 'retry' then 'Manual retry was authorized after an unresolved delivery claim.'
            else error_message
        end,
        updated_at = now()
    where id = p_delivery_id
      and user_id = v_user_id;
end;
$$;

-- RR-01: normalize old monitor rows before the inherited v5 restore helper
-- expands them into the current composite table type.
create or replace function public.restore_second_rereview_details(p_backup jsonb)
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
        from jsonb_array_elements(
            coalesce(p_backup->'data'->'analyzer_notification_deliveries', '[]'::jsonb)
        )
    loop
        update public.analyzer_notification_deliveries
        set status = case
                when v_row->>'status' in ('claimed', 'sent', 'failed', 'uncertain', 'dismissed')
                    then v_row->>'status'
                else status
            end,
            resolved_at = nullif(v_row->>'resolved_at', '')::timestamptz,
            resolved_by = case
                when nullif(v_row->>'resolved_by', '')::uuid = v_user_id then v_user_id
                else null
            end,
            resolution_action = case
                when v_row->>'resolution_action' in ('retry_allowed', 'dismissed')
                    then v_row->>'resolution_action'
                else null
            end,
            resolution_note = nullif(left(coalesce(v_row->>'resolution_note', ''), 1000), '')
        where id = (v_row->>'id')::uuid
          and user_id = v_user_id;
    end loop;

    update public.swing_monitor_runs
    set status = 'partial',
        data_issues = coalesce(data_issues, '[]'::jsonb) || jsonb_build_array(
            jsonb_build_object(
                'severity', 'warning',
                'source', 'analyzer_contract',
                'message', 'This restored monitor predates strict requested/evaluated/failed reconciliation.'
            )
        )
    where user_id = v_user_id
      and status = 'successful'
      and coalesce(contract_version, 'legacy-unversioned') <> '2026-07-30.v2'
      and not coalesce(data_issues, '[]'::jsonb) @> jsonb_build_array(
          jsonb_build_object(
              'severity', 'warning',
              'source', 'analyzer_contract',
              'message', 'This restored monitor predates strict requested/evaluated/failed reconciliation.'
          )
      );
end;
$$;

create or replace function public.restore_complete_portfolio_backup_v7(p_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_compatible_backup jsonb;
    v_monitor_rows jsonb;
begin
    if auth.uid() is null then
        raise exception 'Authentication required.';
    end if;
    if p_backup->>'format' <> 'investment-tracker-backup'
       or coalesce((p_backup->>'version')::integer, 0) not in (1, 2, 3, 4, 5) then
        raise exception 'Unsupported backup format';
    end if;

    select coalesce(
        jsonb_agg(
            value || jsonb_build_object(
                'candidates_requested', coalesce(
                    nullif(value->>'candidates_requested', '')::integer,
                    nullif(value->>'candidates_checked', '')::integer,
                    0
                ),
                'positions_requested', coalesce(
                    nullif(value->>'positions_requested', '')::integer,
                    nullif(value->>'positions_checked', '')::integer,
                    0
                ),
                'candidates_evaluated', coalesce(
                    nullif(value->>'candidates_evaluated', '')::integer,
                    nullif(value->>'candidates_checked', '')::integer,
                    0
                ),
                'positions_evaluated', coalesce(
                    nullif(value->>'positions_evaluated', '')::integer,
                    nullif(value->>'positions_checked', '')::integer,
                    0
                ),
                'failed_candidate_ids', coalesce(value->'failed_candidate_ids', '[]'::jsonb),
                'failed_trade_ids', coalesce(value->'failed_trade_ids', '[]'::jsonb)
            )
        ),
        '[]'::jsonb
    )
    into v_monitor_rows
    from jsonb_array_elements(
        coalesce(p_backup->'data'->'swing_monitor_runs', '[]'::jsonb)
    );

    v_compatible_backup := jsonb_set(p_backup, '{version}', '4'::jsonb, true);
    v_compatible_backup := jsonb_set(
        v_compatible_backup,
        '{data,swing_monitor_runs}',
        v_monitor_rows,
        true
    );
    perform public.restore_complete_portfolio_backup_v6(v_compatible_backup);
    perform public.restore_rereview_fixes_details(p_backup);
    perform public.restore_second_rereview_details(p_backup);
end;
$$;

revoke all on function public.resolve_analyzer_notification_delivery(uuid, text, text)
    from public, anon;
grant execute on function public.resolve_analyzer_notification_delivery(uuid, text, text)
    to authenticated;

revoke all on function public.restore_second_rereview_details(jsonb)
    from public, anon, authenticated;
revoke all on function public.restore_complete_portfolio_backup_v7(jsonb)
    from public, anon;
grant execute on function public.restore_complete_portfolio_backup_v7(jsonb)
    to authenticated;

commit;
