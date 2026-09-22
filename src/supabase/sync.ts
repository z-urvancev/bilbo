import type { Completions, Habit, Persisted } from '../types'
import { buildSeed } from '../seed'
import { supabase } from '../lib/supabase'
import {
  DataValidationError,
  parseHabit,
  parsePendingOutgoing,
  type PendingOutgoing,
} from '../validation'
import { applyEvent } from './eventReducer'
import { collectAllPages } from './pagination'

export type { PendingOutgoing } from '../validation'

export type SyncEventRow = {
  seq: number
  user_id: string
  occurred_at: string
  client_event_id: string
  kind: string
  payload: unknown
}

type DbHabitRow = {
  id: string
  user_id: string
  name: string
  emoji: string
  negative: boolean
  monthly_goal: number
  goal_period?: string | null
  is_priority?: boolean | null
  created_day?: string | null
  created_at?: string | null
  archived?: boolean
  deadline?: string | null
  postponed_until?: string | null
  deleted_at?: string | null
}

type DbMarkRow = {
  habit_id: string
  user_id?: string
  day: string
  marked?: boolean | null
}

type SyncMeta = {
  revision: number
  updatedAt: string
}

export type PushBatchResult = {
  applied: boolean
  revision: number
  version: string
}

export class SyncConflictError extends Error {
  constructor(message = 'Данные на сервере изменились. Очередь будет перестроена.') {
    super(message)
    this.name = 'SyncConflictError'
  }
}

export class PermanentSyncError extends Error {
  readonly causeValue: unknown

  constructor(message: string, causeValue?: unknown) {
    super(message)
    this.name = 'PermanentSyncError'
    this.causeValue = causeValue
  }
}

export class SyncNeedsRebaseError extends Error {
  constructor() {
    super('Очередь синхронизации не привязана к версии сервера')
    this.name = 'SyncNeedsRebaseError'
  }
}

export function isSyncConflictError(error: unknown): error is SyncConflictError {
  return error instanceof SyncConflictError
}

export function isPermanentSyncError(error: unknown): error is PermanentSyncError {
  return error instanceof PermanentSyncError
}

export function isSyncNeedsRebaseError(error: unknown): error is SyncNeedsRebaseError {
  return error instanceof SyncNeedsRebaseError
}

const HABIT_SELECT =
  'id,user_id,name,emoji,negative,monthly_goal,goal_period,is_priority,created_day,created_at,archived,deadline,postponed_until,deleted_at'
const PAGE_SIZE = 500
const CONSISTENT_READ_ATTEMPTS = 3

function dateOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null
}

function habitFromRow(row: DbHabitRow): Habit {
  const createdAt = dateOrNull(row.created_day)
  return parseHabit({
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    negative: row.negative,
    monthlyGoal: row.monthly_goal,
    goalPeriod: row.goal_period === 'week' ? 'week' : 'month',
    isPriority: row.is_priority === true,
    ...(createdAt === null ? {} : { createdAt }),
    archived: row.archived ?? false,
    deadline: row.deadline ?? null,
    postponedUntil: row.postponed_until ?? null,
  })
}

function completionsFromMarks(rows: DbMarkRow[]): Completions {
  const completions: Completions = {}
  for (const row of rows) {
    if (row.marked === false) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) {
      throw new DataValidationError(`Сервер вернул некорректную дату отметки: ${row.day}`)
    }
    if (!completions[row.habit_id]) completions[row.habit_id] = {}
    completions[row.habit_id]![row.day] = true
  }
  return completions
}

async function fetchAllLiveHabits(userId: string): Promise<DbHabitRow[]> {
  const client = supabase
  if (!client) return []
  return collectAllPages(async (from, to) => {
    const { data, error } = await client
      .from('habits')
      .select(HABIT_SELECT)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (error) throw error
    return (data ?? []) as DbHabitRow[]
  }, PAGE_SIZE)
}

async function fetchAllActiveMarks(userId: string): Promise<DbMarkRow[]> {
  const client = supabase
  if (!client) return []
  return collectAllPages(async (from, to) => {
    const { data, error } = await client
      .from('habit_marks')
      .select('habit_id,user_id,day,marked')
      .eq('user_id', userId)
      .eq('marked', true)
      .order('habit_id', { ascending: true })
      .order('day', { ascending: true })
      .range(from, to)
    if (error) throw error
    return (data ?? []) as DbMarkRow[]
  }, PAGE_SIZE)
}

async function legacyPullPersisted(userId: string): Promise<Persisted | null> {
  if (!supabase) return null
  let habitsRows: DbHabitRow[]
  try {
    habitsRows = await fetchAllLiveHabits(userId)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === '42P01' || code === 'PGRST205') return null
    throw error
  }
  if (habitsRows.length === 0) return null
  try {
    const markRows = await fetchAllActiveMarks(userId)
    return {
      habits: habitsRows.map(habitFromRow),
      completions: completionsFromMarks(markRows),
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === '42P01' || code === 'PGRST205') {
      return { habits: habitsRows.map(habitFromRow), completions: {} }
    }
    throw error
  }
}

async function fetchEventsPage(
  userId: string,
  afterSeq: number,
  limit: number,
): Promise<SyncEventRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('sync_events')
    .select('seq,user_id,occurred_at,client_event_id,kind,payload')
    .eq('user_id', userId)
    .gt('seq', afterSeq)
    .order('seq', { ascending: true })
    .limit(limit)
  if (error) {
    const code = (error as { code?: string }).code
    if (code === '42P01' || code === 'PGRST205') return []
    throw error
  }
  return (data ?? []) as SyncEventRow[]
}

export async function fetchAllEventsSince(
  userId: string,
  afterSeq: number,
): Promise<SyncEventRow[]> {
  const all: SyncEventRow[] = []
  let cursor = afterSeq
  while (true) {
    const batch = await fetchEventsPage(userId, cursor, 800)
    if (batch.length === 0) break
    all.push(...batch)
    cursor = batch[batch.length - 1]!.seq
  }
  return all
}

async function loadPersistedFromEventLog(userId: string): Promise<Persisted | null> {
  const events = await fetchAllEventsSince(userId, 0)
  if (events.length === 0) return null
  let state: Persisted = { habits: [], completions: {} }
  for (const row of events) {
    try {
      state = applyEvent(state, { kind: row.kind, payload: row.payload })
    } catch (error) {
      if (error instanceof DataValidationError) continue
      throw error
    }
  }
  return state
}

async function fetchSyncMeta(userId: string): Promise<SyncMeta | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('calendar_sync_meta')
    .select('revision,updated_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as { revision?: unknown; updated_at?: unknown }
  if (
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    typeof row.updated_at !== 'string'
  ) {
    throw new DataValidationError('Сервер вернул некорректную версию синхронизации')
  }
  return { revision: row.revision as number, updatedAt: row.updated_at }
}

async function fetchServerPersistedStable(
  userId: string,
): Promise<{ state: Persisted; meta: SyncMeta }> {
  for (let attempt = 0; attempt < CONSISTENT_READ_ATTEMPTS; attempt += 1) {
    const before = await fetchSyncMeta(userId)
    if (!before) throw new SyncConflictError('Состояние сервера ещё не инициализировано')
    const [habitRows, markRows] = await Promise.all([
      fetchAllLiveHabits(userId),
      fetchAllActiveMarks(userId),
    ])
    const after = await fetchSyncMeta(userId)
    if (after && before.revision === after.revision) {
      const habits = habitRows.map(habitFromRow)
      const liveIds = new Set(habits.map((habit) => habit.id))
      const validMarks = markRows.filter((mark) => liveIds.has(mark.habit_id))
      return {
        state: { habits, completions: completionsFromMarks(validMarks) },
        meta: after,
      }
    }
  }
  throw new SyncConflictError(
    'Серверное состояние постоянно меняется; чтение будет повторено позже',
  )
}

type RpcResultRow = {
  applied?: unknown
  server_revision?: unknown
  server_updated_at?: unknown
}

async function applyServerEvent(
  userId: string,
  pending: PendingOutgoing,
): Promise<PushBatchResult> {
  if (!supabase) return { applied: false, revision: 0, version: '' }
  let event: PendingOutgoing
  try {
    event = parsePendingOutgoing(pending)
  } catch (error) {
    if (error instanceof DataValidationError) {
      throw new PermanentSyncError(error.message, error)
    }
    throw error
  }
  if (event.expected_revision === undefined) throw new SyncNeedsRebaseError()

  const { data, error } = await supabase.rpc('apply_habit_sync_event', {
    p_user_id: userId,
    p_client_event_id: event.client_event_id,
    p_kind: event.kind,
    p_payload: event.payload,
    p_expected_revision: event.expected_revision,
  })
  if (error) {
    const code = (error as { code?: string }).code
    if (code === '40001') throw new SyncConflictError()
    if (code === '22023' || code === '22007' || code === '22008') {
      throw new PermanentSyncError(error.message, error)
    }
    throw error
  }
  const raw = Array.isArray(data) ? data[0] : data
  const row = (raw ?? {}) as RpcResultRow
  if (
    typeof row.applied !== 'boolean' ||
    !Number.isSafeInteger(row.server_revision) ||
    (row.server_revision as number) < 0 ||
    typeof row.server_updated_at !== 'string'
  ) {
    throw new DataValidationError('RPC вернул некорректную версию синхронизации')
  }
  return {
    applied: row.applied,
    revision: row.server_revision as number,
    version: row.server_updated_at,
  }
}

async function ensureServerStateInitialized(userId: string): Promise<void> {
  if (!supabase) return
  const meta = await fetchSyncMeta(userId)
  if (meta) return

  const fromEvents = await loadPersistedFromEventLog(userId)
  const fromLegacyTables = fromEvents ?? (await legacyPullPersisted(userId))
  const initialState = fromLegacyTables ?? buildSeed(new Date())
  try {
    await applyServerEvent(userId, {
      client_event_id: 'sync-v3-initial-state',
      kind: 'state_snapshot',
      payload: initialState,
      expected_revision: 0,
    })
  } catch (error) {
    if (!isSyncConflictError(error)) throw error
  }
}

export async function fetchServerSyncVersion(userId: string): Promise<string | null> {
  const meta = await fetchSyncMeta(userId)
  return meta?.updatedAt ?? null
}

export async function pushEventBatch(
  userId: string,
  batch: PendingOutgoing[],
): Promise<PushBatchResult | null> {
  if (!supabase || batch.length === 0) return null
  await ensureServerStateInitialized(userId)
  let result: PushBatchResult | null = null
  for (const item of batch) {
    result = await applyServerEvent(userId, item)
  }
  return result
}

export async function loadPersistedFromEvents(
  userId: string,
): Promise<{
  state: Persisted
  lastSeq: number
  version: string | null
  revision: number
}> {
  if (!supabase) {
    return {
      state: buildSeed(new Date()),
      lastSeq: 0,
      version: null,
      revision: 0,
    }
  }
  await ensureServerStateInitialized(userId)
  const { state, meta } = await fetchServerPersistedStable(userId)
  return {
    state,
    lastSeq: 0,
    version: meta.updatedAt,
    revision: meta.revision,
  }
}

export function subscribeToSyncEvents(
  userId: string,
  onNewData: () => void,
): () => void {
  const client = supabase
  if (!client) return () => {}
  const channel = client
    .channel(`calendar_state:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'habits',
        filter: `user_id=eq.${userId}`,
      },
      onNewData,
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'habit_marks',
        filter: `user_id=eq.${userId}`,
      },
      onNewData,
    )
    .subscribe()
  return () => {
    void client.removeChannel(channel)
  }
}

export { applyEvent } from './eventReducer'
