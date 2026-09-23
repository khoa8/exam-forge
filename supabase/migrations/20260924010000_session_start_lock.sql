-- Serialize mock starts with answer submission for a course. The active-mock
-- uniqueness index remains the final constraint for concurrent starts.
create function public.ef_start_session(
  p_owner_id uuid,
  p_id text,
  p_course_id text,
  p_kind text,
  p_concept_id text,
  p_question_ids text[]
) returns boolean
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_course_id, 1));
  if not exists (select 1 from public.ef_courses
    where id = p_course_id and owner_id = p_owner_id) then
    raise exception 'Course not found';
  end if;
  if cardinality(p_question_ids) < 1 or exists (
    select 1 from unnest(p_question_ids) qid
    where not exists (select 1 from public.ef_questions q
      where q.course_id = p_course_id and q.id = qid)
  ) then
    raise exception 'Invalid session questions';
  end if;
  insert into public.ef_sessions(id, course_id, kind, concept_id, question_ids)
  values (p_id, p_course_id, p_kind, p_concept_id, p_question_ids);
  return true;
end;
$$;

create or replace function public.ef_submit_attempt(
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
  perform pg_advisory_xact_lock(hashtextextended(v_session.course_id, 1));
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

revoke all on function public.ef_start_session(uuid, text, text, text, text, text[])
  from public, anon, authenticated;
grant execute on function public.ef_start_session(uuid, text, text, text, text, text[])
  to service_role;
