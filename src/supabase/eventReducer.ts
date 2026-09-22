import type { Completions, Habit, Persisted } from '../types'
import { parseSyncEventInput } from '../validation.ts'

export type EventInput = {
  kind: string
  payload: unknown
}

function cloneCompletions(c: Completions): Completions {
  const o: Completions = {}
  for (const k of Object.keys(c)) {
    o[k] = { ...c[k]! }
  }
  return o
}

export function applyEvent(state: Persisted, e: EventInput): Persisted {
  const event = parseSyncEventInput(e.kind, e.payload)
  switch (event.kind) {
    case 'state_snapshot': {
      const p = event.payload as Persisted
      return {
        habits: p.habits.map((h) => ({ ...h })),
        completions: cloneCompletions(p.completions),
      }
    }
    case 'habit_upsert': {
      const h = event.payload as Habit
      const copy = { ...h }
      const i = state.habits.findIndex((x) => x.id === copy.id)
      const habits =
        i >= 0
          ? state.habits.map((x) => (x.id === copy.id ? copy : x))
          : [...state.habits, copy]
      return { ...state, habits }
    }
    case 'habit_patch': {
      const { id, changes } = event.payload as {
        id: string
        changes: Partial<Habit> & { createdAt?: string | null }
      }
      const current = state.habits.find((habit) => habit.id === id)
      if (!current) return state
      const candidate: Record<string, unknown> = { ...current, ...changes }
      if (changes.createdAt === null) delete candidate.createdAt
      const patched = parseSyncEventInput('habit_upsert', candidate).payload as Habit
      return {
        ...state,
        habits: state.habits.map((habit) => (habit.id === id ? patched : habit)),
      }
    }
    case 'habit_delete': {
      const { id } = event.payload as { id: string }
      const habits = state.habits.filter((x) => x.id !== id)
      const completions = { ...state.completions }
      delete completions[id]
      return { habits, completions }
    }
    case 'mark_set': {
      const { habitId, dayKey, marked } = event.payload as {
        habitId: string
        dayKey: string
        marked: boolean
      }
      if (!state.habits.some((habit) => habit.id === habitId)) return state
      const prevMap = state.completions[habitId] ?? {}
      const nextMap = { ...prevMap }
      if (marked) nextMap[dayKey] = true
      else delete nextMap[dayKey]
      return {
        ...state,
        completions: { ...state.completions, [habitId]: nextMap },
      }
    }
    default:
      return state
  }
}
