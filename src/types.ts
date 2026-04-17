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

export type DataSource = 'local' | 'folder' | 'supabase'

export type AppSettings = {
  dataSource: DataSource
}
