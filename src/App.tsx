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
  Eye,
  EyeOff,
  Flame,
  HelpCircle,
  LayoutGrid,
  List,
  MoreVertical,
  Plus,
  Star,
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
  isSuccess,
  progressPercent,
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
const PENDING_KEY_PREFIX = 'habit-calendar-pending-v1:'

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

const EMAIL_MAX_TOTAL = 320
const EMAIL_MAX_LOCAL = 64
const EMAIL_MAX_DOMAIN = 255

function emailLengthError(email: string): string | null {
  if (email.length > EMAIL_MAX_TOTAL) {
    return 'Адрес почты не длиннее 320 символов.'
  }
  const at = email.indexOf('@')
  if (at === -1) return null
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length > EMAIL_MAX_LOCAL) {
    return 'Часть до «@» — не более 64 символов.'
  }
  if (domain.length > EMAIL_MAX_DOMAIN) {
    return 'Часть после «@» — не более 255 символов.'
  }
  return null
}

function friendlyAuthError(e: unknown): string {
  const msg = errText(e)
  const low = msg.toLowerCase()
  if (low.includes('invalid login credentials')) {
    return 'Неверная почта или пароль. Проверьте данные и попробуйте снова.'
  }
  if (low.includes('email not confirmed')) {
    return 'Почта не подтверждена. Откройте письмо и подтвердите адрес.'
  }
  if (low.includes('too many requests') || low.includes('over_request_rate_limit')) {
    return 'Слишком много попыток. Подождите минуту и повторите.'
  }
  if (low.includes('429')) {
    return 'Сервер временно ограничил запросы. Попробуйте чуть позже.'
  }
  if (low.includes('500') || low.includes('internal') || low.includes('database error')) {
    return 'Сервис временно недоступен. Попробуйте позже.'
  }
  if (low.includes('network') || low.includes('failed to fetch')) {
    return 'Проблема с сетью. Проверьте интернет и повторите.'
  }
  if (
    low.includes('password should') ||
    low.includes('password does not meet') ||
    low.includes('password is too weak') ||
    low.includes('weak password')
  ) {
    return 'Пароль: от 8 до 50 символов.'
  }
  if (low.includes('user already registered') || low.includes('already been registered')) {
    return 'Пользователь с такой почтой уже зарегистрирован. Попробуйте войти.'
  }
  return `Не удалось выполнить действие: ${msg}`
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
  isToday,
  onToggle,
}: {
  habit: Habit
  raw: boolean | undefined
  isToday: boolean
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
  if (isToday) cls += ' ring-2 ring-teal-300 ring-offset-1'
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

function pendingStorageKey(userId: string): string {
  return `${PENDING_KEY_PREFIX}${userId}`
}

function loadPendingOutgoing(userId: string): PendingOutgoing[] {
  try {
    const raw = localStorage.getItem(pendingStorageKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as PendingOutgoing[]
  } catch {
    return []
  }
}

function savePendingOutgoing(userId: string, queue: PendingOutgoing[]) {
  if (queue.length === 0) {
    localStorage.removeItem(pendingStorageKey(userId))
    return
  }
  localStorage.setItem(pendingStorageKey(userId), JSON.stringify(queue))
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

function parseHabitCreatedAt(habit: Habit): { y: number; m0: number; d: number } | null {
  if (!habit.createdAt) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(habit.createdAt)) return null
  try {
    return parseKey(habit.createdAt)
  } catch {
    return null
  }
}

function habitGoalPeriod(habit: Habit): 'month' | 'week' {
  return habit.goalPeriod ?? 'month'
}

function maxGoalForHabitPeriod(period: 'month' | 'week'): number {
  return period === 'week' ? 7 : 31
}

function habitCreatedAtDate(habit: Habit): Date | null {
  const created = parseHabitCreatedAt(habit)
  if (!created) return null
  return new Date(created.y, created.m0, created.d)
}

const LEGACY_HABIT_START_DATE = new Date(2026, 3, 1)

function habitStartDate(habit: Habit): Date {
  return habitCreatedAtDate(habit) ?? LEGACY_HABIT_START_DATE
}

function periodDateRange(
  habit: Habit,
  y: number,
  m0: number,
  weekAnchorDay: number,
): { start: Date; end: Date; periodDays: number } | null {
  if (habitGoalPeriod(habit) === 'month') {
    const dim = daysInMonth(y, m0)
    return {
      start: new Date(y, m0, 1),
      end: new Date(y, m0, dim),
      periodDays: dim,
    }
  }
  const anchor = new Date(y, m0, Math.max(1, weekAnchorDay))
  const weekDayMon0 = (anchor.getDay() + 6) % 7
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - weekDayMon0)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { start, end, periodDays: 7 }
}

function effectiveGoalForPeriod(
  habit: Habit,
  y: number,
  m0: number,
  weekAnchorDay: number,
): { goal: number; start: Date; end: Date } {
  const range = periodDateRange(habit, y, m0, weekAnchorDay)
  if (!range) {
    const fallback = new Date(y, m0, 1)
    return { goal: 0, start: fallback, end: fallback }
  }
  const created = habitStartDate(habit)
  const activeStart =
    created.getTime() > range.start.getTime() ? created : range.start
  if (activeStart.getTime() > range.end.getTime()) {
    return { goal: 0, start: range.start, end: range.end }
  }
  const activeDays =
    Math.floor((range.end.getTime() - activeStart.getTime()) / 86400000) + 1
  const scaled = Math.round((habit.monthlyGoal * activeDays) / range.periodDays)
  const goal = !habit.negative && scaled === 0 && habit.monthlyGoal > 0 ? 1 : Math.max(0, scaled)
  return { goal, start: activeStart, end: range.end }
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
  const [formGoalPeriod, setFormGoalPeriod] = useState<'month' | 'week'>('month')
  const [priorityModalOpen, setPriorityModalOpen] = useState(false)
  const [priorityHintOpen, setPriorityHintOpen] = useState(false)
  const [moreMenuHabitId, setMoreMenuHabitId] = useState<string | null>(null)
  const [clockMenuHabitId, setClockMenuHabitId] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authPassword2, setAuthPassword2] = useState('')
  const [authShowPassword, setAuthShowPassword] = useState(false)
  const [authShowPassword2, setAuthShowPassword2] = useState(false)
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
  const authMenuRootRef = useRef<HTMLDivElement | null>(null)
  const [calendarTarget, setCalendarTarget] = useState<CalendarTarget | null>(null)
  const [calendarY, setCalendarY] = useState(now.getFullYear())
  const [calendarM0, setCalendarM0] = useState(now.getMonth())

  useEffect(() => {
    if (!authModalOpen) {
      setAuthShowPassword(false)
      setAuthShowPassword2(false)
    }
  }, [authModalOpen])

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
    if (!authMenuOpen || !session?.user || isMobile) return
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target
      if (!(t instanceof Node)) return
      if (authMenuRootRef.current?.contains(t)) return
      setAuthMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [authMenuOpen, session?.user, isMobile])

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
    savePendingOutgoing(uid, pendingRef.current)
    try {
      setSyncErr(null)
      const maxSeq = await pushEventBatch(uid, batch)
      if (maxSeq > lastSeqRef.current) lastSeqRef.current = maxSeq
      savePendingOutgoing(uid, pendingRef.current)
    } catch (e) {
      pendingRef.current = [...batch, ...pendingRef.current]
      savePendingOutgoing(uid, pendingRef.current)
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
        savePendingOutgoing(session.user.id, pendingRef.current)
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
    pendingRef.current = loadPendingOutgoing(session.user.id)
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
      if (document.visibilityState === 'hidden') void flushPendingInternal()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [pullIncremental, flushPendingInternal])

  useEffect(() => {
    if (!session?.user || supabaseSyncPhase !== 'ready') return
    const t = window.setInterval(() => {
      void pullIncremental()
    }, 15000)
    return () => window.clearInterval(t)
  }, [session?.user?.id, supabaseSyncPhase, pullIncremental])

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
  const todayY = today.getFullYear()
  const todayM0 = today.getMonth()
  const todayD = today.getDate()
  const weekdayRu = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
  const todayKey = dateKey(todayY, todayM0, today.getDate())
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
  const trackerWeekAnchorDay = useMemo(() => {
    if (isMobile && mobileMarksView === 'week') {
      return Math.max(1, Math.min(dim, selectedD ?? todayD))
    }
    if (y === todayY && m0 === todayM0) return todayD
    return 1
  }, [isMobile, mobileMarksView, dim, selectedD, todayD, y, m0, todayY, todayM0])

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
    const parsedGoal = Math.floor(Number(formGoalInput))
    const fallbackGoal = formNeg ? 0 : 20
    const h: Habit = {
      id: crypto.randomUUID(),
      name,
      emoji: formEmoji || '🎯',
      negative: formNeg,
      monthlyGoal: Math.max(
        formNeg ? 0 : 1,
        Math.min(
          maxGoalForHabitPeriod(formGoalPeriod),
          Number.isFinite(parsedGoal) ? parsedGoal : fallbackGoal,
        ),
      ),
      goalPeriod: formGoalPeriod,
      createdAt: todayKey,
      archived: false,
      deadline: null,
      postponedUntil: null,
    }
    dispatch('habit_upsert', h)
    setModal(false)
    setFormName('')
    setFormEmoji('🎯')
    setFormGoalInput('20')
    setFormNeg(false)
    setFormGoalPeriod('month')
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
    return [...visible].sort((a, b) => {
      const ap = a.isPriority ? 0 : 1
      const bp = b.isPriority ? 0 : 1
      if (ap !== bp) return ap - bp
      const an = a.negative ? 1 : 0
      const bn = b.negative ? 1 : 0
      if (an !== bn) return an - bn
      return a.name.localeCompare(b.name, 'ru')
    })
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
      const ap = a.isPriority ? 0 : 1
      const bp = b.isPriority ? 0 : 1
      if (ap !== bp) return ap - bp
      const an = a.negative ? 1 : 0
      const bn = b.negative ? 1 : 0
      if (an !== bn) return an - bn
      return a.name.localeCompare(b.name, 'ru')
    }
    active.sort(sort)
    inactive.sort(sort)
    return { active, inactive }
  }, [habits, todayKey])

  const activePriorityCount = useMemo(
    () => habitsEditorSections.active.filter((h) => h.isPriority === true).length,
    [habitsEditorSections],
  )

  const rowStyle = (h: Habit) => {
    if (h.isPriority) {
      return h.negative ? 'bg-rose-100' : 'bg-emerald-100'
    }
    if (h.negative) {
      const i = habits.filter((x) => x.negative).findIndex((x) => x.id === h.id)
      return i % 2 === 0 ? 'bg-rose-50' : 'bg-red-50'
    }
    const i = habits.filter((x) => !x.negative).findIndex((x) => x.id === h.id)
    return i % 2 === 0 ? 'bg-white' : 'bg-teal-50'
  }

  const editorCardStyle = (h: Habit) => {
    if (h.isPriority) {
      return h.negative
        ? 'border-rose-400 bg-rose-100'
        : 'border-emerald-400 bg-emerald-100'
    }
    if (h.negative) return 'border-rose-300 bg-rose-50'
    return 'border-emerald-300 bg-emerald-50'
  }

  const editorFieldStyle = (h: Habit) => {
    if (h.isPriority) {
      return h.negative
        ? 'border-rose-400 bg-white focus:ring-rose-300'
        : 'border-emerald-400 bg-white focus:ring-emerald-300'
    }
    if (h.negative) return 'border-rose-300 bg-white focus:ring-rose-300'
    return 'border-emerald-300 bg-white focus:ring-emerald-300'
  }

  const countDoneInDateRange = (
    map: Record<string, boolean> | undefined,
    start: Date,
    end: Date,
  ) => {
    const m = map ?? {}
    let n = 0
    const cur = new Date(start)
    while (cur.getTime() <= end.getTime()) {
      const k = dateKey(cur.getFullYear(), cur.getMonth(), cur.getDate())
      if (m[k] === true) n++
      cur.setDate(cur.getDate() + 1)
    }
    return n
  }

  const goalAndDoneForHabit = (
    h: Habit,
    map: Record<string, boolean> | undefined,
    y0: number,
    m00: number,
    weekAnchorDay: number,
  ) => {
    const { goal, start, end } = effectiveGoalForPeriod(h, y0, m00, weekAnchorDay)
    const done = countDoneInDateRange(map, start, end)
    return { goal, done, period: habitGoalPeriod(h) }
  }

  const analyticsCurrentStreak = (
    h: Habit,
    map: Record<string, boolean> | undefined,
    ref: Date,
  ) => {
    const m = map ?? {}
    const start = habitStartDate(h)
    const end = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate())
    if (start.getTime() > end.getTime()) return 0
    let streak = 0
    const cur = new Date(end)
    while (cur.getTime() >= start.getTime()) {
      const k = dateKey(cur.getFullYear(), cur.getMonth(), cur.getDate())
      if (!isSuccess(h, m[k])) break
      streak++
      cur.setDate(cur.getDate() - 1)
    }
    return streak
  }

  const analyticsLongestStreak = (
    h: Habit,
    map: Record<string, boolean> | undefined,
    ref: Date,
  ) => {
    const m = map ?? {}
    const start = habitStartDate(h)
    const end = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate())
    if (start.getTime() > end.getTime()) return 0
    let best = 0
    let curStreak = 0
    const d = new Date(start)
    while (d.getTime() <= end.getTime()) {
      const k = dateKey(d.getFullYear(), d.getMonth(), d.getDate())
      if (isSuccess(h, m[k])) {
        curStreak++
        if (curStreak > best) best = curStreak
      } else {
        curStreak = 0
      }
      d.setDate(d.getDate() + 1)
    }
    return best
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
    const emailLenErr = emailLengthError(email)
    if (emailLenErr) {
      setAuthErr(emailLenErr)
      return
    }
    if (authMode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password: authPassword,
      })
      if (error) setAuthErr(friendlyAuthError(error))
      else setAuthModalOpen(false)
      return
    }
    if (authPassword.length < 8 || authPassword.length > 50) {
      setAuthErr('Пароль: от 8 до 50 символов')
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
    if (error) setAuthErr(friendlyAuthError(error))
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
      <div className="relative" ref={authMenuRootRef}>
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

      {!session?.user ? (
      <main
        className={`mx-auto max-w-3xl px-3 py-10 ${isMobile ? 'pb-28' : ''}`}
      >
        <div className="rounded-2xl border border-teal-200 bg-white p-6 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-teal-900">Нужна авторизация</h2>
          <p className="mt-2 text-sm text-teal-800/80">
            Трекер и редактирование привычек доступны только после входа.
          </p>
          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            className="mt-4 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
          >
            Войти
          </button>
        </div>
      </main>
      ) : screen === 'habits' ? (
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
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setPriorityModalOpen(true)
              setPriorityHintOpen(false)
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-sm font-semibold text-teal-900 hover:bg-teal-100"
          >
            <Star className="h-4 w-4 fill-teal-500 text-teal-500" />
            Приоритеты
          </button>
        </div>
        <div className="space-y-4">
          {habitsEditorSections.active.map((h) => (
            <div
              key={h.id}
              className={`rounded-2xl border px-4 py-3 shadow-sm ${editorCardStyle(h)}`}
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
                  className={`min-w-[8rem] flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 ${editorFieldStyle(h)}`}
                />
                {h.isPriority && (
                  <Star
                    className={`h-4 w-4 shrink-0 ${
                      h.negative
                        ? 'fill-rose-500 text-rose-500'
                        : 'fill-emerald-500 text-emerald-500'
                    }`}
                    aria-hidden
                  />
                )}
                <input
                  type="number"
                  min={h.negative ? 0 : 1}
                  max={maxGoalForHabitPeriod(habitGoalPeriod(h))}
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
                    const next = Math.max(
                      minGoal,
                      Math.min(maxGoalForHabitPeriod(habitGoalPeriod(h)), Math.floor(n)),
                    )
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
                    const maxGoal = maxGoalForHabitPeriod(habitGoalPeriod(habit))
                    let normalized = habit.monthlyGoal
                    if (raw === '') normalized = minGoal
                    else if (raw !== undefined) {
                      const parsed = Number(raw)
                      if (Number.isFinite(parsed)) {
                        normalized = Math.max(minGoal, Math.min(maxGoal, Math.floor(parsed)))
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
                  className={`w-20 rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 ${editorFieldStyle(h)}`}
                />
                <select
                  value={habitGoalPeriod(h)}
                  onChange={(e) => {
                    const period = e.target.value as 'month' | 'week'
                    const maxGoal = maxGoalForHabitPeriod(period)
                    const minGoal = h.negative ? 0 : 1
                    const nextGoal = Math.max(
                      minGoal,
                      Math.min(maxGoal, h.monthlyGoal),
                    )
                    const updated = { ...h, goalPeriod: period, monthlyGoal: nextGoal }
                    setHabits((prev) => prev.map((x) => (x.id === h.id ? updated : x)))
                    dispatch('habit_upsert', updated)
                  }}
                  className={`w-24 rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 ${editorFieldStyle(h)}`}
                >
                  <option value="month">В месяц</option>
                  <option value="week">В неделю</option>
                </select>
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
            <div className="flex h-[9.25rem] items-stretch gap-1.5 sm:h-[10.25rem] sm:gap-2">
              <div
                aria-hidden
                className="flex h-full w-7 shrink-0 flex-col justify-between border-r border-teal-200 py-0.5 pr-0.5 text-right text-[9px] tabular-nums leading-none text-teal-600 sm:w-8 sm:pr-1 sm:text-[10px]"
              >
                {[100, 75, 50, 25, 0].map((tick) => (
                  <span key={tick}>{tick}</span>
                ))}
              </div>
              <div
                className={`min-h-0 min-w-0 flex-1 touch-pan-x overflow-y-hidden [scrollbar-gutter:stable] ${
                  dynMode === 'day' ? 'overflow-x-auto' : 'overflow-x-hidden'
                }`}
              >
                <div
                  className={`relative h-full min-h-0 ${
                    dynMode === 'day' ? 'min-w-max' : 'w-full'
                  }`}
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
                    const { goal, done, period } = goalAndDoneForHabit(
                      h,
                      completions[h.id],
                      y,
                      m0,
                      trackerWeekAnchorDay,
                    )
                    const periodLabel = period === 'week' ? 'в неделю' : 'в месяц'
                    const goalLabel = h.negative
                      ? `${done}/${goal} срыв. ${periodLabel}`
                      : `${done}/${goal} дн. ${periodLabel}`
                    return (
                      <div
                        key={h.id}
                        className={`relative rounded-2xl border px-4 py-3 shadow-sm ${
                          h.isPriority
                            ? h.negative
                              ? 'border-rose-300 bg-rose-50/70'
                              : 'border-emerald-300 bg-emerald-50/70'
                            : 'border-neutral-200/70 bg-white'
                        }`}
                      >
                        {h.isPriority && (
                          <Star
                            className={`absolute left-1 top-1 h-3 w-3 ${
                              h.negative
                                ? 'fill-rose-500 text-rose-500'
                                : 'fill-emerald-500 text-emerald-500'
                            }`}
                            aria-hidden
                          />
                        )}
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
                                  <span
                                    className={`text-[10px] font-medium ${
                                      col.isToday ? 'text-teal-700' : 'text-neutral-400'
                                    }`}
                                  >
                                    {col.weekday}
                                  </span>
                                  <WeekDot
                                    habit={h}
                                    raw={raw}
                                    isToday={col.isToday}
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
                        <div className="relative flex min-w-0 flex-col gap-0.5">
                          <div className="flex min-w-0 items-center gap-1">
                            <span className="shrink-0 select-none">{h.emoji}</span>
                            <span
                              className={`min-w-0 truncate text-xs font-medium sm:text-sm ${
                                h.negative ? 'text-rose-950' : 'text-teal-950'
                              }`}
                            >
                              {h.name}
                            </span>
                            {h.isPriority && (
                              <Star
                                className={`ml-auto h-3 w-3 shrink-0 ${
                                  h.negative
                                    ? 'fill-rose-500 text-rose-500'
                                    : 'fill-emerald-500 text-emerald-500'
                                }`}
                                aria-hidden
                              />
                            )}
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
                        const { goal, done } = goalAndDoneForHabit(
                          h,
                          map,
                          y,
                          m0,
                          trackerWeekAnchorDay,
                        )
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
                        const cur = analyticsCurrentStreak(h, map, today)
                        const lon = analyticsLongestStreak(h, map, today)
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
                          const { goal, done } = goalAndDoneForHabit(
                            h,
                            map,
                            y,
                            m0,
                            trackerWeekAnchorDay,
                          )
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
                          const cur = analyticsCurrentStreak(h, map, today)
                          const lon = analyticsLongestStreak(h, map, today)
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

      {session?.user && screen === 'tracker' && !isMobile && (
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
              onMouseDown={() => setAuthMenuOpen(false)}
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
                  className="absolute inset-0 h-full w-full rounded-t-[2.2rem] rounded-b-[1.2rem] text-teal-800 drop-shadow-[0_-6px_24px_rgba(15,118,110,0.2)]"
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
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAuthModalOpen(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-t-2xl rounded-b-xl border border-teal-200 bg-white p-4 shadow-2xl sm:p-5"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <h3 className="text-lg font-semibold text-teal-900">
                {authMode === 'login' ? 'Вход' : 'Регистрация'}
              </h3>
              <button
                type="button"
                onClick={() => setAuthModalOpen(false)}
                className="-m-1 rounded-lg p-1.5 text-teal-600 hover:bg-teal-50"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" strokeWidth={2} />
              </button>
            </div>
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
                    maxLength={EMAIL_MAX_TOTAL}
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    className="w-full rounded-lg border border-teal-200 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-teal-400"
                  />
                  <div className="relative">
                    <input
                      type={authShowPassword ? 'text' : 'password'}
                      autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                      placeholder={
                        authMode === 'register'
                          ? 'Минимум 8 символов'
                          : 'Пароль'
                      }
                      minLength={authMode === 'register' ? 8 : undefined}
                      maxLength={authMode === 'register' ? 50 : undefined}
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      className="w-full rounded-lg border border-teal-200 py-2.5 pl-3 pr-11 text-base outline-none focus:ring-2 focus:ring-teal-400"
                    />
                    <button
                      type="button"
                      onClick={() => setAuthShowPassword((v) => !v)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-teal-600 hover:bg-teal-50"
                      aria-label={authShowPassword ? 'Скрыть пароль' : 'Показать пароль'}
                    >
                      {authShowPassword ? (
                        <EyeOff className="h-5 w-5" strokeWidth={1.75} />
                      ) : (
                        <Eye className="h-5 w-5" strokeWidth={1.75} />
                      )}
                    </button>
                  </div>
                  {authMode === 'register' && (
                    <div className="relative">
                      <input
                        type={authShowPassword2 ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Пароль ещё раз"
                        minLength={8}
                        maxLength={50}
                        value={authPassword2}
                        onChange={(e) => setAuthPassword2(e.target.value)}
                        className="w-full rounded-lg border border-teal-200 py-2.5 pl-3 pr-11 text-base outline-none focus:ring-2 focus:ring-teal-400"
                      />
                      <button
                        type="button"
                        onClick={() => setAuthShowPassword2((v) => !v)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-teal-600 hover:bg-teal-50"
                        aria-label={authShowPassword2 ? 'Скрыть пароль' : 'Показать пароль'}
                      >
                        {authShowPassword2 ? (
                          <EyeOff className="h-5 w-5" strokeWidth={1.75} />
                        ) : (
                          <Eye className="h-5 w-5" strokeWidth={1.75} />
                        )}
                      </button>
                    </div>
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
            {authErr && (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <p className="font-semibold">Не получилось выполнить запрос</p>
                <p className="mt-1 leading-snug">{authErr}</p>
              </div>
            )}
            {authInfo && <p className="mt-2 text-sm text-emerald-800">{authInfo}</p>}
          </div>
        </div>
      )}

      {priorityModalOpen && (
        <div
          className="fixed inset-0 z-[121] flex items-end justify-center overflow-y-auto bg-black/40 p-0 sm:items-center sm:p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setPriorityModalOpen(false)
              setPriorityHintOpen(false)
            }
          }}
        >
          <div className="my-2 w-full max-w-lg rounded-t-2xl rounded-b-xl border border-amber-200 bg-white p-4 shadow-2xl sm:my-auto sm:rounded-2xl sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-amber-950">
                  Приоритетные привычки
                </h3>
                <p className="mt-0.5 text-sm text-amber-800">
                  Выбрано {activePriorityCount}/2
                </p>
              </div>
              <div className="flex items-center gap-1">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setPriorityHintOpen((v) => !v)}
                    className="rounded-lg p-1.5 text-amber-700 hover:bg-amber-100"
                    aria-label="Подсказка о фокусе"
                  >
                    <HelpCircle className="h-5 w-5" />
                  </button>
                  {priorityHintOpen && (
                    <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 shadow-lg">
                      Рекомендуется держать особый фокус не более чем на 1–2 привычках.
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPriorityModalOpen(false)
                    setPriorityHintOpen(false)
                  }}
                  className="rounded-lg p-1.5 text-amber-700 hover:bg-amber-100"
                  aria-label="Закрыть"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
              {habitsEditorSections.active.map((h) => {
                const selected = h.isPriority === true
                const disabled = !selected && activePriorityCount >= 2
                return (
                  <label
                    key={`priority-pick-${h.id}`}
                    className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2 ${
                      selected
                        ? 'border-amber-300 bg-amber-50'
                        : 'border-teal-100 bg-white'
                    } ${disabled ? 'opacity-50' : ''}`}
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-teal-900">
                      {h.emoji} {h.name}
                    </span>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={disabled}
                      onChange={(e) => {
                        const next = { ...h, isPriority: e.target.checked }
                        setHabits((prev) =>
                          prev.map((x) => (x.id === h.id ? next : x)),
                        )
                        dispatch('habit_upsert', next)
                      }}
                      className="h-4 w-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                    />
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div
          className="fixed inset-0 z-[120] flex max-h-[100dvh] items-end justify-center overflow-y-auto overscroll-contain bg-black/40 p-0 sm:items-center sm:p-4 sm:py-8"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(false)
          }}
        >
          <div
            role="dialog"
            className="my-2 w-full max-w-lg max-h-[min(92dvh,calc(100dvh-env(safe-area-inset-bottom)-1rem))] overflow-y-auto rounded-t-2xl rounded-b-xl border border-teal-200 bg-white p-4 shadow-2xl sm:my-auto sm:max-h-[min(90vh,calc(100dvh-4rem))] sm:rounded-t-2xl sm:rounded-b-xl sm:p-6"
          >
            <div className="mb-4 flex items-start justify-between gap-2">
              <h3 className="text-lg font-semibold text-teal-900">
                Новая привычка
              </h3>
              <button
                type="button"
                onClick={() => setModal(false)}
                className="-m-1 shrink-0 rounded-lg p-1.5 text-teal-600 hover:bg-teal-50"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" strokeWidth={2} />
              </button>
            </div>
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
                ? `Допустимое количество срывов ${formGoalPeriod === 'week' ? 'в неделю' : 'в месяц'}`
                : `Цель ${formGoalPeriod === 'week' ? 'на неделю' : 'на месяц'} (дней)`}
              <input
                type="number"
                min={formNeg ? 0 : 1}
                max={maxGoalForHabitPeriod(formGoalPeriod)}
                value={formGoalInput}
                onChange={(e) => setFormGoalInput(e.target.value)}
                className="mt-1 w-full rounded-lg border border-teal-200 px-3 py-2 outline-none focus:ring-2 focus:ring-teal-400"
              />
            </label>
            <label className="mb-4 block text-sm font-medium text-teal-800">
              Период цели
              <select
                value={formGoalPeriod}
                onChange={(e) => {
                  const period = e.target.value as 'month' | 'week'
                  setFormGoalPeriod(period)
                  const maxGoal = maxGoalForHabitPeriod(period)
                  const minGoal = formNeg ? 0 : 1
                  const parsed = Math.floor(Number(formGoalInput))
                  if (Number.isFinite(parsed)) {
                    const next = Math.max(minGoal, Math.min(maxGoal, parsed))
                    setFormGoalInput(String(next))
                  }
                }}
                className="mt-1 w-full rounded-lg border border-teal-200 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-teal-400"
              >
                <option value="month">В месяц</option>
                <option value="week">В неделю</option>
              </select>
            </label>
            <label className="mb-6 flex cursor-pointer items-center gap-2 text-sm text-teal-900">
              <input
                type="checkbox"
                checked={formNeg}
                onChange={(e) => {
                  const nextNeg = e.target.checked
                  setFormNeg(nextNeg)
                  const maxGoal = maxGoalForHabitPeriod(formGoalPeriod)
                  const minGoal = nextNeg ? 0 : 1
                  const parsed = Math.floor(Number(formGoalInput))
                  if (Number.isFinite(parsed)) {
                    const next = Math.max(minGoal, Math.min(maxGoal, parsed))
                    setFormGoalInput(String(next))
                  }
                }}
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
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCalendarTarget(null)
          }}
        >
          <div className="relative w-full max-w-sm rounded-t-2xl rounded-b-xl border border-teal-200 bg-white p-4 shadow-2xl sm:rounded-2xl">
            <button
              type="button"
              onClick={() => setCalendarTarget(null)}
              className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-teal-600 hover:bg-teal-50"
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
            <div className="mb-3 flex items-center justify-between pr-10">
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
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDeleteConfirmId(null)
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-habit-title"
            className="relative w-full max-w-sm rounded-t-2xl rounded-b-xl border border-teal-200 bg-white p-5 shadow-2xl sm:rounded-2xl"
          >
            <button
              type="button"
              onClick={() => setDeleteConfirmId(null)}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-teal-600 hover:bg-teal-50"
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
            <div
              id="delete-habit-title"
              className="space-y-2 px-8 text-center text-base leading-snug text-teal-900"
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
