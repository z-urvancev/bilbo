import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileOptimisticIntervals } from '../src/timer/optimisticIntervals.ts'

const baseSnapshot = {
  timers: [],
  state: {
    revision: 8,
    activeTimerId: 'break',
    activeStartedAt: '2026-09-25T12:37:00.000Z',
    updatedAt: '2026-09-25T12:37:00.000Z',
  },
  intervals: [],
  events: [],
  importedTotals: [],
}

const completedInterval = {
  id: 42,
  timerId: 'deep-work',
  startedAt: '2026-09-25T12:02:00.000Z',
  endedAt: '2026-09-25T12:37:00.000Z',
}

test('stale snapshot keeps a just-completed optimistic interval', () => {
  const optimistic = new Map([[completedInterval.id, completedInterval]])
  const reconciled = reconcileOptimisticIntervals(baseSnapshot, optimistic)

  assert.deepEqual(reconciled.intervals, [completedInterval])
  assert.equal(optimistic.has(completedInterval.id), true)
})

test('server-confirmed interval replaces and clears optimistic copy', () => {
  const optimistic = new Map([[completedInterval.id, completedInterval]])
  const serverInterval = { ...completedInterval }
  const reconciled = reconcileOptimisticIntervals(
    { ...baseSnapshot, intervals: [serverInterval] },
    optimistic,
  )

  assert.deepEqual(reconciled.intervals, [serverInterval])
  assert.equal(optimistic.size, 0)
})
