import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Pause,
  Play,
  Plus,
  X,
} from 'lucide-react'
import { dateKey, parseKey } from '../dates'
import { supabase } from '../lib/supabase'
import {
  applyTimerCommand,
  createTimerDefinition,
  fetchTimerSnapshot,
  isTimerConflict,
  timerRangeBounds,
  timerErrorText,
} from './api'
import type {
  TimerDefinition,
  TimerInterval,
  TimerPeriod,
  TimerSnapshot,
} from './types'

const TIMER_COLORS = [
  '#6d5dfc',
  '#f06f4f',
  '#22a67a',
  '#e8a632',
  '#3e8ee8',
  '#d65e9f',
]
const TIMER_ICONS = ['✦', '◎', '↗', '☕', '◇', '◌']

function todayKey(): string {
  const now = new Date()
  return dateKey(now.getFullYear(), now.getMonth(), now.getDate())
}

function shiftDay(key: string, delta: number): string {
  const { y, m0, d } = parseKey(key)
  const next = new Date(y, m0, d + delta)
  return dateKey(next.getFullYear(), next.getMonth(), next.getDate())
}

function formatDay(key: string): string {
  if (key === todayKey()) return 'Сегодня'
  if (key === shiftDay(todayKey(), -1)) return 'Вчера'
  const { y, m0, d } = parseKey(key)
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: y === new Date().getFullYear() ? undefined : 'numeric',
  }).format(new Date(y, m0, d))
}

function keyFromDate(value: Date): string {
  return dateKey(value.getFullYear(), value.getMonth(), value.getDate())
}

function formatPeriod(key: string, period: TimerPeriod): string {
  if (period === 'day') return formatDay(key)
  const { start, end } = timerRangeBounds(key, period)
  const last = new Date(end)
  last.setDate(last.getDate() - 1)
  const sameMonth = start.getMonth() === last.getMonth()
  const sameYear = start.getFullYear() === last.getFullYear()
  const currentYear = new Date().getFullYear()
  if (sameMonth && sameYear) {
    const month = new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(last)
    const year = last.getFullYear() === currentYear ? '' : ` ${last.getFullYear()} г.`
    return `${start.getDate()}–${last.getDate()} ${month}${year}`
  }
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: sameYear && last.getFullYear() === currentYear ? undefined : 'numeric',
  })
  return `${formatter.format(start)} — ${formatter.format(last)}`
}

function formatDuration(milliseconds: number, seconds = true): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const restSeconds = totalSeconds % 60
  if (!seconds) {
    if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`
    return `${minutes} мин`
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')}`
}

function formatCompactDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return minutes > 0 ? `${hours}ч ${minutes}м` : `${hours}ч`
  return totalMinutes > 0 ? `${totalMinutes}м` : '—'
}

function formatClock(value: string | number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatIntervalStart(
  value: string | number,
  period: TimerPeriod,
): string {
  if (period === 'day') return formatClock(value)
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function shortWeekday(day: string): string {
  const { y, m0, d } = parseKey(day)
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'short' })
    .format(new Date(y, m0, d))
    .replace('.', '')
}

function durationWithinPeriod(
  startValue: string | number,
  endValue: string | number,
  day: string,
  period: TimerPeriod,
): number {
  const { start, end } = timerRangeBounds(day, period)
  const intervalStart = new Date(startValue).getTime()
  const intervalEnd = new Date(endValue).getTime()
  return Math.max(
    0,
    Math.min(intervalEnd, end.getTime()) -
      Math.max(intervalStart, start.getTime()),
  )
}

function timerCardStyle(timer: TimerDefinition): CSSProperties {
  return {
    '--timer-color': timer.color,
    borderColor: `color-mix(in srgb, ${timer.color} 25%, #dfe6e1)`,
  } as CSSProperties
}

function isNetworkish(error: unknown): boolean {
  const text = timerErrorText(error).toLowerCase()
  return (
    text.includes('network') ||
    text.includes('fetch') ||
    text.includes('load failed') ||
    text.includes('timeout')
  )
}

export function TimerScreen({
  userId,
  isMobile,
}: {
  userId: string
  isMobile: boolean
}) {
  const [selectedDate, setSelectedDate] = useState(todayKey)
  const [period, setPeriod] = useState<TimerPeriod>('day')
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [commandBusy, setCommandBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newTimerName, setNewTimerName] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const loadGenerationRef = useRef(0)

  const reload = useCallback(
    async (quiet = false) => {
      const generation = ++loadGenerationRef.current
      if (!quiet) setLoading(true)
      try {
        const next = await fetchTimerSnapshot(userId, selectedDate, period)
        if (generation !== loadGenerationRef.current) return
        setSnapshot(next)
        setError(null)
      } catch (nextError) {
        if (generation !== loadGenerationRef.current) return
        setError(timerErrorText(nextError))
      } finally {
        if (generation === loadGenerationRef.current) setLoading(false)
      }
    },
    [period, selectedDate, userId],
  )

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void reload(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [reload])

  useEffect(() => {
    if (!snapshot?.state.activeTimerId) return
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [snapshot?.state.activeTimerId])

  useEffect(() => {
    if (!supabase) return
    let reloadTimer: number | undefined
    const scheduleReload = () => {
      if (reloadTimer !== undefined) window.clearTimeout(reloadTimer)
      reloadTimer = window.setTimeout(() => void reload(true), 120)
    }
    const channel = supabase
      .channel(`multitimer:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'timer_state',
          filter: `user_id=eq.${userId}`,
        },
        scheduleReload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'timer_intervals',
          filter: `user_id=eq.${userId}`,
        },
        scheduleReload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'timer_definitions',
          filter: `user_id=eq.${userId}`,
        },
        scheduleReload,
      )
      .subscribe()

    return () => {
      if (reloadTimer !== undefined) window.clearTimeout(reloadTimer)
      void supabase?.removeChannel(channel)
    }
  }, [reload, userId])

  const activeTimer = useMemo(
    () =>
      snapshot?.timers.find(
        (timer) => timer.id === snapshot.state.activeTimerId,
      ) ?? null,
    [snapshot],
  )

  const totals = useMemo(() => {
    const result: Record<string, number> = {}
    if (!snapshot) return result
    for (const total of snapshot.importedTotals) {
      result[total.timerId] = (result[total.timerId] ?? 0) + total.durationMs
    }
    for (const interval of snapshot.intervals) {
      result[interval.timerId] =
        (result[interval.timerId] ?? 0) +
        durationWithinPeriod(
          interval.startedAt,
          interval.endedAt,
          selectedDate,
          period,
        )
    }
    if (
      snapshot.state.activeTimerId &&
      snapshot.state.activeStartedAt
    ) {
      result[snapshot.state.activeTimerId] =
        (result[snapshot.state.activeTimerId] ?? 0) +
        durationWithinPeriod(
          snapshot.state.activeStartedAt,
          now,
          selectedDate,
          period,
        )
    }
    return result
  }, [now, period, selectedDate, snapshot])

  const periodTotal = Object.values(totals).reduce((sum, value) => sum + value, 0)

  const timeline = useMemo(() => {
    const exact: Array<TimerInterval & { active?: boolean }> = [
      ...(snapshot?.intervals ?? []),
    ]
    if (
      snapshot?.state.activeTimerId &&
      snapshot.state.activeStartedAt &&
      durationWithinPeriod(
        snapshot.state.activeStartedAt,
        now,
        selectedDate,
        period,
      ) > 0
    ) {
      exact.push({
        id: -1,
        timerId: snapshot.state.activeTimerId,
        startedAt: snapshot.state.activeStartedAt,
        endedAt: new Date(now).toISOString(),
        active: true,
      })
    }
    return exact.sort(
      (left, right) =>
        new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
    )
  }, [now, period, selectedDate, snapshot])

  const periodDays = useMemo(() => {
    const { start } = timerRangeBounds(selectedDate, period)
    const count = period === 'week' ? 7 : 1
    return Array.from({ length: count }, (_, index) => {
      const day = new Date(start)
      day.setDate(start.getDate() + index)
      return keyFromDate(day)
    })
  }, [period, selectedDate])

  const dayViews = useMemo(
    () =>
      periodDays.map((day) => {
        const { start, end } = timerRangeBounds(day, 'day')
        const segments = timeline
          .map((interval) => {
            const segmentStart = Math.max(
              new Date(interval.startedAt).getTime(),
              start.getTime(),
            )
            const segmentEnd = Math.min(
              new Date(interval.endedAt).getTime(),
              end.getTime(),
            )
            if (segmentEnd <= segmentStart) return null
            return {
              interval,
              start: segmentStart,
              end: segmentEnd,
              startMinute: (segmentStart - start.getTime()) / 60000,
              endMinute: (segmentEnd - start.getTime()) / 60000,
            }
          })
          .filter((segment) => segment !== null)
          .sort((left, right) => left.start - right.start)
        const imported = (snapshot?.importedTotals ?? [])
          .filter((total) => total.day === day)
          .reduce((sum, total) => sum + total.durationMs, 0)
        const exact = segments.reduce(
          (sum, segment) => sum + segment.end - segment.start,
          0,
        )
        return { day, segments, total: imported + exact }
      }),
    [periodDays, snapshot?.importedTotals, timeline],
  )

  const weekScale = useMemo(() => {
    const segments = dayViews.flatMap((day) => day.segments)
    if (segments.length === 0) return { startHour: 8, endHour: 20 }
    const earliest = Math.min(...segments.map((segment) => segment.startMinute))
    const latest = Math.max(...segments.map((segment) => segment.endMinute))
    let startHour = Math.max(0, Math.floor(earliest / 60))
    let endHour = Math.min(24, Math.ceil(latest / 60))
    if (endHour - startHour < 6) {
      const missing = 6 - (endHour - startHour)
      startHour = Math.max(0, startHour - Math.ceil(missing / 2))
      endHour = Math.min(24, startHour + 6)
      startHour = Math.max(0, endHour - 6)
    }
    return { startHour, endHour }
  }, [dayViews])

  async function runTimerCommand(timer: TimerDefinition) {
    if (!snapshot || commandBusy) return
    const action =
      snapshot.state.activeTimerId === timer.id ? 'stop' : 'start'
    const commandId = crypto.randomUUID()
    setCommandBusy(true)
    setError(null)
    try {
      let result
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await applyTimerCommand({
            clientCommandId: commandId,
            action,
            timerId: timer.id,
            expectedRevision: snapshot.state.revision,
          })
          break
        } catch (commandError) {
          if (attempt === 0 && isNetworkish(commandError)) continue
          throw commandError
        }
      }
      if (!result) throw new Error('Команда таймера не была подтверждена')
      setSnapshot((current) =>
        current
          ? {
              ...current,
              state: {
                revision: result.revision,
                activeTimerId: result.activeTimerId,
                activeStartedAt: result.activeStartedAt,
                updatedAt: result.updatedAt,
              },
            }
          : current,
      )
      setNow(new Date(result.updatedAt ?? result.activeStartedAt ?? 0).getTime())
      if (selectedDate !== todayKey()) setSelectedDate(todayKey())
      else await reload(true)
    } catch (commandError) {
      if (isTimerConflict(commandError)) await reload(true)
      setError(timerErrorText(commandError))
    } finally {
      setCommandBusy(false)
    }
  }

  async function addTimer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newTimerName.trim()
    if (!name || !snapshot || addBusy) return
    const index = snapshot.timers.length
    setAddBusy(true)
    setError(null)
    try {
      await createTimerDefinition({
        userId,
        id: `timer-${crypto.randomUUID()}`,
        name,
        color: TIMER_COLORS[index % TIMER_COLORS.length]!,
        icon: TIMER_ICONS[index % TIMER_ICONS.length]!,
        sortOrder: index,
      })
      setNewTimerName('')
      setShowAdd(false)
      await reload(true)
    } catch (nextError) {
      setError(timerErrorText(nextError))
    } finally {
      setAddBusy(false)
    }
  }

  const panelClass =
    'rounded-[1.4rem] border border-[#dfe6e1] bg-white/90 shadow-[0_12px_36px_rgba(23,35,31,0.055)]'
  const stepDays = period === 'week' ? 7 : 1
  const selectedRangeStart = keyFromDate(
    timerRangeBounds(selectedDate, period).start,
  )
  const currentRangeStart = keyFromDate(
    timerRangeBounds(todayKey(), period).start,
  )
  const canMoveForward = selectedRangeStart < currentRangeStart

  return (
    <section
      className={`mx-auto w-full max-w-6xl text-[#17231f] ${
        isMobile ? 'pb-40' : ''
      }`}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 sm:mb-6">
        <div>
          <p className="mb-1 text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-[#819089]">
            {period === 'day' ? 'Ваш день' : 'Ваша неделя'}
          </p>
          <h2 className="text-3xl font-bold tracking-[-0.045em] text-[#17231f] sm:text-4xl">
            {formatPeriod(selectedDate, period)}
          </h2>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!isMobile && (
            <div className="inline-flex h-11 items-center rounded-2xl border border-blue-200 bg-white p-1 shadow-sm">
              {(['day', 'week'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPeriod(value)}
                  className={`h-9 rounded-xl px-4 text-xs font-bold transition ${
                    period === value
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-blue-800 hover:bg-blue-50'
                  }`}
                  aria-pressed={period === value}
                >
                  {value === 'day' ? 'День' : 'Неделя'}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1 rounded-2xl border border-[#dfe6e1] bg-white/80 p-1 shadow-sm">
            <button
              type="button"
              onClick={() =>
                setSelectedDate((current) => shiftDay(current, -stepDays))
              }
              className="grid h-9 w-9 place-items-center rounded-xl text-[#58665f] active:bg-[#edf1ee]"
              aria-label={period === 'day' ? 'Предыдущий день' : 'Предыдущая неделя'}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <input
              type="date"
              value={selectedDate}
              max={todayKey()}
              onChange={(event) =>
                setSelectedDate(event.target.value || todayKey())
              }
              className="h-9 min-w-0 max-w-32 bg-transparent px-1 text-center text-xs font-bold text-[#36433d] outline-none"
            />
            <button
              type="button"
              disabled={!canMoveForward}
              onClick={() =>
                setSelectedDate((current) => shiftDay(current, stepDays))
              }
              className="grid h-9 w-9 place-items-center rounded-xl text-[#58665f] active:bg-[#edf1ee] disabled:opacity-30"
              aria-label={period === 'day' ? 'Следующий день' : 'Следующая неделя'}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Закрыть">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-7">
        <div className="min-w-0">
          <div className={`${panelClass} mb-4 p-4 sm:p-5`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-xs font-semibold text-[#6f7d77]">
                  Учтено за {period === 'day' ? 'день' : 'неделю'}
                </span>
                <div className="mt-1 text-2xl font-bold tabular-nums tracking-[-0.04em] sm:text-3xl">
                  {formatDuration(periodTotal, false)}
                </div>
              </div>
              <div
                className={`inline-flex max-w-[55%] items-center gap-2 rounded-full px-3 py-2 text-[0.68rem] font-bold ${
                  activeTimer
                    ? 'bg-[#dff3e8] text-[#176646]'
                    : 'bg-[#edf1ee] text-[#6f7d77]'
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    activeTimer ? 'animate-pulse bg-[#27a872]' : 'bg-[#aab3af]'
                  }`}
                />
                <span className="truncate">
                  {activeTimer ? activeTimer.name : 'Ничего не запущено'}
                </span>
              </div>
            </div>
          </div>

          {showAdd && (
            <>
            {isMobile && (
              <button
                type="button"
                className="fixed inset-0 z-[109] bg-black/25"
                onClick={() => setShowAdd(false)}
                aria-label="Закрыть добавление таймера"
              />
            )}
            <form
              onSubmit={addTimer}
              className={`${panelClass} flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${
                isMobile
                  ? 'fixed inset-x-3 bottom-[calc(10rem+env(safe-area-inset-bottom))] z-[110]'
                  : 'mb-4'
              }`}
            >
              <div className="flex-1">
                <label
                  htmlFor="new-timer-name"
                  className="mb-1 block text-xs font-bold text-[#53615b]"
                >
                  Новый таймер
                </label>
                <input
                  id="new-timer-name"
                  value={newTimerName}
                  onChange={(event) => setNewTimerName(event.target.value)}
                  autoFocus
                  maxLength={80}
                  placeholder="Например, код-ревью"
                  className="h-11 w-full rounded-xl border border-[#cfd8d2] bg-[#fbfcfa] px-3 text-sm outline-none focus:border-[#6d5dfc] focus:ring-2 focus:ring-[#6d5dfc]/15"
                />
              </div>
              <div className="flex gap-2 sm:self-end">
                <button
                  type="submit"
                  disabled={addBusy || !newTimerName.trim()}
                  className={`h-11 flex-1 rounded-xl px-4 text-sm font-bold text-white disabled:opacity-40 sm:flex-none ${
                    isMobile ? 'bg-[#6d5dfc]' : 'bg-blue-600'
                  }`}
                >
                  Добавить
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="h-11 rounded-xl border border-[#dfe6e1] bg-white px-4 text-sm font-bold text-[#53615b]"
                >
                  Отмена
                </button>
              </div>
            </form>
            </>
          )}

          {!isMobile && (
          <>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-[#36433d]">Таймеры</h3>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-xs font-bold text-white shadow-sm active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" />
              Добавить
            </button>
          </div>

          {loading && !snapshot ? (
            <div className={`${panelClass} grid min-h-52 place-items-center p-6 text-sm text-[#6f7d77]`}>
              Загружаем таймеры…
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {(snapshot?.timers ?? []).map((timer) => {
                const running = timer.id === snapshot?.state.activeTimerId
                return (
                  <article
                    key={timer.id}
                    style={timerCardStyle(timer)}
                    className="relative overflow-hidden rounded-[1.4rem] border bg-white/90 p-4 shadow-[0_10px_30px_rgba(28,47,39,0.045)] sm:p-5"
                  >
                    <span
                      className="absolute inset-x-0 top-0 h-1"
                      style={{ backgroundColor: timer.color }}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <span
                        className="grid h-10 w-10 place-items-center rounded-xl text-lg font-extrabold"
                        style={{
                          color: timer.color,
                          backgroundColor: `color-mix(in srgb, ${timer.color} 11%, white)`,
                        }}
                      >
                        {timer.icon}
                      </span>
                      {running && (
                        <span
                          className="inline-flex items-center gap-1.5 text-[0.62rem] font-extrabold uppercase tracking-[0.1em]"
                          style={{ color: timer.color }}
                        >
                          <span
                            className="h-1.5 w-1.5 animate-pulse rounded-full"
                            style={{ backgroundColor: timer.color }}
                          />
                          в работе
                        </span>
                      )}
                    </div>
                    <div className="mt-4 text-sm font-bold text-[#53615b]">
                      {timer.name}
                    </div>
                    <div className="mt-1 text-[2rem] font-bold leading-none tabular-nums tracking-[-0.055em] sm:text-[2.35rem]">
                      {formatDuration(totals[timer.id] ?? 0)}
                    </div>
                    <div className="mt-5 flex items-center justify-between gap-3">
                      <span className="text-[0.65rem] font-semibold text-[#8a958f]">
                        за{' '}
                        {period === 'week'
                          ? 'неделю'
                          : selectedDate === todayKey()
                            ? 'сегодня'
                            : formatDay(selectedDate).toLocaleLowerCase('ru-RU')}
                      </span>
                      <button
                        type="button"
                        disabled={commandBusy}
                        onClick={() => void runTimerCommand(timer)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-extrabold text-white shadow-sm transition active:scale-95 disabled:opacity-45"
                        style={{ backgroundColor: timer.color }}
                      >
                        {running ? (
                          <Pause className="h-3.5 w-3.5" fill="currentColor" />
                        ) : (
                          <Play className="h-3.5 w-3.5" fill="currentColor" />
                        )}
                        {running ? 'Стоп' : 'Старт'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
          </>
          )}
        </div>

        {isMobile && (
          <section className={`${panelClass} min-w-0 overflow-hidden p-4`}>
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#e7ece8] pb-3">
              <div>
                <p className="mb-1 text-[0.6rem] font-extrabold uppercase tracking-[0.14em] text-[#819089]">
                  Хронология
                </p>
                <h3 className="font-extrabold tracking-[-0.03em] text-[#26332d]">
                  {period === 'day' ? 'Интервалы дня' : 'Таймлайн недели'}
                </h3>
              </div>
              <span className="grid h-8 min-w-8 place-items-center rounded-xl bg-[#ebe8ff] px-2 text-xs font-extrabold text-[#6d5dfc]">
                {timeline.length}
              </span>
            </div>

            {period === 'day' ? (
              <div>
                <div className="mb-2 grid grid-cols-5 text-[0.58rem] font-semibold text-[#9aa49f]">
                  {['00', '06', '12', '18', '24'].map((hour, index) => (
                    <span
                      key={hour}
                      className={index === 4 ? 'text-right' : index > 0 ? 'text-center' : ''}
                    >
                      {hour}:00
                    </span>
                  ))}
                </div>
                {(dayViews[0]?.segments.length ?? 0) === 0 ? (
                  <div className="grid min-h-36 place-items-center rounded-2xl bg-[#f5f7f4] px-5 text-center">
                    <div>
                      <Clock3 className="mx-auto mb-2 h-5 w-5 text-[#85908a]" />
                      <strong className="block text-xs text-[#59665f]">
                        Точных интервалов пока нет
                      </strong>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {dayViews[0]?.segments.map((segment) => {
                      const timer = snapshot?.timers.find(
                        (item) => item.id === segment.interval.timerId,
                      )
                      if (!timer) return null
                      const left = (segment.startMinute / 1440) * 100
                      const width = Math.max(
                        1.5,
                        ((segment.endMinute - segment.startMinute) / 1440) * 100,
                      )
                      return (
                        <div
                          key={`${segment.interval.id}-${segment.start}`}
                          className="rounded-2xl border border-[#e4e9e6] bg-white p-3"
                        >
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <strong className="block truncate text-xs text-[#46544e]">
                                {timer.icon} {timer.name}
                              </strong>
                              <span className="text-[0.62rem] font-semibold text-[#89948e]">
                                {formatClock(segment.start)} —{' '}
                                {segment.interval.active
                                  ? 'сейчас'
                                  : formatClock(segment.end)}
                              </span>
                            </div>
                            <strong className="shrink-0 text-xs tabular-nums text-[#4d5b55]">
                              {formatDuration(segment.end - segment.start, false)}
                            </strong>
                          </div>
                          <div className="relative h-3 overflow-hidden rounded-full bg-[#edf1ee]">
                            <span
                              className="absolute inset-y-0 rounded-full"
                              style={{
                                left: `${left}%`,
                                width: `${Math.min(width, 100 - left)}%`,
                                backgroundColor: timer.color,
                              }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="mb-2 grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] gap-px">
                  <span />
                  {dayViews.map((dayView) => {
                    const { d } = parseKey(dayView.day)
                    const current = dayView.day === todayKey()
                    return (
                      <div key={dayView.day} className="min-w-0 text-center">
                        <span className="block truncate text-[0.56rem] font-bold uppercase text-[#8c9791]">
                          {shortWeekday(dayView.day)}
                        </span>
                        <span
                          className={`mx-auto mt-1 grid h-6 w-6 place-items-center rounded-full text-[0.68rem] font-extrabold ${
                            current
                              ? 'bg-[#6d5dfc] text-white'
                              : 'text-[#3e4c46]'
                          }`}
                        >
                          {d}
                        </span>
                        <span className="mt-1 block truncate text-[0.5rem] font-bold text-[#7e8a84]">
                          {formatCompactDuration(dayView.total)}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="relative ml-8 h-[26rem] rounded-xl bg-[#f4f6f3]">
                  {Array.from(
                    { length: weekScale.endHour - weekScale.startHour + 1 },
                    (_, index) => weekScale.startHour + index,
                  ).map((hour) => {
                    const top =
                      ((hour - weekScale.startHour) /
                        (weekScale.endHour - weekScale.startHour)) *
                      100
                    return (
                      <div
                        key={hour}
                        className="absolute inset-x-0 border-t border-[#dfe5e1]"
                        style={{ top: `${top}%` }}
                      >
                        <span className="absolute -left-8 -top-2 w-7 text-right text-[0.5rem] font-semibold text-[#98a29d]">
                          {String(hour).padStart(2, '0')}:00
                        </span>
                      </div>
                    )
                  })}
                  {dayViews.map((dayView, dayIndex) => (
                    <div
                      key={dayView.day}
                      className="absolute inset-y-0 border-l border-[#e1e6e3]"
                      style={{ left: `${(dayIndex / 7) * 100}%` }}
                    />
                  ))}
                  {dayViews.flatMap((dayView, dayIndex) =>
                    dayView.segments.map((segment) => {
                      const timer = snapshot?.timers.find(
                        (item) => item.id === segment.interval.timerId,
                      )
                      if (!timer) return null
                      const scaleMinutes =
                        (weekScale.endHour - weekScale.startHour) * 60
                      const top = Math.max(
                        0,
                        ((segment.startMinute - weekScale.startHour * 60) /
                          scaleMinutes) *
                          416,
                      )
                      const height = Math.min(
                        416 - top,
                        Math.max(
                          20,
                          ((segment.endMinute - segment.startMinute) /
                            scaleMinutes) *
                            416,
                        ),
                      )
                      return (
                        <div
                          key={`${dayView.day}-${segment.interval.id}-${segment.start}`}
                          className="absolute grid place-items-center overflow-hidden rounded-lg border border-white/70 text-[0.62rem] font-bold text-white shadow-sm"
                          style={{
                            left: `calc(${(dayIndex / 7) * 100}% + 2px)`,
                            width: `calc(${100 / 7}% - 4px)`,
                            top,
                            height,
                            backgroundColor: timer.color,
                          }}
                          title={`${timer.name}: ${formatClock(segment.start)}–${formatClock(segment.end)}`}
                        >
                          {timer.icon}
                        </div>
                      )
                    }),
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        <aside className={`${panelClass} self-start p-4 sm:p-5 lg:sticky lg:top-5 ${
          isMobile ? 'hidden' : ''
        }`}>
          <div className="flex items-center justify-between gap-3 border-b border-[#e7ece8] pb-4">
            <div>
              <p className="mb-1 text-[0.62rem] font-extrabold uppercase tracking-[0.14em] text-[#819089]">
                Хронология
              </p>
              <h3 className="font-extrabold tracking-[-0.03em] text-[#26332d]">
                Интервалы {period === 'day' ? 'дня' : 'недели'}
              </h3>
            </div>
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#e8ede9] text-xs font-extrabold text-[#66746e]">
              {timeline.length}
            </span>
          </div>

          {activeTimer && snapshot?.state.activeStartedAt && (
            <div
              className="mt-4 flex items-center gap-3 rounded-2xl border p-3"
              style={{
                borderColor: `color-mix(in srgb, ${activeTimer.color} 22%, white)`,
                backgroundColor: `color-mix(in srgb, ${activeTimer.color} 7%, white)`,
              }}
            >
              <span
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 bg-white"
                style={{ color: activeTimer.color, borderColor: activeTimer.color }}
              >
                {activeTimer.icon}
              </span>
              <div className="min-w-0 flex-1">
                <span
                  className="block text-[0.58rem] font-extrabold uppercase tracking-[0.1em]"
                  style={{ color: activeTimer.color }}
                >
                  Идёт сейчас
                </span>
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-xs">{activeTimer.name}</strong>
                  <strong className="text-xs tabular-nums">
                    {formatDuration(
                      now - new Date(snapshot.state.activeStartedAt).getTime(),
                    )}
                  </strong>
                </div>
              </div>
            </div>
          )}

          <div className="min-h-40 py-3">
            {timeline.length === 0 ? (
              <div className="grid min-h-40 place-items-center px-4 text-center">
                <div>
                  <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full border border-[#d9e2dc] bg-[#f7f9f6] text-[#6c7a73]">
                    <Clock3 className="h-5 w-5" />
                  </span>
                  <strong className="block text-xs">Точных интервалов пока нет</strong>
                  <p className="mt-1 text-[0.68rem] leading-relaxed text-[#8a958f]">
                    Запустите таймер — начало, конец и длительность сохранятся в базе.
                  </p>
                </div>
              </div>
            ) : (
              timeline.map((interval) => {
                const timer = snapshot?.timers.find(
                  (item) => item.id === interval.timerId,
                )
                if (!timer) return null
                const duration = durationWithinPeriod(
                  interval.startedAt,
                  interval.endedAt,
                  selectedDate,
                  period,
                )
                return (
                  <div
                    key={`${interval.id}-${interval.startedAt}`}
                    className="grid grid-cols-[0.65rem_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[#edf1ee] py-3 last:border-0"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full border-2 border-white shadow-[0_0_0_1px_#d6ded9]"
                      style={{ backgroundColor: timer.color }}
                    />
                    <div className="min-w-0">
                      <strong className="block truncate text-xs">{timer.name}</strong>
                      <span className="text-[0.65rem] font-semibold text-[#87928c]">
                        {formatIntervalStart(interval.startedAt, period)} —{' '}
                        {interval.active ? 'сейчас' : formatClock(interval.endedAt)}
                      </span>
                    </div>
                    <span className="text-[0.65rem] font-extrabold tabular-nums text-[#4b5953]">
                      {formatDuration(duration, false)}
                    </span>
                  </div>
                )
              })
            )}
          </div>

          <div className="flex items-start gap-2 border-t border-[#e7ece8] pt-4 text-[0.65rem] leading-relaxed text-[#85908a]">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#e7ece8] text-[#68766f]">
              ⌁
            </span>
            <p className="m-0">
              <strong className="text-[#5f6d66]">Синхронизация включена.</strong>{' '}
              Таймеры и новые интервалы хранятся в Supabase и доступны на ваших устройствах.
            </p>
          </div>
        </aside>
      </div>

      {isMobile && (
        <div className="fixed inset-x-0 bottom-0 z-[100] px-3 pb-[max(0.55rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-md">
            <div className="mb-2 inline-flex h-11 items-center rounded-2xl border border-[#d8e0db] bg-white p-1 shadow-[0_6px_24px_rgba(23,35,31,0.14)]">
              {(['day', 'week'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPeriod(value)}
                  className={`h-9 min-w-[5.25rem] rounded-xl px-4 text-xs font-bold transition ${
                    period === value
                      ? 'bg-[#6d5dfc] text-white shadow-sm'
                      : 'text-[#4c5a54] active:bg-[#f1f4f2]'
                  }`}
                  aria-pressed={period === value}
                >
                  {value === 'day' ? 'День' : 'Неделя'}
                </button>
              ))}
            </div>
            <div className="relative rounded-[1.7rem] bg-[#17231f] px-2 py-2.5 pr-[4.7rem] shadow-[0_-8px_32px_rgba(23,35,31,0.22)]">
              <div className="flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {(snapshot?.timers ?? []).map((timer) => {
                  const running = snapshot?.state.activeTimerId === timer.id
                  return (
                    <button
                      key={timer.id}
                      type="button"
                      disabled={commandBusy}
                      onClick={() => void runTimerCommand(timer)}
                      className="flex w-[3.75rem] shrink-0 flex-col items-center gap-1 rounded-2xl py-1 text-white/75 outline-none transition active:scale-95 disabled:opacity-45"
                      aria-label={running ? `Остановить ${timer.name}` : `Запустить ${timer.name}`}
                    >
                      <span
                        className={`relative grid h-11 w-11 place-items-center rounded-full border-2 text-lg font-extrabold shadow-sm ${
                          running
                            ? 'border-white ring-2 ring-white/35'
                            : 'border-white/20'
                        }`}
                        style={{ backgroundColor: timer.color }}
                      >
                        {timer.icon}
                        {running && (
                          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-pulse rounded-full border-2 border-[#17231f] bg-white" />
                        )}
                      </span>
                      <span className="w-full truncate text-center text-[0.52rem] font-bold">
                        {timer.name}
                      </span>
                    </button>
                  )
                })}
              </div>
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="absolute bottom-2.5 right-2.5 grid h-14 w-14 place-items-center rounded-full bg-[#6d5dfc] text-white shadow-[0_5px_18px_rgba(109,93,252,0.45)] ring-2 ring-white/25 transition active:scale-95"
                aria-label="Добавить таймер"
              >
                <Plus className="h-7 w-7" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
