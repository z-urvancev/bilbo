export type TimerDefinition = {
  id: string
  userId: string
  name: string
  color: string
  icon: string
  sortOrder: number
  createdAt: string
}

export type TimerState = {
  revision: number
  activeTimerId: string | null
  activeStartedAt: string | null
  updatedAt: string | null
}

export type TimerInterval = {
  id: number
  timerId: string
  startedAt: string
  endedAt: string
}

export type TimerDailyTotal = {
  timerId: string
  durationMs: number
  source: string
}

export type TimerSnapshot = {
  timers: TimerDefinition[]
  state: TimerState
  intervals: TimerInterval[]
  importedTotals: TimerDailyTotal[]
}

export type TimerCommandResult = TimerState & {
  applied: boolean
  completedIntervalId: number | null
}
