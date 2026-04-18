import type { Completions, Habit, Persisted } from '../types'

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
  switch (e.kind) {
    case 'state_snapshot': {
      const p = e.payload as Persisted
      return {
        habits: p.habits.map((h) => ({ ...h })),
        completions: cloneCompletions(p.completions),
      }
    }
    case 'habit_upsert': {
      const h = e.payload as Habit
      const copy = { ...h }
      const i = state.habits.findIndex((x) => x.id === copy.id)
      const habits =
        i >= 0
          ? state.habits.map((x) => (x.id === copy.id ? copy : x))
          : [...state.habits, copy]
      return { ...state, habits }
    }
    case 'habit_delete': {
      const { id } = e.payload as { id: string }
      const habits = state.habits.filter((x) => x.id !== id)
      const completions = { ...state.completions }
      delete completions[id]
      return { habits, completions }
    }
    case 'mark_set': {
      const { habitId, dayKey, marked } = e.payload as {
        habitId: string
        dayKey: string
        marked: boolean
      }
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
