export type Habit = {
  id: string
  name: string
  emoji: string
  negative: boolean
  monthlyGoal: number
}

export type Completions = Record<string, Record<string, boolean>>

export type Persisted = {
  habits: Habit[]
  completions: Completions
}
