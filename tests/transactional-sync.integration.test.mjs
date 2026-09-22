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

test('transactional sync migration enforces CAS, idempotency and tombstones', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema auth to authenticated;
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
      insert into auth.users (id) values ('${USER_A}'), ('${USER_B}');
      select set_config('request.jwt.claim.sub', '${USER_A}', false);
      set role authenticated;
    `)

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
