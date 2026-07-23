begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    display_name text,
    base_currency text not null default 'INR' check (base_currency = 'INR'),
    default_usd_inr_rate numeric not null default 1 check (default_usd_inr_rate > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.asset_categories (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null check (length(trim(name)) > 0),
    sort_order integer not null default 99,
    tracking_currency text not null default 'INR' check (tracking_currency in ('INR', 'USD')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, name)
);

create table if not exists public.portfolio_targets (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    category_id uuid not null references public.asset_categories(id) on delete cascade,
    target_percentage numeric not null default 0 check (target_percentage between 0 and 100),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, category_id)
);

create table if not exists public.holdings (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    category_id uuid not null references public.asset_categories(id) on delete restrict,
    name text not null check (length(trim(name)) > 0),
    asset_type text not null default 'Other',
    currency text not null default 'INR' check (currency in ('INR', 'USD')),
    current_value numeric not null default 0 check (current_value >= 0),
    exchange_rate_to_inr numeric not null default 1 check (exchange_rate_to_inr > 0),
    current_value_inr numeric generated always as (current_value * exchange_rate_to_inr) stored,
    notes text,
    is_active boolean not null default true,
    last_updated_at date not null default (now() at time zone 'Asia/Kolkata')::date,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.sip_plans (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    category_id uuid not null references public.asset_categories(id) on delete restrict,
    name text not null check (length(trim(name)) > 0),
    monthly_amount numeric not null default 0 check (monthly_amount >= 0),
    sip_day integer check (sip_day between 1 and 31),
    notes text,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.investment_notes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null check (length(trim(title)) > 0),
    content text not null default '',
    is_current boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.portfolio_snapshots (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    snapshot_month date not null,
    total_value_inr numeric not null default 0,
    total_monthly_sip numeric not null default 0,
    note_id uuid references public.investment_notes(id) on delete set null,
    note_title text,
    note_content text,
    created_at timestamptz not null default now(),
    unique (user_id, snapshot_month)
);

create table if not exists public.snapshot_categories (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
    category_id uuid references public.asset_categories(id) on delete set null,
    category_name text not null,
    amount_inr numeric not null default 0,
    current_percentage numeric not null default 0,
    target_percentage numeric not null default 0,
    difference_percentage numeric not null default 0,
    created_at timestamptz not null default now(),
    unique (snapshot_id, category_name)
);

create table if not exists public.snapshot_sips (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
    category_id uuid references public.asset_categories(id) on delete set null,
    category_name text not null,
    name text not null,
    monthly_amount numeric not null default 0,
    created_at timestamptz not null default now()
);

create index if not exists asset_categories_user_sort_idx
    on public.asset_categories(user_id, sort_order, name);
create index if not exists holdings_user_active_idx
    on public.holdings(user_id, is_active, category_id);
create index if not exists sip_plans_user_active_idx
    on public.sip_plans(user_id, is_active, category_id);
create index if not exists portfolio_snapshots_user_month_idx
    on public.portfolio_snapshots(user_id, snapshot_month desc);
create index if not exists snapshot_categories_snapshot_idx
    on public.snapshot_categories(user_id, snapshot_id);
create index if not exists snapshot_sips_snapshot_idx
    on public.snapshot_sips(user_id, snapshot_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'profiles', 'asset_categories', 'portfolio_targets', 'holdings',
        'sip_plans', 'investment_notes', 'portfolio_snapshots',
        'snapshot_categories', 'snapshot_sips'
    ]
    loop
        execute format('alter table public.%I enable row level security', v_table);
        execute format('drop policy if exists "Users manage %1$s" on public.%1$I', v_table);
        execute format(
            'create policy "Users manage %1$s" on public.%1$I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
            v_table
        );
        execute format('grant select, insert, update, delete on public.%I to authenticated', v_table);
    end loop;
end;
$$;

do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'profiles', 'asset_categories', 'portfolio_targets', 'holdings',
        'sip_plans', 'investment_notes'
    ]
    loop
        execute format('drop trigger if exists %1$s_set_updated_at on public.%1$I', v_table);
        execute format(
            'create trigger %1$s_set_updated_at before update on public.%1$I for each row execute function public.set_updated_at()',
            v_table
        );
    end loop;
end;
$$;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles(user_id, display_name)
    values (new.id, nullif(new.raw_user_meta_data->>'display_name', ''))
    on conflict (user_id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created_investment_tracker on auth.users;
create trigger on_auth_user_created_investment_tracker
after insert on auth.users
for each row execute function public.handle_new_user_profile();

insert into public.profiles(user_id)
select id from auth.users
on conflict (user_id) do nothing;

commit;
