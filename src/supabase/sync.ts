import type { Completions, Habit, Persisted } from '../types'
import { buildSeed } from '../seed'
import { supabase } from '../lib/supabase'
import { applyEvent } from './eventReducer'

export type SyncEventRow = {
  seq: number
  user_id: string
  occurred_at: string
  client_event_id: string
  kind: string
  payload: unknown
}

export type PendingOutgoing = {
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
  user_id: string
  day: string
  marked?: boolean | null
}

const HABIT_SELECT =
  'id,user_id,name,emoji,negative,monthly_goal,goal_period,is_priority,created_day,created_at,archived,deadline,postponed_until,deleted_at'

function dateOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null
}

function habitFromRow(r: DbHabitRow): Habit {
  const createdAt = dateOrNull(r.created_day)
  return {
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    negative: r.negative,
    monthlyGoal: r.monthly_goal,
    goalPeriod: r.goal_period === 'week' ? 'week' : 'month',
    isPriority: r.is_priority === true,
    createdAt: createdAt ?? undefined,
    archived: r.archived ?? false,
    deadline: r.deadline ?? null,
    postponedUntil: r.postponed_until ?? null,
  }
}

function habitToRow(userId: string, h: Habit) {
  return {
    id: h.id,
    user_id: userId,
    name: h.name,
    emoji: h.emoji || '🎯',
    negative: h.negative,
    monthly_goal: h.monthlyGoal,
    goal_period: h.goalPeriod === 'week' ? 'week' : 'month',
    is_priority: h.isPriority === true,
    created_day: dateOrNull(h.createdAt),
    archived: h.archived === true,
    deadline: dateOrNull(h.deadline),
    postponed_until: dateOrNull(h.postponedUntil),
    deleted_at: null,
  }
}

function completionsFromMarks(rows: DbMarkRow[]): Completions {
  const c: Completions = {}
  for (const row of rows) {
    if (row.marked === false) continue
    if (!c[row.habit_id]) c[row.habit_id] = {}
    c[row.habit_id]![row.day] = true
  }
  return c
}

async function legacyPullPersisted(userId: string): Promise<Persisted | null> {
  if (!supabase) return null
  const { data: hRows, error: e1 } = await supabase
    .from('habits')
    .select(HABIT_SELECT)
    .eq('user_id', userId)
    .is('deleted_at', null)
  if (e1) {
    const code = (e1 as { code?: string }).code
    if (code === '42P01' || code === 'PGRST205') return null
    throw e1
  }
  if (!hRows?.length) return null
  const { data: mRows, error: e2 } = await supabase
    .from('habit_marks')
    .select('habit_id,user_id,day,marked')
    .eq('user_id', userId)
    .eq('marked', true)
  if (e2) {
    const code = (e2 as { code?: string }).code
    if (code === '42P01' || code === 'PGRST205') {
      return {
        habits: (hRows as DbHabitRow[]).map(habitFromRow),
        completions: {},
      }
    }
    throw e2
  }
  const habits = (hRows as DbHabitRow[]).map(habitFromRow)
  const completions = completionsFromMarks((mRows ?? []) as DbMarkRow[])
  return { habits, completions }
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
    state = applyEvent(state, { kind: row.kind, payload: row.payload })
  }
  return state
}

async function fetchServerPersisted(userId: string): Promise<Persisted> {
  if (!supabase) return buildSeed(new Date())
  const { data: hRows, error: e1 } = await supabase
    .from('habits')
    .select(HABIT_SELECT)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  if (e1) throw e1
  const { data: mRows, error: e2 } = await supabase
    .from('habit_marks')
    .select('habit_id,user_id,day,marked')
    .eq('user_id', userId)
    .eq('marked', true)
  if (e2) throw e2
  return {
    habits: ((hRows ?? []) as DbHabitRow[]).map(habitFromRow),
    completions: completionsFromMarks((mRows ?? []) as DbMarkRow[]),
  }
}

async function upsertServerHabit(userId: string, habit: Habit) {
  if (!supabase) return
  const { error } = await supabase
    .from('habits')
    .upsert(habitToRow(userId, habit), { onConflict: 'user_id,id' })
  if (error) throw error
}

async function softDeleteServerHabit(userId: string, id: string) {
  if (!supabase) return
  const now = new Date().toISOString()
  const { error: hErr } = await supabase
    .from('habits')
    .update({ deleted_at: now, archived: true })
    .eq('user_id', userId)
    .eq('id', id)
  if (hErr) throw hErr
  const { error: mErr } = await supabase
    .from('habit_marks')
    .update({ marked: false })
    .eq('user_id', userId)
    .eq('habit_id', id)
  if (mErr) throw mErr
}

async function upsertServerMark(
  userId: string,
  habitId: string,
  dayKey: string,
  marked: boolean,
) {
  if (!supabase) return
  const { error } = await supabase
    .from('habit_marks')
    .upsert(
      {
        user_id: userId,
        habit_id: habitId,
        day: dayKey,
        marked,
      },
      { onConflict: 'user_id,habit_id,day' },
    )
  if (error) throw error
}

async function replaceServerState(userId: string, state: Persisted) {
  if (!supabase) return
  const habitRows = state.habits.map((h) => habitToRow(userId, h))
  if (habitRows.length > 0) {
    const { error } = await supabase
      .from('habits')
      .upsert(habitRows, { onConflict: 'user_id,id' })
    if (error) throw error
  }

  const liveHabitIds = new Set(state.habits.map((h) => h.id))
  const { data: existingHabits, error: e1 } = await supabase
    .from('habits')
    .select('id')
    .eq('user_id', userId)
    .is('deleted_at', null)
  if (e1) throw e1
  for (const row of (existingHabits ?? []) as { id: string }[]) {
    if (liveHabitIds.has(row.id)) continue
    await softDeleteServerHabit(userId, row.id)
  }

  const desiredMarkKeys = new Set<string>()
  const markRows: Array<{
    user_id: string
    habit_id: string
    day: string
    marked: boolean
  }> = []
  for (const habit of state.habits) {
    const days = state.completions[habit.id] ?? {}
    for (const day of Object.keys(days)) {
      if (!days[day]) continue
      desiredMarkKeys.add(`${habit.id}\n${day}`)
      markRows.push({
        user_id: userId,
        habit_id: habit.id,
        day,
        marked: true,
      })
    }
  }

  const { data: existingMarks, error: e2 } = await supabase
    .from('habit_marks')
    .select('habit_id,day')
    .eq('user_id', userId)
    .eq('marked', true)
  if (e2) throw e2
  for (const row of (existingMarks ?? []) as DbMarkRow[]) {
    if (desiredMarkKeys.has(`${row.habit_id}\n${row.day}`)) continue
    await upsertServerMark(userId, row.habit_id, row.day, false)
  }

  if (markRows.length > 0) {
    const { error } = await supabase
      .from('habit_marks')
      .upsert(markRows, { onConflict: 'user_id,habit_id,day' })
    if (error) throw error
  }
}

async function touchServerSyncMeta(userId: string) {
  if (!supabase) return
  const { error } = await supabase
    .from('calendar_sync_meta')
    .upsert(
      {
        user_id: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
  if (error) throw error
}

export async function fetchServerSyncVersion(userId: string): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('calendar_sync_meta')
    .select('updated_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  const updatedAt = (data as { updated_at?: unknown } | null)?.updated_at
  return typeof updatedAt === 'string' ? updatedAt : null
}

async function ensureServerStateInitialized(userId: string) {
  if (!supabase) return
  const { data, error } = await supabase
    .from('calendar_sync_meta')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (data) return

  const fromEvents = await loadPersistedFromEventLog(userId)
  const fromLegacyTables = fromEvents ?? (await legacyPullPersisted(userId))
  const initialState = fromLegacyTables ?? buildSeed(new Date())
  await replaceServerState(userId, initialState)
  await touchServerSyncMeta(userId)
}

async function applyServerOperation(userId: string, item: PendingOutgoing) {
  switch (item.kind) {
    case 'state_snapshot':
      await replaceServerState(userId, item.payload as Persisted)
      await touchServerSyncMeta(userId)
      return
    case 'habit_upsert':
      await upsertServerHabit(userId, item.payload as Habit)
      await touchServerSyncMeta(userId)
      return
    case 'habit_delete': {
      const { id } = item.payload as { id?: string }
      if (id) {
        await softDeleteServerHabit(userId, id)
        await touchServerSyncMeta(userId)
      }
      return
    }
    case 'mark_set': {
      const { habitId, dayKey, marked } = item.payload as {
        habitId?: string
        dayKey?: string
        marked?: boolean
      }
      if (habitId && dayKey) {
        await upsertServerMark(userId, habitId, dayKey, marked === true)
        await touchServerSyncMeta(userId)
      }
      return
    }
    default:
      return
  }
}

export async function pushEventBatch(
  userId: string,
  batch: PendingOutgoing[],
): Promise<void> {
  if (!supabase || batch.length === 0) return
  await ensureServerStateInitialized(userId)
  for (const item of batch) {
    await applyServerOperation(userId, item)
  }
}

export async function loadPersistedFromEvents(
  userId: string,
): Promise<{ state: Persisted; lastSeq: number; version: string | null }> {
  if (!supabase) {
    return { state: buildSeed(new Date()), lastSeq: 0, version: null }
  }
  await ensureServerStateInitialized(userId)
  const [state, version] = await Promise.all([
    fetchServerPersisted(userId),
    fetchServerSyncVersion(userId),
  ])
  return { state, lastSeq: 0, version }
}

export function subscribeToSyncEvents(
  userId: string,
  onNewData: () => void,
): () => void {
  const client = supabase
  if (!client) return () => {}
  const ch = client
    .channel(`calendar_state:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'habits',
        filter: `user_id=eq.${userId}`,
      },
      () => {
        onNewData()
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'habit_marks',
        filter: `user_id=eq.${userId}`,
      },
      () => {
        onNewData()
      },
    )
    .subscribe()
  return () => {
    void client.removeChannel(ch)
  }
}

export { applyEvent } from './eventReducer'
