export type TimerDefinition = {
  id: string
  userId: string
  name: string
  color: string
  icon: string
  sortOrder: number
  createdAt: string
}

export type TimerPeriod = 'day' | 'week'

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

export type TimerEventKind = 'interruption' | 'distraction'

export type TimerEvent = {
  clientEventId: string
  kind: TimerEventKind
  occurredAt: string
}

export type TimerDailyTotal = {
  timerId: string
  day: string
  durationMs: number
  source: string
}

export type TimerSnapshot = {
  timers: TimerDefinition[]
  state: TimerState
  intervals: TimerInterval[]
  events: TimerEvent[]
  importedTotals: TimerDailyTotal[]
}

export type TimerCommandResult = TimerState & {
  applied: boolean
  completedIntervalId: number | null
}
