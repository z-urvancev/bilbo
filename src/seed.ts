import type { Completions, Habit, Persisted } from './types'
import { dateKey } from './dates'

export function buildSeed(now: Date): Persisted {
  const y = now.getFullYear()
  const m0 = now.getMonth()

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
  return { habits, completions }
}
