-- ============================================================
-- ملاحظاتي — إعداد قاعدة بيانات Supabase
-- ------------------------------------------------------------
-- نفّذ هذا الملف كاملًا من: Supabase Dashboard → SQL Editor → New query
-- ثم اضغط Run.
--
-- ما يفعله هذا الملف:
--   1) إنشاء جدول public.notes المرتبط بحسابات Supabase Auth.
--   2) تفعيل Row Level Security (RLS) وسياسات الوصول الخاصة بكل مستخدم.
--   3) إضافة فهارس للبحث السريع.
--   4) إضافة Trigger لتحديث updated_at تلقائيًا.
--   5) إضافة دالة delete_my_account() لحذف حساب المستخدم الحالي بأمان.
--
-- مهم: لا تستخدم service_role في تطبيق الواجهة أبدًا.
-- ============================================================


-- ------------------------------------------------------------
-- 1) جدول الملاحظات
-- ------------------------------------------------------------
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  title       text not null default '',
  content     text not null default '',
  color       text not null default 'default',
  pinned      boolean not null default false,
  favorite    boolean not null default false,
  trashed     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint notes_color_check
    check (color in ('default', 'blue', 'green', 'amber', 'rose', 'violet')),

  constraint notes_title_length_check
    check (char_length(title) <= 500),

  constraint notes_content_length_check
    check (char_length(content) <= 100000)
);

comment on table public.notes is 'ملاحظات المستخدمين — كل صف مرتبط بحساب Supabase Auth.';
comment on column public.notes.user_id is 'معرّف المستخدم المالك للملاحظة (auth.users.id).';
comment on column public.notes.deleted_at is 'وقت نقل الملاحظة إلى المهملات، أو null إذا كانت نشطة.';


-- ------------------------------------------------------------
-- 2) الفهارس
-- ------------------------------------------------------------
create index if not exists notes_user_updated_idx
  on public.notes (user_id, updated_at desc);

create index if not exists notes_user_trashed_idx
  on public.notes (user_id, trashed);


-- ------------------------------------------------------------
-- 3) تفعيل RLS
-- ------------------------------------------------------------
alter table public.notes enable row level security;

-- إزالة السياسات القديمة إن وُجدت (حتى يكون السكربت قابلًا لإعادة التنفيذ)
drop policy if exists "notes_select_own" on public.notes;
drop policy if exists "notes_insert_own" on public.notes;
drop policy if exists "notes_update_own" on public.notes;
drop policy if exists "notes_delete_own" on public.notes;

-- قراءة: المستخدم يرى ملاحظاته فقط
create policy "notes_select_own"
  on public.notes
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- إضافة: لا يمكن إضافة ملاحظة إلا باسم المستخدم الحالي
create policy "notes_insert_own"
  on public.notes
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- تعديل: لا يمكن تعديل إلا ملاحظات المستخدم الحالي، ولا نقل ملكيتها
create policy "notes_update_own"
  on public.notes
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- حذف: لا يمكن حذف إلا ملاحظات المستخدم الحالي
create policy "notes_delete_own"
  on public.notes
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);


-- ------------------------------------------------------------
-- 4) الصلاحيات
-- ------------------------------------------------------------
-- منع الوصول المجهول (anon) تمامًا، والسماح للمستخدمين المسجلين فقط.
revoke all on table public.notes from anon;
revoke all on table public.notes from public;
grant select, insert, update, delete on table public.notes to authenticated;


-- ------------------------------------------------------------
-- 5) تحديث updated_at تلقائيًا
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists notes_set_updated_at on public.notes;

create trigger notes_set_updated_at
before update on public.notes
for each row
execute function public.set_updated_at();


-- ------------------------------------------------------------
-- 6) حذف حساب المستخدم الحالي
-- ------------------------------------------------------------
-- تُستدعى من التطبيق عبر: supabase.rpc('delete_my_account')
-- حذف صف auth.users يؤدي تلقائيًا إلى حذف ملاحظات المستخدم
-- بسبب ON DELETE CASCADE في جدول notes.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'not authenticated';
  end if;

  delete from auth.users
  where id = current_user_id;
end;
$$;

revoke all on function public.delete_my_account() from public;
revoke all on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;


-- ------------------------------------------------------------
-- 7) تحقق سريع (اختياري)
-- ------------------------------------------------------------
-- بعد تنفيذ السكربت، سجّل الدخول بحساب مستخدم ثم نفّذ:
--   select * from public.notes;
-- يجب أن ترى ملاحظات هذا المستخدم فقط.
--
-- وللتحقق من أن RLS مفعّل:
--   select relname, relrowsecurity
--   from pg_class
--   where oid = 'public.notes'::regclass;
-- ------------------------------------------------------------

-- إبلاغ PostgREST بإعادة تحميل مخطط قاعدة البيانات فورًا
notify pgrst, 'reload schema';
