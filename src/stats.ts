import type { Completions, Habit } from './types'
import { dateKey, daysInMonth } from './dates'

export function isSuccess(
  habit: Habit,
  raw: boolean | undefined,
): boolean {
  if (habit.negative) {
    if (raw === undefined) return true
    return !raw
  }
  if (raw === undefined) return false
  return raw
}

export function totalSuccessInMonth(
  habit: Habit,
  completions: Record<string, boolean> | undefined,
  y: number,
  m0: number,
): number {
  const map = completions ?? {}
  let n = 0
  const dim = daysInMonth(y, m0)
  for (let d = 1; d <= dim; d++) {
    const k = dateKey(y, m0, d)
    if (isSuccess(habit, map[k])) n++
  }
  return n
}

export function longestStreakInMonth(
  habit: Habit,
  completions: Record<string, boolean> | undefined,
  y: number,
  m0: number,
): number {
  const map = completions ?? {}
  const dim = daysInMonth(y, m0)
  let best = 0
  let cur = 0
  for (let d = 1; d <= dim; d++) {
    if (isSuccess(habit, map[dateKey(y, m0, d)])) {
      cur++
      if (cur > best) best = cur
    } else {
      cur = 0
    }
  }
  return best
}

export function currentStreakEndingAt(
  habit: Habit,
  completions: Record<string, boolean> | undefined,
  y: number,
  m0: number,
  ref: Date,
): number {
  const map = completions ?? {}
  const dim = daysInMonth(y, m0)
  const refY = ref.getFullYear()
  const refM = ref.getMonth()
  const refD = ref.getDate()
  let endD = dim
  if (refY === y && refM === m0) endD = Math.min(refD, dim)
  else if (refY < y || (refY === y && refM < m0)) endD = 0
  else if (refY > y || (refY === y && refM > m0)) endD = dim
  let streak = 0
  for (let d = endD; d >= 1; d--) {
    if (isSuccess(habit, map[dateKey(y, m0, d)])) streak++
    else break
  }
  return streak
}

export function progressPercent(done: number, goal: number): number {
  if (goal <= 0) return 0
  return Math.round((done / goal) * 1000) / 10
}

export function monthWeekChunks(
  y: number,
  m0: number,
): { startD: number; endD: number }[] {
  const dim = daysInMonth(y, m0)
  const chunks: { startD: number; endD: number }[] = []
  for (let start = 1; start <= dim; start += 7) {
    chunks.push({ startD: start, endD: Math.min(start + 6, dim) })
  }
  return chunks
}

export function weekCompletionRate(
  habits: Habit[],
  completions: Completions,
  y: number,
  m0: number,
  startD: number,
  endD: number,
): number {
  if (habits.length === 0) return 0
  let sum = 0
  let count = 0
  for (const h of habits) {
    const m = completions[h.id] ?? {}
    for (let d = startD; d <= endD; d++) {
      const k = dateKey(y, m0, d)
      if (isSuccess(h, m[k])) sum++
      count++
    }
  }
  return count ? Math.round((sum / count) * 1000) / 10 : 0
}

export function buildCompletionSeries(
  habits: Habit[],
  completions: Completions,
  dynMode: 'day' | 'week' | 'month' | 'year',
  y: number,
  m0: number,
): { rates: number[]; labels: string[] } {
  if (dynMode === 'week') {
    const w = monthWeekChunks(y, m0)
    return {
      rates: w.map((chunk) =>
        weekCompletionRate(habits, completions, y, m0, chunk.startD, chunk.endD),
      ),
      labels: w.map((c) => `${c.startD}–${c.endD}`),
    }
  }
  if (dynMode === 'day') {
    const d0 = daysInMonth(y, m0)
    return {
      rates: Array.from({ length: d0 }, (_, i) =>
        weekCompletionRate(habits, completions, y, m0, i + 1, i + 1),
      ),
      labels: Array.from({ length: d0 }, (_, i) => `${i + 1}`),
    }
  }
  if (dynMode === 'month') {
    return {
      rates: Array.from({ length: 12 }, (_, m) =>
        monthCompletionRate(habits, completions, y, m),
      ),
      labels: Array.from({ length: 12 }, (_, m) =>
        new Date(y, m, 1).toLocaleDateString('ru-RU', { month: 'short' }),
      ),
    }
  }
  const years = [y - 4, y - 3, y - 2, y - 1, y]
  return {
    rates: years.map((yr) => yearCompletionRate(habits, completions, yr)),
    labels: years.map((yr) => String(yr)),
  }
}

export function monthCompletionRate(
  habits: Habit[],
  completions: Completions,
  year: number,
  m0: number,
): number {
  const dim = daysInMonth(year, m0)
  return weekCompletionRate(habits, completions, year, m0, 1, dim)
}

export function yearCompletionRate(
  habits: Habit[],
  completions: Completions,
  year: number,
): number {
  if (habits.length === 0) return 0
  let sum = 0
  let count = 0
  for (let m0 = 0; m0 < 12; m0++) {
    const dim = daysInMonth(year, m0)
    for (let d = 1; d <= dim; d++) {
      const k = dateKey(year, m0, d)
      for (const h of habits) {
        if (isSuccess(h, completions[h.id]?.[k])) sum++
        count++
      }
    }
  }
  return count ? Math.round((sum / count) * 1000) / 10 : 0
}
