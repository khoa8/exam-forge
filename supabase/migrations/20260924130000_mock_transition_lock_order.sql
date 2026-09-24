-- Every hosted session transition takes the course advisory lock before a
-- session row lock. The initial course_id read is only a lock key; status and
-- question membership are re-read after both locks under READ COMMITTED.
-- This serializes mock completion with practice's active-mock recheck while
-- avoiding a row -> advisory / advisory -> row deadlock cycle.
create or replace function public.ef_submit_attempt(
  p_session_id text, p_question_id text, p_answer_json jsonb,
  p_score double precision, p_correct boolean
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_course_id text;
  v_session public.ef_sessions%rowtype;
  v_concept_id text;
  v_payload jsonb;
  v_answer_type text;
  v_valid boolean := false;
  v_inserted boolean;
begin
  select course_id into v_course_id from public.ef_sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_course_id, 1));
  select * into v_session from public.ef_sessions where id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if v_session.course_id is distinct from v_course_id then raise exception 'COURSE_STATE_CHANGED'; end if;
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

create or replace function public.ef_finish_session(p_session_id text) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_course_id text;
  v_session public.ef_sessions%rowtype;
begin
  select course_id into v_course_id from public.ef_sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_course_id, 1));
  select * into v_session from public.ef_sessions where id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if v_session.course_id is distinct from v_course_id then raise exception 'COURSE_STATE_CHANGED'; end if;
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

revoke all on function public.ef_submit_attempt(text, text, jsonb, double precision, boolean),
  public.ef_finish_session(text) from public, anon, authenticated;
grant execute on function public.ef_submit_attempt(text, text, jsonb, double precision, boolean),
  public.ef_finish_session(text) to service_role;
