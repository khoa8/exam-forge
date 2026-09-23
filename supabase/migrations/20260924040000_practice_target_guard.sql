-- Automatic practice targets must still match the mock-protection state when
-- the new session is inserted. The course advisory lock serializes this check
-- with mock starts; a mismatch rolls back without creating a session.
create function public.ef_start_practice_session(
  p_owner_id uuid, p_id text, p_course_id text, p_concept_id text,
  p_question_ids text[], p_expected_active_mock_id text
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_active_mock_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_course_id, 1));
  select id into v_active_mock_id from public.ef_sessions
    where course_id = p_course_id and kind = 'mock' and status = 'active';
  if v_active_mock_id is distinct from p_expected_active_mock_id then
    raise exception 'COURSE_STATE_CHANGED';
  end if;
  return public.ef_start_session(
    p_owner_id, p_id, p_course_id, 'practice', p_concept_id, p_question_ids
  );
end;
$$;

revoke all on function public.ef_start_practice_session(uuid, text, text, text, text[], text)
  from public, anon, authenticated;
grant execute on function public.ef_start_practice_session(uuid, text, text, text, text[], text)
  to service_role;
