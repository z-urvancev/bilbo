import { supabase } from '../lib/supabase'
import type {
  TimerCommandResult,
  TimerDailyTotal,
  TimerDefinition,
  TimerEvent,
  TimerEventKind,
  TimerInterval,
  TimerPeriod,
  TimerSnapshot,
  TimerState,
} from './types'

type DbTimerDefinition = {
  id: string
  user_id: string
  name: string
  color: string
  icon: string
  sort_order: number
  created_at: string
}

type DbTimerState = {
  revision: number
  active_timer_id: string | null
  active_started_at: string | null
  updated_at: string
}

type DbTimerInterval = {
  id: number
  timer_id: string
  started_at: string
  ended_at: string
}

type DbTimerEvent = {
  client_event_id: string
  kind: TimerEventKind
  occurred_at: string
}

type DbDailyTotal = {
  timer_id: string
  day: string
  duration_ms: number
  source: string
}

type DbTimerCommandResult = {
  applied: boolean
  revision: number
  active_timer_id: string | null
  active_started_at: string | null
  completed_interval_id: number | null
  server_updated_at: string
}

const TIMER_READ_TIMEOUT_MS = 15_000
const CURRENT_WEEK_CACHE_TTL_MS = 60_000
const HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_HISTORICAL_CACHE_ENTRIES = 32
const PERSISTED_CURRENT_WEEK_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PERSISTED_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TIMER_CACHE_STORAGE_PREFIX = 'habit-calendar:timer-cache:v1:'

type DbTimerSnapshot = {
  definitions: DbTimerDefinition[]
  state: DbTimerState | null
  intervals: DbTimerInterval[]
  events: DbTimerEvent[]
  daily_totals: DbDailyTotal[]
}

type TimerWeekCacheEntry = {
  expiresAt: number
  snapshot: TimerSnapshot
}

type PersistedTimerCacheEntry = {
  key: string
  savedAt: number
  snapshot: TimerSnapshot
}

const currentWeekCache = new Map<string, TimerWeekCacheEntry>()
const currentWeekRequests = new Map<string, Promise<TimerSnapshot>>()
const currentWeekCacheEpoch = new Map<string, number>()
const historicalSnapshotCache = new Map<string, TimerWeekCacheEntry>()

function isTimerSnapshot(value: unknown): value is TimerSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<TimerSnapshot>
  return (
    Array.isArray(snapshot.timers) &&
    Array.isArray(snapshot.intervals) &&
    Array.isArray(snapshot.events) &&
    Array.isArray(snapshot.importedTotals) &&
    Boolean(snapshot.state && typeof snapshot.state === 'object')
  )
}

function timerCacheStorageKey(userId: string): string {
  return `${TIMER_CACHE_STORAGE_PREFIX}${userId}`
}

function readPersistedTimerCache(userId: string): PersistedTimerCacheEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(timerCacheStorageKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is PersistedTimerCacheEntry => {
      if (!entry || typeof entry !== 'object') return false
      const candidate = entry as Partial<PersistedTimerCacheEntry>
      return (
        typeof candidate.key === 'string' &&
        typeof candidate.savedAt === 'number' &&
        isTimerSnapshot(candidate.snapshot)
      )
    })
  } catch {
    return []
  }
}

function persistTimerSnapshot(
  userId: string,
  key: string,
  snapshot: TimerSnapshot,
): void {
  try {
    const entries = readPersistedTimerCache(userId).filter(
      (entry) => entry.key !== key,
    )
    entries.push({ key, savedAt: Date.now(), snapshot })
    globalThis.localStorage?.setItem(
      timerCacheStorageKey(userId),
      JSON.stringify(entries.slice(-MAX_HISTORICAL_CACHE_ENTRIES)),
    )
  } catch {
    // Cache persistence is best-effort; network data remains authoritative.
  }
}

function readPersistedTimerSnapshot(
  userId: string,
  key: string,
  maxAgeMs: number,
): TimerSnapshot | null {
  const now = Date.now()
  const entry = readPersistedTimerCache(userId).find(
    (candidate) => candidate.key === key,
  )
  if (!entry || now - entry.savedAt > maxAgeMs) return null
  return entry.snapshot
}

function cacheHistoricalSnapshot(
  key: string,
  snapshot: TimerSnapshot,
): void {
  const now = Date.now()
  for (const [cachedKey, cached] of historicalSnapshotCache) {
    if (cached.expiresAt <= now) historicalSnapshotCache.delete(cachedKey)
  }
  while (historicalSnapshotCache.size >= MAX_HISTORICAL_CACHE_ENTRIES) {
    const oldestKey = historicalSnapshotCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    historicalSnapshotCache.delete(oldestKey)
  }
  historicalSnapshotCache.set(key, {
    expiresAt: now + HISTORICAL_CACHE_TTL_MS,
    snapshot,
  })
}

export class TimerApiError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'TimerApiError'
    this.code = code
  }
}

function ensureClient() {
  if (!supabase) throw new TimerApiError('Supabase не настроен')
  return supabase
}

function throwApiError(error: { message?: string; code?: string } | null) {
  if (!error) return
  throw new TimerApiError(error.message || 'Ошибка Supabase', error.code)
}

async function withTimerReadTimeout<T>(
  label: string,
  read: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    TIMER_READ_TIMEOUT_MS,
  )
  try {
    const result = await read(controller.signal)
    if (controller.signal.aborted) {
      throw new TimerApiError(
        `Не удалось загрузить ${label}: превышено время ожидания.`,
        'TIMER_READ_TIMEOUT',
      )
    }
    return result
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TimerApiError(
        `Не удалось загрузить ${label}: превышено время ожидания.`,
        'TIMER_READ_TIMEOUT',
      )
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

function localDateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function timerRangeBounds(
  dayKey: string,
  period: TimerPeriod = 'day',
): { start: Date; end: Date } {
  const [year, month, day] = dayKey.split('-').map(Number)
  const start = new Date(year!, month! - 1, day!)
  if (period === 'week') {
    const weekdayFromMonday = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - weekdayFromMonday)
  }
  const end = new Date(start)
  end.setDate(start.getDate() + (period === 'week' ? 7 : 1))
  return { start, end }
}

function definitionFromRow(row: DbTimerDefinition): TimerDefinition {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }
}

function intervalFromRow(row: DbTimerInterval): TimerInterval {
  return {
    id: row.id,
    timerId: row.timer_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

function eventFromRow(row: DbTimerEvent): TimerEvent {
  return {
    clientEventId: row.client_event_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
  }
}

function stateFromRow(row: DbTimerState | null): TimerState {
  return row
    ? {
        revision: row.revision,
        activeTimerId: row.active_timer_id,
        activeStartedAt: row.active_started_at,
        updatedAt: row.updated_at,
      }
    : {
        revision: 0,
        activeTimerId: null,
        activeStartedAt: null,
        updatedAt: null,
      }
}

function snapshotFromRow(payload: DbTimerSnapshot): TimerSnapshot {
  return {
    timers: (payload.definitions ?? []).map(definitionFromRow),
    state: stateFromRow(payload.state ?? null),
    intervals: (payload.intervals ?? []).map(intervalFromRow),
    events: (payload.events ?? []).map(eventFromRow),
    importedTotals: (payload.daily_totals ?? []).map(
      (row): TimerDailyTotal => ({
        timerId: row.timer_id,
        day: row.day,
        durationMs: row.duration_ms,
        source: row.source,
      }),
    ),
  }
}

function timerWeekCacheKey(userId: string, dayKey: string): string {
  return `${userId}:${localDateKey(timerRangeBounds(dayKey, 'week').start)}`
}

function historicalCacheKey(
  userId: string,
  dayKey: string,
  period: TimerPeriod,
): string {
  const rangeStart = localDateKey(timerRangeBounds(dayKey, period).start)
  return `${userId}:${period}:${rangeStart}`
}

function isCurrentTimerWeek(dayKey: string): boolean {
  return (
    localDateKey(timerRangeBounds(dayKey, 'week').start) ===
    localDateKey(timerRangeBounds(localDateKey(new Date()), 'week').start)
  )
}

export function getCachedTimerSnapshot(
  userId: string,
  dayKey: string,
  period: TimerPeriod,
): TimerSnapshot | null {
  if (isCurrentTimerWeek(dayKey)) {
    const key = timerWeekCacheKey(userId, dayKey)
    const memory = currentWeekCache.get(key)
    if (memory && memory.expiresAt > Date.now()) {
      return snapshotForPeriod(memory.snapshot, dayKey, period)
    }
    const persisted = readPersistedTimerSnapshot(
      userId,
      historicalCacheKey(userId, dayKey, 'week'),
      PERSISTED_CURRENT_WEEK_MAX_AGE_MS,
    )
    return persisted ? snapshotForPeriod(persisted, dayKey, period) : null
  }

  const historicalWeekKey = historicalCacheKey(userId, dayKey, 'week')
  const historicalWeek = historicalSnapshotCache.get(historicalWeekKey)
  if (historicalWeek && historicalWeek.expiresAt > Date.now()) {
    return snapshotForPeriod(historicalWeek.snapshot, dayKey, period)
  }
  const persistedWeek = readPersistedTimerSnapshot(
    userId,
    historicalWeekKey,
    PERSISTED_HISTORY_MAX_AGE_MS,
  )
  if (persistedWeek) return snapshotForPeriod(persistedWeek, dayKey, period)

  const exactKey = historicalCacheKey(userId, dayKey, period)
  const exact = historicalSnapshotCache.get(exactKey)
  if (exact && exact.expiresAt > Date.now()) return exact.snapshot
  return readPersistedTimerSnapshot(
    userId,
    exactKey,
    PERSISTED_HISTORY_MAX_AGE_MS,
  )
}

function snapshotForPeriod(
  snapshot: TimerSnapshot,
  dayKey: string,
  period: TimerPeriod,
): TimerSnapshot {
  if (period === 'week') return snapshot
  const { start, end } = timerRangeBounds(dayKey, 'day')
  const startMs = start.getTime()
  const endMs = end.getTime()
  const startDay = localDateKey(start)
  const endDay = localDateKey(end)
  return {
    ...snapshot,
    intervals: snapshot.intervals.filter(
      (interval) =>
        new Date(interval.startedAt).getTime() < endMs &&
        new Date(interval.endedAt).getTime() > startMs,
    ),
    events: snapshot.events.filter((event) => {
      const occurredAt = new Date(event.occurredAt).getTime()
      return occurredAt >= startMs && occurredAt < endMs
    }),
    importedTotals: snapshot.importedTotals.filter(
      (total) => total.day >= startDay && total.day < endDay,
    ),
  }
}

async function fetchTimerRangeSnapshot(
  dayKey: string,
  period: TimerPeriod,
): Promise<TimerSnapshot> {
  const client = ensureClient()
  const { start, end } = timerRangeBounds(dayKey, period)
  const { data, error } = await withTimerReadTimeout(
    period === 'day' ? 'данные за день' : 'данные за неделю',
    (signal) =>
      client
        .rpc('get_timer_snapshot', {
          p_start: start.toISOString(),
          p_end: end.toISOString(),
          p_start_day: localDateKey(start),
          p_end_day: localDateKey(end),
        })
        .abortSignal(signal),
  )
  throwApiError(error)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TimerApiError('Сервер не вернул снимок таймеров')
  }
  return snapshotFromRow(data as unknown as DbTimerSnapshot)
}

async function loadCurrentWeek(
  userId: string,
  dayKey: string,
): Promise<TimerSnapshot> {
  const key = timerWeekCacheKey(userId, dayKey)
  const cached = currentWeekCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot
  const pending = currentWeekRequests.get(key)
  if (pending) return pending

  const epoch = currentWeekCacheEpoch.get(userId) ?? 0
  const request = fetchTimerRangeSnapshot(dayKey, 'week')
    .then((snapshot) => {
      if ((currentWeekCacheEpoch.get(userId) ?? 0) === epoch) {
        currentWeekCache.set(key, {
          expiresAt: Date.now() + CURRENT_WEEK_CACHE_TTL_MS,
          snapshot,
        })
        persistTimerSnapshot(
          userId,
          historicalCacheKey(userId, dayKey, 'week'),
          snapshot,
        )
      }
      return snapshot
    })
    .finally(() => {
      if (currentWeekRequests.get(key) === request) {
        currentWeekRequests.delete(key)
      }
    })
  currentWeekRequests.set(key, request)
  return request
}

export function invalidateTimerSnapshotCache(
  userId: string,
  includeHistorical = false,
): void {
  currentWeekCacheEpoch.set(userId, (currentWeekCacheEpoch.get(userId) ?? 0) + 1)
  for (const key of currentWeekCache.keys()) {
    if (key.startsWith(`${userId}:`)) currentWeekCache.delete(key)
  }
  for (const key of currentWeekRequests.keys()) {
    if (key.startsWith(`${userId}:`)) currentWeekRequests.delete(key)
  }
  if (includeHistorical) {
    for (const key of historicalSnapshotCache.keys()) {
      if (key.startsWith(`${userId}:`)) historicalSnapshotCache.delete(key)
    }
    try {
      globalThis.localStorage?.removeItem(timerCacheStorageKey(userId))
    } catch {
      // A blocked storage backend must not break live synchronization.
    }
  }
}

export async function fetchTimerSnapshot(
  userId: string,
  dayKey: string,
  period: TimerPeriod = 'day',
): Promise<TimerSnapshot> {
  if (isCurrentTimerWeek(dayKey)) {
    const key = timerWeekCacheKey(userId, dayKey)
    const cached = currentWeekCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return snapshotForPeriod(cached.snapshot, dayKey, period)
    }
    const currentWeek = await loadCurrentWeek(userId, dayKey)
    return snapshotForPeriod(currentWeek, dayKey, period)
  } else {
    const historicalWeek = historicalSnapshotCache.get(
      historicalCacheKey(userId, dayKey, 'week'),
    )
    if (historicalWeek && historicalWeek.expiresAt > Date.now()) {
      return snapshotForPeriod(historicalWeek.snapshot, dayKey, period)
    }
    const historicalExact = historicalSnapshotCache.get(
      historicalCacheKey(userId, dayKey, period),
    )
    if (historicalExact && historicalExact.expiresAt > Date.now()) {
      return historicalExact.snapshot
    }
  }

  const snapshot = await fetchTimerRangeSnapshot(dayKey, period)
  if (!isCurrentTimerWeek(dayKey)) {
    cacheHistoricalSnapshot(
      historicalCacheKey(userId, dayKey, period),
      snapshot,
    )
    persistTimerSnapshot(
      userId,
      historicalCacheKey(userId, dayKey, period),
      snapshot,
    )
  }
  return snapshot
}

export async function recordTimerEvent(input: {
  userId: string
  clientEventId: string
  kind: TimerEventKind
  occurredAt: string
}): Promise<TimerEvent> {
  const client = ensureClient()
  const { error } = await withTimerReadTimeout(
    'разовую метку',
    (signal) =>
      client
        .from('timer_events')
        .insert({
          user_id: input.userId,
          client_event_id: input.clientEventId,
          kind: input.kind,
          occurred_at: input.occurredAt,
        })
        .abortSignal(signal),
  )
  if (error?.code !== '23505') throwApiError(error)
  return {
    clientEventId: input.clientEventId,
    kind: input.kind,
    occurredAt: input.occurredAt,
  }
}

export async function applyTimerCommand(input: {
  clientCommandId: string
  action: 'start' | 'stop'
  timerId: string | null
  expectedRevision: number
}): Promise<TimerCommandResult> {
  const client = ensureClient()
  const { data, error } = await withTimerReadTimeout(
    'команду таймера',
    (signal) =>
      client
        .rpc('apply_timer_command', {
          p_client_command_id: input.clientCommandId,
          p_action: input.action,
          p_timer_id: input.timerId,
          p_expected_revision: input.expectedRevision,
        })
        .abortSignal(signal),
  )
  throwApiError(error)
  const row = (data?.[0] ?? null) as DbTimerCommandResult | null
  if (!row) throw new TimerApiError('Сервер не вернул состояние таймера')
  return {
    applied: row.applied,
    revision: row.revision,
    activeTimerId: row.active_timer_id,
    activeStartedAt: row.active_started_at,
    completedIntervalId: row.completed_interval_id,
    updatedAt: row.server_updated_at,
  }
}

export function isTimerConflict(error: unknown): boolean {
  return error instanceof TimerApiError && error.code === '40001'
}

export function timerErrorText(error: unknown): string {
  if (error instanceof TimerApiError) {
    if (error.code === '23505') return 'Таймер с таким названием уже существует.'
    if (error.code === '40001') return 'Таймер изменился на другом устройстве.'
    return error.message
  }
  return error instanceof Error ? error.message : 'Неизвестная ошибка таймера'
}
