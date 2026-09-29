import { supabase } from '../lib/supabase'
import type {
  AnnualGoal,
  GoalCalendarSnapshot,
  GoalDraft,
  GoalTask,
  GoalTaskDraft,
} from './types'

type DbAnnualGoal = {
  id: string
  user_id: string
  year: number
  title: string
  category: AnnualGoal['category']
  priority: AnnualGoal['priority']
  status: AnnualGoal['status']
  deadline: string
  notes: string
  created_at: string
  updated_at: string
}

type DbGoalTask = {
  id: string
  user_id: string
  goal_id: string
  title: string
  month: number
  month_block: number | null
  completed: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export class GoalsApiError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'GoalsApiError'
    this.code = code
  }
}

const calendarLoads = new Map<string, Promise<GoalCalendarSnapshot>>()

function ensureClient() {
  if (!supabase) throw new GoalsApiError('Supabase не настроен')
  return supabase
}

function throwApiError(error: { message?: string; code?: string } | null) {
  if (!error) return
  throw new GoalsApiError(error.message || 'Ошибка Supabase', error.code)
}

function goalFromRow(row: DbAnnualGoal): AnnualGoal {
  return {
    id: row.id,
    userId: row.user_id,
    year: row.year,
    title: row.title,
    category: row.category,
    priority: row.priority,
    status: row.status,
    deadline: row.deadline,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function taskFromRow(row: DbGoalTask): GoalTask {
  return {
    id: row.id,
    userId: row.user_id,
    goalId: row.goal_id,
    title: row.title,
    month: row.month,
    monthBlock: row.month_block,
    completed: row.completed,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function fetchGoalCalendar(
  userId: string,
  year: number,
): Promise<GoalCalendarSnapshot> {
  const client = ensureClient()
  const { data: goalRows, error: goalsError } = await client
    .from('annual_goals')
    .select(
      'id,user_id,year,title,category,priority,status,deadline,notes,created_at,updated_at',
    )
    .eq('user_id', userId)
    .eq('year', year)
    .order('created_at', { ascending: true })
  throwApiError(goalsError)

  const goals = ((goalRows ?? []) as DbAnnualGoal[]).map(goalFromRow)
  if (goals.length === 0) return { goals, tasks: [] }

  const { data: taskRows, error: tasksError } = await client
    .from('goal_tasks')
    .select(
      'id,user_id,goal_id,title,month,month_block,completed,sort_order,created_at,updated_at',
    )
    .eq('user_id', userId)
    .in(
      'goal_id',
      goals.map((goal) => goal.id),
    )
    .order('month', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  throwApiError(tasksError)

  return {
    goals,
    tasks: ((taskRows ?? []) as DbGoalTask[]).map(taskFromRow),
  }
}

export function loadGoalCalendar(
  userId: string,
  year: number,
): Promise<GoalCalendarSnapshot> {
  const key = `${userId}:${year}`
  const existing = calendarLoads.get(key)
  if (existing) return existing

  const request = fetchGoalCalendar(userId, year).finally(() => {
    calendarLoads.delete(key)
  })
  calendarLoads.set(key, request)
  return request
}

export async function createGoal(
  userId: string,
  draft: GoalDraft,
): Promise<AnnualGoal> {
  const client = ensureClient()
  const { data, error } = await client
    .from('annual_goals')
    .insert({
      user_id: userId,
      year: draft.year,
      title: draft.title.trim(),
      category: draft.category,
      priority: draft.priority,
      status: draft.status,
      deadline: draft.deadline,
      notes: draft.notes.trim(),
    })
    .select(
      'id,user_id,year,title,category,priority,status,deadline,notes,created_at,updated_at',
    )
    .single()
  throwApiError(error)
  return goalFromRow(data as DbAnnualGoal)
}

export async function updateGoal(
  userId: string,
  goalId: string,
  draft: GoalDraft,
): Promise<AnnualGoal> {
  const client = ensureClient()
  const { data, error } = await client
    .from('annual_goals')
    .update({
      year: draft.year,
      title: draft.title.trim(),
      category: draft.category,
      priority: draft.priority,
      status: draft.status,
      deadline: draft.deadline,
      notes: draft.notes.trim(),
    })
    .eq('user_id', userId)
    .eq('id', goalId)
    .select(
      'id,user_id,year,title,category,priority,status,deadline,notes,created_at,updated_at',
    )
    .single()
  throwApiError(error)
  return goalFromRow(data as DbAnnualGoal)
}

export async function deleteGoal(
  userId: string,
  goalId: string,
): Promise<void> {
  const client = ensureClient()
  const { error } = await client
    .from('annual_goals')
    .delete()
    .eq('user_id', userId)
    .eq('id', goalId)
  throwApiError(error)
}

export async function createGoalTask(
  userId: string,
  draft: GoalTaskDraft,
): Promise<GoalTask> {
  const client = ensureClient()
  const { data, error } = await client
    .from('goal_tasks')
    .insert({
      user_id: userId,
      goal_id: draft.goalId,
      title: draft.title.trim(),
      month: draft.month,
      month_block: draft.monthBlock,
    })
    .select(
      'id,user_id,goal_id,title,month,month_block,completed,sort_order,created_at,updated_at',
    )
    .single()
  throwApiError(error)
  return taskFromRow(data as DbGoalTask)
}

export async function updateGoalTask(
  userId: string,
  taskId: string,
  draft: GoalTaskDraft,
): Promise<GoalTask> {
  const client = ensureClient()
  const { data, error } = await client
    .from('goal_tasks')
    .update({
      title: draft.title.trim(),
      month: draft.month,
      month_block: draft.monthBlock,
    })
    .eq('user_id', userId)
    .eq('id', taskId)
    .eq('goal_id', draft.goalId)
    .select(
      'id,user_id,goal_id,title,month,month_block,completed,sort_order,created_at,updated_at',
    )
    .single()
  throwApiError(error)
  return taskFromRow(data as DbGoalTask)
}

export async function setGoalTaskCompleted(
  userId: string,
  taskId: string,
  completed: boolean,
): Promise<GoalTask> {
  const client = ensureClient()
  const { data, error } = await client
    .from('goal_tasks')
    .update({ completed })
    .eq('user_id', userId)
    .eq('id', taskId)
    .select(
      'id,user_id,goal_id,title,month,month_block,completed,sort_order,created_at,updated_at',
    )
    .single()
  throwApiError(error)
  return taskFromRow(data as DbGoalTask)
}

export async function deleteGoalTask(
  userId: string,
  taskId: string,
): Promise<void> {
  const client = ensureClient()
  const { error } = await client
    .from('goal_tasks')
    .delete()
    .eq('user_id', userId)
    .eq('id', taskId)
  throwApiError(error)
}
