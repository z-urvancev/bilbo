import type { Completions, Habit, Persisted } from './types'

export const SYNC_EVENT_KINDS = [
  'state_snapshot',
  'habit_upsert',
  'habit_patch',
  'habit_delete',
  'mark_set',
] as const

export type SyncEventKind = (typeof SYNC_EVENT_KINDS)[number]

export type PendingOutgoing = {
  client_event_id: string
  kind: SyncEventKind
  payload: unknown
  expected_revision?: number
}

export class DataValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataValidationError'
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_HABITS = 10_000
const MAX_COMPLETIONS = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new DataValidationError(
      `${field} должен быть непустой строкой длиной не более ${maxLength} символов`,
    )
  }
  return value
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new DataValidationError(`${field} должен быть boolean`)
  }
  return value
}

function isDateKey(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  )
}

function optionalDate(
  value: unknown,
  field: string,
  allowUndefined: true,
): string | undefined
function optionalDate(
  value: unknown,
  field: string,
  allowUndefined?: false,
): string | null
function optionalDate(
  value: unknown,
  field: string,
  allowUndefined = false,
): string | null | undefined {
  if (allowUndefined && (value === undefined || value === null || value === '')) {
    return undefined
  }
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isDateKey(value)) {
    throw new DataValidationError(`${field} должен быть корректной датой YYYY-MM-DD`)
  }
  return value
}

export function parseHabit(value: unknown, field = 'habit'): Habit {
  if (!isRecord(value)) {
    throw new DataValidationError(`${field} должен быть объектом`)
  }

  const id = requiredString(value.id, `${field}.id`, 200)
  const name = requiredString(value.name, `${field}.name`, 500)
  const emoji = requiredString(value.emoji, `${field}.emoji`, 64)
  if (typeof value.negative !== 'boolean') {
    throw new DataValidationError(`${field}.negative должен быть boolean`)
  }
  if (!Number.isInteger(value.monthlyGoal)) {
    throw new DataValidationError(`${field}.monthlyGoal должен быть целым числом`)
  }
  const goalPeriod = value.goalPeriod === undefined ? 'month' : value.goalPeriod
  if (goalPeriod !== 'month' && goalPeriod !== 'week') {
    throw new DataValidationError(`${field}.goalPeriod должен быть month или week`)
  }
  const maxGoal = goalPeriod === 'week' ? 7 : 31
  const monthlyGoal = value.monthlyGoal as number
  if (monthlyGoal < 0 || monthlyGoal > maxGoal) {
    throw new DataValidationError(
      `${field}.monthlyGoal должен быть от 0 до ${maxGoal}`,
    )
  }

  const createdAt = optionalDate(value.createdAt, `${field}.createdAt`, true)
  const deadline = optionalDate(value.deadline, `${field}.deadline`)
  const postponedUntil = optionalDate(
    value.postponedUntil,
    `${field}.postponedUntil`,
  )

  return {
    id,
    name,
    emoji,
    negative: value.negative,
    monthlyGoal,
    goalPeriod,
    isPriority: optionalBoolean(value.isPriority, false, `${field}.isPriority`),
    ...(createdAt === undefined ? {} : { createdAt }),
    archived: optionalBoolean(value.archived, false, `${field}.archived`),
    deadline,
    postponedUntil,
  }
}

export function parseHabits(value: unknown, field = 'habits'): Habit[] {
  if (!Array.isArray(value)) {
    throw new DataValidationError(`${field} должен быть массивом`)
  }
  if (value.length > MAX_HABITS) {
    throw new DataValidationError(`${field} содержит слишком много привычек`)
  }
  const habits = value.map((habit, index) => parseHabit(habit, `${field}[${index}]`))
  const ids = new Set<string>()
  for (const habit of habits) {
    if (ids.has(habit.id)) {
      throw new DataValidationError(`${field} содержит повторяющийся id ${habit.id}`)
    }
    ids.add(habit.id)
  }
  return habits
}

function parseCompletions(
  value: unknown,
  habitIds: ReadonlySet<string>,
  field = 'completions',
): Completions {
  if (!isRecord(value)) {
    throw new DataValidationError(`${field} должен быть объектом`)
  }
  const result: Completions = {}
  let count = 0
  for (const [habitId, rawDays] of Object.entries(value)) {
    if (!habitIds.has(habitId)) {
      throw new DataValidationError(`${field} ссылается на неизвестную привычку ${habitId}`)
    }
    if (!isRecord(rawDays)) {
      throw new DataValidationError(`${field}.${habitId} должен быть объектом`)
    }
    const days: Record<string, boolean> = {}
    for (const [day, marked] of Object.entries(rawDays)) {
      if (!isDateKey(day)) {
        throw new DataValidationError(`${field}.${habitId} содержит некорректную дату ${day}`)
      }
      if (typeof marked !== 'boolean') {
        throw new DataValidationError(`${field}.${habitId}.${day} должен быть boolean`)
      }
      if (marked) days[day] = true
      count += 1
      if (count > MAX_COMPLETIONS) {
        throw new DataValidationError(`${field} содержит слишком много отметок`)
      }
    }
    if (Object.keys(days).length > 0) result[habitId] = days
  }
  return result
}

export function parsePersisted(value: unknown, field = 'state'): Persisted {
  if (!isRecord(value)) {
    throw new DataValidationError(`${field} должен быть объектом`)
  }
  const habits = parseHabits(value.habits, `${field}.habits`)
  const ids = new Set(habits.map((habit) => habit.id))
  const completions = parseCompletions(
    value.completions,
    ids,
    `${field}.completions`,
  )
  return { habits, completions }
}

export function parseSyncEventInput(
  kind: unknown,
  payload: unknown,
): { kind: SyncEventKind; payload: unknown } {
  if (typeof kind !== 'string' || !SYNC_EVENT_KINDS.includes(kind as SyncEventKind)) {
    throw new DataValidationError('Неизвестный тип события синхронизации')
  }
  const syncKind = kind as SyncEventKind
  switch (syncKind) {
    case 'state_snapshot':
      return { kind: syncKind, payload: parsePersisted(payload, 'payload') }
    case 'habit_upsert':
      return { kind: syncKind, payload: parseHabit(payload, 'payload') }
    case 'habit_patch': {
      if (!isRecord(payload) || !isRecord(payload.changes)) {
        throw new DataValidationError('payload и payload.changes должны быть объектами')
      }
      const id = requiredString(payload.id, 'payload.id', 200)
      const allowed = new Set([
        'name',
        'emoji',
        'negative',
        'monthlyGoal',
        'goalPeriod',
        'isPriority',
        'createdAt',
        'archived',
        'deadline',
        'postponedUntil',
      ])
      const changes: Record<string, unknown> = {}
      for (const [field, value] of Object.entries(payload.changes)) {
        if (!allowed.has(field)) {
          throw new DataValidationError(`Неизвестное поле habit_patch: ${field}`)
        }
        switch (field) {
          case 'name':
            changes.name = requiredString(value, 'payload.changes.name', 500)
            break
          case 'emoji':
            changes.emoji = requiredString(value, 'payload.changes.emoji', 64)
            break
          case 'negative':
          case 'isPriority':
          case 'archived':
            if (typeof value !== 'boolean') {
              throw new DataValidationError(`payload.changes.${field} должен быть boolean`)
            }
            changes[field] = value
            break
          case 'monthlyGoal':
            if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 31) {
              throw new DataValidationError(
                'payload.changes.monthlyGoal должен быть целым числом от 0 до 31',
              )
            }
            changes.monthlyGoal = value
            break
          case 'goalPeriod':
            if (value !== 'month' && value !== 'week') {
              throw new DataValidationError(
                'payload.changes.goalPeriod должен быть month или week',
              )
            }
            changes.goalPeriod = value
            break
          case 'createdAt':
            changes.createdAt = optionalDate(value, 'payload.changes.createdAt')
            break
          case 'deadline':
          case 'postponedUntil':
            changes[field] = optionalDate(value, `payload.changes.${field}`)
            break
        }
      }
      if (Object.keys(changes).length === 0) {
        throw new DataValidationError('payload.changes не должен быть пустым')
      }
      return { kind: syncKind, payload: { id, changes } }
    }
    case 'habit_delete': {
      if (!isRecord(payload)) {
        throw new DataValidationError('payload должен быть объектом')
      }
      return {
        kind: syncKind,
        payload: { id: requiredString(payload.id, 'payload.id', 200) },
      }
    }
    case 'mark_set': {
      if (!isRecord(payload)) {
        throw new DataValidationError('payload должен быть объектом')
      }
      const habitId = requiredString(payload.habitId, 'payload.habitId', 200)
      if (typeof payload.dayKey !== 'string' || !isDateKey(payload.dayKey)) {
        throw new DataValidationError('payload.dayKey должен быть корректной датой YYYY-MM-DD')
      }
      if (typeof payload.marked !== 'boolean') {
        throw new DataValidationError('payload.marked должен быть boolean')
      }
      return {
        kind: syncKind,
        payload: { habitId, dayKey: payload.dayKey, marked: payload.marked },
      }
    }
  }
}

export function parsePendingOutgoing(value: unknown): PendingOutgoing {
  if (!isRecord(value)) {
    throw new DataValidationError('Событие очереди должно быть объектом')
  }
  const clientEventId = requiredString(
    value.client_event_id,
    'client_event_id',
    200,
  )
  const event = parseSyncEventInput(value.kind, value.payload)
  const expectedRevision = value.expected_revision
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0)
  ) {
    throw new DataValidationError('expected_revision должен быть неотрицательным целым числом')
  }
  return {
    client_event_id: clientEventId,
    kind: event.kind,
    payload: event.payload,
    ...(expectedRevision === undefined
      ? {}
      : { expected_revision: expectedRevision as number }),
  }
}
