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
  archived?: boolean
  deadline?: string | null
  postponed_until?: string | null
}

type DbMarkRow = {
  habit_id: string
  user_id: string
  day: string
}

function habitFromRow(r: DbHabitRow): Habit {
  return {
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    negative: r.negative,
    monthlyGoal: r.monthly_goal,
    goalPeriod: 'month',
    archived: r.archived ?? false,
    deadline: r.deadline ?? null,
    postponedUntil: r.postponed_until ?? null,
  }
}

function completionsFromMarks(rows: DbMarkRow[]): Completions {
  const c: Completions = {}
  for (const row of rows) {
    if (!c[row.habit_id]) c[row.habit_id] = {}
    c[row.habit_id]![row.day] = true
  }
  return c
}

async function legacyPullPersisted(userId: string): Promise<Persisted | null> {
  if (!supabase) return null
  const { data: hRows, error: e1 } = await supabase
    .from('habits')
    .select(
      'id, user_id, name, emoji, negative, monthly_goal, archived, deadline, postponed_until',
    )
    .eq('user_id', userId)
  if (e1) {
    const code = (e1 as { code?: string }).code
    if (code === '42P01' || code === 'PGRST205') return null
    throw e1
  }
  if (!hRows?.length) return null
  const { data: mRows, error: e2 } = await supabase
    .from('habit_marks')
    .select('habit_id, user_id, day')
    .eq('user_id', userId)
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
  if (error) throw error
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

export async function pushEventBatch(
  userId: string,
  batch: PendingOutgoing[],
): Promise<void> {
  if (!supabase || batch.length === 0) return
  const rows = batch.map((b) => ({
    user_id: userId,
    client_event_id: b.client_event_id,
    kind: b.kind,
    payload: b.payload,
  }))
  const { error } = await supabase.from('sync_events').insert(rows)
  if (!error) return

  const code = (error as { code?: string }).code
  if (code !== '23505') throw error

  for (const b of batch) {
    const { error: oneErr } = await supabase.from('sync_events').insert({
      user_id: userId,
      client_event_id: b.client_event_id,
      kind: b.kind,
      payload: b.payload,
    })
    if (!oneErr) continue
    const oneCode = (oneErr as { code?: string }).code
    if (oneCode === '23505') continue
    throw oneErr
  }
}

export async function loadPersistedFromEvents(
  userId: string,
): Promise<{ state: Persisted; lastSeq: number }> {
  if (!supabase) {
    return { state: buildSeed(new Date()), lastSeq: 0 }
  }
  let events = await fetchAllEventsSince(userId, 0)
  if (events.length === 0) {
    const legacy = await legacyPullPersisted(userId)
    if (legacy && legacy.habits.length > 0) {
      await pushEventBatch(userId, [
        {
          client_event_id: `legacy-${userId}`,
          kind: 'state_snapshot',
          payload: legacy,
        },
      ])
      events = await fetchAllEventsSince(userId, 0)
    }
  }
  if (events.length === 0) {
    const seed = buildSeed(new Date())
    await pushEventBatch(userId, [
      {
        client_event_id: `bootstrap-${userId}`,
        kind: 'state_snapshot',
        payload: seed,
      },
    ])
    events = await fetchAllEventsSince(userId, 0)
  }
  let state: Persisted = { habits: [], completions: {} }
  let lastSeq = 0
  for (const row of events) {
    state = applyEvent(state, { kind: row.kind, payload: row.payload })
    lastSeq = row.seq
  }
  return { state, lastSeq }
}

export function mergeRemoteEvents(
  current: Persisted,
  rows: SyncEventRow[],
): { state: Persisted; lastSeq: number } {
  let state = current
  let lastSeq = 0
  for (const row of rows) {
    state = applyEvent(state, { kind: row.kind, payload: row.payload })
    lastSeq = row.seq
  }
  return { state, lastSeq }
}

export function subscribeToSyncEvents(
  userId: string,
  onNewData: () => void,
): () => void {
  const client = supabase
  if (!client) return () => {}
  const ch = client
    .channel(`sync_events:${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'sync_events',
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
