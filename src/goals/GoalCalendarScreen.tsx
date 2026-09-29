import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Dumbbell,
  GraduationCap,
  LayoutList,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  createGoal,
  createGoalTask,
  deleteGoal,
  deleteGoalTask,
  loadGoalCalendar,
  setGoalTaskCompleted,
  updateGoal,
} from './api'
import {
  readGoalCalendarCache,
  writeGoalCalendarCache,
} from './cache'
import type {
  AnnualGoal,
  GoalCalendarSnapshot,
  GoalCategory,
  GoalDraft,
  GoalPriority,
  GoalStatus,
  GoalTask,
  GoalTaskDraft,
  GoalView,
} from './types'

type GoalCalendarScreenProps = {
  userId: string
  isMobile: boolean
}

type CategoryMeta = {
  label: string
  icon: typeof BriefcaseBusiness
  color: string
  soft: string
}

const CATEGORY_ORDER: GoalCategory[] = [
  'career',
  'finance',
  'health_sport',
  'self_development',
  'education',
]

const CATEGORY_META: Record<GoalCategory, CategoryMeta> = {
  career: {
    label: 'Карьера',
    icon: BriefcaseBusiness,
    color: '#7c3aed',
    soft: '#f2eafe',
  },
  finance: {
    label: 'Финансы',
    icon: CircleDollarSign,
    color: '#0f9f6e',
    soft: '#e7f8f1',
  },
  health_sport: {
    label: 'Здоровье и спорт',
    icon: Dumbbell,
    color: '#ef4444',
    soft: '#feecec',
  },
  self_development: {
    label: 'Саморазвитие',
    icon: Sparkles,
    color: '#d97706',
    soft: '#fff5df',
  },
  education: {
    label: 'Учёба',
    icon: GraduationCap,
    color: '#2563eb',
    soft: '#eaf1ff',
  },
}

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]

const PRIORITY_LABELS: Record<GoalPriority, string> = {
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
}

const STATUS_LABELS: Record<GoalStatus, string> = {
  not_started: 'Не начато',
  in_progress: 'В работе',
  completed: 'Выполнено',
  paused: 'На паузе',
}

const PRIORITY_CLASSES: Record<GoalPriority, string> = {
  high: 'bg-rose-50 text-rose-700 ring-rose-200',
  medium: 'bg-amber-50 text-amber-700 ring-amber-200',
  low: 'bg-slate-100 text-slate-600 ring-slate-200',
}

const STATUS_CLASSES: Record<GoalStatus, string> = {
  not_started: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-50 text-blue-700',
  completed: 'bg-emerald-50 text-emerald-700',
  paused: 'bg-amber-50 text-amber-700',
}

const VIEW_OPTIONS = [
  ['category', LayoutList, 'Категории'],
  ['months', CalendarDays, 'Месяцы'],
  ['stats', BarChart3, 'Статистика'],
] as const

function formatDeadline(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year!, month! - 1, day!))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Не удалось выполнить действие'
}

function progressPercent(tasks: GoalTask[]): number {
  if (tasks.length === 0) return 0
  return Math.round(
    (tasks.filter((task) => task.completed).length / tasks.length) * 100,
  )
}

function defaultGoalDraft(year: number, category: GoalCategory): GoalDraft {
  return {
    title: '',
    category,
    priority: 'medium',
    status: 'not_started',
    deadline: `${year}-12-31`,
    notes: '',
    year,
  }
}

export default function GoalCalendarScreen({
  userId,
  isMobile,
}: GoalCalendarScreenProps) {
  const currentYear = new Date().getFullYear()
  const [initialCache] = useState(() =>
    readGoalCalendarCache(userId, currentYear),
  )
  const [year, setYear] = useState(currentYear)
  const [view, setView] = useState<GoalView>('category')
  const [selectedCategory, setSelectedCategory] = useState<
    GoalCategory | 'all'
  >('all')
  const [snapshot, setSnapshot] = useState<GoalCalendarSnapshot>(
    () => initialCache?.snapshot ?? { goals: [], tasks: [] },
  )
  const { goals, tasks } = snapshot
  const [loading, setLoading] = useState(!initialCache)
  const [error, setError] = useState<string | null>(null)
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(new Set())
  const [goalModalOpen, setGoalModalOpen] = useState(false)
  const [editingGoal, setEditingGoal] = useState<AnnualGoal | null>(null)
  const [goalDraft, setGoalDraft] = useState<GoalDraft>(() =>
    defaultGoalDraft(currentYear, 'career'),
  )
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [taskDraft, setTaskDraft] = useState<GoalTaskDraft>({
    goalId: '',
    title: '',
    month: new Date().getMonth() + 1,
  })
  const [saving, setSaving] = useState(false)
  const mutationVersion = useRef(0)

  const updateSnapshot = (
    updater: (current: GoalCalendarSnapshot) => GoalCalendarSnapshot,
  ) => {
    setSnapshot((current) => {
      const next = updater(current)
      writeGoalCalendarCache(userId, year, next)
      return next
    })
  }

  useEffect(() => {
    const cached = readGoalCalendarCache(userId, year)
    if (cached?.fresh) return

    let cancelled = false
    const versionAtStart = mutationVersion.current
    void loadGoalCalendar(userId, year)
      .then((freshSnapshot) => {
        if (cancelled || mutationVersion.current !== versionAtStart) return
        setSnapshot(freshSnapshot)
        writeGoalCalendarCache(userId, year, freshSnapshot)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId, year])

  const changeYear = (nextYear: number) => {
    const cached = readGoalCalendarCache(userId, nextYear)
    setLoading(!cached)
    setError(null)
    setSnapshot(cached?.snapshot ?? { goals: [], tasks: [] })
    setYear(nextYear)
  }

  const goalById = useMemo(
    () => new Map(goals.map((goal) => [goal.id, goal])),
    [goals],
  )

  const tasksByGoal = useMemo(() => {
    const result = new Map<string, GoalTask[]>()
    for (const task of tasks) {
      const group = result.get(task.goalId) ?? []
      group.push(task)
      result.set(task.goalId, group)
    }
    return result
  }, [tasks])

  const visibleCategories = useMemo(
    () =>
      selectedCategory === 'all'
        ? CATEGORY_ORDER
        : CATEGORY_ORDER.filter((category) => category === selectedCategory),
    [selectedCategory],
  )

  const completedTasks = tasks.filter((task) => task.completed).length
  const overallProgress = progressPercent(tasks)
  const completedGoals = goals.filter((goal) => goal.status === 'completed').length

  const openNewGoal = (category?: GoalCategory) => {
    const nextCategory =
      category ?? (selectedCategory === 'all' ? 'career' : selectedCategory)
    setEditingGoal(null)
    setGoalDraft(defaultGoalDraft(year, nextCategory))
    setGoalModalOpen(true)
  }

  const openEditGoal = (goal: AnnualGoal) => {
    setEditingGoal(goal)
    setGoalDraft({
      title: goal.title,
      category: goal.category,
      priority: goal.priority,
      status: goal.status,
      deadline: goal.deadline,
      notes: goal.notes,
      year: goal.year,
    })
    setGoalModalOpen(true)
  }

  const saveGoal = async () => {
    if (!goalDraft.title.trim() || !goalDraft.deadline) return
    setSaving(true)
    setError(null)
    mutationVersion.current += 1
    try {
      if (editingGoal) {
        const saved = await updateGoal(userId, editingGoal.id, goalDraft)
        updateSnapshot((current) => ({
          ...current,
          goals: current.goals.map((goal) =>
            goal.id === saved.id ? saved : goal,
          ),
        }))
      } else {
        const saved = await createGoal(userId, goalDraft)
        updateSnapshot((current) => ({
          ...current,
          goals: [...current.goals, saved],
        }))
        setExpandedGoals((current) => new Set(current).add(saved.id))
      }
      setGoalModalOpen(false)
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  const removeGoal = async (goal: AnnualGoal) => {
    if (!globalThis.confirm(`Удалить цель «${goal.title}» и все её задачи?`)) {
      return
    }
    setError(null)
    mutationVersion.current += 1
    try {
      await deleteGoal(userId, goal.id)
      updateSnapshot((current) => ({
        goals: current.goals.filter((item) => item.id !== goal.id),
        tasks: current.tasks.filter((task) => task.goalId !== goal.id),
      }))
    } catch (deleteError) {
      setError(errorMessage(deleteError))
    }
  }

  const openNewTask = (goalId: string, month?: number) => {
    setTaskDraft({
      goalId,
      title: '',
      month:
        month ??
        (year === currentYear ? new Date().getMonth() + 1 : 1),
    })
    setTaskModalOpen(true)
  }

  const saveTask = async () => {
    if (!taskDraft.goalId || !taskDraft.title.trim()) return
    setSaving(true)
    setError(null)
    mutationVersion.current += 1
    try {
      const saved = await createGoalTask(userId, taskDraft)
      updateSnapshot((current) => ({
        ...current,
        tasks: [...current.tasks, saved],
      }))
      setExpandedGoals((current) => new Set(current).add(saved.goalId))
      setTaskModalOpen(false)
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  const toggleTask = async (task: GoalTask) => {
    const completed = !task.completed
    mutationVersion.current += 1
    updateSnapshot((current) => ({
      ...current,
      tasks: current.tasks.map((item) =>
        item.id === task.id ? { ...item, completed } : item,
      ),
    }))
    setError(null)
    try {
      const saved = await setGoalTaskCompleted(userId, task.id, completed)
      updateSnapshot((current) => ({
        ...current,
        tasks: current.tasks.map((item) =>
          item.id === saved.id ? saved : item,
        ),
      }))
    } catch (toggleError) {
      updateSnapshot((current) => ({
        ...current,
        tasks: current.tasks.map((item) =>
          item.id === task.id ? { ...item, completed: task.completed } : item,
        ),
      }))
      setError(errorMessage(toggleError))
    }
  }

  const removeTask = async (task: GoalTask) => {
    setError(null)
    mutationVersion.current += 1
    try {
      await deleteGoalTask(userId, task.id)
      updateSnapshot((current) => ({
        ...current,
        tasks: current.tasks.filter((item) => item.id !== task.id),
      }))
    } catch (deleteError) {
      setError(errorMessage(deleteError))
    }
  }

  const renderTask = (task: GoalTask, compact = false) => {
    const goal = goalById.get(task.goalId)
    const meta = goal ? CATEGORY_META[goal.category] : CATEGORY_META.career
    return (
      <div
        key={task.id}
        className={`group flex items-start gap-2 rounded-xl border border-slate-200/80 bg-white ${
          compact ? 'p-2.5' : 'p-3'
        }`}
      >
        <button
          type="button"
          onClick={() => void toggleTask(task)}
          className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border transition ${
            task.completed
              ? 'border-violet-600 bg-violet-600 text-white'
              : 'border-slate-300 bg-white text-transparent hover:border-violet-400'
          }`}
          aria-label={task.completed ? 'Вернуть задачу' : 'Выполнить задачу'}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </button>
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-medium leading-5 ${
              task.completed ? 'text-slate-400 line-through' : 'text-slate-800'
            }`}
          >
            {task.title}
          </p>
          {compact && goal && (
            <p className="mt-0.5 truncate text-xs text-slate-500">
              <span style={{ color: meta.color }}>●</span> {goal.title}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void removeTask(task)}
          className="shrink-0 rounded-md p-1 text-slate-300 opacity-100 transition hover:bg-rose-50 hover:text-rose-600 sm:opacity-0 sm:group-hover:opacity-100"
          aria-label="Удалить задачу"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  const renderGoalCard = (goal: AnnualGoal) => {
    const meta = CATEGORY_META[goal.category]
    const Icon = meta.icon
    const goalTasks = tasksByGoal.get(goal.id) ?? []
    const done = goalTasks.filter((task) => task.completed).length
    const progress = progressPercent(goalTasks)
    const expanded = expandedGoals.has(goal.id)
    return (
      <article
        key={goal.id}
        className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)]"
      >
        <div className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <span
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
              style={{ backgroundColor: meta.soft, color: meta.color }}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="min-w-0 text-base font-bold leading-6 text-slate-900 sm:text-lg">
                  {goal.title}
                </h4>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEditGoal(goal)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-violet-700"
                    aria-label="Редактировать цель"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeGoal(goal)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    aria-label="Удалить цель"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span
                  className={`rounded-full px-2 py-1 text-[11px] font-bold ring-1 ${PRIORITY_CLASSES[goal.priority]}`}
                >
                  {PRIORITY_LABELS[goal.priority]}
                </span>
                <span
                  className={`rounded-full px-2 py-1 text-[11px] font-bold ${STATUS_CLASSES[goal.status]}`}
                >
                  {STATUS_LABELS[goal.status]}
                </span>
                <span className="rounded-full bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-500">
                  до {formatDeadline(goal.deadline)}
                </span>
              </div>
            </div>
          </div>

          {goal.notes && (
            <p className="mt-3 text-sm leading-5 text-slate-500">{goal.notes}</p>
          )}

          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-500">
              <span>Задачи</span>
              <span>
                {done}/{goalTasks.length} · {progress}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progress}%`, backgroundColor: meta.color }}
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() =>
                setExpandedGoals((current) => {
                  const next = new Set(current)
                  if (next.has(goal.id)) next.delete(goal.id)
                  else next.add(goal.id)
                  return next
                })
              }
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-violet-700"
            >
              {expanded ? 'Скрыть задачи' : 'Показать задачи'}
              <ChevronDown
                className={`h-4 w-4 transition ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => openNewTask(goal.id)}
              className="inline-flex items-center gap-1 rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs font-bold text-violet-700 hover:bg-violet-100"
            >
              <Plus className="h-3.5 w-3.5" />
              Задача
            </button>
          </div>
        </div>

        {expanded && (
          <div className="border-t border-slate-100 bg-slate-50/70 p-3 sm:p-4">
            {goalTasks.length > 0 ? (
              <div className="space-y-3">
                {MONTHS.map((month, index) => {
                  const monthTasks = goalTasks.filter(
                    (task) => task.month === index + 1,
                  )
                  if (monthTasks.length === 0) return null
                  return (
                    <div key={month}>
                      <p className="mb-1.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-slate-400">
                        {month}
                      </p>
                      <div className="space-y-1.5">
                        {monthTasks.map((task) => renderTask(task))}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-5 text-center">
                <p className="text-sm text-slate-500">
                  Разложите шаги к цели по месяцам.
                </p>
                <button
                  type="button"
                  onClick={() => openNewTask(goal.id)}
                  className="mt-2 text-sm font-bold text-violet-700"
                >
                  Добавить первую задачу
                </button>
              </div>
            )}
          </div>
        )}
      </article>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl">
      <section className="mb-5 rounded-[1.75rem] border border-violet-100 bg-gradient-to-br from-white via-white to-violet-50 p-4 shadow-[0_16px_45px_rgba(91,33,182,0.08)] sm:mb-7 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-violet-500">
              Карта года
            </p>
            <h2 className="mt-1 text-3xl font-bold tracking-[-0.045em] text-slate-950 sm:text-4xl">
              Цели {year}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
              <button
                type="button"
                onClick={() => changeYear(year - 1)}
                className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Предыдущий год"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-16 text-center text-sm font-bold text-slate-800">
                {year}
              </span>
              <button
                type="button"
                onClick={() => changeYear(year + 1)}
                className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Следующий год"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => openNewGoal()}
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-bold text-white shadow-lg shadow-violet-600/20 hover:bg-violet-700"
            >
              <Plus className="h-4 w-4" />
              Новая цель
            </button>
          </div>
        </div>

        <div className="mt-5 hidden grid-cols-3 gap-2 sm:grid sm:max-w-xl">
          {VIEW_OPTIONS.map(([value, Icon, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              className={`flex min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 text-xs font-bold transition sm:text-sm ${
                view === value
                  ? 'bg-violet-600 text-white shadow-md shadow-violet-600/20'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-violet-50 hover:text-violet-700'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      </section>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((item) => (
            <div
              key={item}
              className="h-48 animate-pulse rounded-2xl border border-violet-100 bg-white/80"
            />
          ))}
        </div>
      ) : view === 'category' ? (
        <div>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
            <button
              type="button"
              onClick={() => setSelectedCategory('all')}
              className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${
                selectedCategory === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200'
              }`}
            >
              Все категории
            </button>
            {CATEGORY_ORDER.map((category) => {
              const meta = CATEGORY_META[category]
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setSelectedCategory(category)}
                  className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ring-1 ${
                    selectedCategory === category
                      ? 'text-white ring-transparent'
                      : 'bg-white text-slate-600 ring-slate-200'
                  }`}
                  style={
                    selectedCategory === category
                      ? { backgroundColor: meta.color }
                      : undefined
                  }
                >
                  {meta.label}
                </button>
              )
            })}
          </div>

          <div className="space-y-6">
            {visibleCategories.map((category) => {
              const meta = CATEGORY_META[category]
              const Icon = meta.icon
              const categoryGoals = goals.filter(
                (goal) => goal.category === category,
              )
              if (selectedCategory === 'all' && categoryGoals.length === 0) {
                return null
              }
              return (
                <section key={category}>
                  <div className="mb-3 flex items-center justify-between gap-3 px-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="grid h-8 w-8 place-items-center rounded-lg"
                        style={{ backgroundColor: meta.soft, color: meta.color }}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div>
                        <h3 className="font-bold text-slate-900">{meta.label}</h3>
                        <p className="text-xs text-slate-400">
                          {categoryGoals.length}{' '}
                          {categoryGoals.length === 1 ? 'цель' : 'целей'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openNewGoal(category)}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-bold text-violet-700 hover:bg-violet-50"
                    >
                      + Цель
                    </button>
                  </div>
                  {categoryGoals.length > 0 ? (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {categoryGoals.map(renderGoalCard)}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openNewGoal(category)}
                      className="w-full rounded-2xl border border-dashed border-slate-300 bg-white/70 px-5 py-8 text-center text-sm font-semibold text-slate-500 hover:border-violet-300 hover:text-violet-700"
                    >
                      Добавить первую цель в категории «{meta.label}»
                    </button>
                  )}
                </section>
              )
            })}
            {goals.length === 0 && selectedCategory === 'all' && (
              <div className="rounded-[1.75rem] border border-dashed border-violet-200 bg-white px-5 py-14 text-center">
                <BookOpen className="mx-auto h-9 w-9 text-violet-300" />
                <h3 className="mt-3 text-lg font-bold text-slate-800">
                  Начните с одной важной цели
                </h3>
                <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-slate-500">
                  Затем добавьте конкретные задачи и распределите их по месяцам.
                </p>
                <button
                  type="button"
                  onClick={() => openNewGoal()}
                  className="mt-4 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white"
                >
                  Добавить цель
                </button>
              </div>
            )}
          </div>
        </div>
      ) : view === 'months' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {MONTHS.map((month, monthIndex) => {
            const monthTasks = tasks.filter(
              (task) => task.month === monthIndex + 1,
            )
            const done = monthTasks.filter((task) => task.completed).length
            return (
              <section
                key={month}
                className="min-h-44 rounded-2xl border border-slate-200/90 bg-white p-3.5 shadow-[0_8px_25px_rgba(15,23,42,0.04)]"
              >
                <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="font-bold text-slate-900">{month}</h3>
                  <span className="text-xs font-bold text-slate-400">
                    {done}/{monthTasks.length}
                  </span>
                </div>
                {monthTasks.length > 0 ? (
                  <div className="space-y-2">
                    {monthTasks.map((task) => renderTask(task, true))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-xs text-slate-400">
                    Задач пока нет
                  </p>
                )}
              </section>
            )
          })}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['Целей', goals.length, 'text-violet-700', 'bg-violet-50'],
              [
                'Выполнено целей',
                completedGoals,
                'text-emerald-700',
                'bg-emerald-50',
              ],
              ['Задач', tasks.length, 'text-blue-700', 'bg-blue-50'],
              [
                'Прогресс задач',
                `${overallProgress}%`,
                'text-amber-700',
                'bg-amber-50',
              ],
            ].map(([label, value, textClass, bgClass]) => (
              <div
                key={label}
                className={`rounded-2xl border border-white p-4 shadow-sm ${bgClass}`}
              >
                <p className="text-xs font-semibold text-slate-500">{label}</p>
                <p className={`mt-1 text-2xl font-bold ${textClass}`}>{value}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <h3 className="font-bold text-slate-900">По категориям</h3>
              <div className="mt-4 space-y-4">
                {CATEGORY_ORDER.map((category) => {
                  const meta = CATEGORY_META[category]
                  const categoryGoalIds = new Set(
                    goals
                      .filter((goal) => goal.category === category)
                      .map((goal) => goal.id),
                  )
                  const categoryTasks = tasks.filter((task) =>
                    categoryGoalIds.has(task.goalId),
                  )
                  const progress = progressPercent(categoryTasks)
                  return (
                    <div key={category}>
                      <div className="mb-1.5 flex items-center justify-between text-sm">
                        <span className="font-semibold text-slate-700">
                          {meta.label}
                        </span>
                        <span className="font-bold text-slate-400">
                          {categoryTasks.filter((task) => task.completed).length}/
                          {categoryTasks.length}
                        </span>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${progress}%`,
                            backgroundColor: meta.color,
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <h3 className="font-bold text-slate-900">По месяцам</h3>
              <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
                {MONTHS.map((month, index) => {
                  const monthTasks = tasks.filter(
                    (task) => task.month === index + 1,
                  )
                  const progress = progressPercent(monthTasks)
                  return (
                    <div key={month}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="font-semibold text-slate-600">{month}</span>
                        <span className="text-slate-400">{progress}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-violet-500"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          </div>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-900">Общий прогресс задач</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Выполнено {completedTasks} из {tasks.length}
                </p>
              </div>
              <span className="text-3xl font-bold text-violet-700">
                {overallProgress}%
              </span>
            </div>
            <div className="mt-4 h-4 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-all"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </section>
        </div>
      )}

      {goalModalOpen && (
        <div
          className="fixed inset-0 z-[150] flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setGoalModalOpen(false)
            }
          }}
        >
          <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[1.75rem] bg-white p-5 shadow-2xl sm:rounded-[1.75rem] sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.15em] text-violet-500">
                  {year} год
                </p>
                <h3 className="mt-1 text-xl font-bold text-slate-900">
                  {editingGoal ? 'Редактировать цель' : 'Новая цель'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setGoalModalOpen(false)}
                disabled={saving}
                className="rounded-full bg-slate-100 p-2 text-slate-500"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Название
                </span>
                <input
                  value={goalDraft.title}
                  onChange={(event) =>
                    setGoalDraft((draft) => ({
                      ...draft,
                      title: event.target.value,
                    }))
                  }
                  maxLength={160}
                  autoFocus={!isMobile}
                  placeholder="Например, выйти на новый уровень дохода"
                  className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                    Категория
                  </span>
                  <select
                    value={goalDraft.category}
                    onChange={(event) =>
                      setGoalDraft((draft) => ({
                        ...draft,
                        category: event.target.value as GoalCategory,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-violet-400"
                  >
                    {CATEGORY_ORDER.map((category) => (
                      <option key={category} value={category}>
                        {CATEGORY_META[category].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                    Приоритет
                  </span>
                  <select
                    value={goalDraft.priority}
                    onChange={(event) =>
                      setGoalDraft((draft) => ({
                        ...draft,
                        priority: event.target.value as GoalPriority,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-violet-400"
                  >
                    {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                    Статус
                  </span>
                  <select
                    value={goalDraft.status}
                    onChange={(event) =>
                      setGoalDraft((draft) => ({
                        ...draft,
                        status: event.target.value as GoalStatus,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-violet-400"
                  >
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                    Дедлайн
                  </span>
                  <input
                    type="date"
                    value={goalDraft.deadline}
                    min={`${year}-01-01`}
                    max={`${year}-12-31`}
                    onChange={(event) =>
                      setGoalDraft((draft) => ({
                        ...draft,
                        deadline: event.target.value,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-violet-400"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Заметка
                </span>
                <textarea
                  value={goalDraft.notes}
                  onChange={(event) =>
                    setGoalDraft((draft) => ({
                      ...draft,
                      notes: event.target.value,
                    }))
                  }
                  rows={3}
                  placeholder="Критерий результата или важный контекст"
                  className="w-full resize-none rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={() => void saveGoal()}
              disabled={saving || !goalDraft.title.trim() || !goalDraft.deadline}
              className="mt-5 w-full rounded-xl bg-violet-600 py-3 text-sm font-bold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Сохраняем…' : editingGoal ? 'Сохранить' : 'Добавить цель'}
            </button>
          </div>
        </div>
      )}

      {taskModalOpen && (
        <div
          className="fixed inset-0 z-[150] flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setTaskModalOpen(false)
            }
          }}
        >
          <div className="w-full max-w-md rounded-t-[1.75rem] bg-white p-5 shadow-2xl sm:rounded-[1.75rem] sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.15em] text-violet-500">
                  Задача по цели
                </p>
                <h3 className="mt-1 truncate text-lg font-bold text-slate-900">
                  {goalById.get(taskDraft.goalId)?.title ?? 'Новая задача'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setTaskModalOpen(false)}
                disabled={saving}
                className="rounded-full bg-slate-100 p-2 text-slate-500"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-5 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Что нужно сделать
                </span>
                <input
                  value={taskDraft.title}
                  onChange={(event) =>
                    setTaskDraft((draft) => ({
                      ...draft,
                      title: event.target.value,
                    }))
                  }
                  maxLength={200}
                  autoFocus={!isMobile}
                  placeholder="Конкретный измеримый шаг"
                  className="w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Месяц
                </span>
                <select
                  value={taskDraft.month}
                  onChange={(event) =>
                    setTaskDraft((draft) => ({
                      ...draft,
                      month: Number(event.target.value),
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-violet-400"
                >
                  {MONTHS.map((month, index) => (
                    <option key={month} value={index + 1}>
                      {month}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              onClick={() => void saveTask()}
              disabled={saving || !taskDraft.title.trim()}
              className="mt-5 w-full rounded-xl bg-violet-600 py-3 text-sm font-bold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Сохраняем…' : 'Добавить задачу'}
            </button>
          </div>
        </div>
      )}

      {isMobile && (
        <nav
          className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] z-[140] mx-auto grid max-w-md grid-cols-3 gap-1 rounded-[1.4rem] bg-slate-950 p-1.5 shadow-[0_18px_45px_rgba(15,23,42,0.28)]"
          aria-label="Разделы календаря целей"
        >
          {VIEW_OPTIONS.map(([value, Icon, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-[1rem] px-1 py-2 text-[11px] font-bold transition ${
                view === value
                  ? 'bg-violet-600 text-white shadow-md shadow-violet-950/30'
                  : 'text-slate-300 active:bg-white/10'
              }`}
              aria-current={view === value ? 'page' : undefined}
            >
              <Icon className="h-5 w-5" />
              <span className="w-full truncate text-center">{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
