-- Existing hosted rows were inspected before this forward migration. The
-- database bound also protects against a privileged caller bypassing the API.
alter table public.ef_attempts add constraint ef_attempts_answer_size_check
  check (octet_length(answer_json::text) <= 8192);

-- The browser uses only the Edge Function. Remove unnecessary direct material
-- and concept egress for learner JWTs; service_role remains the server boundary.
revoke select on public.ef_courses, public.ef_concepts from authenticated;
revoke all on sequence public.ef_sessions_created_seq_seq,
  public.ef_attempts_id_seq from anon, authenticated;
drop policy if exists ef_courses_owner_read on public.ef_courses;
drop policy if exists ef_concepts_owner_read on public.ef_concepts;

create or replace function public.ef_start_session(
  p_owner_id uuid, p_id text, p_course_id text, p_kind text,
  p_concept_id text, p_question_ids text[]
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
  if (select count(*) from public.ef_sessions where course_id = p_course_id) >= 100 then
    raise exception 'SESSION_LIMIT_REACHED';
  end if;
  if cardinality(p_question_ids) not between 1 and 8 or exists (
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
  v_payload jsonb;
  v_answer_type text;
  v_valid boolean := false;
  v_inserted boolean;
begin
  select * into v_session from public.ef_sessions where id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_session.course_id, 1));
  if v_session.status <> 'active' then raise exception 'Session is completed'; end if;
  if not p_question_id = any(v_session.question_ids) then raise exception 'Question is not in this session'; end if;
  select concept_id, payload_json into v_concept_id, v_payload from public.ef_questions
    where course_id = v_session.course_id and id = p_question_id;
  if not found then raise exception 'Question not found'; end if;
  if v_session.kind <> 'mock' and exists (
    select 1 from public.ef_sessions m where m.course_id = v_session.course_id
      and m.kind = 'mock' and m.status = 'active' and p_question_id = any(m.question_ids)
  ) then
    raise exception 'Question is protected by an active mock';
  end if;

  if jsonb_typeof(p_answer_json) = 'object'
     and octet_length(p_answer_json::text) <= 8192
     and (select count(*) from jsonb_object_keys(p_answer_json)) = 2 then
    v_answer_type := p_answer_json->>'type';
    if v_payload->>'type' = 'mcq' and v_answer_type = 'option'
       and jsonb_typeof(p_answer_json->'optionId') = 'string'
       and length(p_answer_json->>'optionId') between 1 and 64 then
      v_valid := exists (
        select 1 from jsonb_array_elements(coalesce(v_payload->'options', '[]'::jsonb)) o
        where o->>'id' = p_answer_json->>'optionId'
      );
    elsif v_payload->>'type' = 'truefalse' and v_answer_type = 'boolean'
       and jsonb_typeof(p_answer_json->'value') = 'boolean' then
      v_valid := true;
    elsif v_payload->>'type' in ('short', 'explanation') and v_answer_type = 'text'
       and jsonb_typeof(p_answer_json->'text') = 'string'
       and length(p_answer_json->>'text') <= 2000 then
      v_valid := true;
    end if;
  end if;
  if not v_valid then raise exception 'INVALID_ANSWER'; end if;

  insert into public.ef_attempts(session_id, course_id, question_id, concept_id,
    answer_json, score, correct)
  values (p_session_id, v_session.course_id, p_question_id, v_concept_id,
    p_answer_json, p_score, p_correct)
  on conflict (session_id, question_id) do nothing
  returning true into v_inserted;
  return coalesce(v_inserted, false);
end;
$$;
