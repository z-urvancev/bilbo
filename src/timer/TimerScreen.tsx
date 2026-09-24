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
  Sparkles,
  X,
} from 'lucide-react'
import { dateKey, parseKey } from '../dates'
import { supabase } from '../lib/supabase'
import {
  applyTimerCommand,
  createTimerDefinition,
  fetchTimerSnapshot,
  isTimerConflict,
  timerDayBounds,
  timerErrorText,
} from './api'
import type { TimerDefinition, TimerInterval, TimerSnapshot } from './types'

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

function formatClock(value: string | number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function durationWithinDay(
  startValue: string | number,
  endValue: string | number,
  day: string,
): number {
  const { start, end } = timerDayBounds(day)
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
        const next = await fetchTimerSnapshot(userId, selectedDate)
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
    [selectedDate, userId],
  )

  useEffect(() => {
    void reload()
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
        durationWithinDay(interval.startedAt, interval.endedAt, selectedDate)
    }
    if (
      snapshot.state.activeTimerId &&
      snapshot.state.activeStartedAt
    ) {
      result[snapshot.state.activeTimerId] =
        (result[snapshot.state.activeTimerId] ?? 0) +
        durationWithinDay(
          snapshot.state.activeStartedAt,
          now,
          selectedDate,
        )
    }
    return result
  }, [now, selectedDate, snapshot])

  const dayTotal = Object.values(totals).reduce((sum, value) => sum + value, 0)
  const hasImportedTotals = (snapshot?.importedTotals.length ?? 0) > 0

  const timeline = useMemo(() => {
    const exact: Array<TimerInterval & { active?: boolean }> = [
      ...(snapshot?.intervals ?? []),
    ]
    if (
      snapshot?.state.activeTimerId &&
      snapshot.state.activeStartedAt &&
      durationWithinDay(snapshot.state.activeStartedAt, now, selectedDate) > 0
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
  }, [now, selectedDate, snapshot])

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
      setNow(Date.now())
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

  return (
    <section className="mx-auto w-full max-w-6xl text-[#17231f]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 sm:mb-6">
        <div>
          <p className="mb-1 text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-[#819089]">
            Ваш день
          </p>
          <h2 className="text-3xl font-bold tracking-[-0.045em] text-[#17231f] sm:text-4xl">
            {formatDay(selectedDate)}
          </h2>
        </div>
        <div className="flex items-center gap-1 rounded-2xl border border-[#dfe6e1] bg-white/80 p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setSelectedDate((current) => shiftDay(current, -1))}
            className="grid h-9 w-9 place-items-center rounded-xl text-[#58665f] active:bg-[#edf1ee]"
            aria-label="Предыдущий день"
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
            disabled={selectedDate >= todayKey()}
            onClick={() => setSelectedDate((current) => shiftDay(current, 1))}
            className="grid h-9 w-9 place-items-center rounded-xl text-[#58665f] active:bg-[#edf1ee] disabled:opacity-30"
            aria-label="Следующий день"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
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
                  Учтено за день
                </span>
                <div className="mt-1 text-2xl font-bold tabular-nums tracking-[-0.04em] sm:text-3xl">
                  {formatDuration(dayTotal, false)}
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
            {hasImportedTotals && (
              <div className="mt-3 flex items-start gap-2 border-t border-[#e7ece8] pt-3 text-[0.68rem] leading-relaxed text-[#6f7d77]">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#6d5dfc]" />
                История за этот день импортирована из локального Мультитаймера.
                Точные часы старых интервалов в экспорте отсутствовали.
              </div>
            )}
          </div>

          {showAdd && (
            <form
              onSubmit={addTimer}
              className={`${panelClass} mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center`}
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
                  className="h-11 flex-1 rounded-xl bg-[#174e3b] px-4 text-sm font-bold text-white disabled:opacity-40 sm:flex-none"
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
          )}

          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-[#36433d]">Таймеры</h3>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[#174e3b] px-3 text-xs font-bold text-white shadow-sm active:scale-[0.98]"
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
            <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
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
                        {selectedDate === todayKey()
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
        </div>

        <aside className={`${panelClass} self-start p-4 sm:p-5 lg:sticky lg:top-5`}>
          <div className="flex items-center justify-between gap-3 border-b border-[#e7ece8] pb-4">
            <div>
              <p className="mb-1 text-[0.62rem] font-extrabold uppercase tracking-[0.14em] text-[#819089]">
                Хронология
              </p>
              <h3 className="font-extrabold tracking-[-0.03em] text-[#26332d]">
                Интервалы дня
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
                const duration = durationWithinDay(
                  interval.startedAt,
                  interval.endedAt,
                  selectedDate,
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
                        {formatClock(interval.startedAt)} —{' '}
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
    </section>
  )
}
