import { supabase } from '../lib/supabase'
import { collectAllPages } from '../supabase/pagination'
import type {
  TimerCommandResult,
  TimerDailyTotal,
  TimerDefinition,
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

export async function fetchTimerSnapshot(
  userId: string,
  dayKey: string,
  period: TimerPeriod = 'day',
): Promise<TimerSnapshot> {
  const client = ensureClient()
  const { start, end } = timerRangeBounds(dayKey, period)

  const definitionsPromise = client
    .from('timer_definitions')
    .select('id,user_id,name,color,icon,sort_order,created_at')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  const statePromise = client
    .from('timer_state')
    .select('revision,active_timer_id,active_started_at,updated_at')
    .eq('user_id', userId)
    .maybeSingle()

  const intervalsPromise = collectAllPages(async (from, to) => {
    const { data, error } = await client
      .from('timer_intervals')
      .select('id,timer_id,started_at,ended_at')
      .eq('user_id', userId)
      .lt('started_at', end.toISOString())
      .gt('ended_at', start.toISOString())
      .order('started_at', { ascending: false })
      .range(from, to)
    throwApiError(error)
    return (data ?? []) as DbTimerInterval[]
  })

  const totalsPromise = client
    .from('timer_daily_totals')
    .select('timer_id,day,duration_ms,source')
    .eq('user_id', userId)
    .gte('day', localDateKey(start))
    .lt('day', localDateKey(end))
    .order('day', { ascending: false })
    .order('timer_id', { ascending: true })

  const [definitionsResult, stateResult, intervalRows, totalsResult] =
    await Promise.all([
      definitionsPromise,
      statePromise,
      intervalsPromise,
      totalsPromise,
    ])

  throwApiError(definitionsResult.error)
  throwApiError(stateResult.error)
  throwApiError(totalsResult.error)

  return {
    timers: ((definitionsResult.data ?? []) as DbTimerDefinition[]).map(
      definitionFromRow,
    ),
    state: stateFromRow((stateResult.data ?? null) as DbTimerState | null),
    intervals: intervalRows.map(intervalFromRow),
    importedTotals: ((totalsResult.data ?? []) as DbDailyTotal[]).map(
      (row): TimerDailyTotal => ({
        timerId: row.timer_id,
        day: row.day,
        durationMs: row.duration_ms,
        source: row.source,
      }),
    ),
  }
}

export async function applyTimerCommand(input: {
  clientCommandId: string
  action: 'start' | 'stop'
  timerId: string | null
  expectedRevision: number
}): Promise<TimerCommandResult> {
  const client = ensureClient()
  const { data, error } = await client.rpc('apply_timer_command', {
    p_client_command_id: input.clientCommandId,
    p_action: input.action,
    p_timer_id: input.timerId,
    p_expected_revision: input.expectedRevision,
  })
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

export async function createTimerDefinition(input: {
  userId: string
  id: string
  name: string
  color: string
  icon: string
  sortOrder: number
}): Promise<void> {
  const client = ensureClient()
  const { error } = await client.from('timer_definitions').insert({
    user_id: input.userId,
    id: input.id,
    name: input.name,
    color: input.color,
    icon: input.icon,
    sort_order: input.sortOrder,
  })
  throwApiError(error)
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
