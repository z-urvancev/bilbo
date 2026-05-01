import type { Completions, Habit, Persisted } from './types'
import { dateKey, daysInMonth } from './dates'

export function buildSeed(now: Date): Persisted {
  const y = now.getFullYear()
  const m0 = now.getMonth()
  const dim = daysInMonth(y, m0)
  const today = now.getDate()

  const habits: Habit[] = [
    {
      id: 'seed-yoga',
      name: 'Йога',
      emoji: '🧘',
      negative: false,
      monthlyGoal: 20,
      goalPeriod: 'month',
      createdAt: dateKey(y, m0, 1),
    },
    {
      id: 'seed-walk',
      name: 'Прогулка',
      emoji: '🚶',
      negative: false,
      monthlyGoal: 22,
      goalPeriod: 'month',
      createdAt: dateKey(y, m0, 1),
    },
    {
      id: 'seed-neg',
      name: 'Без сладкого',
      emoji: '🍫',
      negative: true,
      monthlyGoal: 0,
      goalPeriod: 'month',
      createdAt: dateKey(y, m0, 1),
    },
  ]

  const completions: Completions = {}

  const setPos = (id: string, d: number) => {
    if (!completions[id]) completions[id] = {}
    completions[id]![dateKey(y, m0, d)] = true
  }

  const setNegSlip = (id: string, d: number) => {
    if (!completions[id]) completions[id] = {}
    completions[id]![dateKey(y, m0, d)] = true
  }

  for (let d = 1; d <= dim; d++) {
    const pastOrToday = d <= today

    if (pastOrToday && d % 3 !== 0) setPos('seed-yoga', d)
    if (pastOrToday && d % 2 === 0) setPos('seed-walk', d)

    if (pastOrToday && (d === 5 || d === 12 || d === 19)) setNegSlip('seed-neg', d)
  }

  return { habits, completions }
}
