import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DataValidationError,
  parsePendingOutgoing,
  parsePersisted,
} from '../src/validation.ts'
import {
  acknowledgePendingHead,
  convertHabitUpsertToPatch,
  nextExpectedRevision,
  rebasePendingItems,
} from '../src/supabase/pendingQueue.ts'
import { applyEvent } from '../src/supabase/eventReducer.ts'
import { collectAllPages } from '../src/supabase/pagination.ts'

const habit = {
  id: 'habit-1',
  name: 'Читать',
  emoji: '📚',
  negative: false,
  monthlyGoal: 20,
  goalPeriod: 'month',
}

test('parsePersisted validates and normalizes saved state', () => {
  const state = parsePersisted({
    habits: [habit],
    completions: {
      'habit-1': {
        '2026-09-22': true,
        '2026-09-23': false,
      },
    },
  })

  assert.deepEqual(state.completions, {
    'habit-1': { '2026-09-22': true },
  })
  assert.equal(state.habits[0].archived, false)
})

test('parsePersisted rejects impossible dates and orphan marks', () => {
  assert.throws(
    () =>
      parsePersisted({
        habits: [habit],
        completions: { 'habit-1': { '2026-02-30': true } },
      }),
    DataValidationError,
  )
  assert.throws(
    () =>
      parsePersisted({
        habits: [habit],
        completions: { missing: { '2026-09-22': true } },
      }),
    DataValidationError,
  )
})

test('pending event validation rejects poison queue entries', () => {
  assert.throws(
    () =>
      parsePendingOutgoing({
        client_event_id: 'event-1',
        kind: 'mark_set',
        payload: {
          habitId: 'habit-1',
          dayKey: 'not-a-date',
          marked: true,
        },
      }),
    DataValidationError,
  )
})

test('queue revisions are deterministic and acknowledgements are isolated', () => {
  const queueA = {
    userId: 'user-a',
    items: [
      parsePendingOutgoing({
        client_event_id: 'a-1',
        kind: 'habit_upsert',
        payload: habit,
      }),
      parsePendingOutgoing({
        client_event_id: 'a-2',
        kind: 'mark_set',
        payload: {
          habitId: 'habit-1',
          dayKey: '2026-09-22',
          marked: true,
        },
      }),
    ],
  }
  const queueB = {
    userId: 'user-b',
    items: [
      parsePendingOutgoing({
        client_event_id: 'b-1',
        kind: 'habit_upsert',
        payload: { ...habit, id: 'habit-b' },
      }),
    ],
  }

  queueA.items = rebasePendingItems(queueA.items, 7)
  queueB.items = rebasePendingItems(queueB.items, 2)

  assert.deepEqual(
    queueA.items.map((item) => item.expected_revision),
    [7, 8],
  )
  assert.equal(nextExpectedRevision(queueA.items, 7), 9)
  assert.equal(acknowledgePendingHead(queueA, 'a-1'), true)
  assert.equal(queueA.items[0].client_event_id, 'a-2')
  assert.equal(queueB.items[0].client_event_id, 'b-1')
})

test('habit edits become field patches and preserve concurrent remote fields', () => {
  const desired = { ...habit, name: 'Читать ежедневно' }
  const event = convertHabitUpsertToPatch(
    parsePendingOutgoing({
      client_event_id: 'patch-1',
      kind: 'habit_upsert',
      payload: desired,
    }),
    habit,
  )
  assert.equal(event?.kind, 'habit_patch')
  assert.deepEqual(event?.payload, {
    id: 'habit-1',
    changes: { name: 'Читать ежедневно' },
  })

  const remoteHabit = { ...habit, monthlyGoal: 25 }
  const merged = applyEvent(
    { habits: [remoteHabit], completions: {} },
    event,
  )
  assert.equal(merged.habits[0].name, 'Читать ежедневно')
  assert.equal(merged.habits[0].monthlyGoal, 25)
})

test('pagination reads all rows beyond the Supabase default row cap', async () => {
  const source = Array.from({ length: 1001 }, (_, index) => index)
  const ranges = []
  const rows = await collectAllPages(async (from, to) => {
    ranges.push([from, to])
    return source.slice(from, to + 1)
  }, 500)

  assert.equal(rows.length, 1001)
  assert.deepEqual(ranges, [
    [0, 499],
    [500, 999],
    [1000, 1499],
  ])
})
