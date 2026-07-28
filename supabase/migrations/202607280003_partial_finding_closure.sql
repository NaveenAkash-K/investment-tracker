begin;

-- Keep the prior risk, sizing, and entry-window checks as the inner operation.
do $$
begin
    if to_regprocedure(
        'public.confirm_swing_entry_review_v2(uuid,date,numeric,integer,text,text)'
    ) is null then
        execute 'alter function public.confirm_swing_entry(uuid, date, numeric, integer, text, text) rename to confirm_swing_entry_review_v2';
    end if;
end;
$$;

-- An old candidate may remain visible until its exchange-session expiry, but
-- it cannot become a trade unless both its source scan and the newest scan
-- have a confirmed, published price session.
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
            not in ('2026-07-28.v1', 'legacy-unversioned') then
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
            not in ('2026-07-28.v1', 'legacy-unversioned') then
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

revoke all on function public.confirm_swing_entry_review_v2(
    uuid, date, numeric, integer, text, text
) from public, anon, authenticated;

revoke all on function public.confirm_swing_entry(
    uuid, date, numeric, integer, text, text
) from public, anon;

grant execute on function public.confirm_swing_entry(
    uuid, date, numeric, integer, text, text
) to authenticated;

commit;
