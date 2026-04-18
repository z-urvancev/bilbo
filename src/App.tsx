import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  LayoutGrid,
  List,
  MoreVertical,
  Plus,
  Target,
  Trophy,
  User,
  X,
} from 'lucide-react'
import type { Completions, Habit, Persisted } from './types'
import { habitHiddenFromTracker, habitInactiveInList } from './habitUtils'
import {
  dateKey,
  daysInMonth,
  pad2,
  parseKey,
  weekdayMon0,
} from './dates'
import {
  buildCompletionSeries,
  currentStreakEndingAt,
  longestStreakInMonth,
  progressPercent,
  totalSuccessInMonth,
} from './stats'
import { buildSeed } from './seed'
import { EMOJI_OPTIONS } from './emojis'
import {
  downloadJsonFile,
  mergeCompletionsForImportedHabits,
  parseBundleJson,
} from './fileSync'
import { supabase, supabaseConfigured } from './lib/supabase'
import {
  applyEvent,
  fetchAllEventsSince,
  loadPersistedFromEvents,
  mergeRemoteEvents,
  pushEventBatch,
  subscribeToSyncEvents,
  type PendingOutgoing,
} from './supabase/sync'

const STORAGE_KEY = 'habit-calendar-v1'

function errText(e: unknown): string {
  if (e == null) return 'Неизвестная ошибка'
  if (typeof e === 'string') return e
  if (typeof e === 'number' || typeof e === 'boolean') return String(e)
  if (e instanceof Error) return e.message || 'Ошибка'
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>
    const m = o.message
    if (typeof m === 'string' && m.trim()) return m
    const msg = o.msg
    if (typeof msg === 'string' && msg.trim()) return msg
    const ed = o.error_description
    if (typeof ed === 'string' && ed.trim()) return ed
    const er = o.error
    if (typeof er === 'string') return er
    try {
      const j = JSON.stringify(e)
      if (j && j !== '{}') return j
    } catch {
      void 0
    }
  }
  return 'Ошибка запроса'
}

type Screen = 'tracker' | 'habits'
type DynMode = 'day' | 'week' | 'month' | 'year'
type MobileTrackerTab = 'marks' | 'analytics'
type MobileMarksView = 'week' | 'month'
type DayColumn = {
  key: string
  day: number
  weekday: string
  isToday: boolean
}

type CalendarTarget =
  | { kind: 'mobileWeek' }
  | { kind: 'clock'; habitId: string; mode: 'postpone' | 'deadline' }

function WeekDot({
  habit,
  raw,
  onToggle,
}: {
  habit: Habit
  raw: boolean | undefined
  onToggle: () => void
}) {
  const marked = raw === true
  let cls =
    'flex h-9 w-9 shrink-0 touch-manipulation select-none items-center justify-center rounded-full border text-xs font-semibold transition focus:outline-none focus:ring-2 focus:ring-teal-400'
  if (!habit.negative) {
    cls += marked
      ? ' border-emerald-600 bg-emerald-500 text-white shadow-sm'
      : ' border-slate-200 bg-white hover:bg-slate-50'
  } else {
    cls += !marked
      ? ' border-emerald-400 bg-emerald-100 text-emerald-900'
      : ' border-rose-300 bg-rose-200 text-rose-900'
  }
  return (
    <button type="button" className={cls} onClick={onToggle} aria-pressed={marked}>
      {!habit.negative && marked ? '✓' : habit.negative && !marked ? '·' : ''}
      {habit.negative && marked ? '✕' : ''}
    </button>
  )
}

function loadPersisted(): Persisted {
  try {
    const r = localStorage.getItem(STORAGE_KEY)
    if (r) return JSON.parse(r) as Persisted
  } catch {
    void 0
  }
  return buildSeed(new Date())
}

function savePersisted(p: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
}

function MiniCalendar() {
  const today = new Date()
  const y = today.getFullYear()
  const m0 = today.getMonth()
  const todayD = today.getDate()
  const dim = daysInMonth(y, m0)
  const first = new Date(y, m0, 1)
  const pad = weekdayMon0(first)
  const cells: (number | null)[] = []
  for (let i = 0; i < pad; i++) cells.push(null)
  for (let d = 1; d <= dim; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  const rows: (number | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7))
  }
  const wdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
  return (
    <div className="rounded-lg border border-teal-200 bg-white p-2 shadow-sm">
      <div className="mb-1 grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] gap-0.5 text-center text-[10px] font-medium text-teal-800">
        <span className="text-teal-500">Н</span>
        {wdays.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      {rows.map((row, ri) => {
        const firstNum = row.find((x) => x !== null)
        const wn =
          firstNum != null
            ? (() => {
                const dd = new Date(y, m0, firstNum)
                const t = new Date(
                  Date.UTC(dd.getFullYear(), dd.getMonth(), dd.getDate()),
                )
                const day = t.getUTCDay() || 7
                t.setUTCDate(t.getUTCDate() + 4 - day)
                const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
                return Math.ceil(((+t - +yStart) / 86400000 + 1) / 7)
              })()
            : ''
        return (
          <div
            key={ri}
            className="grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] gap-0.5"
          >
            <div className="flex items-center justify-center text-[10px] text-teal-500">
              {wn}
            </div>
            {row.map((d, ci) => (
              <div
                key={ci}
                className={`flex h-7 items-center justify-center rounded text-xs font-medium ${
                  d === null
                    ? 'bg-transparent'
                    : d === todayD
                      ? 'bg-teal-600 text-white shadow'
                      : 'bg-teal-50 text-teal-900'
                }`}
              >
                {d ?? ''}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function Cell({
  habit,
  raw,
  onToggle,
}: {
  habit: Habit
  raw: boolean | undefined
  onToggle: () => void
}) {
  const marked = raw === true
  let cls =
    'flex h-6 w-6 shrink-0 touch-manipulation select-none items-center justify-center rounded border text-xs transition focus:outline-none focus:ring-2 focus:ring-teal-400 sm:h-8 sm:w-8 sm:text-sm'
  if (!habit.negative) {
    cls += marked
      ? ' border-emerald-600 bg-emerald-500 text-white shadow-sm'
      : ' border-slate-200 bg-white hover:bg-slate-50'
  } else {
    cls += !marked
      ? ' border-emerald-400 bg-emerald-100 text-emerald-900'
      : ' border-rose-300 bg-rose-200 text-rose-900'
  }
  return (
    <button type="button" className={cls} onClick={onToggle} aria-pressed={marked}>
      {!habit.negative && marked ? '✓' : habit.negative && !marked ? '·' : ''}
      {habit.negative && marked ? '✕' : ''}
    </button>
  )
}

export default function App() {
  const [habits, setHabits] = useState<Habit[]>(() => loadPersisted().habits)
  const [completions, setCompletions] = useState<Completions>(
    () => loadPersisted().completions,
  )
  const [screen, setScreen] = useState<Screen>('tracker')
  const [dynMode, setDynMode] = useState<DynMode>('week')
  const now = new Date()
  const [y, setY] = useState(now.getFullYear())
  const [m0, setM0] = useState(now.getMonth())
  const [selectedD, setSelectedD] = useState<number | null>(now.getDate())
  const [modal, setModal] = useState(false)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  const [mobileTrackerTab, setMobileTrackerTab] =
    useState<MobileTrackerTab>('marks')
  const [mobileMarksView, setMobileMarksView] = useState<MobileMarksView>('week')
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [emojiPickerForId, setEmojiPickerForId] = useState<string | null>(null)
  const [goalInputDrafts, setGoalInputDrafts] = useState<Record<string, string>>({})
  const [formName, setFormName] = useState('')
  const [formEmoji, setFormEmoji] = useState('🎯')
  const [formGoalInput, setFormGoalInput] = useState('20')
  const [formNeg, setFormNeg] = useState(false)
  const [formDeadline, setFormDeadline] = useState('')
  const [moreMenuHabitId, setMoreMenuHabitId] = useState<string | null>(null)
  const [clockMenuHabitId, setClockMenuHabitId] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authPassword2, setAuthPassword2] = useState('')
  const [authName, setAuthName] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authMenuOpen, setAuthMenuOpen] = useState(false)
  const [authErr, setAuthErr] = useState<string | null>(null)
  const [authInfo, setAuthInfo] = useState<string | null>(null)
  const [syncErr, setSyncErr] = useState<string | null>(null)
  const [supabaseSyncPhase, setSupabaseSyncPhase] = useState<
    'idle' | 'pulling' | 'ready'
  >('idle')
  const [exportIncludeProgress, setExportIncludeProgress] = useState(true)
  const habitsRef = useRef(habits)
  const completionsRef = useRef(completions)
  habitsRef.current = habits
  completionsRef.current = completions
  const lastSeqRef = useRef(0)
  const pendingRef = useRef<PendingOutgoing[]>([])
  const flushTimerRef = useRef<number | undefined>(undefined)
  const goalDebouncersRef = useRef<Record<string, number>>({})
  const [calendarTarget, setCalendarTarget] = useState<CalendarTarget | null>(null)
  const [calendarY, setCalendarY] = useState(now.getFullYear())
  const [calendarM0, setCalendarM0] = useState(now.getMonth())

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!isMobile) setMobileTrackerTab('marks')
  }, [isMobile])

  useEffect(() => {
    if (screen !== 'tracker') setMobileMarksView('week')
  }, [screen])

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    setAuthMenuOpen(false)
  }, [session?.user?.id])

  useEffect(() => {
    setAuthMenuOpen(false)
  }, [screen, mobileTrackerTab])

  useEffect(() => {
    if (emojiPickerForId == null) return
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target
      if (t instanceof Element && t.closest('[data-emoji-picker-root]')) return
      setEmojiPickerForId(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [emojiPickerForId])

  useEffect(() => {
    savePersisted({ habits, completions })
  }, [habits, completions])

  useEffect(() => {
    if (!modal) return
    const d = new Date()
    d.setMonth(d.getMonth() + 1)
    setFormDeadline(dateKey(d.getFullYear(), d.getMonth(), d.getDate()))
  }, [modal])

  useEffect(() => {
    if (moreMenuHabitId == null && clockMenuHabitId == null) return
    const onDoc = (ev: PointerEvent | TouchEvent) => {
      const t = ev.target
      if (t instanceof Element && t.closest('[data-habit-menu-root]')) return
      setMoreMenuHabitId(null)
      setClockMenuHabitId(null)
    }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('touchstart', onDoc, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('touchstart', onDoc)
    }
  }, [moreMenuHabitId, clockMenuHabitId])

  const flushPendingInternal = useCallback(async () => {
    if (!session?.user || !supabase || pendingRef.current.length === 0) return
    const uid = session.user.id
    const batch = [...pendingRef.current]
    pendingRef.current = []
    try {
      setSyncErr(null)
      const maxSeq = await pushEventBatch(uid, batch)
      if (maxSeq > lastSeqRef.current) lastSeqRef.current = maxSeq
    } catch (e) {
      pendingRef.current = [...batch, ...pendingRef.current]
      setSyncErr(errText(e))
    }
  }, [session?.user])

  const dispatch = useCallback(
    (kind: string, payload: unknown, fixedClientId?: string) => {
      const client_event_id = fixedClientId ?? crypto.randomUUID()
      const next = applyEvent(
        { habits: habitsRef.current, completions: completionsRef.current },
        { kind, payload },
      )
      setHabits(next.habits)
      setCompletions(next.completions)
      if (session?.user && supabaseConfigured && supabaseSyncPhase === 'ready') {
        pendingRef.current.push({ client_event_id, kind, payload })
        if (flushTimerRef.current !== undefined) {
          window.clearTimeout(flushTimerRef.current)
        }
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = undefined
          void flushPendingInternal()
        }, 450)
      }
    },
    [session?.user, supabaseSyncPhase, flushPendingInternal],
  )

  const applyClockDate = useCallback(
    (value: string, id: string, mode: 'postpone' | 'deadline') => {
      if (!value || !id) return
      const h = habitsRef.current.find((x) => x.id === id)
      if (!h) return
      if (mode === 'postpone') {
        dispatch('habit_upsert', { ...h, archived: true, postponedUntil: value })
      } else {
        dispatch('habit_upsert', {
          ...h,
          deadline: value,
          archived: false,
          postponedUntil: null,
        })
      }
    },
    [dispatch],
  )

  useEffect(() => {
    const t = new Date()
    const tk = dateKey(t.getFullYear(), t.getMonth(), t.getDate())
    habits.forEach((h) => {
      if (h.postponedUntil && tk >= h.postponedUntil) {
        dispatch('habit_upsert', { ...h, archived: false, postponedUntil: null })
      }
    })
  }, [habits, dispatch])

  const pullIncremental = useCallback(async () => {
    if (!session?.user || supabaseSyncPhase !== 'ready' || !supabase) return
    const uid = session.user.id
    await flushPendingInternal()
    const rows = await fetchAllEventsSince(uid, lastSeqRef.current)
    if (rows.length === 0) return
    const { state, lastSeq } = mergeRemoteEvents(
      { habits: habitsRef.current, completions: completionsRef.current },
      rows,
    )
    lastSeqRef.current = lastSeq
    setHabits(state.habits)
    setCompletions(state.completions)
  }, [session?.user, supabaseSyncPhase, flushPendingInternal])

  useEffect(() => {
    if (!session?.user || !supabaseConfigured) {
      setSupabaseSyncPhase('idle')
      lastSeqRef.current = 0
      pendingRef.current = []
      return
    }
    let cancelled = false
    setSyncErr(null)
    setSupabaseSyncPhase('pulling')
    pendingRef.current = []
    void (async () => {
      try {
        const { state, lastSeq } = await loadPersistedFromEvents(session.user.id)
        if (cancelled) return
        lastSeqRef.current = lastSeq
        setHabits(state.habits)
        setCompletions(state.completions)
        if (!cancelled) setSupabaseSyncPhase('ready')
      } catch (e) {
        if (!cancelled) {
          setSyncErr(errText(e))
          setSupabaseSyncPhase('idle')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void pullIncremental()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [pullIncremental])

  useEffect(() => {
    if (!session?.user || supabaseSyncPhase !== 'ready' || !supabaseConfigured)
      return
    const uid = session.user.id
    return subscribeToSyncEvents(uid, () => {
      void pullIncremental()
    })
  }, [session?.user?.id, supabaseSyncPhase, pullIncremental])

  const dim = daysInMonth(y, m0)
  const today = new Date()
  const todayD = today.getDate()
  const weekdayRu = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
  const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate())
  const dayColumns = useMemo(() => {
    if (!isMobile || mobileMarksView === 'month') {
      return Array.from({ length: dim }, (_, i) => {
        const d = new Date(y, m0, i + 1)
        const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate())
        return {
          key,
          day: i + 1,
          weekday: weekdayRu[d.getDay()] ?? '',
          isToday: key === todayKey,
        } satisfies DayColumn
      })
    }
    const anchor = Math.max(1, Math.min(dim, selectedD ?? todayD))
    const base = new Date(y, m0, anchor)
    const weekDayMon0 = (base.getDay() + 6) % 7
    const start = new Date(base)
    start.setDate(base.getDate() - weekDayMon0)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate())
      return {
        key,
        day: d.getDate(),
        weekday: weekdayRu[d.getDay()] ?? '',
        isToday: key === todayKey,
      } satisfies DayColumn
    })
  }, [isMobile, mobileMarksView, dim, selectedD, todayD, y, m0, todayKey])
  const mobileWeekRangeLabel = useMemo(() => {
    if (!isMobile || mobileMarksView === 'month' || dayColumns.length === 0) return ''
    const first = dayColumns[0]
    const last = dayColumns[dayColumns.length - 1]
    if (!first || !last) return ''
    const [fy, fm, fd] = first.key.split('-').map(Number)
    const [ly, lm, ld] = last.key.split('-').map(Number)
    const fDate = new Date(fy, (fm ?? 1) - 1, fd ?? 1)
    const lDate = new Date(ly, (lm ?? 1) - 1, ld ?? 1)
    try {
      const opts: Intl.DateTimeFormatOptions = {
        day: 'numeric',
        month: 'long',
      }
      if (fDate.getFullYear() !== lDate.getFullYear()) {
        opts.year = 'numeric'
      }
      const fmt = new Intl.DateTimeFormat('ru-RU', opts)
      const anyFmt = fmt as Intl.DateTimeFormat & {
        formatRange?: (a: Date, b: Date) => string
      }
      if (typeof anyFmt.formatRange === 'function') {
        return anyFmt.formatRange(fDate, lDate)
      }
    } catch {
      void 0
    }
    const ru = new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
    })
    return `${ru.format(fDate)} — ${ru.format(lDate)}`
  }, [isMobile, mobileMarksView, dayColumns])
  const mobileMonthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('ru-RU', {
        month: 'long',
        year: 'numeric',
      }).format(new Date(y, m0, 1)),
    [y, m0],
  )
  const mobileMonthCells = useMemo(() => {
    const first = new Date(y, m0, 1)
    const pad = weekdayMon0(first)
    const cells: (number | null)[] = []
    for (let i = 0; i < pad; i++) cells.push(null)
    for (let d = 1; d <= dim; d++) cells.push(d)
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [y, m0, dim])
  const selectedDateKey = `${y}-${String(m0 + 1).padStart(2, '0')}-${String(
    Math.max(1, Math.min(dim, selectedD ?? todayD)),
  ).padStart(2, '0')}`

  const setMonthDelta = (delta: number) => {
    const d = new Date(y, m0 + delta, 1)
    setY(d.getFullYear())
    setM0(d.getMonth())
    setSelectedD(1)
  }

  const moveMobileWeek = (deltaWeeks: number) => {
    const baseDay = selectedD ?? todayD
    const from = new Date(y, m0, baseDay)
    from.setDate(from.getDate() + deltaWeeks * 7)
    setY(from.getFullYear())
    setM0(from.getMonth())
    setSelectedD(from.getDate())
  }

  const selectDate = (value: string) => {
    if (!value) return
    const parsed = new Date(`${value}T00:00:00`)
    if (Number.isNaN(parsed.getTime())) return
    setY(parsed.getFullYear())
    setM0(parsed.getMonth())
    setSelectedD(parsed.getDate())
  }

  const openCalendar = useCallback((target: CalendarTarget, initial?: string) => {
    const fallback = new Date()
    const base = initial ? new Date(`${initial}T00:00:00`) : fallback
    const safe = Number.isNaN(base.getTime()) ? fallback : base
    setCalendarY(safe.getFullYear())
    setCalendarM0(safe.getMonth())
    setClockMenuHabitId(null)
    setMoreMenuHabitId(null)
    setCalendarTarget(target)
  }, [])

  const openClockCalendar = useCallback(
    (habitId: string, mode: 'postpone' | 'deadline') => {
      const h = habitsRef.current.find((x) => x.id === habitId)
      const fallback = dateKey(y, m0, selectedD ?? todayD)
      const initial =
        mode === 'postpone' ? (h?.postponedUntil ?? fallback) : (h?.deadline ?? fallback)
      openCalendar({ kind: 'clock', habitId, mode }, initial)
    },
    [openCalendar, y, m0, selectedD, todayD],
  )

  const applyCalendarPick = useCallback(
    (value: string) => {
      const t = calendarTarget
      if (!t) return
      if (t.kind === 'mobileWeek') {
        selectDate(value)
      } else {
        applyClockDate(value, t.habitId, t.mode)
      }
      setCalendarTarget(null)
      setClockMenuHabitId(null)
      setMoreMenuHabitId(null)
    },
    [calendarTarget, applyClockDate],
  )

  const calendarMonthDays = useMemo(() => {
    const first = new Date(calendarY, calendarM0, 1)
    const pad = weekdayMon0(first)
    const dimInMonth = daysInMonth(calendarY, calendarM0)
    const cells: (number | null)[] = []
    for (let i = 0; i < pad; i++) cells.push(null)
    for (let d = 1; d <= dimInMonth; d++) cells.push(d)
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [calendarY, calendarM0])

  const calendarSelectedKey = useMemo(() => {
    if (!calendarTarget) return null
    if (calendarTarget.kind === 'mobileWeek') return selectedDateKey
    const h = habits.find((x) => x.id === calendarTarget.habitId)
    if (!h) return null
    return calendarTarget.mode === 'postpone' ? (h.postponedUntil ?? null) : (h.deadline ?? null)
  }, [calendarTarget, selectedDateKey, habits])

  const calendarMonthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('ru-RU', {
        month: 'long',
        year: 'numeric',
      }).format(new Date(calendarY, calendarM0, 1)),
    [calendarY, calendarM0],
  )

  const profileName =
    (session?.user?.user_metadata?.display_name as string | undefined)?.trim() ||
    (session?.user?.user_metadata?.name as string | undefined)?.trim() ||
    session?.user?.email?.split('@')[0] ||
    'Профиль'

  const toggleDay = useCallback(
    (habitId: string, key: string) => {
      const cur = completionsRef.current[habitId]?.[key]
      const marked = !cur
      dispatch('mark_set', { habitId, dayKey: key, marked })
    },
    [dispatch],
  )

  const addHabit = () => {
    const name = formName.trim()
    if (!name) return
    const h: Habit = {
      id: crypto.randomUUID(),
      name,
      emoji: formEmoji || '🎯',
      negative: formNeg,
      monthlyGoal: Math.max(
        1,
        Math.min(31, Math.floor(Number(formGoalInput)) || 20),
      ),
      archived: false,
      deadline: formDeadline || null,
      postponedUntil: null,
    }
    dispatch('habit_upsert', h)
    setModal(false)
    setFormName('')
    setFormEmoji('🎯')
    setFormGoalInput('20')
    setFormNeg(false)
  }

  const removeHabit = (id: string) => {
    dispatch('habit_delete', { id })
  }

  const posHabits = useMemo(
    () =>
      habits.filter(
        (h) => !h.negative && !habitHiddenFromTracker(h, todayKey),
      ),
    [habits, todayKey],
  )
  const negHabits = useMemo(
    () =>
      habits.filter(
        (h) => h.negative && !habitHiddenFromTracker(h, todayKey),
      ),
    [habits, todayKey],
  )

  const habitPendingDelete = useMemo(
    () =>
      deleteConfirmId
        ? habits.find((h) => h.id === deleteConfirmId)
        : undefined,
    [habits, deleteConfirmId],
  )

  const chartSeries = useMemo(() => {
    const pos = buildCompletionSeries(posHabits, completions, dynMode, y, m0)
    const neg = buildCompletionSeries(negHabits, completions, dynMode, y, m0)
    const negRates =
      negHabits.length === 0
        ? neg.rates.map(() => 0)
        : neg.rates.map((r) => Math.round((100 - r) * 10) / 10)
    return {
      posRates: pos.rates,
      negRates,
      labels: pos.labels,
    }
  }, [dynMode, posHabits, negHabits, completions, y, m0])

  const chartPosRates = chartSeries.posRates
  const chartNegRates = chartSeries.negRates
  const chartLabels = chartSeries.labels

  const dynTitle =
    dynMode === 'week'
      ? 'за месяц по неделям'
      : dynMode === 'day'
        ? 'по дням месяца'
        : dynMode === 'month'
          ? `по месяцам ${y}`
          : 'по годам'

  const trackerOrderedHabits = useMemo(() => {
    const visible = habits.filter((h) => !habitHiddenFromTracker(h, todayKey))
    const pos = visible.filter((h) => !h.negative)
    const neg = visible.filter((h) => h.negative)
    return [...pos, ...neg]
  }, [habits, todayKey])

  const trackerStatsKind = useMemo(() => {
    const list = trackerOrderedHabits
    if (list.length === 0) return 'pos' as const
    if (list.every((h) => h.negative)) return 'neg' as const
    if (list.every((h) => !h.negative)) return 'pos' as const
    return 'mix' as const
  }, [trackerOrderedHabits])

  const habitsEditorSections = useMemo(() => {
    const active = habits.filter((h) => !habitInactiveInList(h, todayKey))
    const inactive = habits.filter((h) => habitInactiveInList(h, todayKey))
    const sort = (a: Habit, b: Habit) => {
      const an = a.negative ? 1 : 0
      const bn = b.negative ? 1 : 0
      if (an !== bn) return an - bn
      return a.name.localeCompare(b.name, 'ru')
    }
    active.sort(sort)
    inactive.sort(sort)
    return { active, inactive }
  }, [habits, todayKey])

  const rowStyle = (h: Habit) => {
    if (h.negative) {
      const i = habits.filter((x) => x.negative).findIndex((x) => x.id === h.id)
      return i % 2 === 0 ? 'bg-rose-50' : 'bg-red-50'
    }
    const i = habits.filter((x) => !x.negative).findIndex((x) => x.id === h.id)
    return i % 2 === 0 ? 'bg-white' : 'bg-teal-50'
  }

  const slipCountInMonth = (
    map: Record<string, boolean> | undefined,
    y0: number,
    m00: number,
  ) => {
    const m = map ?? {}
    let n = 0
    const d0 = daysInMonth(y0, m00)
    for (let d = 1; d <= d0; d++) {
      if (m[dateKey(y0, m00, d)] === true) n++
    }
    return n
  }

  const submitAuth = async () => {
    setAuthErr(null)
    setAuthInfo(null)
    if (!supabase) return
    const email = authEmail.trim()
    if (!email) {
      setAuthErr('Укажите почту')
      return
    }
    if (authMode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password: authPassword,
      })
      if (error) setAuthErr(errText(error))
      else setAuthModalOpen(false)
      return
    }
    if (authPassword.length < 6) {
      setAuthErr('Пароль не короче 6 символов')
      return
    }
    if (authPassword !== authPassword2) {
      setAuthErr('Пароли не совпадают')
      return
    }
    const displayName = authName.trim()
    if (!displayName) {
      setAuthErr('Укажите имя')
      return
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password: authPassword,
      options: {
        emailRedirectTo: new URL(import.meta.env.BASE_URL, window.location.origin)
          .href,
        data: {
          display_name: displayName,
          name: displayName,
        },
      },
    })
    if (error) setAuthErr(errText(error))
    else if (data.user && !data.session) {
      setAuthInfo('Откройте письмо и подтвердите адрес.')
    } else {
      setAuthPassword('')
      setAuthPassword2('')
      setAuthName('')
      setAuthModalOpen(false)
    }
  }

  const renderAuthControl = (compactEmail: boolean) => {
    if (!session?.user) {
      return (
        <button
          type="button"
          disabled={!supabaseConfigured || !supabase}
          onClick={() => setAuthModalOpen(true)}
          className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-teal-800 shadow hover:bg-teal-50 disabled:opacity-60 sm:text-sm"
        >
          Вход
        </button>
      )
    }
    return (
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setAuthMenuOpen((v) => !v)
          }}
          className="rounded-md border border-teal-300/70 bg-teal-800/70 px-2.5 py-1.5 text-xs font-medium text-teal-50 hover:bg-teal-800 sm:text-sm"
        >
          <span className={compactEmail ? 'max-w-[10rem] truncate' : 'max-w-[14rem] truncate'}>
            {profileName}
          </span>
        </button>
        {authMenuOpen && (
          <div className="absolute right-0 z-[70] mt-1 min-w-[8rem] rounded-lg border border-teal-200 bg-white p-1 shadow-lg">
            <button
              type="button"
              disabled={!supabase}
              onClick={async () => {
                setAuthMenuOpen(false)
                setAuthErr(null)
                setAuthInfo(null)
                if (!supabase) return
                await supabase.auth.signOut()
              }}
              className="w-full rounded-md px-2 py-1.5 text-left text-sm text-teal-800 hover:bg-teal-50 disabled:opacity-50"
            >
              Выйти
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`min-h-svh pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)] ${
        isMobile
          ? 'bg-[#f9f9f9]'
          : 'bg-gradient-to-b from-teal-50 to-white'
      }`}
    >
      <header
        className={
          isMobile
            ? 'border-b border-black/[0.06] bg-[#f7f7f7] px-3 pb-3 pt-3 text-neutral-900'
            : 'border-b border-teal-200 bg-teal-700 px-3 py-3 text-white shadow-md sm:px-4 sm:py-4'
        }
      >
        <div className="mx-auto max-w-7xl">
          {isMobile ? (
            screen === 'tracker' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (mobileMarksView === 'month') setMonthDelta(-1)
                    else moveMobileWeek(-1)
                  }}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-neutral-800 shadow-sm ring-1 ring-black/5"
                  aria-label={mobileMarksView === 'month' ? 'Предыдущий месяц' : 'Предыдущая неделя'}
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <div className="relative min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => openCalendar({ kind: 'mobileWeek' }, selectedDateKey)}
                    className="flex min-h-[2.75rem] w-full touch-manipulation items-center justify-center rounded-2xl bg-white px-3 py-2.5 text-center text-base font-semibold leading-tight text-neutral-900 shadow-sm ring-1 ring-black/5 active:bg-neutral-50"
                    aria-label={mobileMarksView === 'month' ? 'Выбрать дату месяца' : 'Выбрать дату недели'}
                  >
                    {mobileMarksView === 'month' ? mobileMonthLabel : mobileWeekRangeLabel}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (mobileMarksView === 'month') setMonthDelta(1)
                    else moveMobileWeek(1)
                  }}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-neutral-800 shadow-sm ring-1 ring-black/5"
                  aria-label={mobileMarksView === 'month' ? 'Следующий месяц' : 'Следующая неделя'}
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            ) : (
              <h1 className="text-center text-lg font-semibold tracking-tight text-neutral-900">
                Привычки
              </h1>
            )
          ) : (
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="min-w-0 flex-1 overflow-x-auto [-webkit-overflow-scrolling:touch]">
                <div className="flex min-w-max flex-nowrap items-center gap-2 sm:gap-3">
                  <h1 className="shrink-0 text-lg font-semibold tracking-tight sm:text-2xl">
                    Bilbo
                  </h1>
                  <nav className="flex shrink-0 rounded-lg bg-teal-800/60 p-0.5 text-sm">
                    <button
                      type="button"
                      onClick={() => setScreen('tracker')}
                      className={`rounded-md px-3 py-1.5 font-medium transition ${
                        screen === 'tracker'
                          ? 'bg-white text-teal-800 shadow'
                          : 'text-teal-100 hover:bg-teal-800/80'
                      }`}
                    >
                      Трекер
                    </button>
                    <button
                      type="button"
                      onClick={() => setScreen('habits')}
                      className={`rounded-md px-3 py-1.5 font-medium transition ${
                        screen === 'habits'
                          ? 'bg-white text-teal-800 shadow'
                          : 'text-teal-100 hover:bg-teal-800/80'
                      }`}
                    >
                      Привычки
                    </button>
                  </nav>
                  {screen === 'tracker' && (
                    <>
                      <button
                        type="button"
                        onClick={() => setMonthDelta(-1)}
                        className="shrink-0 rounded-lg bg-teal-800/80 p-1.5 hover:bg-teal-800 sm:p-2"
                        aria-label="Предыдущий месяц"
                      >
                        <ChevronLeft className="h-5 w-5" />
                      </button>
                      <input
                        type="month"
                        value={`${y}-${String(m0 + 1).padStart(2, '0')}`}
                        onChange={(e) => {
                          const v = e.target.value
                          if (!v) return
                          const [ys, ms] = v.split('-').map(Number)
                          setY(ys)
                          setM0(ms - 1)
                          setSelectedD(1)
                        }}
                        className="shrink-0 rounded-lg border border-teal-600 bg-teal-800/50 px-2 py-1.5 text-sm text-white outline-none focus:ring-2 focus:ring-teal-300"
                      />
                      <button
                        type="button"
                        onClick={() => setMonthDelta(1)}
                        className="shrink-0 rounded-lg bg-teal-800/80 p-1.5 hover:bg-teal-800 sm:p-2"
                        aria-label="Следующий месяц"
                      >
                        <ChevronRight className="h-5 w-5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="relative z-[80] shrink-0">{renderAuthControl(false)}</div>
            </div>
          )}
        </div>
      </header>
      {syncErr && (
        <div className="mx-auto mt-3 max-w-7xl rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {syncErr}
        </div>
      )}

      {screen === 'habits' ? (
      <main
        className={`mx-auto max-w-3xl px-3 py-6 sm:py-8 ${
          isMobile ? 'pb-28' : ''
        }`}
      >
        {!isMobile && (
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-teal-900">Привычки</h2>
            <button
              type="button"
              onClick={() => setModal(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800"
            >
              <Plus className="h-4 w-4" />
              Добавить
            </button>
          </div>
        )}
        <div className="space-y-4">
          {habitsEditorSections.active.map((h) => (
            <div
              key={h.id}
              className={`rounded-2xl border border-teal-100 px-4 py-3 shadow-sm ${rowStyle(h)}`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div
                  className="relative shrink-0"
                  data-emoji-picker-root
                >
                  <button
                    type="button"
                    onClick={() =>
                      setEmojiPickerForId((id) => (id === h.id ? null : h.id))
                    }
                    className="text-2xl leading-none hover:opacity-80"
                  >
                    {h.emoji}
                  </button>
                  {emojiPickerForId === h.id && (
                    <div className="absolute left-0 top-full z-30 mt-1 w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-teal-200 bg-white p-2 shadow-lg">
                      <div className="max-h-52 overflow-y-auto">
                        <div className="grid grid-cols-8 gap-1 sm:grid-cols-10">
                          {EMOJI_OPTIONS.map((e) => (
                            <button
                              key={e}
                              type="button"
                              onClick={() => {
                                const updated = { ...h, emoji: e }
                                setHabits((prev) =>
                                  prev.map((x) =>
                                    x.id === h.id ? updated : x,
                                  ),
                                )
                                setEmojiPickerForId(null)
                                dispatch('habit_upsert', updated)
                              }}
                              className={`flex aspect-square items-center justify-center rounded-md text-lg transition ${
                                h.emoji === e
                                  ? 'bg-teal-600 text-white ring-2 ring-teal-400 ring-offset-1'
                                  : 'bg-teal-50/80 hover:bg-teal-100'
                              }`}
                            >
                              {e}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <input
                  type="text"
                  value={h.name}
                  onChange={(e) => {
                    const next = e.target.value
                    setHabits((prev) =>
                      prev.map((x) => (x.id === h.id ? { ...x, name: next } : x)),
                    )
                  }}
                  onBlur={() => {
                    const habit = habitsRef.current.find((x) => x.id === h.id)
                    if (habit) dispatch('habit_upsert', habit)
                  }}
                  className="min-w-[8rem] flex-1 rounded-lg border border-teal-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-teal-300"
                />
                <input
                  type="number"
                  min={h.negative ? 0 : 1}
                  max={31}
                  value={(() => {
                    const draft = goalInputDrafts[h.id]
                    if (draft !== undefined) return draft
                    if (!h.negative && h.monthlyGoal < 1) return ''
                    return String(h.monthlyGoal)
                  })()}
                  onChange={(e) => {
                    const raw = e.target.value
                    setGoalInputDrafts((prev) => ({ ...prev, [h.id]: raw }))
                    if (raw === '') return
                    const n = Number(raw)
                    if (Number.isNaN(n)) return
                    const minGoal = h.negative ? 0 : 1
                    const next = Math.max(minGoal, Math.min(31, Math.floor(n)))
                    setHabits((prev) =>
                      prev.map((x) =>
                        x.id === h.id ? { ...x, monthlyGoal: next } : x,
                      ),
                    )
                    const tid = goalDebouncersRef.current[h.id]
                    if (tid !== undefined) window.clearTimeout(tid)
                    goalDebouncersRef.current[h.id] = window.setTimeout(() => {
                      const habit = habitsRef.current.find((x) => x.id === h.id)
                      if (!habit) {
                        delete goalDebouncersRef.current[h.id]
                        return
                      }
                      if (!habit.negative && habit.monthlyGoal < 1) {
                        delete goalDebouncersRef.current[h.id]
                        return
                      }
                      dispatch('habit_upsert', habit)
                      delete goalDebouncersRef.current[h.id]
                    }, 500)
                  }}
                  onBlur={() => {
                    const tid = goalDebouncersRef.current[h.id]
                    if (tid !== undefined) {
                      window.clearTimeout(tid)
                      delete goalDebouncersRef.current[h.id]
                    }
                    const raw = goalInputDrafts[h.id]
                    setGoalInputDrafts((prev) => {
                      if (!(h.id in prev)) return prev
                      const next = { ...prev }
                      delete next[h.id]
                      return next
                    })
                    const habit = habitsRef.current.find((x) => x.id === h.id)
                    if (!habit) return
                    const minGoal = habit.negative ? 0 : 1
                    let normalized = habit.monthlyGoal
                    if (raw === '') normalized = minGoal
                    else if (raw !== undefined) {
                      const parsed = Number(raw)
                      if (Number.isFinite(parsed)) {
                        normalized = Math.max(
                          minGoal,
                          Math.min(31, Math.floor(parsed)),
                        )
                      }
                    } else if (!habit.negative && habit.monthlyGoal < 1) {
                      normalized = 1
                    }
                    if (normalized !== habit.monthlyGoal) {
                      const fixed = { ...habit, monthlyGoal: normalized }
                      setHabits((prev) =>
                        prev.map((x) => (x.id === h.id ? fixed : x)),
                      )
                      dispatch('habit_upsert', fixed)
                    } else {
                      dispatch('habit_upsert', habit)
                    }
                  }}
                  className="w-20 rounded-lg border border-teal-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-teal-300"
                />
                <div
                  className="relative ml-auto flex shrink-0 items-center gap-0.5"
                  data-habit-menu-root
                >
                  <button
                    type="button"
                    onClick={() => {
                      setClockMenuHabitId((id) =>
                        id === h.id ? null : h.id,
                      )
                      setMoreMenuHabitId(null)
                    }}
                    className="rounded-lg p-2 text-teal-700 hover:bg-teal-100"
                    aria-label="Срок и отложить"
                  >
                    <Clock className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuHabitId((id) =>
                        id === h.id ? null : h.id,
                      )
                      setClockMenuHabitId(null)
                    }}
                    className="rounded-lg p-2 text-teal-700 hover:bg-teal-100"
                    aria-label="Ещё"
                  >
                    <MoreVertical className="h-5 w-5" />
                  </button>
                  {clockMenuHabitId === h.id && (
                    <div className="absolute bottom-full right-0 z-40 mb-1 min-w-[12rem] rounded-lg border border-teal-200 bg-white py-1 shadow-lg">
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-teal-900 hover:bg-teal-50"
                        onClick={() => openClockCalendar(h.id, 'postpone')}
                      >
                        Отложить до
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-teal-900 hover:bg-teal-50"
                        onClick={() => openClockCalendar(h.id, 'deadline')}
                      >
                        Соблюдать до
                      </button>
                    </div>
                  )}
                  {moreMenuHabitId === h.id && (
                    <div className="absolute bottom-full right-8 z-40 mb-1 min-w-[10rem] rounded-lg border border-teal-200 bg-white py-1 shadow-lg">
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50"
                        onClick={() => {
                          setMoreMenuHabitId(null)
                          setDeleteConfirmId(h.id)
                        }}
                      >
                        Удалить
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-teal-900 hover:bg-teal-50"
                        onClick={() => {
                          const habit = habitsRef.current.find(
                            (x) => x.id === h.id,
                          )
                          if (habit)
                            dispatch('habit_upsert', {
                              ...habit,
                              archived: true,
                              postponedUntil: null,
                            })
                          setMoreMenuHabitId(null)
                        }}
                      >
                        В архив
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {h.deadline ? (
                <div className="mt-1 flex items-start justify-between gap-2">
                  <p className="min-w-0 text-xs leading-snug text-neutral-600">
                    Соблюдать до{' '}
                    {(() => {
                      const { y, m0, d } = parseKey(h.deadline)
                      return `${pad2(d)}.${pad2(m0 + 1)}.${y}`
                    })()}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      const habit = habitsRef.current.find((x) => x.id === h.id)
                      if (habit)
                        dispatch('habit_upsert', {
                          ...habit,
                          deadline: null,
                          archived: false,
                        })
                    }}
                    className="shrink-0 rounded p-0.5 text-teal-600 hover:bg-teal-100"
                    aria-label="Убрать срок"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {habitsEditorSections.inactive.length > 0 && (
            <div className="space-y-3 pt-2">
              <h3 className="text-sm font-semibold text-neutral-500">
                Архив и скрытые
              </h3>
              {habitsEditorSections.inactive.map((h) => (
                <div
                  key={h.id}
                  className="rounded-2xl border border-neutral-200 bg-neutral-100/60 px-4 py-3 text-neutral-600"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-lg">{h.emoji}</span>
                    <span className="min-w-0 flex-1 font-medium text-neutral-700">
                      {h.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        dispatch('habit_upsert', {
                          ...h,
                          archived: false,
                          deadline: null,
                          postponedUntil: null,
                        })
                      }}
                      className="shrink-0 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800"
                    >
                      Вернуть
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    {h.postponedUntil && todayKey < h.postponedUntil
                      ? `До ${h.postponedUntil} в архиве`
                      : h.deadline && todayKey > h.deadline
                        ? `Срок ${h.deadline} истёк`
                        : h.archived
                          ? 'В архиве'
                          : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
        <h3 className="mb-3 mt-6 text-base font-semibold text-teal-900">
          Экспорт и импорт
        </h3>
        <div className="space-y-3 rounded-xl border border-teal-200 bg-white p-4 shadow-sm">
          <label className="flex cursor-pointer items-start gap-2 text-sm text-teal-900">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-teal-400 text-teal-600"
              checked={exportIncludeProgress}
              onChange={(e) => setExportIncludeProgress(e.target.checked)}
            />
            <span>Сохранять отметки по дням (иначе только список привычек)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                downloadJsonFile(
                  { habits, completions },
                  exportIncludeProgress,
                )
              }
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
            >
              Скачать JSON
            </button>
            <label className="cursor-pointer rounded-lg border border-teal-300 px-4 py-2 text-sm text-teal-800 hover:bg-teal-50">
              Загрузить JSON
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  const r = new FileReader()
                  r.onload = () => {
                    const t = String(r.result)
                    const p = parseBundleJson(t)
                    if (!p) return
                    if (p.kind === 'full') {
                      const data = {
                        habits: p.data.habits,
                        completions: p.data.completions,
                      }
                      if (
                        session?.user &&
                        supabaseConfigured &&
                        supabaseSyncPhase === 'ready'
                      ) {
                        dispatch('state_snapshot', data)
                      } else {
                        setHabits(data.habits)
                        setCompletions(data.completions)
                      }
                    } else {
                      const merged = {
                        habits: p.habits,
                        completions: mergeCompletionsForImportedHabits(
                          p.habits,
                          completionsRef.current,
                        ),
                      }
                      if (
                        session?.user &&
                        supabaseConfigured &&
                        supabaseSyncPhase === 'ready'
                      ) {
                        dispatch('state_snapshot', merged)
                      } else {
                        setHabits(merged.habits)
                        setCompletions(merged.completions)
                      }
                    }
                  }
                  r.readAsText(f)
                  e.target.value = ''
                }}
              />
            </label>
          </div>
        </div>
      </main>
      ) : (
      <main
        className={`mx-auto max-w-7xl px-2 py-4 sm:px-3 sm:py-6 ${
          isMobile ? 'pb-28' : ''
        }`}
      >
        {(!isMobile || mobileTrackerTab === 'analytics') && (
        <div
          className={`mb-4 grid gap-4 lg:mb-6 ${
            !isMobile ? 'lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]' : ''
          } ${
            isMobile
              ? 'rounded-2xl border border-neutral-200/80 bg-white p-3 shadow-sm'
              : ''
          }`}
        >
          {!isMobile && (
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-teal-700">
              Сегодня
            </p>
            <MiniCalendar />
          </div>
          )}
          <section
            className={`min-w-0 p-3 sm:p-4 ${
              isMobile
                ? 'border-0 bg-transparent p-0 shadow-none'
                : 'rounded-xl border border-teal-200 bg-white shadow-sm'
            }`}
          >
            <h2 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-teal-900">
              <BarChart3 className="h-4 w-4 shrink-0" />
              <span>Динамика: {dynTitle}</span>
            </h2>
            <div className="mb-3 flex flex-wrap gap-1">
              {(
                [
                  ['day', 'День'],
                  ['week', 'Неделя'],
                  ['month', 'Месяц'],
                  ['year', 'Год'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDynMode(m)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    dynMode === m
                      ? 'bg-teal-700 text-white shadow'
                      : 'bg-teal-50 text-teal-800 hover:bg-teal-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-stretch gap-1.5 sm:gap-2">
              <div
                aria-hidden
                className="flex h-32 w-7 shrink-0 flex-col justify-between border-r border-teal-200 py-0.5 pr-0.5 text-right text-[9px] tabular-nums leading-none text-teal-600 sm:h-36 sm:w-8 sm:pr-1 sm:text-[10px]"
              >
                {[100, 75, 50, 25, 0].map((tick) => (
                  <span key={tick}>{tick}</span>
                ))}
              </div>
              <div
                className={`min-w-0 flex-1 touch-pan-x ${dynMode === 'day' ? 'overflow-x-auto pb-1' : ''}`}
              >
                <div
                  className={`relative h-32 sm:h-36 ${dynMode === 'day' ? 'min-w-max' : ''}`}
                >
                  <div
                    className="pointer-events-none absolute inset-0 flex flex-col justify-between py-0"
                    aria-hidden
                  >
                    {Array.from({ length: 5 }).map((_, gi) => (
                      <div
                        key={gi}
                        className="h-px w-full bg-teal-100/90"
                      />
                    ))}
                  </div>
                  <div
                    className="relative z-10 grid h-full min-h-0 gap-1.5 px-0.5 sm:gap-2"
                    style={{
                      gridTemplateColumns: `repeat(${Math.max(1, chartPosRates.length)}, minmax(0, 1fr))`,
                    }}
                  >
                    {chartLabels.map((_, i) => {
                      const posClamped = Math.min(
                        100,
                        Math.max(0, chartPosRates[i] ?? 0),
                      )
                      const negClamped = Math.min(
                        100,
                        Math.max(0, chartNegRates[i] ?? 0),
                      )
                      return (
                        <div
                          key={i}
                          className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-0.5"
                        >
                          <div
                            className="flex h-full min-h-0 w-full items-end justify-center gap-0.5 sm:gap-1"
                            title={`${posClamped}% · срывы ${negClamped}%`}
                          >
                            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col justify-end">
                              <div
                                className="w-full rounded-t-md bg-emerald-400 transition-all"
                                style={{
                                  height: `${posClamped}%`,
                                  minHeight: posClamped > 0 ? '1px' : 0,
                                }}
                              />
                            </div>
                            <div className="flex h-full min-w-0 min-h-0 flex-1 flex-col justify-end">
                              <div
                                className="w-full rounded-t-md bg-rose-500 transition-all"
                                style={{
                                  height: `${negClamped}%`,
                                  minHeight: negClamped > 0 ? '1px' : 0,
                                }}
                              />
                            </div>
                          </div>
                          <span className="max-w-[4.5rem] truncate text-center text-[10px] leading-tight text-teal-700">
                            {chartLabels[i]}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
        )}

        {habits.length === 0 ? (
          <div
            className={`rounded-xl border border-dashed px-6 py-16 text-center ${
              isMobile
                ? 'border-neutral-300 bg-white text-neutral-800'
                : 'border-teal-300 bg-teal-50/80 text-teal-800'
            }`}
          >
            <p className="text-lg font-medium">Пока нет привычек</p>
            <p className="mt-2 text-sm opacity-90">
              {isMobile
                ? 'Нажмите кнопку «+» внизу.'
                : 'Нажмите «Привычка», чтобы добавить первую.'}
            </p>
          </div>
        ) : (
          <div
            className={`flex flex-col gap-0 overflow-hidden lg:flex-row ${
              isMobile
                ? 'border-0 bg-transparent shadow-none'
                : 'rounded-xl border border-teal-200 bg-white shadow-md'
            }`}
          >
            {(!isMobile || mobileTrackerTab === 'marks') && (
            <div className="flex min-w-0 flex-1 touch-pan-y items-stretch gap-1">
              <div
                className={`min-w-0 flex-1 ${
                  isMobile
                    ? 'overflow-x-hidden'
                    : 'overflow-x-auto [-webkit-overflow-scrolling:touch]'
                }`}
              >
              {isMobile ? (
                <div className="space-y-3 px-0.5">
                  {trackerOrderedHabits.map((h) => {
                    const goalLabel = h.negative
                      ? `до ${h.monthlyGoal} срыв./мес.`
                      : `${h.monthlyGoal} дн. в месяц`
                    return (
                      <div
                        key={h.id}
                        className="rounded-2xl border border-neutral-200/70 bg-white px-4 py-3 shadow-sm"
                      >
                        <div className="mb-3 flex items-start justify-between gap-2">
                          <div className="flex min-w-0 flex-1 items-start gap-2">
                            <span className="text-2xl leading-none">{h.emoji}</span>
                            <div className="min-w-0">
                              <p className="truncate text-base font-semibold text-neutral-900">
                                {h.name}
                              </p>
                              {h.deadline ? (
                                <p className="mt-0.5 text-xs leading-snug text-neutral-500">
                                  Соблюдать до{' '}
                                  {(() => {
                                    const { y: yy, m0: mm, d: dd } = parseKey(
                                      h.deadline,
                                    )
                                    return `${pad2(dd)}.${pad2(mm + 1)}.${yy}`
                                  })()}
                                </p>
                              ) : null}
                            </div>
                          </div>
                          <span className="shrink-0 text-xs text-neutral-500">
                            {goalLabel}
                          </span>
                        </div>
                        {mobileMarksView === 'week' ? (
                          <div className="flex justify-between gap-1">
                            {dayColumns.map((col) => {
                              const key = col.key
                              const raw = completions[h.id]?.[key]
                              return (
                                <div
                                  key={key}
                                  className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
                                >
                                  <span className="text-[10px] font-medium text-neutral-400">
                                    {col.weekday}
                                  </span>
                                  <WeekDot
                                    habit={h}
                                    raw={raw}
                                    onToggle={() => toggleDay(h.id, key)}
                                  />
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-neutral-400">
                              {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((wd) => (
                                <span key={wd}>{wd}</span>
                              ))}
                            </div>
                            <div className="grid grid-cols-7 gap-1">
                              {mobileMonthCells.map((d, idx) => {
                                if (d == null) return <div key={`empty-${h.id}-${idx}`} className="h-10" />
                                const key = dateKey(y, m0, d)
                                const raw = completions[h.id]?.[key]
                                const marked = raw === true
                                const cellCls = h.negative
                                  ? marked
                                    ? 'border-rose-300 bg-rose-100 text-rose-800'
                                    : 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                  : marked
                                    ? 'border-emerald-600 bg-emerald-500 text-white'
                                    : 'border-slate-200 bg-white text-neutral-700'
                                return (
                                  <button
                                    key={`${h.id}-${key}`}
                                    type="button"
                                    onClick={() => toggleDay(h.id, key)}
                                    className={`flex h-10 flex-col items-center justify-center rounded-lg border text-[10px] font-semibold ${cellCls} ${key === todayKey ? 'ring-2 ring-teal-200' : ''}`}
                                  >
                                    <span className="leading-none">{d}</span>
                                    <span className="mt-0.5 leading-none">
                                      {!h.negative && marked ? '✓' : h.negative && marked ? '✕' : h.negative ? '·' : ''}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
              <table
                className={`border-collapse text-xs sm:text-sm ${
                  isMobile ? 'w-full table-fixed' : 'w-max min-w-full'
                }`}
              >
                <thead>
                  <tr className="bg-teal-700 text-white">
                    <th
                      rowSpan={2}
                      className={`sticky left-0 z-20 border border-teal-600 bg-teal-700 px-1.5 py-2 align-middle text-left text-xs font-semibold sm:max-w-none sm:min-w-[10rem] sm:px-2 sm:text-sm ${isMobile ? 'w-[6.4rem] min-w-[6.4rem] max-w-[6.4rem]' : 'max-w-[42vw] min-w-[7.5rem]'}`}
                    >
                      Привычка
                    </th>
                    {dayColumns.map((col) => (
                      <th
                        key={col.key}
                        className={`border border-teal-600 px-0 py-1.5 text-center text-[10px] font-medium sm:min-w-[2.25rem] sm:text-xs ${
                          isMobile ? 'w-[2.05rem] min-w-[2.05rem]' : 'min-w-[2rem]'
                        } ${
                          col.isToday ? 'bg-teal-500' : ''
                        }`}
                      >
                        {col.day}
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-teal-700 text-white">
                    {dayColumns.map((col) => (
                      <th
                        key={`w-${col.key}`}
                        className={`border border-teal-600 px-0 pb-1.5 pt-0 text-center text-[9px] font-normal opacity-95 sm:min-w-[2.25rem] sm:text-[10px] ${
                          isMobile ? 'w-[2.05rem] min-w-[2.05rem]' : 'min-w-[2rem]'
                        } ${
                          col.isToday ? 'bg-teal-500' : ''
                        }`}
                      >
                        {col.weekday}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trackerOrderedHabits.map((h) => (
                    <tr key={h.id}>
                      <td
                        className={`sticky left-0 z-10 border border-slate-200 px-1.5 py-1 text-xs font-medium sm:max-w-none sm:min-w-[10rem] sm:px-2 sm:text-sm ${
                          isMobile ? 'w-[6.4rem] min-w-[6.4rem] max-w-[6.4rem]' : 'max-w-[42vw] min-w-[7.5rem]'
                        } ${
                          h.negative ? 'text-rose-950' : 'text-teal-950'
                        } ${rowStyle(h)} border-r-teal-100/80 shadow-[4px_0_8px_-2px_rgba(15,118,110,0.12)]`}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex min-w-0 items-center gap-1">
                            <span className="shrink-0 select-none">{h.emoji}</span>
                            <span
                              className={`min-w-0 truncate text-xs font-medium sm:text-sm ${
                                h.negative ? 'text-rose-950' : 'text-teal-950'
                              }`}
                            >
                              {h.name}
                            </span>
                          </div>
                          {h.deadline ? (
                            <span className="block pl-5 text-[9px] leading-tight text-neutral-500 sm:text-[10px]">
                              Соблюдать до{' '}
                              {(() => {
                                const { y: yy, m0: mm, d: dd } = parseKey(
                                  h.deadline,
                                )
                                return `${pad2(dd)}.${pad2(mm + 1)}.${yy}`
                              })()}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      {dayColumns.map(
                        (col) => {
                          const key = col.key
                          const raw = completions[h.id]?.[key]
                          const base = rowStyle(h)
                          const hi =
                            col.isToday
                              ? h.negative
                                ? 'bg-rose-200'
                                : 'bg-teal-100'
                              : base
                          return (
                            <td
                              key={key}
                              className={`border border-slate-200 text-center ${isMobile ? 'p-0' : 'p-0.5'} ${hi}`}
                            >
                              <div className="flex justify-center">
                                <Cell
                                  habit={h}
                                  raw={raw}
                                  onToggle={() => toggleDay(h.id, key)}
                                />
                              </div>
                            </td>
                          )
                        },
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
              </div>
            </div>
            )}

            {(!isMobile || mobileTrackerTab === 'analytics') && (
            <div
              className={`w-full shrink-0 lg:min-w-[21rem] lg:w-[21rem] lg:max-w-none ${
                isMobile
                  ? 'border-0 bg-transparent'
                  : 'border-t border-teal-200 bg-teal-50/90 lg:border-l lg:border-t-0'
              }`}
            >
              <div
                className={
                  isMobile
                    ? ''
                    : 'overflow-x-auto [-webkit-overflow-scrolling:touch]'
                }
              >
                <div
                  className={isMobile ? '' : 'min-w-[18.5rem] sm:min-w-[20rem]'}
                >
                  {isMobile ? (
                    <div className="space-y-3">
                      {trackerOrderedHabits.map((h) => {
                        const map = completions[h.id]
                        const goal = h.monthlyGoal
                        const done = h.negative
                          ? slipCountInMonth(map, y, m0)
                          : totalSuccessInMonth(h, map, y, m0)
                        const pct = h.negative
                          ? done === 0
                            ? 100
                            : Math.max(
                                0,
                                Math.round(
                                  ((goal - done) / Math.max(1, goal)) * 1000,
                                ) / 10,
                              )
                          : progressPercent(done, goal)
                        const cur = currentStreakEndingAt(h, map, y, m0, today)
                        const lon = longestStreakInMonth(h, map, y, m0)
                        const bar = Math.min(100, pct)
                        return (
                          <div
                            key={h.id}
                            className="rounded-2xl border border-teal-100 bg-white px-4 py-3 shadow-sm"
                          >
                            <div className="mb-3 flex items-center gap-2">
                              <span className="text-2xl leading-none">{h.emoji}</span>
                              <span className="min-w-0 truncate text-base font-semibold text-teal-950">
                                {h.name}
                              </span>
                            </div>
                            <div className="mb-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs text-teal-900">
                              <div className="flex items-center justify-between gap-2 rounded-lg bg-teal-50/80 px-2 py-1.5">
                                <span className="text-teal-600">
                                  {h.negative ? 'Лимит' : 'Цель'}
                                </span>
                                <span className="font-semibold tabular-nums">
                                  {goal}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2 rounded-lg bg-teal-50/80 px-2 py-1.5">
                                <span className="text-teal-600">
                                  {h.negative ? 'Запас' : 'Прогресс'}
                                </span>
                                <span className="font-semibold tabular-nums">
                                  {pct}%
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2 rounded-lg bg-teal-50/80 px-2 py-1.5">
                                <span className="text-teal-600">
                                  {h.negative ? 'Срывов' : 'Всего'}
                                </span>
                                <span className="font-semibold tabular-nums">
                                  {done}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2 rounded-lg bg-teal-50/80 px-2 py-1.5">
                                <span className="text-teal-600">
                                  {h.negative ? 'Подряд без срыва' : 'Серия'}
                                </span>
                                <span className="font-semibold tabular-nums">
                                  {cur}
                                </span>
                              </div>
                              <div className="col-span-2 flex items-center justify-between gap-2 rounded-lg bg-teal-50/80 px-2 py-1.5">
                                <span className="text-teal-600">
                                  {h.negative ? 'Рекорд чистых дней' : 'Рекорд'}
                                </span>
                                <span className="font-semibold tabular-nums">
                                  {lon}
                                </span>
                              </div>
                            </div>
                            <div
                              className={`h-2 w-full overflow-hidden rounded-full ring-1 ${
                                h.negative
                                  ? 'bg-rose-100 ring-rose-200/60'
                                  : 'bg-emerald-100 ring-emerald-200/60'
                              }`}
                            >
                              <div
                                className={`h-full rounded-full transition-all ${
                                  h.negative ? 'bg-rose-500' : 'bg-emerald-500'
                                }`}
                                style={{
                                  width: `${bar}%`,
                                  minWidth: bar > 0 ? '2px' : undefined,
                                }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-5 gap-x-0.5 border-b border-teal-200 bg-teal-100 px-1.5 py-2 text-[9px] font-semibold uppercase leading-tight tracking-wide text-teal-900 sm:gap-x-1 sm:px-2 sm:text-[10px]">
                        <div className="flex min-w-0 flex-col items-center justify-center gap-0.5 text-center">
                          <Target className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="whitespace-nowrap">
                            {trackerStatsKind === 'neg'
                              ? 'Лимит'
                              : trackerStatsKind === 'mix'
                                ? 'План'
                                : 'Цель'}
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-col items-center justify-center gap-0.5 text-center">
                          <BarChart3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="whitespace-nowrap">
                            {trackerStatsKind === 'neg'
                              ? 'Запас'
                              : trackerStatsKind === 'mix'
                                ? 'Доля'
                                : 'Прогресс'}
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-col items-center justify-center gap-0.5 text-center">
                          <span className="text-xs leading-none" aria-hidden>
                            Σ
                          </span>
                          <span className="whitespace-nowrap">
                            {trackerStatsKind === 'neg'
                              ? 'Срывов'
                              : trackerStatsKind === 'mix'
                                ? 'Факт'
                                : 'Всего'}
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-col items-center justify-center gap-0.5 text-center">
                          <Flame className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="whitespace-nowrap">
                            {trackerStatsKind === 'neg'
                              ? 'Подряд'
                              : trackerStatsKind === 'mix'
                                ? 'Серия'
                                : 'Серия'}
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-col items-center justify-center gap-0.5 text-center">
                          <Trophy className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="whitespace-nowrap">
                            {trackerStatsKind === 'neg'
                              ? 'Рекорд'
                              : trackerStatsKind === 'mix'
                                ? 'Рекорд'
                                : 'Рекорд'}
                          </span>
                        </div>
                      </div>
                      <div className="divide-y divide-teal-200">
                        {trackerOrderedHabits.map((h) => {
                          const map = completions[h.id]
                          const goal = h.monthlyGoal
                          const done = h.negative
                            ? slipCountInMonth(map, y, m0)
                            : totalSuccessInMonth(h, map, y, m0)
                          const pct = h.negative
                            ? done === 0
                              ? 100
                              : Math.max(
                                  0,
                                  Math.round(
                                    ((goal - done) / Math.max(1, goal)) * 1000,
                                  ) / 10,
                                )
                            : progressPercent(done, goal)
                          const cur = currentStreakEndingAt(h, map, y, m0, today)
                          const lon = longestStreakInMonth(h, map, y, m0)
                          const bar = Math.min(100, pct)
                          return (
                            <div
                              key={h.id}
                              className={`flex flex-col gap-2 px-1.5 py-2 text-xs sm:px-2 ${rowStyle(h)} text-teal-900`}
                            >
                              <div className="truncate text-[11px] font-medium">
                                {h.emoji} {h.name}
                              </div>
                              <div className="grid grid-cols-5 gap-x-0.5 sm:gap-x-1">
                                <div className="min-w-0 text-center tabular-nums">
                                  {goal}
                                </div>
                                <div className="min-w-0 text-center font-semibold tabular-nums">
                                  {pct}%
                                </div>
                                <div className="min-w-0 text-center tabular-nums">
                                  {done}
                                </div>
                                <div className="min-w-0 text-center tabular-nums">
                                  {cur}
                                </div>
                                <div className="min-w-0 text-center tabular-nums">
                                  {lon}
                                </div>
                              </div>
                              <div
                                className={`h-2 w-full shrink-0 overflow-hidden rounded-full ring-1 ${
                                  h.negative
                                    ? 'bg-rose-100 ring-rose-200/60'
                                    : 'bg-emerald-100 ring-emerald-200/60'
                                }`}
                              >
                                <div
                                  className={`h-full rounded-full transition-all ${
                                    h.negative ? 'bg-rose-500' : 'bg-emerald-500'
                                  }`}
                                  style={{
                                    width: `${bar}%`,
                                    minWidth: bar > 0 ? '2px' : undefined,
                                  }}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
            )}
          </div>
        )}
      </main>
      )}

      {screen === 'tracker' && !isMobile && (
        <button
          type="button"
          onClick={() => setModal(true)}
          className="fixed bottom-5 right-5 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full bg-teal-700 text-white shadow-lg hover:bg-teal-800 sm:bottom-6 sm:right-6"
          aria-label="Добавить привычку"
        >
          <Plus className="h-6 w-6" />
        </button>
      )}

      {isMobile && (
        <>
          {authMenuOpen && session?.user && (
            <button
              type="button"
              className="fixed inset-0 z-[90] bg-black/30"
              aria-label="Закрыть меню"
              onClick={() => setAuthMenuOpen(false)}
            />
          )}
          {authMenuOpen && session?.user && (
            <div className="fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[110] mx-auto max-w-sm rounded-2xl border border-teal-200 bg-white p-4 shadow-2xl">
              <p className="mb-3 truncate text-sm font-medium text-teal-900">
                {profileName}
              </p>
              <button
                type="button"
                disabled={!supabase}
                onClick={async () => {
                  setAuthMenuOpen(false)
                  setAuthErr(null)
                  setAuthInfo(null)
                  if (!supabase) return
                  await supabase.auth.signOut()
                }}
                className="w-full rounded-xl bg-teal-700 py-3 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
              >
                Выйти
              </button>
            </div>
          )}
          {screen === 'tracker' && mobileTrackerTab === 'marks' && (
            <div className="fixed bottom-[calc(5.2rem+env(safe-area-inset-bottom))] left-3 z-[105]">
              <div className="inline-flex rounded-xl border border-teal-200 bg-white p-0.5 shadow-sm">
                <button
                  type="button"
                  onClick={() => setMobileMarksView('week')}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold ${
                    mobileMarksView === 'week' ? 'bg-teal-600 text-white' : 'text-teal-800'
                  }`}
                >
                  Неделя
                </button>
                <button
                  type="button"
                  onClick={() => setMobileMarksView('month')}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold ${
                    mobileMarksView === 'month' ? 'bg-teal-600 text-white' : 'text-teal-800'
                  }`}
                >
                  Месяц
                </button>
              </div>
            </div>
          )}
          <nav
            className="fixed bottom-0 left-0 right-0 z-[100] pointer-events-none"
            aria-label="Основная навигация"
          >
            <div className="pointer-events-auto px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
              <div className="relative mx-auto h-[4.5rem] max-w-md">
                <svg
                  className="absolute inset-0 h-full w-full text-teal-800 drop-shadow-[0_-6px_24px_rgba(15,118,110,0.2)]"
                  viewBox="0 0 400 80"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <path
                    fill="currentColor"
                    d="M0,80 L0,40 C0,18 16,0 38,0 L158,0 Q200,-30 242,0 L362,0 C384,0 400,18 400,40 L400,80 Z"
                  />
                </svg>
                <div className="relative z-10 grid h-full grid-cols-5 items-end gap-0 px-0.5 pb-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setScreen('tracker')
                      setMobileTrackerTab('marks')
                    }}
                    className={`flex flex-col items-center justify-end gap-1 pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 ${
                      screen === 'tracker' && mobileTrackerTab === 'marks'
                        ? 'text-white'
                        : 'text-teal-200/85'
                    }`}
                    aria-current={
                      screen === 'tracker' && mobileTrackerTab === 'marks'
                        ? 'page'
                        : undefined
                    }
                    aria-label="Трекер"
                  >
                    <LayoutGrid className="h-6 w-6" strokeWidth={1.75} />
                    {screen === 'tracker' && mobileTrackerTab === 'marks' && (
                      <span className="h-0.5 w-5 rounded-full bg-white" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setScreen('habits')}
                    className={`flex flex-col items-center justify-end gap-1 pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 ${
                      screen === 'habits' ? 'text-white' : 'text-teal-200/85'
                    }`}
                    aria-current={screen === 'habits' ? 'page' : undefined}
                    aria-label="Список привычек"
                  >
                    <List className="h-6 w-6" strokeWidth={1.75} />
                    {screen === 'habits' && (
                      <span className="h-0.5 w-5 rounded-full bg-white" />
                    )}
                  </button>
                  <div className="relative flex min-h-[2.75rem] items-end justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        setAuthMenuOpen(false)
                        setModal(true)
                      }}
                      className="absolute left-1/2 top-0 z-10 flex h-[3.35rem] w-[3.35rem] -translate-x-1/2 -translate-y-[42%] items-center justify-center rounded-full bg-teal-500 text-white shadow-[0_4px_14px_rgba(15,118,110,0.45)] ring-4 ring-[#f9f9f9] transition active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
                      aria-label="Добавить привычку"
                    >
                      <Plus className="h-7 w-7" strokeWidth={2.75} />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!session?.user) setAuthModalOpen(true)
                      else setAuthMenuOpen((v) => !v)
                    }}
                    className={`flex flex-col items-center justify-end gap-1 pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 ${
                      authMenuOpen && session?.user
                        ? 'text-white'
                        : 'text-teal-200/85'
                    }`}
                    aria-label="Профиль"
                  >
                    <User className="h-6 w-6" strokeWidth={1.75} />
                    {authMenuOpen && session?.user && (
                      <span className="h-0.5 w-5 rounded-full bg-white" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScreen('tracker')
                      setMobileTrackerTab('analytics')
                    }}
                    className={`flex flex-col items-center justify-end gap-1 pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 ${
                      screen === 'tracker' && mobileTrackerTab === 'analytics'
                        ? 'text-white'
                        : 'text-teal-200/85'
                    }`}
                    aria-current={
                      screen === 'tracker' && mobileTrackerTab === 'analytics'
                        ? 'page'
                        : undefined
                    }
                    aria-label="Статистика"
                  >
                    <BarChart3 className="h-6 w-6" strokeWidth={1.75} />
                    {screen === 'tracker' &&
                      mobileTrackerTab === 'analytics' && (
                        <span className="h-0.5 w-5 rounded-full bg-white" />
                      )}
                  </button>
                </div>
              </div>
            </div>
          </nav>
        </>
      )}

      {authModalOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setAuthModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-teal-200 bg-white p-4 shadow-2xl sm:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-lg font-semibold text-teal-900">
              {authMode === 'login' ? 'Вход' : 'Регистрация'}
            </h3>
            {!supabaseConfigured && (
              <p className="text-sm text-amber-800">
                Вход недоступен: не заданы переменные Supabase для сборки.
              </p>
            )}
            {supabaseConfigured && (
              <>
                <div className="mb-3 flex rounded-lg bg-teal-100/80 p-0.5 text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('login')
                      setAuthErr(null)
                      setAuthInfo(null)
                    }}
                    className={`flex-1 rounded-md px-3 py-2 font-medium transition ${
                      authMode === 'login'
                        ? 'bg-white text-teal-900 shadow'
                        : 'text-teal-800'
                    }`}
                  >
                    Вход
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('register')
                      setAuthErr(null)
                      setAuthInfo(null)
                    }}
                    className={`flex-1 rounded-md px-3 py-2 font-medium transition ${
                      authMode === 'register'
                        ? 'bg-white text-teal-900 shadow'
                        : 'text-teal-800'
                    }`}
                  >
                    Регистрация
                  </button>
                </div>
                <div className="space-y-2.5">
                  {authMode === 'register' && (
                    <input
                      type="text"
                      autoComplete="nickname"
                      placeholder="Имя"
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      className="w-full rounded-lg border border-teal-200 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-teal-400"
                    />
                  )}
                  <input
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    placeholder="Эл. почта"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    className="w-full rounded-lg border border-teal-200 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-teal-400"
                  />
                  <input
                    type="password"
                    autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                    placeholder="Пароль"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="w-full rounded-lg border border-teal-200 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-teal-400"
                  />
                  {authMode === 'register' && (
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Пароль ещё раз"
                      value={authPassword2}
                      onChange={(e) => setAuthPassword2(e.target.value)}
                      className="w-full rounded-lg border border-teal-200 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-teal-400"
                    />
                  )}
                  <button
                    type="button"
                    disabled={!supabase}
                    onClick={submitAuth}
                    className="w-full rounded-lg bg-teal-700 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                  >
                    {authMode === 'login' ? 'Войти' : 'Создать аккаунт'}
                  </button>
                </div>
              </>
            )}
            {authErr && <p className="mt-2 text-sm text-rose-700">{authErr}</p>}
            {authInfo && <p className="mt-2 text-sm text-emerald-800">{authInfo}</p>}
          </div>
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
          <div
            role="dialog"
            className="max-h-[min(92dvh,100vh-env(safe-area-inset-bottom))] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-teal-200 bg-white p-4 shadow-2xl sm:max-h-[85vh] sm:rounded-2xl sm:p-6"
          >
            <h3 className="mb-4 text-lg font-semibold text-teal-900">
              Новая привычка
            </h3>
            <label className="mb-2 block text-sm font-medium text-teal-800">
              Название
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-teal-200 px-3 py-2 outline-none focus:ring-2 focus:ring-teal-400"
                placeholder="Например, йога"
              />
            </label>
            <div className="mb-4">
              <p className="mb-2 text-sm font-medium text-teal-800">Эмодзи</p>
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50/50 px-3 py-2">
                <span className="text-3xl leading-none">
                  {EMOJI_OPTIONS.includes(formEmoji) ? formEmoji : EMOJI_OPTIONS[0]}
                </span>
              </div>
              <div className="max-h-52 overflow-y-auto rounded-lg border border-teal-200 bg-white p-2 shadow-inner">
                <div className="grid grid-cols-8 gap-1 sm:grid-cols-10">
                  {EMOJI_OPTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setFormEmoji(e)}
                      className={`flex aspect-square items-center justify-center rounded-md text-xl transition ${
                        formEmoji === e
                          ? 'bg-teal-600 text-white ring-2 ring-teal-400 ring-offset-1'
                          : 'bg-teal-50/80 hover:bg-teal-100'
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <label className="mb-4 block text-sm font-medium text-teal-800">
              {formNeg
                ? 'Допустимое количество срывов в месяц'
                : 'Цель на месяц (дней)'}
              <input
                type="number"
                min={1}
                max={31}
                value={formGoalInput}
                onChange={(e) => setFormGoalInput(e.target.value)}
                className="mt-1 w-full rounded-lg border border-teal-200 px-3 py-2 outline-none focus:ring-2 focus:ring-teal-400"
              />
            </label>
            <label className="mb-4 block text-sm font-medium text-teal-800">
              Соблюдать до (окончание цикла)
              <input
                type="date"
                value={formDeadline}
                onChange={(e) => setFormDeadline(e.target.value)}
                className="mt-1 w-full rounded-lg border border-teal-200 px-3 py-2 outline-none focus:ring-2 focus:ring-teal-400"
              />
            </label>
            <label className="mb-6 flex cursor-pointer items-center gap-2 text-sm text-teal-900">
              <input
                type="checkbox"
                checked={formNeg}
                onChange={(e) => setFormNeg(e.target.checked)}
                className="h-4 w-4 rounded border-teal-400 text-teal-600 focus:ring-teal-500"
              />
              Негативная привычка (отмечаю срывы)
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModal(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-teal-800 hover:bg-teal-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={addHabit}
                className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white shadow hover:bg-teal-800"
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}

      {calendarTarget && (
        <div
          className="fixed inset-0 z-[124] flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4"
          onClick={() => setCalendarTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-teal-200 bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  const d = new Date(calendarY, calendarM0 - 1, 1)
                  setCalendarY(d.getFullYear())
                  setCalendarM0(d.getMonth())
                }}
                className="rounded-lg p-2 text-teal-700 hover:bg-teal-50"
                aria-label="Предыдущий месяц"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <div className="text-sm font-semibold capitalize text-teal-900">
                {calendarMonthLabel}
              </div>
              <button
                type="button"
                onClick={() => {
                  const d = new Date(calendarY, calendarM0 + 1, 1)
                  setCalendarY(d.getFullYear())
                  setCalendarM0(d.getMonth())
                }}
                className="rounded-lg p-2 text-teal-700 hover:bg-teal-50"
                aria-label="Следующий месяц"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
            <div className="mb-2 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-neutral-500">
              {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w) => (
                <div key={w} className="py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calendarMonthDays.map((d, i) => {
                if (d == null) return <div key={`empty-${i}`} className="h-10" />
                const key = dateKey(calendarY, calendarM0, d)
                const isSel = key === calendarSelectedKey
                const isNow = key === todayKey
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => applyCalendarPick(key)}
                    className={`h-10 rounded-lg text-sm font-medium ${
                      isSel
                        ? 'bg-teal-600 text-white'
                        : isNow
                          ? 'bg-teal-100 text-teal-900'
                          : 'text-neutral-800 hover:bg-neutral-100'
                    }`}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => applyCalendarPick(todayKey)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-teal-800 hover:bg-teal-50"
              >
                Сегодня
              </button>
              <button
                type="button"
                onClick={() => setCalendarTarget(null)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmId && (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setDeleteConfirmId(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-habit-title"
            className="w-full max-w-sm rounded-2xl border border-teal-200 bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              id="delete-habit-title"
              className="space-y-2 text-center text-base leading-snug text-teal-900"
            >
              <p className="mb-0">Вы уверены, что хотите удалить привычку</p>
              {habitPendingDelete ? (
                <p className="mb-0 font-semibold">
                  <span className="mr-1.5 inline-block" aria-hidden>
                    {habitPendingDelete.emoji}
                  </span>
                  {habitPendingDelete.name}?
                </p>
              ) : (
                <p className="mb-0">?</p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmId(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-teal-800 hover:bg-teal-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  removeHabit(deleteConfirmId)
                  setDeleteConfirmId(null)
                }}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-rose-700"
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
