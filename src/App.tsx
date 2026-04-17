import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Flame,
  Plus,
  Settings,
  Target,
  Trash2,
  Trophy,
} from 'lucide-react'
import type { Completions, DataSource, Habit, Persisted } from './types'
import {
  dateKey,
  daysInMonth,
  monthLabel,
  weekdayMon0,
  weekdayShortRu,
} from './dates'
import {
  currentStreakEndingAt,
  longestStreakInMonth,
  monthCompletionRate,
  monthWeekChunks,
  progressPercent,
  totalSuccessInMonth,
  weekCompletionRate,
  yearCompletionRate,
} from './stats'
import { buildSeed } from './seed'
import { EMOJI_OPTIONS } from './emojis'
import {
  downloadJsonFile,
  idbClearDirHandle,
  idbGetDirHandle,
  idbSetDirHandle,
  mergeCompletionsForImportedHabits,
  parseBundleJson,
  pickDirectory,
  readBundleFromDirectory,
  writeBundleToDirectory,
} from './fileSync'
import { loadSettings, saveSettings } from './settingsStorage'
import { supabase, supabaseConfigured } from './lib/supabase'
import { pullFromSupabase, pushToSupabase } from './supabase/sync'

const STORAGE_KEY = 'habit-calendar-v1'

const CHART_BAR_MAX_PX = 112

type Screen = 'tracker' | 'settings'
type DynMode = 'day' | 'week' | 'month' | 'year'

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

function MiniCalendar({
  y,
  m0,
  selectedD,
  onPick,
}: {
  y: number
  m0: number
  selectedD: number | null
  onPick: (d: number) => void
}) {
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
              <button
                key={ci}
                type="button"
                disabled={d === null}
                onClick={() => d != null && onPick(d)}
                className={`flex h-7 items-center justify-center rounded text-xs font-medium transition ${
                  d === null
                    ? 'cursor-default bg-transparent'
                    : selectedD === d
                      ? 'bg-teal-600 text-white shadow'
                      : 'bg-teal-50 text-teal-900 hover:bg-teal-100'
                }`}
              >
                {d ?? ''}
              </button>
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
    'flex h-7 w-7 shrink-0 items-center justify-center rounded border text-xs transition focus:outline-none focus:ring-2 focus:ring-teal-400 sm:h-8 sm:w-8 sm:text-sm'
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
  const [dataSource, setDataSource] = useState<DataSource>(
    () => loadSettings().dataSource,
  )
  const [folderConnected, setFolderConnected] = useState(false)
  const [dynMode, setDynMode] = useState<DynMode>('week')
  const now = new Date()
  const [y, setY] = useState(now.getFullYear())
  const [m0, setM0] = useState(now.getMonth())
  const [selectedD, setSelectedD] = useState<number | null>(now.getDate())
  const [modal, setModal] = useState(false)
  const [formName, setFormName] = useState('')
  const [formEmoji, setFormEmoji] = useState('🎯')
  const [formGoal, setFormGoal] = useState(20)
  const [formNeg, setFormNeg] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authPassword2, setAuthPassword2] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authErr, setAuthErr] = useState<string | null>(null)
  const [authInfo, setAuthInfo] = useState<string | null>(null)
  const [syncErr, setSyncErr] = useState<string | null>(null)
  const [exportIncludeProgress, setExportIncludeProgress] = useState(true)
  const habitsRef = useRef(habits)
  const completionsRef = useRef(completions)
  habitsRef.current = habits
  completionsRef.current = completions

  useEffect(() => {
    void idbGetDirHandle().then((h) => setFolderConnected(!!h))
  }, [])

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
    savePersisted({ habits, completions })
  }, [habits, completions])

  useEffect(() => {
    if (!session?.user || dataSource !== 'supabase' || !supabaseConfigured) return
    let cancelled = false
    setSyncErr(null)
    void (async () => {
      try {
        const r = await pullFromSupabase(session.user.id)
        if (cancelled) return
        if (r && r.habits.length > 0) {
          setHabits(r.habits)
          setCompletions(r.completions)
        } else {
          await pushToSupabase(
            session.user.id,
            habitsRef.current,
            completionsRef.current,
          )
        }
      } catch (e) {
        if (!cancelled) setSyncErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session?.user?.id, dataSource])

  useEffect(() => {
    if (!session?.user || dataSource !== 'supabase' || !supabaseConfigured) return
    const uid = session.user.id
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          setSyncErr(null)
          await pushToSupabase(uid, habitsRef.current, completionsRef.current)
        } catch (e) {
          setSyncErr(e instanceof Error ? e.message : String(e))
        }
      })()
    }, 650)
    return () => window.clearTimeout(t)
  }, [habits, completions, session?.user?.id, dataSource])

  useEffect(() => {
    if (dataSource !== 'folder' || !folderConnected) return
    const t = window.setTimeout(() => {
      void (async () => {
        const dir = await idbGetDirHandle()
        if (dir) {
          try {
            await writeBundleToDirectory(dir, { habits, completions })
          } catch {
            void 0
          }
        }
      })()
    }, 450)
    return () => window.clearTimeout(t)
  }, [habits, completions, dataSource, folderConnected])

  const dim = daysInMonth(y, m0)
  const today = new Date()

  const setMonthDelta = (delta: number) => {
    const d = new Date(y, m0 + delta, 1)
    setY(d.getFullYear())
    setM0(d.getMonth())
    setSelectedD(1)
  }

  const toggleDay = useCallback((habitId: string, key: string) => {
    setCompletions((prev) => {
      const h = { ...(prev[habitId] ?? {}) }
      const cur = h[key]
      if (cur) delete h[key]
      else h[key] = true
      return { ...prev, [habitId]: h }
    })
  }, [])

  const addHabit = () => {
    const name = formName.trim()
    if (!name) return
    const h: Habit = {
      id: crypto.randomUUID(),
      name,
      emoji: formEmoji || '🎯',
      negative: formNeg,
      monthlyGoal: formNeg
        ? 0
        : Math.max(
            1,
            Math.min(31, Math.floor(Number(formGoal)) || 20),
          ),
    }
    setHabits((prev) => [...prev, h])
    setModal(false)
    setFormName('')
    setFormEmoji('🎯')
    setFormGoal(20)
    setFormNeg(false)
  }

  const removeHabit = (id: string) => {
    setHabits((prev) => prev.filter((x) => x.id !== id))
    setCompletions((prev) => {
      const n = { ...prev }
      delete n[id]
      return n
    })
  }

  const habitsPositive = useMemo(
    () => habits.filter((h) => !h.negative),
    [habits],
  )

  const chartSeries = useMemo(() => {
    const hp = habitsPositive
    if (dynMode === 'week') {
      const w = monthWeekChunks(y, m0)
      return {
        rates: w.map((chunk) =>
          weekCompletionRate(hp, completions, y, m0, chunk.startD, chunk.endD),
        ),
        labels: w.map((c) => `${c.startD}–${c.endD}`),
      }
    }
    if (dynMode === 'day') {
      const d0 = daysInMonth(y, m0)
      return {
        rates: Array.from({ length: d0 }, (_, i) =>
          weekCompletionRate(hp, completions, y, m0, i + 1, i + 1),
        ),
        labels: Array.from({ length: d0 }, (_, i) => `${i + 1}`),
      }
    }
    if (dynMode === 'month') {
      return {
        rates: Array.from({ length: 12 }, (_, m) =>
          monthCompletionRate(hp, completions, y, m),
        ),
        labels: Array.from({ length: 12 }, (_, m) =>
          new Date(y, m, 1).toLocaleDateString('ru-RU', { month: 'short' }),
        ),
      }
    }
    const years = [y - 4, y - 3, y - 2, y - 1, y]
    return {
      rates: years.map((yr) => yearCompletionRate(hp, completions, yr)),
      labels: years.map((yr) => String(yr)),
    }
  }, [dynMode, habitsPositive, completions, y, m0, dim])

  const chartRates = chartSeries.rates
  const chartLabels = chartSeries.labels

  const dynTitle =
    dynMode === 'week'
      ? 'за выбранный месяц по неделям'
      : dynMode === 'day'
        ? 'по дням выбранного месяца'
        : dynMode === 'month'
          ? `по месяцам ${y} года`
          : 'по годам (5 лет до выбранного года включительно)'

  const orderedHabits = useMemo(() => {
    const pos = habits.filter((h) => !h.negative)
    const neg = habits.filter((h) => h.negative)
    return [...pos, ...neg]
  }, [habits])

  const rowStyle = (h: Habit) => {
    if (h.negative) {
      const i = habits.filter((x) => x.negative).findIndex((x) => x.id === h.id)
      return i % 2 === 0 ? 'bg-rose-50' : 'bg-red-50'
    }
    const i = habits.filter((x) => !x.negative).findIndex((x) => x.id === h.id)
    return i % 2 === 0 ? 'bg-white' : 'bg-teal-50'
  }

  return (
    <div className="min-h-svh bg-gradient-to-b from-teal-50 to-white pb-[env(safe-area-inset-bottom,0px)] pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))] pt-[env(safe-area-inset-top,0px)]">
      <header className="border-b border-teal-200 bg-teal-700 px-3 py-3 text-white shadow-md sm:px-4 sm:py-4">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight sm:text-2xl">
              Календарь привычек
            </h1>
            <nav className="flex rounded-lg bg-teal-800/60 p-0.5 text-sm">
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
                onClick={() => setScreen('settings')}
                className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 font-medium transition ${
                  screen === 'settings'
                    ? 'bg-white text-teal-800 shadow'
                    : 'text-teal-100 hover:bg-teal-800/80'
                }`}
              >
                <Settings className="h-4 w-4" />
                Настройки
              </button>
            </nav>
          </div>
          {screen === 'tracker' && (
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-1 sm:flex-initial sm:justify-end sm:gap-2">
            <button
              type="button"
              onClick={() => setMonthDelta(-1)}
              className="shrink-0 rounded-lg bg-teal-800/80 p-1.5 hover:bg-teal-800 sm:p-2"
              aria-label="Предыдущий месяц"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="min-w-0 flex-1 text-center text-sm font-medium capitalize sm:min-w-[10rem] sm:flex-none sm:text-base">
              {monthLabel(y, m0)}
            </span>
            <button
              type="button"
              onClick={() => setMonthDelta(1)}
              className="shrink-0 rounded-lg bg-teal-800/80 p-1.5 hover:bg-teal-800 sm:p-2"
              aria-label="Следующий месяц"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            </div>
            <div className="flex w-full shrink-0 items-center justify-center gap-2 sm:w-auto">
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
              className="max-w-full rounded-lg border border-teal-600 bg-teal-800/50 px-2 py-1.5 text-xs text-white outline-none focus:ring-2 focus:ring-teal-300 sm:text-sm"
            />
            <button
              type="button"
              onClick={() => setModal(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white px-2.5 py-2 text-xs font-medium text-teal-800 shadow hover:bg-teal-50 sm:px-3 sm:text-sm"
            >
              <Plus className="h-4 w-4" />
              Привычка
            </button>
            </div>
          </div>
          )}
        </div>
      </header>

      {screen === 'settings' ? (
      <main className="mx-auto max-w-lg px-3 py-6 sm:max-w-2xl sm:py-8">
        <h2 className="mb-4 text-lg font-semibold text-teal-900">
          Данные
        </h2>
        <div className="space-y-3 rounded-xl border border-teal-200 bg-white p-4 shadow-sm sm:p-5">
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-teal-100 p-3 has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50/50">
            <input
              type="radio"
              name="src"
              checked={dataSource === 'local'}
              onChange={() => {
                setDataSource('local')
                saveSettings({ dataSource: 'local' })
              }}
            />
            <span className="font-medium text-teal-900">Только на устройстве</span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-teal-100 p-3 has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50/50">
            <input
              type="radio"
              name="src"
              className="mt-0.5"
              checked={dataSource === 'folder'}
              onChange={() => {
                setDataSource('folder')
                saveSettings({ dataSource: 'folder' })
              }}
            />
            <span className="w-full min-w-0">
              <span className="font-medium text-teal-900">Файл на диске</span>
              <p className="mt-1 text-xs text-teal-700">
                {folderConnected ? 'Папка выбрана' : 'Папка не выбрана'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const dir = await pickDirectory()
                    if (!dir) return
                    await idbSetDirHandle(dir)
                    setFolderConnected(true)
                    setDataSource('folder')
                    saveSettings({ dataSource: 'folder' })
                    const fromFile = await readBundleFromDirectory(dir)
                    if (fromFile) {
                      setHabits(fromFile.habits)
                      setCompletions(fromFile.completions)
                    } else {
                      await writeBundleToDirectory(dir, {
                        habits,
                        completions,
                      })
                    }
                  }}
                  className="rounded-lg bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800"
                >
                  Выбрать папку
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await idbClearDirHandle()
                    setFolderConnected(false)
                    setDataSource('local')
                    saveSettings({ dataSource: 'local' })
                  }}
                  className="rounded-lg border border-teal-300 px-3 py-2 text-sm text-teal-800 hover:bg-teal-50"
                >
                  Отключить
                </button>
              </div>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-teal-100 p-3 has-[:checked]:border-teal-500 has-[:checked]:bg-teal-50/50">
            <input
              type="radio"
              name="src"
              className="mt-0.5"
              checked={dataSource === 'supabase'}
              disabled={!supabaseConfigured}
              onChange={() => {
                setDataSource('supabase')
                saveSettings({ dataSource: 'supabase' })
              }}
            />
            <span className="w-full min-w-0">
              <span className="font-medium text-teal-900">Облако</span>
              {!supabaseConfigured && (
                <p className="mt-1 text-xs text-amber-800">
                  Не настроено
                </p>
              )}
              {supabaseConfigured && session?.user && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-900">
                  <span className="min-w-0 truncate font-medium">{session.user.email}</span>
                  <button
                    type="button"
                    disabled={!supabase}
                    onClick={async () => {
                      setAuthErr(null)
                      setAuthInfo(null)
                      if (!supabase) return
                      await supabase.auth.signOut()
                    }}
                    className="shrink-0 rounded-md border border-teal-300 px-2.5 py-1 text-xs text-teal-800 hover:bg-white disabled:opacity-50"
                  >
                    Выйти
                  </button>
                </div>
              )}
              {supabaseConfigured && !session?.user && (
                <div className="mt-3 space-y-3">
                  <div className="flex rounded-lg bg-teal-100/80 p-0.5 text-sm">
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
                    onClick={async () => {
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
                        if (error) setAuthErr(error.message)
                        else {
                          setDataSource('supabase')
                          saveSettings({ dataSource: 'supabase' })
                        }
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
                      const { data, error } = await supabase.auth.signUp({
                        email,
                        password: authPassword,
                        options: {
                          emailRedirectTo: new URL(
                            import.meta.env.BASE_URL,
                            window.location.origin,
                          ).href,
                        },
                      })
                      if (error) setAuthErr(error.message)
                      else {
                        setDataSource('supabase')
                        saveSettings({ dataSource: 'supabase' })
                        if (data.user && !data.session) {
                          setAuthInfo('Откройте письмо и подтвердите адрес.')
                        } else {
                          setAuthPassword('')
                          setAuthPassword2('')
                        }
                      }
                    }}
                    className="w-full rounded-lg bg-teal-700 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                  >
                    {authMode === 'login' ? 'Войти' : 'Создать аккаунт'}
                  </button>
                </div>
              )}
              {syncErr && (
                <p className="mt-2 text-sm text-rose-700">{syncErr}</p>
              )}
              {authErr && (
                <p className="mt-2 text-sm text-rose-700">{authErr}</p>
              )}
              {authInfo && (
                <p className="mt-2 text-sm text-emerald-800">{authInfo}</p>
              )}
            </span>
          </label>
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
                      setHabits(p.data.habits)
                      setCompletions(p.data.completions)
                    } else {
                      setHabits(p.habits)
                      setCompletions((prev) =>
                        mergeCompletionsForImportedHabits(p.habits, prev),
                      )
                    }
                  }
                  r.readAsText(f)
                  e.target.value = ''
                }}
              />
            </label>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setScreen('tracker')}
          className="mt-8 text-sm font-medium text-teal-700 underline hover:text-teal-900"
        >
          ← Назад к трекеру
        </button>
      </main>
      ) : (
      <main className="mx-auto max-w-7xl px-2 py-4 sm:px-3 sm:py-6">
        <div className="mb-4 grid gap-4 lg:mb-6 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-teal-700">
              Месяц
            </p>
            <MiniCalendar
              y={y}
              m0={m0}
              selectedD={selectedD}
              onPick={setSelectedD}
            />
            <p className="mt-2 text-[11px] leading-snug text-teal-800 sm:mt-3 sm:text-xs">
              Негативная: отметка — срыв, пусто — успех.
            </p>
          </div>
          <section className="min-w-0 rounded-xl border border-teal-200 bg-white p-3 shadow-sm sm:p-4">
            <h2 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-teal-900">
              <BarChart3 className="h-4 w-4 shrink-0" />
              <span>Динамика: {dynTitle}</span>
            </h2>
            <p className="mb-2 text-xs text-teal-700">
              Средняя доля выполнения по обычным привычкам, %
            </p>
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
                    className="relative z-10 grid h-full gap-1.5 px-0.5 sm:gap-2"
                    style={{
                      gridTemplateColumns: `repeat(${Math.max(1, chartRates.length)}, minmax(0, 1fr))`,
                    }}
                  >
                    {chartRates.map((rate, i) => {
                      const clamped = Math.min(100, Math.max(0, rate))
                      const hPx = Math.round((clamped / 100) * CHART_BAR_MAX_PX)
                      return (
                        <div
                          key={i}
                          className="grid min-h-0 min-w-0 grid-rows-[1fr_auto] gap-0.5"
                        >
                          <div
                            className="flex min-h-0 w-full flex-col justify-end"
                            title={`${clamped}%`}
                          >
                            <div
                              className="w-full rounded-t-md bg-emerald-400 transition-all"
                              style={{
                                height: `${Math.max(0, hPx)}px`,
                                minHeight: hPx > 0 ? `${hPx}px` : '0',
                              }}
                            />
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

        {habits.length === 0 ? (
          <div className="rounded-xl border border-dashed border-teal-300 bg-teal-50/80 px-6 py-16 text-center text-teal-800">
            <p className="text-lg font-medium">Пока нет привычек</p>
            <p className="mt-2 text-sm opacity-90">
              Нажмите «Привычка», чтобы добавить первую.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-0 overflow-hidden rounded-xl border border-teal-200 bg-white shadow-md lg:flex-row">
            <div className="min-w-0 flex-1 overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-max min-w-full border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="bg-teal-700 text-white">
                    <th
                      rowSpan={2}
                      className="sticky left-0 z-20 max-w-[42vw] min-w-[7.5rem] border border-teal-600 bg-teal-700 px-1.5 py-2 align-middle text-left text-xs font-semibold sm:max-w-none sm:min-w-[10rem] sm:px-2 sm:text-sm"
                    >
                      Привычка
                    </th>
                    {Array.from({ length: dim }, (_, i) => i + 1).map((d) => (
                      <th
                        key={d}
                        className={`min-w-[2rem] border border-teal-600 px-0 py-1.5 text-center text-[10px] font-medium sm:min-w-[2.25rem] sm:text-xs ${
                          selectedD === d ? 'bg-teal-500' : ''
                        }`}
                      >
                        {d}
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-teal-700 text-white">
                    {Array.from({ length: dim }, (_, i) => i + 1).map((d) => (
                      <th
                        key={`w-${d}`}
                        className={`min-w-[2rem] border border-teal-600 px-0 pb-1.5 pt-0 text-center text-[9px] font-normal opacity-95 sm:min-w-[2.25rem] sm:text-[10px] ${
                          selectedD === d ? 'bg-teal-500' : ''
                        }`}
                      >
                        {weekdayShortRu(y, m0, d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderedHabits.map((h) => (
                    <tr key={h.id}>
                      <td
                        className={`sticky left-0 z-10 max-w-[42vw] min-w-[7.5rem] border border-slate-200 px-1.5 py-1 text-xs font-medium sm:max-w-none sm:min-w-[10rem] sm:px-2 sm:text-sm ${
                          h.negative ? 'text-rose-950' : 'text-teal-950'
                        } ${rowStyle(h)} border-r-teal-100/80 shadow-[4px_0_8px_-2px_rgba(15,118,110,0.12)]`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">
                            <span className="mr-1">{h.emoji}</span>
                            {h.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeHabit(h.id)}
                            className={`shrink-0 rounded p-1 ${
                              h.negative
                                ? 'text-rose-600 hover:bg-rose-100 hover:text-rose-900'
                                : 'text-teal-600 hover:bg-teal-100 hover:text-teal-900'
                            }`}
                            aria-label="Удалить"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                      {Array.from({ length: dim }, (_, i) => i + 1).map(
                        (d) => {
                          const key = dateKey(y, m0, d)
                          const raw = completions[h.id]?.[key]
                          const base = rowStyle(h)
                          const hi =
                            selectedD === d
                              ? h.negative
                                ? 'bg-rose-200'
                                : 'bg-teal-100'
                              : base
                          return (
                            <td
                              key={key}
                              className={`border border-slate-200 p-0.5 text-center ${hi}`}
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
            </div>

            <div className="w-full shrink-0 border-t border-teal-200 bg-teal-50/90 lg:w-[16.5rem] lg:border-l lg:border-t-0">
              <div className="border-b border-teal-200 bg-teal-200 text-[10px] font-semibold uppercase tracking-wide text-teal-900">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-teal-100 px-2 py-2">
                  <span className="inline-flex items-center gap-0.5">
                    <Target className="h-3.5 w-3.5" /> Цель
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <BarChart3 className="h-3.5 w-3.5" /> Прогресс
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    Σ Всего
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Flame className="h-3.5 w-3.5" /> Серия
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Trophy className="h-3.5 w-3.5" /> Рекорд
                  </span>
                </div>
              </div>
              <div className="divide-y divide-teal-200">
                {orderedHabits.map((h) => {
                  if (h.negative) {
                    return (
                      <div
                        key={h.id}
                        className="border-t border-teal-200/80 bg-teal-50/90 py-2"
                      />
                    )
                  }
                  const map = completions[h.id]
                  const done = totalSuccessInMonth(h, map, y, m0)
                  const goal = h.monthlyGoal
                  const pct = progressPercent(done, goal)
                  const cur = currentStreakEndingAt(h, map, y, m0, today)
                  const lon = longestStreakInMonth(h, map, y, m0)
                  const bar = Math.min(100, pct)
                  return (
                    <div
                      key={h.id}
                      className={`flex flex-col gap-2 px-3 py-3 text-xs ${rowStyle(h)} text-teal-900`}
                    >
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        <span>
                          <Target className="mr-0.5 inline h-3 w-3 align-text-bottom" />
                          {goal}
                        </span>
                        <span className="font-semibold">{pct}%</span>
                        <span>Σ {done}</span>
                        <span>
                          <Flame className="mr-0.5 inline h-3 w-3 align-text-bottom" />
                          {cur}
                        </span>
                        <span>
                          <Trophy className="mr-0.5 inline h-3 w-3 align-text-bottom" />
                          {lon}
                        </span>
                      </div>
                      <div className="h-2 w-full shrink-0 overflow-hidden rounded-full bg-emerald-100 ring-1 ring-emerald-200/60">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all"
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
            </div>
          </div>
        )}
      </main>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
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
            {!formNeg && (
              <label className="mb-4 block text-sm font-medium text-teal-800">
                Цель на месяц (дней)
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={formGoal}
                  onChange={(e) => setFormGoal(+e.target.value)}
                  className="mt-1 w-full rounded-lg border border-teal-200 px-3 py-2 outline-none focus:ring-2 focus:ring-teal-400"
                />
              </label>
            )}
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
    </div>
  )
}
