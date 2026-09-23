-- ExamForge hosted beta. This migration is intended for a dedicated project.
-- Authenticated anonymous learners may inspect only their own course metadata and
-- concepts through the Data API. Answer-bearing rows and progress are server-only.

create table public.ef_courses (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  source_type text not null check (source_type in ('bundled', 'paste', 'pdf')),
  material_text text not null check (length(material_text) between 80 and 200000),
  quality_json jsonb not null,
  created_at timestamptz not null default now(),
  unique (owner_id, id)
);
create index ef_courses_owner_created_idx on public.ef_courses(owner_id, created_at desc, id desc);

create table public.ef_concepts (
  id text primary key,
  course_id text not null references public.ef_courses(id) on delete cascade,
  name text not null,
  description text not null,
  evidence_json jsonb not null,
  importance double precision not null check (importance >= 0 and importance <= 1),
  ord integer not null check (ord >= 0),
  unique (course_id, id),
  unique (course_id, ord)
);

create table public.ef_questions (
  id text primary key,
  course_id text not null references public.ef_courses(id) on delete cascade,
  concept_id text not null,
  payload_json jsonb not null,
  ord integer not null check (ord >= 0),
  foreign key (course_id, concept_id) references public.ef_concepts(course_id, id) on delete cascade,
  unique (course_id, id),
  unique (course_id, ord)
);

create table public.ef_sessions (
  id text primary key,
  course_id text not null references public.ef_courses(id) on delete cascade,
  kind text not null check (kind in ('diagnostic', 'practice', 'mock')),
  concept_id text,
  question_ids text[] not null check (array_length(question_ids, 1) > 0),
  status text not null default 'active' check (status in ('active', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  created_seq bigint generated always as identity,
  foreign key (course_id, concept_id) references public.ef_concepts(course_id, id),
  unique (course_id, id),
  check ((status = 'active' and completed_at is null) or (status = 'completed' and completed_at is not null))
);
create index ef_sessions_course_newest_idx on public.ef_sessions(course_id, created_at desc, created_seq desc);
create unique index ef_sessions_one_active_mock_idx on public.ef_sessions(course_id)
  where kind = 'mock' and status = 'active';

create table public.ef_attempts (
  id bigint generated always as identity primary key,
  session_id text not null,
  course_id text not null,
  question_id text not null,
  concept_id text not null,
  answer_json jsonb not null,
  score double precision not null check (score >= 0 and score <= 1),
  correct boolean not null,
  created_at timestamptz not null default now(),
  foreign key (course_id, session_id) references public.ef_sessions(course_id, id) on delete cascade,
  foreign key (course_id, question_id) references public.ef_questions(course_id, id) on delete cascade,
  foreign key (course_id, concept_id) references public.ef_concepts(course_id, id) on delete cascade,
  unique (session_id, question_id)
);
create index ef_attempts_course_order_idx on public.ef_attempts(course_id, created_at, id);
create index ef_attempts_session_order_idx on public.ef_attempts(session_id, id);

-- Each accepted course and its generated data commits as one transaction. The
-- server validates grounding and question semantics before calling this function.
create function public.ef_create_course(
  p_owner_id uuid,
  p_course jsonb,
  p_concepts jsonb,
  p_questions jsonb
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_course_id text := p_course->>'id';
begin
  if jsonb_typeof(p_concepts) <> 'array' or jsonb_typeof(p_questions) <> 'array'
     or jsonb_array_length(p_concepts) < 1 or jsonb_array_length(p_questions) < 3
     or not exists (select 1 from jsonb_array_elements(p_questions) q
                    where q->'payload_json'->>'type' in ('mcq', 'truefalse', 'short')) then
    raise exception 'Course does not meet assessment viability requirements';
  end if;

  -- Serialize quota checks per owner so concurrent requests cannot exceed the cap.
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
  if (select count(*) from public.ef_courses where owner_id = p_owner_id) >= 10 then
    raise exception 'The beta allows at most 10 courses per browser identity';
  end if;

  insert into public.ef_courses(id, owner_id, title, source_type, material_text, quality_json, created_at)
  values (v_course_id, p_owner_id, p_course->>'title', p_course->>'source_type',
          p_course->>'material_text', p_course->'quality_json', (p_course->>'created_at')::timestamptz);

  insert into public.ef_concepts(id, course_id, name, description, evidence_json, importance, ord)
  select c.id, v_course_id, c.name, c.description, c.evidence_json, c.importance, c.ord
  from jsonb_to_recordset(p_concepts) as c(id text, name text, description text,
    evidence_json jsonb, importance double precision, ord integer);

  insert into public.ef_questions(id, course_id, concept_id, payload_json, ord)
  select q.id, v_course_id, q.concept_id, q.payload_json, q.ord
  from jsonb_to_recordset(p_questions) as q(id text, concept_id text, payload_json jsonb, ord integer);

  return v_course_id;
end;
$$;

-- The row lock serializes answer and finish operations on the same session.
-- Both functions are callable only by the server's privileged role.
create function public.ef_submit_attempt(
  p_session_id text, p_question_id text, p_answer_json jsonb,
  p_score double precision, p_correct boolean
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_session public.ef_sessions%rowtype;
  v_concept_id text;
  v_inserted boolean;
begin
  select * into v_session from public.ef_sessions where id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if v_session.status <> 'active' then raise exception 'Session is completed'; end if;
  if not p_question_id = any(v_session.question_ids) then raise exception 'Question is not in this session'; end if;
  select concept_id into v_concept_id from public.ef_questions
    where course_id = v_session.course_id and id = p_question_id;
  if not found then raise exception 'Question not found'; end if;
  if v_session.kind <> 'mock' and exists (
    select 1 from public.ef_sessions m where m.course_id = v_session.course_id
      and m.kind = 'mock' and m.status = 'active' and p_question_id = any(m.question_ids)
  ) then
    raise exception 'Question is protected by an active mock';
  end if;

  insert into public.ef_attempts(session_id, course_id, question_id, concept_id,
    answer_json, score, correct)
  values (p_session_id, v_session.course_id, p_question_id, v_concept_id,
    p_answer_json, p_score, p_correct)
  on conflict (session_id, question_id) do nothing
  returning true into v_inserted;
  return coalesce(v_inserted, false);
end;
$$;

create function public.ef_finish_session(p_session_id text) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_session public.ef_sessions%rowtype;
begin
  select * into v_session from public.ef_sessions where id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if v_session.status = 'completed' then return false; end if;
  if v_session.kind = 'diagnostic' and exists (
    select 1 from unnest(v_session.question_ids) qid
    where not exists (select 1 from public.ef_attempts a
      where a.session_id = p_session_id and a.question_id = qid)
  ) then
    raise exception 'Answer all diagnostic questions before finishing';
  end if;
  update public.ef_sessions set status = 'completed', completed_at = now()
    where id = p_session_id;
  return true;
end;
$$;

-- Disable all implicit Data API reachability, then opt in to two owner-only
-- read surfaces. Anonymous Supabase users have the authenticated DB role.
alter table public.ef_courses enable row level security;
alter table public.ef_concepts enable row level security;
alter table public.ef_questions enable row level security;
alter table public.ef_sessions enable row level security;
alter table public.ef_attempts enable row level security;

revoke all on public.ef_courses, public.ef_concepts, public.ef_questions,
  public.ef_sessions, public.ef_attempts from anon, authenticated;
revoke all on function public.ef_create_course(uuid, jsonb, jsonb, jsonb),
  public.ef_submit_attempt(text, text, jsonb, double precision, boolean),
  public.ef_finish_session(text) from public, anon, authenticated;

grant select on public.ef_courses, public.ef_concepts to authenticated;
grant select, insert, update, delete on public.ef_courses, public.ef_concepts,
  public.ef_questions, public.ef_sessions, public.ef_attempts to service_role;
grant usage, select on sequence public.ef_sessions_created_seq_seq,
  public.ef_attempts_id_seq to service_role;
grant execute on function public.ef_create_course(uuid, jsonb, jsonb, jsonb),
  public.ef_submit_attempt(text, text, jsonb, double precision, boolean),
  public.ef_finish_session(text) to service_role;

create policy ef_courses_owner_read on public.ef_courses for select to authenticated
  using (owner_id = (select auth.uid()));
create policy ef_concepts_owner_read on public.ef_concepts for select to authenticated
  using (exists (select 1 from public.ef_courses c
    where c.id = course_id and c.owner_id = (select auth.uid())));
