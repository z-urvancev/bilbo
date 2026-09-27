export const GOAL_CATEGORIES = [
  'career',
  'finance',
  'health_sport',
  'self_development',
  'education',
] as const

export const GOAL_PRIORITIES = ['high', 'medium', 'low'] as const

export const GOAL_STATUSES = [
  'not_started',
  'in_progress',
  'completed',
  'paused',
] as const

export type GoalCategory = (typeof GOAL_CATEGORIES)[number]
export type GoalPriority = (typeof GOAL_PRIORITIES)[number]
export type GoalStatus = (typeof GOAL_STATUSES)[number]
export type GoalView = 'category' | 'months' | 'stats'

export type AnnualGoal = {
  id: string
  userId: string
  year: number
  title: string
  category: GoalCategory
  priority: GoalPriority
  status: GoalStatus
  deadline: string
  notes: string
  createdAt: string
  updatedAt: string
}

export type GoalTask = {
  id: string
  userId: string
  goalId: string
  title: string
  month: number
  completed: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type GoalCalendarSnapshot = {
  goals: AnnualGoal[]
  tasks: GoalTask[]
}

export type GoalDraft = {
  title: string
  category: GoalCategory
  priority: GoalPriority
  status: GoalStatus
  deadline: string
  notes: string
  year: number
}

export type GoalTaskDraft = {
  goalId: string
  title: string
  month: number
}
