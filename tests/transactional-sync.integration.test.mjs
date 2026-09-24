import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'

async function applyEvent(db, userId, clientEventId, kind, payload, revision) {
  const result = await db.query(
    `select * from public.apply_habit_sync_event(
      $1::uuid,
      $2::text,
      $3::text,
      $4::jsonb,
      $5::bigint
    )`,
    [userId, clientEventId, kind, JSON.stringify(payload), revision],
  )
  return result.rows[0]
}

async function applyTimerCommand(
  db,
  clientCommandId,
  action,
  timerId,
  revision,
) {
  const result = await db.query(
    `select * from public.apply_timer_command(
      $1::text,
      $2::text,
      $3::text,
      $4::bigint
    )`,
    [clientCommandId, action, timerId, revision],
  )
  return result.rows[0]
}

test('transactional sync migration enforces CAS, idempotency and tombstones', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key, email text);
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema auth to authenticated;
      insert into auth.users (id, email) values
        ('${USER_A}', 'zahvinar358@gmail.com'),
        ('${USER_B}', 'other@example.com');
    `)

    const migrationsUrl = new URL('../supabase/migrations/', import.meta.url)
    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => name.endsWith('.sql'))
      .sort()
    for (const migrationName of migrationNames) {
      const migration = await readFile(new URL(migrationName, migrationsUrl), 'utf8')
      await db.exec(migration)
    }
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${USER_A}', false);
      set role authenticated;
    `)

    const seededTimers = await db.query(
      `select id, name from public.timer_definitions
       where user_id = $1::uuid order by sort_order`,
      [USER_A],
    )
    assert.deepEqual(
      seededTimers.rows.map((row) => row.id),
      ['deep-work', 'meeting', 'ad-hoc', 'break', 'chill-work'],
    )
    assert.deepEqual(
      Object.fromEntries(seededTimers.rows.map((row) => [row.id, row.name])),
      {
        'deep-work': 'Deep work',
        meeting: 'Meet',
        'ad-hoc': 'Ad-hoc',
        break: 'Break',
        'chill-work': 'Chill work',
      },
    )
    const seededTotals = await db.query(
      `select count(*)::int as rows, sum(duration_ms)::bigint as duration_ms
       from public.timer_daily_totals where user_id = $1::uuid`,
      [USER_A],
    )
    assert.deepEqual(seededTotals.rows[0], {
      rows: 36,
      duration_ms: 310166793,
    })

    const directStateUpdate = await db.query(
      `update public.timer_state set revision = 99
       where user_id = $1::uuid returning revision`,
      [USER_A],
    )
    assert.equal(directStateUpdate.rows.length, 0)

    await assert.rejects(
      () =>
        db.query(
          `insert into public.timer_intervals (
            user_id, timer_id, started_at, ended_at, client_command_id
          ) values ($1::uuid, 'deep-work', now() - interval '1 minute', now(), 'direct')`,
          [USER_A],
        ),
      (error) => error.code === '42501',
    )

    const timerStart = await applyTimerCommand(
      db,
      'timer-start',
      'start',
      'deep-work',
      0,
    )
    assert.equal(timerStart.applied, true)
    assert.equal(timerStart.revision, 1)
    assert.equal(timerStart.active_timer_id, 'deep-work')

    const timerDuplicate = await applyTimerCommand(
      db,
      'timer-start',
      'start',
      'deep-work',
      0,
    )
    assert.equal(timerDuplicate.applied, false)
    assert.equal(timerDuplicate.revision, 1)
    assert.equal(timerDuplicate.active_timer_id, 'deep-work')

    const timerSwitch = await applyTimerCommand(
      db,
      'timer-switch',
      'start',
      'meeting',
      1,
    )
    assert.equal(timerSwitch.applied, true)
    assert.equal(timerSwitch.revision, 2)
    assert.equal(timerSwitch.active_timer_id, 'meeting')
    assert.ok(timerSwitch.completed_interval_id)

    await assert.rejects(
      () => applyTimerCommand(db, 'timer-stale', 'stop', 'meeting', 1),
      (error) => error.code === '40001',
    )
    await assert.rejects(
      () => applyTimerCommand(db, 'timer-wrong-stop', 'stop', 'deep-work', 2),
      (error) => error.code === '40001',
    )

    const timerStop = await applyTimerCommand(
      db,
      'timer-stop',
      'stop',
      'meeting',
      2,
    )
    assert.equal(timerStop.applied, true)
    assert.equal(timerStop.revision, 3)
    assert.equal(timerStop.active_timer_id, null)
    const timerIntervals = await db.query(
      `select timer_id from public.timer_intervals
       where user_id = $1::uuid order by id`,
      [USER_A],
    )
    assert.deepEqual(
      timerIntervals.rows.map((row) => row.timer_id),
      ['deep-work', 'meeting'],
    )

    await db.query(
      `insert into public.timer_events (
        user_id, client_event_id, kind, occurred_at
      ) values ($1::uuid, 'event-1', 'interruption', now())`,
      [USER_A],
    )
    const timerEvents = await db.query(
      `select client_event_id, kind from public.timer_events
       where user_id = $1::uuid`,
      [USER_A],
    )
    assert.deepEqual(timerEvents.rows, [
      { client_event_id: 'event-1', kind: 'interruption' },
    ])
    await assert.rejects(
      () =>
        db.query(
          `insert into public.timer_events (
            user_id, client_event_id, kind, occurred_at
          ) values ($1::uuid, 'event-2', 'distraction', now())`,
          [USER_B],
        ),
      (error) => error.code === '42501',
    )
    await assert.rejects(
      () =>
        db.query(
          `insert into public.timer_events (
            user_id, client_event_id, kind, occurred_at
          ) values ($1::uuid, 'event-3', 'other', now())`,
          [USER_A],
        ),
      (error) => error.code === '23514',
    )

    const initialHabit = {
      id: 'habit-1',
      name: 'Читать',
      emoji: '📚',
      negative: false,
      monthlyGoal: 20,
      goalPeriod: 'month',
      isPriority: false,
      archived: false,
      deadline: null,
      postponedUntil: null,
    }

    await assert.rejects(
      () =>
        db.query(
          `insert into public.habits (
            id, user_id, name, emoji, negative, monthly_goal
          ) values ('direct-write', $1::uuid, 'Нельзя', '⛔', false, 1)`,
          [USER_A],
        ),
      (error) => error.code === '42501',
    )

    const initial = await applyEvent(
      db,
      USER_A,
      'initial',
      'state_snapshot',
      { habits: [initialHabit], completions: {} },
      0,
    )
    assert.equal(initial.applied, true)
    assert.equal(initial.server_revision, 1)

    const directUpdate = await db.query(
      `update public.habits set name = 'Обход RPC'
       where user_id = $1::uuid and id = 'habit-1'
       returning name`,
      [USER_A],
    )
    assert.equal(directUpdate.rows.length, 0)

    const duplicate = await applyEvent(
      db,
      USER_A,
      'initial',
      'state_snapshot',
      { habits: [initialHabit], completions: {} },
      0,
    )
    assert.equal(duplicate.applied, false)
    assert.equal(duplicate.server_revision, 1)

    await assert.rejects(
      () =>
        applyEvent(
          db,
          USER_A,
          'stale-patch',
          'habit_patch',
          { id: 'habit-1', changes: { name: 'Устаревшее имя' } },
          0,
        ),
      (error) => error.code === '40001',
    )

    await applyEvent(
      db,
      USER_A,
      'goal-patch',
      'habit_patch',
      { id: 'habit-1', changes: { monthlyGoal: 25 } },
      1,
    )
    await applyEvent(
      db,
      USER_A,
      'name-patch',
      'habit_patch',
      { id: 'habit-1', changes: { name: 'Читать ежедневно' } },
      2,
    )
    const patched = await db.query(
      `select name, monthly_goal from public.habits
       where user_id = $1::uuid and id = 'habit-1'`,
      [USER_A],
    )
    assert.deepEqual(patched.rows[0], {
      name: 'Читать ежедневно',
      monthly_goal: 25,
    })

    await applyEvent(
      db,
      USER_A,
      'delete',
      'habit_delete',
      { id: 'habit-1' },
      3,
    )
    const staleUpsert = await applyEvent(
      db,
      USER_A,
      'stale-upsert',
      'habit_upsert',
      initialHabit,
      4,
    )
    assert.equal(staleUpsert.applied, false)
    const tombstone = await db.query(
      `select deleted_at is not null as deleted from public.habits
       where user_id = $1::uuid and id = 'habit-1'`,
      [USER_A],
    )
    assert.equal(tombstone.rows[0].deleted, true)

    await assert.rejects(
      () =>
        applyEvent(
          db,
          USER_B,
          'wrong-user',
          'habit_delete',
          { id: 'habit-1' },
          0,
        ),
      (error) => error.code === '42501',
    )

    await assert.rejects(
      () =>
        applyEvent(
          db,
          USER_A,
          'invalid-snapshot',
          'state_snapshot',
          {
            habits: [],
            completions: { missing: { '2026-09-23': true } },
          },
          5,
        ),
      (error) => error.code === '22023',
    )
    const meta = await db.query(
      'select revision from public.calendar_sync_meta where user_id = $1::uuid',
      [USER_A],
    )
    assert.equal(meta.rows[0].revision, 5)
  } finally {
    await db.close()
  }
})
