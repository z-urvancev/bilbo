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
    },
    {
      id: 'seed-med',
      name: 'Медитация',
      emoji: '🧘‍♀️',
      negative: false,
      monthlyGoal: 25,
    },
    {
      id: 'seed-fruit',
      name: 'Фрукты',
      emoji: '🍏',
      negative: false,
      monthlyGoal: 15,
    },
    {
      id: 'seed-steps',
      name: '10 000 шагов',
      emoji: '🏃',
      negative: false,
      monthlyGoal: 22,
    },
    {
      id: 'seed-water',
      name: '2 л воды',
      emoji: '💧',
      negative: false,
      monthlyGoal: 28,
    },
    {
      id: 'seed-gym',
      name: 'Зал',
      emoji: '🏋️',
      negative: false,
      monthlyGoal: 12,
    },
    {
      id: 'seed-smoke',
      name: 'Без сигарет',
      emoji: '🚭',
      negative: true,
      monthlyGoal: 0,
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

    if (pastOrToday && d % 4 !== 0) setPos('seed-yoga', d)
    if (pastOrToday && d % 5 !== 0) setPos('seed-med', d)
    if (pastOrToday && d % 2 === 0) setPos('seed-fruit', d)
    if (pastOrToday && d % 3 !== 1) setPos('seed-steps', d)
    if (pastOrToday) setPos('seed-water', d)
    if (pastOrToday && (d % 7 === 2 || d % 7 === 5)) setPos('seed-gym', d)

    if (pastOrToday && (d === 3 || d === 10 || d === 17)) setNegSlip('seed-smoke', d)
  }

  return { habits, completions }
}
