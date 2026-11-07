-- ======================================================================
-- テンシ ポータル：Supabase の最終形
--
-- ・実際のDB（supabase_inspect.sql の結果）と突き合わせ済み。
--     関数14本すべての定義が、このファイルと一致している（md5で確認）。
--     表・列・インデックス・RLS・方針・権限・登録サイトも一致している。
-- ・使い方：SQL Editor に丸ごと貼って Run。何度実行しても安全。
--     まっさらなDBでも、このファイルだけで同じ状態になる。
--
--   A. 英単語サイト(eitango)の日別回答数と、同期の関数
--   B. ポータル本体
--        portal_sites / profiles / user_links、合算ビュー all_daily_counts、
--        プロフィール・連携・ランキングの関数
--        連携キーは、照合用の key_hash と、表示用の key_plain（そのまま）の両方を保存する
--   C. 古文文法サイト(kobunbunpou)の日別回答数と関数
--   D. 古文文法サイトの登録と、合算ビューの作り直し
--   E. 仕上がりの確認（読み取りだけ）
--
-- 動作確認の portal_selftest.sql は、このあとに別に実行する。
-- ※ 今のDBの関数本体は、改行が CRLF で保存されている。このファイルを実行すると LF になり、
--    md5 は変わるが、動きは同じ。
-- ======================================================================


-- ======================================================================
-- A. 英単語サイト（eitango）の日別回答数と、同期の関数
-- ======================================================================

create table if not exists public.daily_counts (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null,                              -- 日本時間の学習日
  answers    integer not null check (answers between 0 and 100000),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
create index if not exists daily_counts_day_idx on public.daily_counts (day, user_id);

alter table public.daily_counts enable row level security;
drop policy if exists daily_select_own on public.daily_counts;
create policy daily_select_own on public.daily_counts for select to authenticated using (user_id = auth.uid());
revoke all on public.daily_counts from anon, authenticated, public;
grant select on public.daily_counts to authenticated;   -- 書き込みは下のRPCだけ


-- ============ 同期：{"2026-11-01": 12, "2026-10-31": 5} を受け取る ============
-- 端末は毎回「全日分」を送る。何度送っても同じ結果（冪等）。
-- 件数は減らさない（greatest）ので、古い状態が遅れて届いても巻き戻らない。
-- 不正な日付・件数の行は黙って無視する（1行のせいで全体が止まらない）。
create or replace function public.sync_daily(p_days jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  today date := (now() at time zone 'Asia/Tokyo')::date;
  k     record;
  d     date;
  c     int;
  n     int := 0;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if jsonb_typeof(p_days) <> 'object' then raise exception 'invalid payload' using errcode = '22023'; end if;

  for k in select key, value from jsonb_each_text(p_days) limit 400 loop
    begin
      d := k.key::date;
      c := k.value::int;
      continue when d < today - 400 or d > today + 1 or c < 0 or c > 100000;
      insert into public.daily_counts (user_id, day, answers)
      values (uid, d, c)
      on conflict (user_id, day) do update
         set answers = excluded.answers, updated_at = now()
       where excluded.answers > public.daily_counts.answers;
      n := n + 1;
    exception when others then
      continue;
    end;
  end loop;

  return jsonb_build_object('days', n);
end $$;


-- ============ 実行権限 ============
revoke all on function public.sync_daily(jsonb) from public, anon;
grant execute on function public.sync_daily(jsonb) to authenticated;
-- ここまで。このファイルには、これ以外のSQLを足さない。


-- ======================================================================
-- B. ポータル本体
-- ======================================================================

create table if not exists public.portal_sites (
  site        text primary key check (site ~ '^[a-z][a-z0-9_]{1,30}$'),
  has_counts  boolean not null default true,
  sort        integer not null default 100,
  daily_table text                      -- そのサイトの日別テーブル名（has_counts のサイトだけ）
);
alter table public.portal_sites add column if not exists daily_table text;   -- 前の版からの更新用
insert into public.portal_sites (site, has_counts, sort, daily_table) values
  ('portal',  false, 0,  null),
  ('eitango', true,  10, 'daily_counts')
on conflict (site) do nothing;
update public.portal_sites set daily_table = 'daily_counts' where site = 'eitango' and daily_table is null;

-- ============ プロフィール（人）：キーは照合用のハッシュ＋表示用にそのまま保存 ============
create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  nickname      text not null check (char_length(nickname) between 1 and 20),
  key_hash      text not null unique,
  banned        boolean not null default false,   -- true にするとランキングから外れ、ポータルに警告が出る
  ban_reason    text,                              -- ポータルの警告に表示される（任意）
  created_at    timestamptz not null default now(),
  key_issued_at timestamptz not null default now(),
  key_plain     text                               -- 表示用の連携キー（ポータルでいつでも見せる。本人にだけ返す）
);

-- ============ 紐付け：どの匿名ユーザー（端末）がどの人か ============
-- 主キーが (user_id, site) なので、同じ端末が別の人に紐付くと古い方は自動で外れる。
create table if not exists public.user_links (
  user_id    uuid not null references auth.users(id) on delete cascade,
  site       text not null references public.portal_sites(site),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  linked_at  timestamptz not null default now(),
  primary key (user_id, site)
);
alter table public.profiles add column if not exists key_plain text;   -- 前の版からの更新用
create index if not exists user_links_profile_idx on public.user_links (profile_id, site);

alter table public.portal_sites enable row level security;
alter table public.profiles     enable row level security;
alter table public.user_links   enable row level security;
revoke all on public.portal_sites, public.profiles, public.user_links from anon, authenticated, public;  -- 読み書きは下のRPCだけ

-- ============ 全サイトの日別回数（サイトごとのテーブルを束ねるビュー） ============
-- ビューは portal_sites の登録から自動で組み立てる。サイトを増やしたら、登録して
--   select public.portal_rebuild_view();
-- を1回実行するだけ（手でビューを書き換えない。登録済みで、テーブルが存在するサイトだけが入る）。
-- 運営専用：anon / authenticated からは実行できない。
create or replace function public.portal_rebuild_view()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  parts text[] := '{}';
  s     record;
begin
  for s in
    select ps.site, ps.daily_table
      from public.portal_sites ps
     where ps.has_counts and ps.daily_table is not null
     order by ps.sort, ps.site
  loop
    if to_regclass('public.' || quote_ident(s.daily_table)) is not null then
      parts := parts || format('select %L::text as site, user_id, day, answers from public.%I', s.site, s.daily_table);
    end if;
  end loop;
  if array_length(parts, 1) is null then
    raise exception '集計できるサイトのテーブルがありません' using errcode = 'P0002';
  end if;
  execute 'create or replace view public.all_daily_counts with (security_invoker = true) as '
          || array_to_string(parts, ' union all ');
  execute 'revoke all on public.all_daily_counts from anon, authenticated, public';
  return array_to_string(parts, ' union all ');
end $$;
revoke all on function public.portal_rebuild_view() from public, anon, authenticated;
select public.portal_rebuild_view();

-- ============ プロフィール作成（ポータルの初回） ============
create or replace function public.portal_create_profile(p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid  uuid := auth.uid();
  nick text := btrim(regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', '', 'g'), E' \u3000');
  k    text;
  pid  uuid;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if char_length(nick) not between 1 and 20 then
    raise exception 'ニックネームは1〜20文字で入力してください' using errcode = '22023';
  end if;
  if exists (select 1 from public.user_links where user_id = uid and site = 'portal') then
    raise exception 'すでにプロフィールがあります' using errcode = '23505';
  end if;
  k := upper(replace(gen_random_uuid()::text, '-', ''));   -- 32桁の16進（約122bitの乱数）
  insert into public.profiles (nickname, key_hash, key_plain)
  values (nick, encode(sha256(convert_to(k, 'UTF8')), 'hex'), regexp_replace(k, '(.{4})(?!$)', '\1-', 'g'))
  returning id into pid;
  insert into public.user_links (user_id, site, profile_id) values (uid, 'portal', pid);
  return jsonb_build_object('key', regexp_replace(k, '(.{4})(?!$)', '\1-', 'g'));
end $$;

-- ============ キー再発行（古いキーは無効。連携済みの端末はそのまま） ============
create or replace function public.portal_regenerate_key()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  pid uuid;
  k   text;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select l.profile_id into pid from public.user_links l where l.user_id = uid and l.site = 'portal';
  if pid is null then raise exception 'プロフィールがありません' using errcode = 'P0002'; end if;
  k := upper(replace(gen_random_uuid()::text, '-', ''));
  update public.profiles
     set key_hash = encode(sha256(convert_to(k, 'UTF8')), 'hex'),
         key_plain = regexp_replace(k, '(.{4})(?!$)', '\1-', 'g'),
         key_issued_at = now()
   where id = pid;
  return jsonb_build_object('key', regexp_replace(k, '(.{4})(?!$)', '\1-', 'g'));
end $$;

-- ============ ニックネーム変更 ============
create or replace function public.portal_set_nickname(p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid  uuid := auth.uid();
  nick text := btrim(regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', '', 'g'), E' \u3000');
  pid  uuid;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if char_length(nick) not between 1 and 20 then
    raise exception 'ニックネームは1〜20文字で入力してください' using errcode = '22023';
  end if;
  select l.profile_id into pid from public.user_links l where l.user_id = uid and l.site = 'portal';
  if pid is null then raise exception 'プロフィールがありません' using errcode = 'P0002'; end if;
  update public.profiles set nickname = nick where id = pid;
  return jsonb_build_object('nickname', nick);
end $$;

-- ============ キーで連携（各サイト／ポータルの別端末から呼ぶ） ============
-- 同じ端末が別のキーで連携し直すと、古い紐付けは自動で解除される。
create or replace function public.redeem_link_key(p_key text, p_site text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid     uuid := auth.uid();
  k       text := upper(regexp_replace(coalesce(p_key, ''), '[^0-9A-Za-z]', '', 'g'));
  pid     uuid;
  nick    text;
  old_pid uuid;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.portal_sites s where s.site = p_site) then
    raise exception 'unknown site' using errcode = '22023';
  end if;
  if char_length(k) <> 32 then raise exception 'キーが正しくありません' using errcode = '22023'; end if;
  select p.id, p.nickname into pid, nick
    from public.profiles p
   where p.key_hash = encode(sha256(convert_to(k, 'UTF8')), 'hex');
  if pid is null then raise exception 'キーが正しくありません' using errcode = '22023'; end if;
  select l.profile_id into old_pid from public.user_links l where l.user_id = uid and l.site = p_site;
  insert into public.user_links (user_id, site, profile_id) values (uid, p_site, pid)
  on conflict (user_id, site) do update set profile_id = excluded.profile_id, linked_at = now();
  return jsonb_build_object('site', p_site, 'nickname', nick,
                            'replaced', old_pid is not null and old_pid <> pid);
end $$;

-- ============ 連携の解除 ============
-- サイト側から：この端末の連携を外す
create or replace function public.unlink_self(p_site text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  n   int;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  delete from public.user_links where user_id = uid and site = p_site and site <> 'portal';
  get diagnostics n = row_count;
  return jsonb_build_object('removed', n);
end $$;

-- ポータル側から：そのサイトの連携をすべて外す
create or replace function public.portal_unlink_site(p_site text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  pid uuid;
  n   int;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select l.profile_id into pid from public.user_links l where l.user_id = uid and l.site = 'portal';
  if pid is null then raise exception 'プロフィールがありません' using errcode = 'P0002'; end if;
  delete from public.user_links where profile_id = pid and site = p_site and site <> 'portal';
  get diagnostics n = row_count;
  return jsonb_build_object('removed', n);
end $$;

-- ============ サイト側：連携状態 ============
create or replace function public.link_status(p_site text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid       uuid := auth.uid();
  nick      text;
  is_banned boolean;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select p.nickname, p.banned into nick, is_banned
    from public.user_links l
    join public.profiles p on p.id = l.profile_id
   where l.user_id = uid and l.site = p_site;
  return jsonb_build_object('linked', found, 'nickname', nick, 'banned', coalesce(is_banned, false));
end $$;

-- ============ ポータル：自分の状態（プロフィール・BAN・サイト別の参加状況） ============
create or replace function public.portal_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid    uuid := auth.uid();
  today  date := (now() at time zone 'Asia/Tokyo')::date;
  me_pid uuid;
  prof   record;
  sites  jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select l.profile_id into me_pid from public.user_links l where l.user_id = uid and l.site = 'portal';
  if me_pid is null then return jsonb_build_object('hasProfile', false); end if;
  select p.nickname, p.banned, p.ban_reason, p.key_plain into prof from public.profiles p where p.id = me_pid;

  select coalesce(jsonb_agg(jsonb_build_object(
           'site', s.site,
           'devices', (select count(*)::int from public.user_links l
                        where l.profile_id = me_pid and l.site = s.site),
           'answers', (select coalesce(sum(a.answers), 0)::int
                         from public.all_daily_counts a
                         join public.user_links l on l.user_id = a.user_id and l.site = a.site
                        where l.profile_id = me_pid and a.site = s.site),
           'today',   (select coalesce(sum(a.answers), 0)::int
                         from public.all_daily_counts a
                         join public.user_links l on l.user_id = a.user_id and l.site = a.site
                        where l.profile_id = me_pid and a.site = s.site and a.day = today)
         ) order by s.sort), '[]'::jsonb)
    into sites
    from public.portal_sites s
   where s.has_counts;

  return jsonb_build_object(
    'hasProfile', true,
    'day', to_char(today, 'YYYY-MM-DD'),
    'profile', jsonb_build_object('nickname', prof.nickname, 'banned', prof.banned, 'banReason', prof.ban_reason, 'key', prof.key_plain),
    'sites', sites);
end $$;

-- ============ ポータル：ランキング（合算／サイト別 × 今日／通算） ============
-- 順位の計算には全員を含める（連携していない人も匿名のまま数える）。BANされた人は除く。
-- 一覧に名前が出るのは、ポータルのプロフィールがある人だけ。
create or replace function public.portal_ranking(p_scope text default 'all', p_period text default 'allTime', p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid    uuid := auth.uid();
  today  date := (now() at time zone 'Asia/Tokyo')::date;
  lim    int  := least(greatest(coalesce(p_limit, 20), 1), 50);
  me_pid uuid;
  result jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_period not in ('daily', 'allTime') then raise exception 'invalid period' using errcode = '22023'; end if;
  if p_scope <> 'all' and not exists (select 1 from public.portal_sites s where s.site = p_scope and s.has_counts) then
    raise exception 'invalid scope' using errcode = '22023';
  end if;
  select l.profile_id into me_pid from public.user_links l where l.user_id = uid and l.site = 'portal';
  if me_pid is null then raise exception 'プロフィールがありません' using errcode = 'P0002'; end if;

  with base as (
    select a.site, coalesce(l.profile_id, a.user_id) as person, a.answers
    from public.all_daily_counts a
    left join public.user_links l on l.user_id = a.user_id and l.site = a.site
    left join public.profiles   p on p.id = l.profile_id
    where coalesce(p.banned, false) = false
      and (p_period = 'allTime' or a.day = today)
  ), agg as (
    select person, sum(answers)::int as n
    from base
    where p_scope = 'all' or site = p_scope
    group by person
    having sum(answers) > 0
  ), ranked as (
    select person, n, (rank() over (order by n desc))::int as rk from agg
  ), per_site as (
    select person, site, sum(answers)::int as n from base group by person, site
  ), toplist as (
    select r.person, r.n, r.rk, p.nickname, p.created_at
    from ranked r
    join public.profiles p on p.id = r.person
    order by r.rk, p.created_at
    limit lim
  )
  select jsonb_build_object(
    'scope', p_scope, 'period', p_period,
    'day', to_char(today, 'YYYY-MM-DD'),
    'participants', (select count(*)::int from ranked),
    'me', (select jsonb_build_object(
             'answers', r.n, 'rank', r.rk,
             'tied', (select count(*)::int from ranked x where x.n = r.n) - 1,
             'gap',  (select min(x.n) from ranked x where x.n > r.n) - r.n)
           from ranked r where r.person = me_pid),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
               'rank', t.rk, 'nickname', t.nickname, 'answers', t.n, 'me', (t.person = me_pid),
               'bySite', (select jsonb_object_agg(s.site,
                                   (select ps.n from per_site ps
                                     where ps.person = t.person and ps.site = s.site and ps.n > 0))
                            from public.portal_sites s where s.has_counts)
             ) order by t.rk, t.created_at)
      from toplist t), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- ============ 英単語サイトのランキング（連携した端末をプロフィール単位でまとめる版） ============
-- 戻り値の形は従来どおり。'hidden' が true のときは、BANでランキングに出ていない。
create or replace function public.get_ranking()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid       uuid := auth.uid();
  today     date := (now() at time zone 'Asia/Tokyo')::date;
  me_person uuid;
  hidden    boolean;
  result    jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;

  -- 自分の「人」：ポータルに連携済みならプロフィール、未連携なら匿名ID自身
  select coalesce(l.profile_id, uid), coalesce(p.banned, false)
    into me_person, hidden
    from (select 1) x
    left join public.user_links l on l.user_id = uid and l.site = 'eitango'
    left join public.profiles   p on p.id = l.profile_id;

  with src as (
    -- 連携済みの端末はプロフィール単位でまとめる（複数端末は合算）。BANされた人は集計から外す
    select coalesce(l.profile_id, d.user_id) as person, d.day, d.answers
    from public.daily_counts d
    left join public.user_links l on l.user_id = d.user_id and l.site = 'eitango'
    left join public.profiles   p on p.id = l.profile_id
    where coalesce(p.banned, false) = false
  ), t as (
    select person,
           sum(answers)::int as total,
           (coalesce(sum(answers) filter (where day = today), 0))::int as today_n
    from src group by person
  ), me as (
    select coalesce((select total from t where person = me_person), 0)   as total,
           coalesce((select today_n from t where person = me_person), 0) as today_n
  )
  select jsonb_build_object(
    'version', 1, 'basis', 'question-counts',
    'hidden', hidden,
    'day', to_char(today, 'YYYY-MM-DD'),
    'updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'daily', jsonb_build_object(
       'answers', me.today_n,
       'participants', (select count(*) from t where today_n > 0),
       'rank', case when me.today_n = 0 then null else 1 + (select count(*) from t where today_n > me.today_n) end,
       'tied', case when me.today_n = 0 then 0 else (select count(*) from t where today_n = me.today_n) end,
       'gap', case when me.today_n = 0 then null else (select min(today_n) from t where today_n > me.today_n) - me.today_n end),
    'allTime', jsonb_build_object(
       'answers', me.total,
       'participants', (select count(*) from t where total > 0),
       'rank', case when me.total = 0 then null else 1 + (select count(*) from t where total > me.total) end,
       'tied', case when me.total = 0 then 0 else (select count(*) from t where total = me.total) end,
       'gap', case when me.total = 0 then null else (select min(total) from t where total > me.total) - me.total end)
  ) into result from me;
  return result;
end $$;

-- ============ 実行権限 ============
revoke all on function public.portal_create_profile(text)           from public, anon;
revoke all on function public.portal_regenerate_key()               from public, anon;
revoke all on function public.portal_set_nickname(text)             from public, anon;
revoke all on function public.redeem_link_key(text, text)           from public, anon;
revoke all on function public.unlink_self(text)                     from public, anon;
revoke all on function public.portal_unlink_site(text)              from public, anon;
revoke all on function public.link_status(text)                     from public, anon;
revoke all on function public.portal_me()                           from public, anon;
revoke all on function public.portal_ranking(text, text, int)       from public, anon;
revoke all on function public.get_ranking()                         from public, anon;
grant execute on function public.portal_create_profile(text)        to authenticated;
grant execute on function public.portal_regenerate_key()            to authenticated;
grant execute on function public.portal_set_nickname(text)          to authenticated;
grant execute on function public.redeem_link_key(text, text)        to authenticated;
grant execute on function public.unlink_self(text)                  to authenticated;
grant execute on function public.portal_unlink_site(text)           to authenticated;
grant execute on function public.link_status(text)                  to authenticated;
grant execute on function public.portal_me()                        to authenticated;
grant execute on function public.portal_ranking(text, text, int)    to authenticated;
grant execute on function public.get_ranking()                      to authenticated;

-- ============ BANのしかた（SQL Editor か Table Editor で） ============
-- update public.profiles set banned = true, ban_reason = '不適切なニックネームのため' where nickname = '（名前）';
-- 解除：update public.profiles set banned = false, ban_reason = null where nickname = '（名前）';
-- BANされた人は、ランキングの順位計算と一覧から外れ、ポータルに警告が表示されます。


-- ======================================================================
-- C. 古文文法サイト（kobunbunpou）の日別回答数と関数
-- ======================================================================

create table if not exists public.kobunbunpou_daily_counts (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null,                              -- 日本時間の学習日
  answers    integer not null check (answers between 0 and 100000),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
create index if not exists kobunbunpou_daily_counts_day_idx on public.kobunbunpou_daily_counts (day, user_id);

alter table public.kobunbunpou_daily_counts enable row level security;
drop policy if exists kobunbunpou_daily_counts_select_own on public.kobunbunpou_daily_counts;
create policy kobunbunpou_daily_counts_select_own on public.kobunbunpou_daily_counts for select to authenticated using (user_id = auth.uid());
revoke all on public.kobunbunpou_daily_counts from anon, authenticated, public;
grant select on public.kobunbunpou_daily_counts to authenticated;   -- 書き込みは下のRPCだけ


-- ============ 同期：{"2026-11-01": 12, "2026-10-31": 5} を受け取る ============
-- 端末は毎回「全日分」を送る。何度送っても同じ結果（冪等）。
-- 件数は減らさない（greatest）ので、古い状態が遅れて届いても巻き戻らない。
-- 不正な日付・件数の行は黙って無視する（1行のせいで全体が止まらない）。
create or replace function public.kobunbunpou_sync_daily(p_days jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  today date := (now() at time zone 'Asia/Tokyo')::date;
  k     record;
  d     date;
  c     int;
  n     int := 0;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if jsonb_typeof(p_days) <> 'object' then raise exception 'invalid payload' using errcode = '22023'; end if;

  for k in select key, value from jsonb_each_text(p_days) limit 400 loop
    begin
      d := k.key::date;
      c := k.value::int;
      continue when d < today - 400 or d > today + 1 or c < 0 or c > 100000;
      insert into public.kobunbunpou_daily_counts (user_id, day, answers)
      values (uid, d, c)
      on conflict (user_id, day) do update
         set answers = excluded.answers, updated_at = now()
       where excluded.answers > public.kobunbunpou_daily_counts.answers;
      n := n + 1;
    exception when others then
      continue;
    end;
  end loop;

  return jsonb_build_object('days', n);
end $$;


-- ============ ランキング（連携した端末をプロフィール単位でまとめる） ============
create or replace function public.kobunbunpou_get_ranking()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid       uuid := auth.uid();
  today     date := (now() at time zone 'Asia/Tokyo')::date;
  me_person uuid;
  hidden    boolean;
  result    jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;

  -- 自分の「人」：ポータルに連携済みならプロフィール、未連携なら匿名ID自身
  select coalesce(l.profile_id, uid), coalesce(p.banned, false)
    into me_person, hidden
    from (select 1) x
    left join public.user_links l on l.user_id = uid and l.site = 'kobunbunpou'
    left join public.profiles   p on p.id = l.profile_id;

  with src as (
    -- 連携済みの端末はプロフィール単位でまとめる（複数端末は合算）。BANされた人は集計から外す
    select coalesce(l.profile_id, d.user_id) as person, d.day, d.answers
    from public.kobunbunpou_daily_counts d
    left join public.user_links l on l.user_id = d.user_id and l.site = 'kobunbunpou'
    left join public.profiles   p on p.id = l.profile_id
    where coalesce(p.banned, false) = false
  ), t as (
    select person,
           sum(answers)::int as total,
           (coalesce(sum(answers) filter (where day = today), 0))::int as today_n
    from src group by person
  ), me as (
    select coalesce((select total from t where person = me_person), 0)   as total,
           coalesce((select today_n from t where person = me_person), 0) as today_n
  )
  select jsonb_build_object(
    'version', 1, 'basis', 'question-counts',
    'hidden', hidden,
    'day', to_char(today, 'YYYY-MM-DD'),
    'updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'daily', jsonb_build_object(
       'answers', me.today_n,
       'participants', (select count(*) from t where today_n > 0),
       'rank', case when me.today_n = 0 then null else 1 + (select count(*) from t where today_n > me.today_n) end,
       'tied', case when me.today_n = 0 then 0 else (select count(*) from t where today_n = me.today_n) end,
       'gap', case when me.today_n = 0 then null else (select min(today_n) from t where today_n > me.today_n) - me.today_n end),
    'allTime', jsonb_build_object(
       'answers', me.total,
       'participants', (select count(*) from t where total > 0),
       'rank', case when me.total = 0 then null else 1 + (select count(*) from t where total > me.total) end,
       'tied', case when me.total = 0 then 0 else (select count(*) from t where total = me.total) end,
       'gap', case when me.total = 0 then null else (select min(total) from t where total > me.total) - me.total end)
  ) into result from me;
  return result;
end $$;

-- ============ 実行権限 ============
revoke all on function public.kobunbunpou_sync_daily(jsonb) from public, anon;
revoke all on function public.kobunbunpou_get_ranking()    from public, anon;
grant execute on function public.kobunbunpou_sync_daily(jsonb) to authenticated;
grant execute on function public.kobunbunpou_get_ranking()    to authenticated;
-- ここまで。このファイルには、これ以外のSQLを足さない。


-- ======================================================================
-- D. 古文文法サイトの登録と、合算ビューの作り直し
-- ======================================================================

insert into public.portal_sites (site, has_counts, sort, daily_table)
values ('kobunbunpou', true, 20, 'kobunbunpou_daily_counts')
on conflict (site) do nothing;

select public.portal_rebuild_view();

-- 確認：新しいサイトが表に出る
select site, daily_table from public.portal_sites order by sort;

-- ======================================================================
-- E. 仕上がりの確認（読み取りだけ）
--    portal_sites に portal / eitango / kobunbunpou の3行が並び、
--    profiles に key_plain の列があれば成功。
-- ======================================================================
select site, has_counts, sort, daily_table from public.portal_sites order by sort;
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles' order by ordinal_position;
