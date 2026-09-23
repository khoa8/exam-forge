-- One SQL statement observes sessions and their attempts at the same MVCC
-- snapshot. TypeScript keeps mastery, readiness, grading and presentation.
create function public.ef_course_state(
  p_owner_id uuid, p_course_id text, p_session_id text default null
) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'sessions', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.created_at desc, s.created_seq desc)
      from public.ef_sessions s where s.course_id = c.id
    ), '[]'::jsonb),
    'attempts', coalesce((
      select jsonb_agg(
        case when p_session_id is null then jsonb_build_object(
          'id', a.id, 'session_id', a.session_id, 'question_id', a.question_id,
          'concept_id', a.concept_id, 'score', a.score,
          'created_at', a.created_at
        ) else to_jsonb(a) end
        order by a.created_at, a.id)
      from public.ef_attempts a
      where a.course_id = c.id and (p_session_id is null or a.session_id = p_session_id)
    ), '[]'::jsonb)
  )
  from public.ef_courses c
  where c.id = p_course_id and c.owner_id = p_owner_id;
$$;

revoke all on function public.ef_course_state(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ef_course_state(uuid, text, text) to service_role;
