begin;

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

    for v_row in
        select value
        from jsonb_array_elements(coalesce(p_monitor->'candidate_updates', '[]'::jsonb))
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
        select value
        from jsonb_array_elements(coalesce(p_monitor->'position_updates', '[]'::jsonb))
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
            )
            values (
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

revoke all on function public.ingest_swing_lab_monitor(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_swing_lab_monitor(uuid, jsonb) to service_role;

commit;
