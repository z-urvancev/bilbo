export type Habit = {
  id: string
  name: string
  emoji: string
  negative: boolean
  monthlyGoal: number
  goalPeriod?: 'month' | 'week'
  isPriority?: boolean
  createdAt?: string
  archived?: boolean
  deadline?: string | null
  postponedUntil?: string | null
}

export type Completions = Record<string, Record<string, boolean>>

export type Persisted = {
  habits: Habit[]
  completions: Completions
}
