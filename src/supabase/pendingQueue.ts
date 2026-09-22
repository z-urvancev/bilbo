import type { PendingOutgoing } from '../validation.ts'
import type { Habit, Persisted } from '../types'
import { parseHabit, parsePendingOutgoing } from '../validation.ts'
import { applyEvent } from './eventReducer.ts'

export type PendingQueue = {
  userId: string
  items: PendingOutgoing[]
}

const PATCHABLE_HABIT_FIELDS: Array<keyof Omit<Habit, 'id'>> = [
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
]

export function normalizePendingOperations(
  items: PendingOutgoing[],
  serverState: Persisted,
  onRejected?: (item: PendingOutgoing, reason: string) => void,
): PendingOutgoing[] {
  const normalized: PendingOutgoing[] = []
  let state = serverState
  for (const item of items) {
    if (item.kind === 'habit_upsert') {
      const desired = item.payload as Habit
      const current = state.habits.find((habit) => habit.id === desired.id)
      if (current) {
        onRejected?.(
          item,
          'Устаревший full-object habit_upsert отклонён: невозможно безопасно восстановить изменённые поля',
        )
        continue
      }
    }
    normalized.push(item)
    state = applyEvent(state, item)
  }
  return normalized
}

export function convertHabitUpsertToPatch(
  item: PendingOutgoing,
  current: Habit,
): PendingOutgoing | null {
  if (item.kind !== 'habit_upsert') return item
  const desired = item.payload as Habit
  const baseline = parseHabit(current)
  const changes: Record<string, unknown> = {}
  for (const field of PATCHABLE_HABIT_FIELDS) {
    if (!Object.is(baseline[field], desired[field])) {
      changes[field] =
        field === 'createdAt' && desired[field] === undefined
          ? null
          : desired[field]
    }
  }
  if (Object.keys(changes).length === 0) return null
  return parsePendingOutgoing({
    ...item,
    kind: 'habit_patch',
    payload: { id: desired.id, changes },
  })
}

export function rebasePendingItems(
  items: PendingOutgoing[],
  serverRevision: number,
): PendingOutgoing[] {
  return items.map((item, index) => ({
    ...item,
    expected_revision: serverRevision + index,
  }))
}

export function nextExpectedRevision(
  items: PendingOutgoing[],
  serverRevision: number | null,
): number | undefined {
  const last = items[items.length - 1]
  if (last?.expected_revision !== undefined) {
    return last.expected_revision + 1
  }
  if (items.length === 0 && serverRevision !== null) return serverRevision
  return undefined
}

export function acknowledgePendingHead(
  queue: PendingQueue,
  clientEventId: string,
): boolean {
  if (queue.items[0]?.client_event_id !== clientEventId) return false
  queue.items = queue.items.slice(1)
  return true
}
