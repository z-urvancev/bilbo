import type { Habit } from './types'

export function habitHiddenFromTracker(h: Habit, todayKey: string): boolean {
  if (h.postponedUntil && todayKey < h.postponedUntil) return true
  if (h.deadline && todayKey > h.deadline) return true
  if (h.archived) return true
  return false
}

export function habitInactiveInList(h: Habit, todayKey: string): boolean {
  return habitHiddenFromTracker(h, todayKey)
}
