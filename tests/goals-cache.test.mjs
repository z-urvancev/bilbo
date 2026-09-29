import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GOAL_CACHE_FRESH_MS,
  GOAL_CACHE_MAX_AGE_MS,
  clearGoalCalendarCache,
  readGoalCalendarCache,
  writeGoalCalendarCache,
} from '../src/goals/cache.ts'

class MemoryStorage {
  values = new Map()

  getItem(key) {
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.values.set(key, value)
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

function snapshot(userId, year) {
  return {
    goals: [
      {
        id: 'goal-1',
        userId,
        year,
        title: 'Кэшируемая цель',
        category: 'career',
        priority: 'high',
        status: 'in_progress',
        deadline: `${year}-12-31`,
        notes: '',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    tasks: [
      {
        id: 'task-1',
        userId,
        goalId: 'goal-1',
        title: 'Первая задача',
        month: 1,
        monthBlock: null,
        completed: false,
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  }
}

test('goals cache returns fresh user/year snapshot', () => {
  const storage = new MemoryStorage()
  const userId = 'cache-user-fresh'
  const year = 2026
  const now = 1_000_000
  const expected = snapshot(userId, year)

  writeGoalCalendarCache(userId, year, expected, { storage, now })
  const hit = readGoalCalendarCache(userId, year, {
    storage,
    now: now + GOAL_CACHE_FRESH_MS,
  })

  assert.deepEqual(hit?.snapshot, expected)
  assert.equal(hit?.fresh, true)
  assert.equal(readGoalCalendarCache('another-user', year, { storage, now }), null)
  assert.equal(readGoalCalendarCache(userId, year + 1, { storage, now }), null)
})

test('goals cache serves stale data for background refresh and drops expired data', () => {
  const storage = new MemoryStorage()
  const userId = 'cache-user-stale'
  const year = 2026
  const now = 2_000_000

  writeGoalCalendarCache(userId, year, snapshot(userId, year), {
    storage,
    now,
  })

  const stale = readGoalCalendarCache(userId, year, {
    storage,
    now: now + GOAL_CACHE_FRESH_MS + 1,
  })
  assert.equal(stale?.fresh, false)

  const expired = readGoalCalendarCache(userId, year, {
    storage,
    now: now + GOAL_CACHE_MAX_AGE_MS + 1,
  })
  assert.equal(expired, null)
})

test('goals cache rejects malformed persisted data', () => {
  const storage = new MemoryStorage()
  const userId = 'cache-user-invalid'
  const year = 2026
  const key = `bilbo:goal-calendar:v2:${userId}:${year}`
  storage.setItem(key, JSON.stringify({ version: 2, userId, year }))

  clearGoalCalendarCache(userId, year, { storage })
  storage.setItem(key, '{broken json')

  assert.equal(readGoalCalendarCache(userId, year, { storage }), null)
  assert.equal(storage.getItem(key), null)
})

test('goals cache rejects an invalid month block', () => {
  const storage = new MemoryStorage()
  const userId = 'cache-user-block'
  const year = 2026
  const invalid = snapshot(userId, year)
  invalid.tasks[0].monthBlock = 5

  storage.setItem(
    `bilbo:goal-calendar:v2:${userId}:${year}`,
    JSON.stringify({ version: 2, userId, year, savedAt: Date.now(), snapshot: invalid }),
  )

  assert.equal(readGoalCalendarCache(userId, year, { storage }), null)
})
