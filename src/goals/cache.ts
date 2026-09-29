import {
  GOAL_CATEGORIES,
  GOAL_PRIORITIES,
  GOAL_STATUSES,
} from './types.ts'
import type {
  AnnualGoal,
  GoalCalendarSnapshot,
  GoalTask,
} from './types.ts'

export const GOAL_CACHE_FRESH_MS = 5 * 60 * 1000
export const GOAL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const CACHE_PREFIX = 'bilbo:goal-calendar:v1'
const CACHE_VERSION = 1

type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type GoalCalendarCacheRecord = {
  version: number
  userId: string
  year: number
  savedAt: number
  snapshot: GoalCalendarSnapshot
}

export type GoalCalendarCacheHit = {
  snapshot: GoalCalendarSnapshot
  savedAt: number
  ageMs: number
  fresh: boolean
}

type CacheOptions = {
  now?: number
  storage?: CacheStorage | null
}

const memoryCache = new Map<string, GoalCalendarCacheRecord>()

function cacheKey(userId: string, year: number): string {
  return `${CACHE_PREFIX}:${userId}:${year}`
}

function defaultStorage(): CacheStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function resolveStorage(options: CacheOptions): CacheStorage | null {
  return Object.hasOwn(options, 'storage')
    ? (options.storage ?? null)
    : defaultStorage()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAnnualGoal(
  value: unknown,
  userId: string,
  year: number,
): value is AnnualGoal {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.userId === userId &&
    value.year === year &&
    typeof value.title === 'string' &&
    GOAL_CATEGORIES.includes(value.category as AnnualGoal['category']) &&
    GOAL_PRIORITIES.includes(value.priority as AnnualGoal['priority']) &&
    GOAL_STATUSES.includes(value.status as AnnualGoal['status']) &&
    typeof value.deadline === 'string' &&
    typeof value.notes === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isGoalTask(
  value: unknown,
  userId: string,
  goalIds: Set<string>,
): value is GoalTask {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.userId === userId &&
    typeof value.goalId === 'string' &&
    goalIds.has(value.goalId) &&
    typeof value.title === 'string' &&
    typeof value.month === 'number' &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    typeof value.completed === 'boolean' &&
    typeof value.sortOrder === 'number' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isCacheRecord(
  value: unknown,
  userId: string,
  year: number,
): value is GoalCalendarCacheRecord {
  if (
    !isRecord(value) ||
    value.version !== CACHE_VERSION ||
    value.userId !== userId ||
    value.year !== year ||
    typeof value.savedAt !== 'number' ||
    !Number.isFinite(value.savedAt) ||
    !isRecord(value.snapshot) ||
    !Array.isArray(value.snapshot.goals) ||
    !Array.isArray(value.snapshot.tasks)
  ) {
    return false
  }

  const goals = value.snapshot.goals
  if (!goals.every((goal) => isAnnualGoal(goal, userId, year))) return false
  const goalIds = new Set(goals.map((goal) => goal.id))
  return value.snapshot.tasks.every((task) =>
    isGoalTask(task, userId, goalIds),
  )
}

function removeCachedRecord(key: string, storage: CacheStorage | null) {
  memoryCache.delete(key)
  try {
    storage?.removeItem(key)
  } catch {
    // Storage can be unavailable in private mode; the memory cache still works.
  }
}

export function readGoalCalendarCache(
  userId: string,
  year: number,
  options: CacheOptions = {},
): GoalCalendarCacheHit | null {
  const key = cacheKey(userId, year)
  const storage = resolveStorage(options)
  let record = memoryCache.get(key)

  if (!record && storage) {
    try {
      const serialized = storage.getItem(key)
      if (serialized) {
        const parsed: unknown = JSON.parse(serialized)
        if (isCacheRecord(parsed, userId, year)) {
          record = parsed
          memoryCache.set(key, parsed)
        } else {
          removeCachedRecord(key, storage)
        }
      }
    } catch {
      removeCachedRecord(key, storage)
    }
  }

  if (!record) return null
  const ageMs = Math.max(0, (options.now ?? Date.now()) - record.savedAt)
  if (ageMs > GOAL_CACHE_MAX_AGE_MS) {
    removeCachedRecord(key, storage)
    return null
  }

  return {
    snapshot: record.snapshot,
    savedAt: record.savedAt,
    ageMs,
    fresh: ageMs <= GOAL_CACHE_FRESH_MS,
  }
}

export function writeGoalCalendarCache(
  userId: string,
  year: number,
  snapshot: GoalCalendarSnapshot,
  options: CacheOptions = {},
): void {
  const key = cacheKey(userId, year)
  const record: GoalCalendarCacheRecord = {
    version: CACHE_VERSION,
    userId,
    year,
    savedAt: options.now ?? Date.now(),
    snapshot,
  }
  memoryCache.set(key, record)

  try {
    resolveStorage(options)?.setItem(key, JSON.stringify(record))
  } catch {
    // Quota and privacy restrictions should not break the goals screen.
  }
}

export function clearGoalCalendarCache(
  userId: string,
  year: number,
  options: CacheOptions = {},
): void {
  removeCachedRecord(cacheKey(userId, year), resolveStorage(options))
}
