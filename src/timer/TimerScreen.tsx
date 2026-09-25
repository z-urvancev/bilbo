import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Pause,
  Play,
  X,
} from 'lucide-react'
import { dateKey, parseKey } from '../dates'
import { supabase } from '../lib/supabase'
import {
  applyTimerCommand,
  fetchTimerSnapshot,
  invalidateTimerSnapshotCache,
  isTimerConflict,
  recordTimerEvent,
  timerErrorText,
  timerRangeBounds,
} from './api'
import type {
  TimerDefinition,
  TimerEvent,
  TimerEventKind,
  TimerInterval,
  TimerPeriod,
  TimerSnapshot,
} from './types'

type ExactInterval = TimerInterval & { active?: boolean }

type DaySegment = {
  interval: ExactInterval
  start: number
  end: number
  startMinute: number
  endMinute: number
}

type DayPointEvent = {
  event: TimerEvent
  at: number
  minute: number
}

type DayView = {
  day: string
  segments: DaySegment[]
  events: DayPointEvent[]
  total: number
}

const MIN_TIMELINE_MINUTES = 5
const TIMER_EVENT_META: Record<
  TimerEventKind,
  { label: string; symbol: string; color: string; softColor: string }
> = {
  interruption: {
    label: 'Interruption',
    symbol: '!',
    color: '#f59e0b',
    softColor: '#fff7df',
  },
  distraction: {
    label: 'Distraction',
    symbol: '↗',
    color: '#ec4899',
    softColor: '#fff0f7',
  },
}

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
    if (minutes > 0) return `${minutes} мин`
    return `${restSeconds} сек`
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

function formatAxisDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}с`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}м`
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours}ч` : `${hours.toFixed(1)}ч`
}

function formatClock(value: string | number): string {
  return new Intl.DateTimeFormat('ru-RU', {
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

function segmentKey(segment: DaySegment): string {
  return `${segment.interval.id}-${segment.start}`
}

function niceDurationCeiling(milliseconds: number): number {
  const steps = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000,
    2 * 60 * 60_000,
    4 * 60 * 60_000,
    8 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
  ]
  return steps.find((step) => step >= milliseconds) ?? milliseconds
}

function timerFor(
  timers: TimerDefinition[],
  timerId: string,
): TimerDefinition | undefined {
  return timers.find((timer) => timer.id === timerId)
}

function visualSegmentMinutes(segment: DaySegment): number {
  return Math.max(
    MIN_TIMELINE_MINUTES,
    segment.endMinute - segment.startMinute,
  )
}

function IntervalPopover({
  segment,
  timer,
  day,
  className = '',
  style,
}: {
  segment: DaySegment
  timer: TimerDefinition
  day?: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={`pointer-events-none absolute z-30 max-w-[12rem] rounded-xl bg-[#17231f]/95 px-2.5 py-2 text-white shadow-xl ${className}`}
      style={{ borderTop: `3px solid ${timer.color}`, ...style }}
      role="status"
    >
      <strong className="block truncate text-[0.68rem]">
        {timer.icon} {timer.name}
      </strong>
      <span className="mt-0.5 block whitespace-nowrap text-[0.58rem] font-semibold text-white/70">
        {day ? `${shortWeekday(day)}, ${parseKey(day).d} · ` : ''}
        {formatClock(segment.start)}–
        {segment.interval.active ? 'сейчас' : formatClock(segment.end)}
      </span>
      <span className="mt-0.5 block text-[0.6rem] font-bold tabular-nums">
        {formatDuration(segment.end - segment.start, false)}
      </span>
    </div>
  )
}

function EventPopover({
  point,
  day,
  className = '',
  style,
}: {
  point: DayPointEvent
  day?: string
  className?: string
  style?: CSSProperties
}) {
  const meta = TIMER_EVENT_META[point.event.kind]
  return (
    <div
      className={`pointer-events-none absolute z-30 max-w-[11rem] rounded-xl bg-[#17231f]/95 px-2.5 py-2 text-white shadow-xl ${className}`}
      style={{ borderTop: `3px solid ${meta.color}`, ...style }}
      role="status"
    >
      <strong className="block truncate text-[0.68rem]">
        {meta.symbol} {meta.label}
      </strong>
      <span className="mt-0.5 block whitespace-nowrap text-[0.58rem] font-semibold text-white/70">
        {day ? `${shortWeekday(day)}, ${parseKey(day).d} · ` : ''}
        {formatClock(point.at)}
      </span>
    </div>
  )
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

function DurationTimelineChart({
  segments,
  events,
  timers,
}: {
  segments: DaySegment[]
  events: DayPointEvent[]
  timers: TimerDefinition[]
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const holdTimerRef = useRef<number | undefined>(undefined)
  const maxDuration = niceDurationCeiling(
    Math.max(60_000, ...segments.map((segment) => segment.end - segment.start)),
  )
  const selectedSegment =
    segments.find(
      (segment) => `interval:${segmentKey(segment)}` === selectedKey,
    ) ?? null
  const selectedPoint =
    events.find(
      (point) => `event:${point.event.clientEventId}` === selectedKey,
    ) ?? null
  const selectedTimer = selectedSegment
    ? timerFor(timers, selectedSegment.interval.timerId)
    : undefined
  const selectedLeft = selectedSegment
    ? Math.min(92, Math.max(8, (selectedSegment.startMinute / 1440) * 100))
    : selectedPoint
      ? Math.min(92, Math.max(8, (selectedPoint.minute / 1440) * 100))
      : 50
  const selectedPopoverStyle: CSSProperties =
    selectedLeft < 30
      ? { left: '0.5rem' }
      : selectedLeft > 70
        ? { right: '0.5rem' }
        : { left: `${selectedLeft}%`, transform: 'translateX(-50%)' }

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current === undefined) return
    window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = undefined
  }, [])

  useEffect(() => clearHoldTimer, [clearHoldTimer])

  if (segments.length === 0 && events.length === 0) {
    return (
      <div className="grid min-h-52 place-items-center rounded-2xl bg-[#f5f7f4] px-5 text-center">
        <div>
          <Clock3 className="mx-auto mb-2 h-5 w-5 text-[#85908a]" />
          <strong className="block text-xs text-[#59665f]">
            Точных интервалов пока нет
          </strong>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
        <div className="relative h-52 text-[0.55rem] font-semibold text-[#929d97]">
          {[maxDuration, maxDuration / 2, 0].map((value, index) => (
            <span
              key={value}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${index * 50}%` }}
            >
              {formatAxisDuration(value)}
            </span>
          ))}
        </div>
        <div>
          <div
            className="relative h-52 overflow-hidden rounded-2xl border border-[#e1e7e3] bg-[#f5f7f4]"
            onClick={() => setSelectedKey(null)}
          >
            {selectedSegment && selectedTimer && (
              <IntervalPopover
                segment={selectedSegment}
                timer={selectedTimer}
                className="top-2"
                style={selectedPopoverStyle}
              />
            )}
            {selectedPoint && (
              <EventPopover
                point={selectedPoint}
                className="top-2"
                style={selectedPopoverStyle}
              />
            )}
            {[0, 50, 100].map((top) => (
              <span
                key={top}
                className="absolute inset-x-0 border-t border-[#dfe5e1]"
                style={{ top: `${top}%` }}
              />
            ))}
            {[0, 25, 50, 75, 100].map((left) => (
              <span
                key={left}
                className="absolute inset-y-0 border-l border-[#e1e6e3]"
                style={{ left: `${left}%` }}
              />
            ))}
            {segments.map((segment) => {
              const timer = timerFor(timers, segment.interval.timerId)
              if (!timer) return null
              const key = `interval:${segmentKey(segment)}`
              const duration = segment.end - segment.start
              const left = (segment.startMinute / 1440) * 100
              const width = (visualSegmentMinutes(segment) / 1440) * 100
              const height = Math.max(4, (duration / maxDuration) * 100)
              const selected = selectedKey === key
              return (
                <div key={key}>
                  <span
                    className={`pointer-events-none absolute bottom-0 rounded-t-sm shadow-sm transition ${
                      selected ? 'z-10 ring-1 ring-white ring-offset-1' : ''
                    }`}
                    style={{
                      left: `${left}%`,
                      width: `${Math.min(width, 100 - left)}%`,
                      minWidth: '1px',
                      height: `${height}%`,
                      backgroundColor: timer.color,
                    }}
                  />
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelectedKey(key)
                    }}
                    onPointerDown={() => {
                      clearHoldTimer()
                      holdTimerRef.current = window.setTimeout(
                        () => setSelectedKey(key),
                        420,
                      )
                    }}
                    onPointerUp={clearHoldTimer}
                    onPointerCancel={clearHoldTimer}
                    onPointerLeave={clearHoldTimer}
                    onFocus={() => setSelectedKey(key)}
                    className="absolute bottom-0 z-20 min-h-6 w-6 -translate-x-1/2 touch-none rounded focus:outline-none focus:ring-2 focus:ring-[#17231f]/20"
                    style={{
                      left: `${Math.min(99, Math.max(1, left + width / 2))}%`,
                      height: `${Math.max(12, height)}%`,
                    }}
                    aria-label={`${timer.name}: ${formatClock(segment.start)}–${segment.interval.active ? 'сейчас' : formatClock(segment.end)}, ${formatDuration(duration, false)}`}
                  />
                </div>
              )
            })}
            {events.map((point) => {
              const meta = TIMER_EVENT_META[point.event.kind]
              const key = `event:${point.event.clientEventId}`
              const left = (point.minute / 1440) * 100
              const selected = selectedKey === key
              return (
                <div key={key}>
                  <span
                    className={`pointer-events-none absolute bottom-1 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[0.18rem] border-2 border-white shadow-sm ${
                      selected ? 'z-20 ring-2 ring-[#17231f]/20' : 'z-10'
                    }`}
                    style={{ left: `${left}%`, backgroundColor: meta.color }}
                  />
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelectedKey(key)
                    }}
                    onPointerDown={() => {
                      clearHoldTimer()
                      holdTimerRef.current = window.setTimeout(
                        () => setSelectedKey(key),
                        420,
                      )
                    }}
                    onPointerUp={clearHoldTimer}
                    onPointerCancel={clearHoldTimer}
                    onPointerLeave={clearHoldTimer}
                    onFocus={() => setSelectedKey(key)}
                    className="absolute bottom-0 z-20 h-7 w-7 -translate-x-1/2 rounded focus:outline-none focus:ring-2 focus:ring-[#17231f]/20"
                    style={{ left: `${Math.min(99, Math.max(1, left))}%` }}
                    aria-label={`${meta.label}: ${formatClock(point.at)}`}
                  />
                </div>
              )
            })}
          </div>
          <div className="mt-2 grid grid-cols-5 text-[0.58rem] font-semibold text-[#929d97]">
            {['00:00', '06:00', '12:00', '18:00', '24:00'].map(
              (label, index) => (
                <span
                  key={label}
                  className={
                    index === 4
                      ? 'text-right'
                      : index > 0
                        ? 'text-center'
                        : ''
                  }
                >
                  {label}
                </span>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function IntervalList({
  days,
  timers,
  period,
}: {
  days: DayView[]
  timers: TimerDefinition[]
  period: TimerPeriod
}) {
  const entries = days.flatMap((dayView) =>
    dayView.segments.map((segment) => ({ day: dayView.day, segment })),
  )
  const pointEntries = days.flatMap((dayView) =>
    dayView.events.map((point) => ({ day: dayView.day, point })),
  )
  if (entries.length === 0 && pointEntries.length === 0) return null

  return (
    <div className="mt-5 border-t border-[#e7ece8] pt-4">
      <h4 className="mb-2 text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-[#819089]">
        Интервалы и метки
      </h4>
      <div className="grid gap-1.5 xl:grid-cols-2">
        {entries.map(({ day, segment }) => {
          const timer = timerFor(timers, segment.interval.timerId)
          if (!timer) return null
          const { d } = parseKey(day)
          return (
            <div
              key={`${day}-${segmentKey(segment)}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[#e8edea] bg-[#f9faf8] px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: timer.color }}
                />
                <div className="min-w-0">
                  <strong className="block truncate text-[0.68rem] text-[#435049]">
                    {timer.icon} {timer.name}
                  </strong>
                  {period === 'week' && (
                    <span className="block text-[0.56rem] font-semibold text-[#8b9690]">
                      {shortWeekday(day)}, {d}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <span className="block whitespace-nowrap text-[0.64rem] font-bold tabular-nums text-[#4e5b55]">
                  {formatClock(segment.start)}–
                  {segment.interval.active ? 'сейчас' : formatClock(segment.end)}
                </span>
                <span className="block text-[0.56rem] font-semibold text-[#8b9690]">
                  {formatDuration(segment.end - segment.start, false)}
                </span>
              </div>
            </div>
          )
        })}
        {pointEntries.map(({ day, point }) => {
          const meta = TIMER_EVENT_META[point.event.kind]
          const { d } = parseKey(day)
          return (
            <div
              key={`${day}-${point.event.clientEventId}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[#e8edea] px-3 py-2"
              style={{ backgroundColor: meta.softColor }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[0.62rem] font-black text-white"
                  style={{ backgroundColor: meta.color }}
                >
                  {meta.symbol}
                </span>
                <div className="min-w-0">
                  <strong className="block truncate text-[0.68rem] text-[#435049]">
                    {meta.label}
                  </strong>
                  {period === 'week' && (
                    <span className="block text-[0.56rem] font-semibold text-[#8b9690]">
                      {shortWeekday(day)}, {d}
                    </span>
                  )}
                </div>
              </div>
              <span className="whitespace-nowrap text-[0.64rem] font-bold tabular-nums text-[#4e5b55]">
                {formatClock(point.at)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DesktopHorizontalTimelines({
  days,
  timers,
  period,
}: {
  days: DayView[]
  timers: TimerDefinition[]
  period: TimerPeriod
}) {
  const hasTimelineItems = days.some(
    (day) => day.segments.length > 0 || day.events.length > 0,
  )

  if (!hasTimelineItems && period === 'day') {
    return (
      <div className="grid min-h-56 place-items-center px-5 text-center">
        <div>
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full border border-[#d9e2dc] bg-[#f7f9f6] text-[#6c7a73]">
            <Clock3 className="h-5 w-5" />
          </span>
          <strong className="block text-xs">Точных интервалов пока нет</strong>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 pt-3">
      <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_4rem] items-end gap-3 text-[0.58rem] font-semibold text-[#929d97]">
        <span />
        <div className="grid grid-cols-5">
          {['00:00', '06:00', '12:00', '18:00', '24:00'].map(
            (label, index) => (
              <span
                key={label}
                className={
                  index === 4
                    ? 'text-right'
                    : index > 0
                      ? 'text-center'
                      : ''
                }
              >
                {label}
              </span>
            ),
          )}
        </div>
        <span className="text-right">Итого</span>
      </div>

      {days.map((dayView) => {
        const { d } = parseKey(dayView.day)
        return (
          <div
            key={dayView.day}
            className="grid grid-cols-[7.5rem_minmax(0,1fr)_4rem] items-center gap-3"
          >
            <div className="min-w-0">
              <strong className="block truncate text-xs text-[#435049]">
                {period === 'week'
                  ? `${shortWeekday(dayView.day)}, ${d}`
                  : formatDay(dayView.day)}
              </strong>
              <span className="text-[0.6rem] font-semibold text-[#8b9690]">
                {dayView.segments.length} инт.
                {dayView.events.length > 0
                  ? ` · ${dayView.events.length} мет.`
                  : ''}
              </span>
            </div>
            <div className="relative h-9 overflow-hidden rounded-xl border border-[#e1e7e3] bg-[#f5f7f4]">
              {[25, 50, 75].map((left) => (
                <span
                  key={left}
                  className="absolute inset-y-0 border-l border-[#e1e6e3]"
                  style={{ left: `${left}%` }}
                />
              ))}
              {dayView.segments.map((segment) => {
                const timer = timerFor(timers, segment.interval.timerId)
                if (!timer) return null
                const left = (segment.startMinute / 1440) * 100
                const width = (visualSegmentMinutes(segment) / 1440) * 100
                return (
                  <span
                    key={segmentKey(segment)}
                    className="absolute inset-y-1 overflow-hidden rounded-sm text-[0.58rem] font-bold leading-7 text-white shadow-sm"
                    style={{
                      left: `${left}%`,
                      width: `${Math.min(width, 100 - left)}%`,
                      minWidth: '1px',
                      backgroundColor: timer.color,
                    }}
                    title={`${timer.name}: ${formatClock(segment.start)}–${segment.interval.active ? 'сейчас' : formatClock(segment.end)} · ${formatDuration(segment.end - segment.start, false)}`}
                  >
                    {width > 8 ? timer.name : ''}
                  </span>
                )
              })}
              {dayView.events.map((point) => {
                const meta = TIMER_EVENT_META[point.event.kind]
                const left = (point.minute / 1440) * 100
                return (
                  <span
                    key={point.event.clientEventId}
                    className="absolute top-1/2 z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[0.2rem] border-2 border-white shadow-sm"
                    style={{ left: `${left}%`, backgroundColor: meta.color }}
                    title={`${meta.label}: ${formatClock(point.at)}`}
                  />
                )
              })}
            </div>
            <strong className="text-right text-xs tabular-nums text-[#46534d]">
              {formatCompactDuration(dayView.total)}
            </strong>
          </div>
        )
      })}
      <IntervalList days={days} timers={timers} period={period} />
    </div>
  )
}

function MobileWeekTimeline({
  days,
  timers,
  startHour,
  endHour,
}: {
  days: DayView[]
  timers: TimerDefinition[]
  startHour: number
  endHour: number
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const holdTimerRef = useRef<number | undefined>(undefined)
  const entries = days.flatMap((dayView, dayIndex) =>
    dayView.segments.map((segment) => ({
      day: dayView.day,
      dayIndex,
      segment,
      key: `interval:${dayView.day}-${segmentKey(segment)}`,
    })),
  )
  const pointEntries = days.flatMap((dayView, dayIndex) =>
    dayView.events.map((point) => ({
      day: dayView.day,
      dayIndex,
      point,
      key: `event:${point.event.clientEventId}`,
    })),
  )
  const selectedEntry = entries.find((entry) => entry.key === selectedKey)
  const selectedPoint = pointEntries.find(
    (entry) => entry.key === selectedKey,
  )
  const selectedTimer = selectedEntry
    ? timerFor(timers, selectedEntry.segment.interval.timerId)
    : undefined
  const scaleMinutes = (endHour - startHour) * 60

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current === undefined) return
    window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = undefined
  }, [])

  useEffect(() => clearHoldTimer, [clearHoldTimer])

  return (
    <div>
      <div className="mb-2 grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] gap-px">
        <span />
        {days.map((dayView) => {
          const { d } = parseKey(dayView.day)
          const current = dayView.day === todayKey()
          return (
            <div key={dayView.day} className="min-w-0 text-center">
              <span className="block truncate text-[0.56rem] font-bold uppercase text-[#8c9791]">
                {shortWeekday(dayView.day)}
              </span>
              <span
                className={`mx-auto mt-1 grid h-6 w-6 place-items-center rounded-full text-[0.68rem] font-extrabold ${
                  current ? 'bg-[#6d5dfc] text-white' : 'text-[#3e4c46]'
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
      <div
        className="relative ml-8 h-[26rem] rounded-xl bg-[#f4f6f3]"
        onClick={() => setSelectedKey(null)}
      >
        {selectedEntry && selectedTimer && (
          <IntervalPopover
            segment={selectedEntry.segment}
            timer={selectedTimer}
            day={selectedEntry.day}
            className="left-2 top-2"
          />
        )}
        {selectedPoint && (
          <EventPopover
            point={selectedPoint.point}
            day={selectedPoint.day}
            className="left-2 top-2"
          />
        )}
        {Array.from(
          { length: endHour - startHour + 1 },
          (_, index) => startHour + index,
        ).map((hour) => {
          const top = ((hour - startHour) / (endHour - startHour)) * 100
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
        {Array.from({ length: 8 }, (_, dayIndex) => (
          <div
            key={dayIndex}
            className="absolute inset-y-0 border-l border-[#e1e6e3]"
            style={{ left: `${(dayIndex / 7) * 100}%` }}
          />
        ))}
        {entries.map(({ dayIndex, segment, key }) => {
          const timer = timerFor(timers, segment.interval.timerId)
          if (!timer) return null
          const top = Math.max(
            0,
            ((segment.startMinute - startHour * 60) / scaleMinutes) * 100,
          )
          const height = Math.min(
            100 - top,
            (visualSegmentMinutes(segment) / scaleMinutes) * 100,
          )
          const selected = selectedKey === key
          return (
            <div key={key}>
              <span
                className={`pointer-events-none absolute rounded-sm shadow-sm ${
                  selected ? 'z-10 ring-1 ring-white ring-offset-1' : ''
                }`}
                style={{
                  left: `calc(${(dayIndex / 7) * 100}% + 2px)`,
                  width: `calc(${100 / 7}% - 4px)`,
                  top: `${top}%`,
                  height: `${height}%`,
                  minHeight: '1px',
                  backgroundColor: timer.color,
                }}
              />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedKey(key)
                }}
                onPointerDown={() => {
                  clearHoldTimer()
                  holdTimerRef.current = window.setTimeout(
                    () => setSelectedKey(key),
                    420,
                  )
                }}
                onPointerUp={clearHoldTimer}
                onPointerCancel={clearHoldTimer}
                onPointerLeave={clearHoldTimer}
                onFocus={() => setSelectedKey(key)}
                className="absolute z-20 min-h-6 -translate-y-1/2 rounded focus:outline-none focus:ring-2 focus:ring-[#17231f]/20"
                style={{
                  left: `calc(${(dayIndex / 7) * 100}% + 1px)`,
                  width: `calc(${100 / 7}% - 2px)`,
                  top: `${Math.min(99, Math.max(1, top + height / 2))}%`,
                }}
                aria-label={`${timer.name}: ${formatClock(segment.start)}–${segment.interval.active ? 'сейчас' : formatClock(segment.end)}, ${formatDuration(segment.end - segment.start, false)}`}
              />
            </div>
          )
        })}
        {pointEntries.map(({ dayIndex, point, key }) => {
          const meta = TIMER_EVENT_META[point.event.kind]
          const top = Math.max(
            0,
            ((point.minute - startHour * 60) / scaleMinutes) * 100,
          )
          const selected = selectedKey === key
          return (
            <div key={key}>
              <span
                className={`pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[0.18rem] border-2 border-white shadow-sm ${
                  selected ? 'z-20 ring-2 ring-[#17231f]/20' : 'z-10'
                }`}
                style={{
                  left: `${((dayIndex + 0.5) / 7) * 100}%`,
                  top: `${Math.min(100, top)}%`,
                  backgroundColor: meta.color,
                }}
              />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedKey(key)
                }}
                onPointerDown={() => {
                  clearHoldTimer()
                  holdTimerRef.current = window.setTimeout(
                    () => setSelectedKey(key),
                    420,
                  )
                }}
                onPointerUp={clearHoldTimer}
                onPointerCancel={clearHoldTimer}
                onPointerLeave={clearHoldTimer}
                onFocus={() => setSelectedKey(key)}
                className="absolute z-20 h-7 -translate-y-1/2 rounded focus:outline-none focus:ring-2 focus:ring-[#17231f]/20"
                style={{
                  left: `calc(${(dayIndex / 7) * 100}% + 1px)`,
                  width: `calc(${100 / 7}% - 2px)`,
                  top: `${Math.min(99, Math.max(1, top))}%`,
                }}
                aria-label={`${meta.label}: ${formatClock(point.at)}`}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TimerEventButtons({
  compact,
  busy,
  lastRecorded,
  onRecord,
}: {
  compact: boolean
  busy: TimerEventKind | null
  lastRecorded: TimerEventKind | null
  onRecord: (kind: TimerEventKind) => void
}) {
  return (
    <div
      className={
        compact ? 'flex min-w-0 flex-1 gap-1' : 'grid grid-cols-2 gap-2'
      }
    >
      {(['interruption', 'distraction'] as const).map((kind) => {
        const meta = TIMER_EVENT_META[kind]
        const recorded = lastRecorded === kind
        return (
          <button
            key={kind}
            type="button"
            disabled={busy !== null}
            onClick={() => onRecord(kind)}
            className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl border font-bold transition active:scale-[0.98] disabled:opacity-50 ${
              compact
                ? 'h-9 flex-1 px-1.5 text-[0.5rem]'
                : 'h-9 px-2.5 text-[0.62rem]'
            }`}
            style={{
              borderColor: `${meta.color}55`,
              backgroundColor: meta.softColor,
              color: meta.color,
            }}
            aria-label={`Отметить ${meta.label}`}
          >
            <span className="grid h-4 w-4 shrink-0 place-items-center rounded text-[0.55rem] text-white" style={{ backgroundColor: meta.color }}>
              {recorded ? '✓' : meta.symbol}
            </span>
            <span className="truncate">
              {busy === kind ? 'Сохраняю…' : meta.label}
            </span>
          </button>
        )
      })}
    </div>
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
  const [eventBusy, setEventBusy] = useState<TimerEventKind | null>(null)
  const [lastRecordedEvent, setLastRecordedEvent] =
    useState<TimerEventKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadGenerationRef = useRef(0)
  const eventFeedbackTimerRef = useRef<number | undefined>(undefined)

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

  useEffect(
    () => () => {
      if (eventFeedbackTimerRef.current !== undefined) {
        window.clearTimeout(eventFeedbackTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (!supabase) return
    let reloadTimer: number | undefined
    const scheduleReload = (includeHistorical = false) => {
      invalidateTimerSnapshotCache(userId, includeHistorical)
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
        () => scheduleReload(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'timer_intervals',
          filter: `user_id=eq.${userId}`,
        },
        () => scheduleReload(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'timer_definitions',
          filter: `user_id=eq.${userId}`,
        },
        () => scheduleReload(true),
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'timer_events',
          filter: `user_id=eq.${userId}`,
        },
        () => scheduleReload(),
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
    if (snapshot.state.activeTimerId && snapshot.state.activeStartedAt) {
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

  const periodTotal = Object.values(totals).reduce(
    (sum, value) => sum + value,
    0,
  )

  const timeline = useMemo(() => {
    const exact: ExactInterval[] = [...(snapshot?.intervals ?? [])]
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

  const dayViews = useMemo<DayView[]>(
    () =>
      periodDays.map((day) => {
        const { start, end } = timerRangeBounds(day, 'day')
        const segments = timeline
          .map((interval): DaySegment | null => {
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
          .filter((segment): segment is DaySegment => segment !== null)
          .sort((left, right) => left.start - right.start)
        const events = (snapshot?.events ?? [])
          .map((event): DayPointEvent | null => {
            const at = new Date(event.occurredAt).getTime()
            if (at < start.getTime() || at >= end.getTime()) return null
            return {
              event,
              at,
              minute: (at - start.getTime()) / 60000,
            }
          })
          .filter((event): event is DayPointEvent => event !== null)
          .sort((left, right) => left.at - right.at)
        const imported = (snapshot?.importedTotals ?? [])
          .filter((total) => total.day === day)
          .reduce((sum, total) => sum + total.durationMs, 0)
        const exact = segments.reduce(
          (sum, segment) => sum + segment.end - segment.start,
          0,
        )
        return { day, segments, events, total: imported + exact }
      }),
    [periodDays, snapshot?.events, snapshot?.importedTotals, timeline],
  )

  const weekScale = useMemo(() => {
    const segments = dayViews.flatMap((day) => day.segments)
    const events = dayViews.flatMap((day) => day.events)
    if (segments.length === 0 && events.length === 0) {
      return { startHour: 8, endHour: 20 }
    }
    const earliest = Math.min(
      ...segments.map((segment) => segment.startMinute),
      ...events.map((event) => event.minute),
    )
    const latest = Math.max(
      ...segments.map((segment) => segment.endMinute),
      ...events.map((event) => event.minute),
    )
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
      invalidateTimerSnapshotCache(userId)
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

  async function markTimerEvent(kind: TimerEventKind) {
    if (eventBusy) return
    const event: TimerEvent = {
      clientEventId: crypto.randomUUID(),
      kind,
      occurredAt: new Date().toISOString(),
    }
    setEventBusy(kind)
    setError(null)
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await recordTimerEvent({ userId, ...event })
          break
        } catch (eventError) {
          if (attempt === 0 && isNetworkish(eventError)) continue
          throw eventError
        }
      }

      const { start, end } = timerRangeBounds(selectedDate, period)
      const occurredAt = new Date(event.occurredAt).getTime()
      invalidateTimerSnapshotCache(userId)
      if (occurredAt < start.getTime() || occurredAt >= end.getTime()) {
        setSelectedDate(todayKey())
      } else {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                events: [
                  event,
                  ...current.events.filter(
                    (item) => item.clientEventId !== event.clientEventId,
                  ),
                ],
              }
            : current,
        )
      }

      setLastRecordedEvent(kind)
      if (eventFeedbackTimerRef.current !== undefined) {
        window.clearTimeout(eventFeedbackTimerRef.current)
      }
      eventFeedbackTimerRef.current = window.setTimeout(
        () => setLastRecordedEvent(null),
        1400,
      )
    } catch (eventError) {
      setError(timerErrorText(eventError))
    } finally {
      setEventBusy(null)
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
  const isCurrentPeriod = selectedRangeStart === currentRangeStart
  const timers = snapshot?.timers ?? []

  return (
    <section
      className={`mx-auto w-full max-w-6xl text-[#17231f] ${
        isMobile ? 'pb-40' : ''
      }`}
    >
      <div
        className={`mb-4 gap-3 sm:mb-6 ${
          isMobile
            ? 'grid grid-cols-1'
            : 'flex flex-wrap items-start justify-between'
        }`}
      >
        <div className="min-w-0">
          <p className="mb-1 text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-[#819089]">
            {period === 'day' ? 'Ваш день' : 'Ваша неделя'}
          </p>
          <h2 className="text-3xl font-bold tracking-[-0.045em] text-[#17231f] sm:text-4xl">
            {formatPeriod(selectedDate, period)}
          </h2>
        </div>
        <div
          className={`items-center gap-2 ${
            isMobile
              ? 'grid w-full grid-cols-[minmax(0,1fr)_auto]'
              : 'flex flex-wrap justify-end'
          }`}
        >
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
          <div
            className={`flex min-w-0 items-center gap-1 rounded-2xl border border-[#dfe6e1] bg-white/80 p-1 shadow-sm ${
              isMobile ? 'w-full' : 'w-56'
            }`}
          >
            <button
              type="button"
              onClick={() =>
                setSelectedDate((current) => shiftDay(current, -stepDays))
              }
              className="grid h-9 w-9 place-items-center rounded-xl text-[#58665f] active:bg-[#edf1ee]"
              aria-label={
                period === 'day' ? 'Предыдущий день' : 'Предыдущая неделя'
              }
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
              className="h-9 min-w-0 flex-1 bg-transparent px-1 text-center text-xs font-bold text-[#36433d] outline-none"
            />
            <button
              type="button"
              disabled={!canMoveForward}
              onClick={() =>
                setSelectedDate((current) => shiftDay(current, stepDays))
              }
              className="grid h-9 w-9 place-items-center rounded-xl text-[#58665f] active:bg-[#edf1ee] disabled:opacity-30"
              aria-label={
                period === 'day' ? 'Следующий день' : 'Следующая неделя'
              }
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button
            type="button"
            disabled={isCurrentPeriod}
            onClick={() => setSelectedDate(todayKey())}
            className={`h-9 shrink-0 rounded-xl px-2.5 text-[0.62rem] font-bold transition disabled:cursor-default disabled:opacity-35 ${
              isMobile
                ? 'bg-[#ebe8ff] text-[#6757ed] active:bg-[#ddd8ff]'
                : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
            }`}
          >
            Сегодня
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

      <div className={`${panelClass} mb-4 p-4 sm:p-5`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="text-xs font-semibold text-[#6f7d77]">
              Учтено за {period === 'day' ? 'день' : 'неделю'}
            </span>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-[-0.04em] sm:text-3xl">
              {periodTotal > 0 ? formatDuration(periodTotal, false) : '0 мин'}
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

      <div
        className={`grid gap-5 ${
          isMobile ? '' : 'lg:grid-cols-[18rem_minmax(0,1fr)]'
        }`}
      >
        {!isMobile && (
          <section className={`${panelClass} self-start overflow-hidden p-3`}>
            <div className="border-b border-[#e7ece8] px-1 pb-3">
              <p className="text-[0.62rem] font-extrabold uppercase tracking-[0.14em] text-[#819089]">
                Таймеры
              </p>
            </div>
            {loading && !snapshot ? (
              <div className="grid min-h-40 place-items-center text-xs text-[#6f7d77]">
                Загружаем таймеры…
              </div>
            ) : (
              <div className="divide-y divide-[#edf1ee]">
                {timers.map((timer) => {
                  const running = timer.id === snapshot?.state.activeTimerId
                  return (
                    <button
                      key={timer.id}
                      type="button"
                      disabled={commandBusy}
                      onClick={() => void runTimerCommand(timer)}
                      className="grid w-full grid-cols-[2.25rem_minmax(0,1fr)_2rem] items-center gap-2.5 px-1 py-2.5 text-left transition hover:bg-[#f7f9f6] disabled:opacity-45"
                      aria-label={
                        running
                          ? `Остановить ${timer.name}`
                          : `Запустить ${timer.name}`
                      }
                    >
                      <span
                        className={`relative grid h-9 w-9 place-items-center rounded-full border-2 text-sm font-extrabold ${
                          running ? 'border-white ring-2' : 'border-white'
                        }`}
                        style={{
                          color: 'white',
                          backgroundColor: timer.color,
                          boxShadow: running
                            ? `0 0 0 2px ${timer.color}`
                            : '0 1px 3px rgba(23,35,31,0.12)',
                        }}
                      >
                        {timer.icon}
                      </span>
                      <span className="min-w-0">
                        <strong className="block truncate text-xs text-[#435049]">
                          {timer.name}
                        </strong>
                        <span className="mt-0.5 block text-[0.66rem] font-semibold tabular-nums text-[#87928c]">
                          {formatDuration(totals[timer.id] ?? 0)}
                        </span>
                      </span>
                      <span
                        className="grid h-8 w-8 place-items-center rounded-full text-white shadow-sm"
                        style={{ backgroundColor: timer.color }}
                      >
                        {running ? (
                          <Pause className="h-3.5 w-3.5" fill="currentColor" />
                        ) : (
                          <Play className="h-3.5 w-3.5" fill="currentColor" />
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="mt-2 border-t border-[#e7ece8] pt-3">
              <p className="mb-2 px-1 text-[0.58rem] font-extrabold uppercase tracking-[0.12em] text-[#819089]">
                Разовые метки
              </p>
              <TimerEventButtons
                compact={false}
                busy={eventBusy}
                lastRecorded={lastRecordedEvent}
                onRecord={(kind) => void markTimerEvent(kind)}
              />
            </div>
          </section>
        )}

        <section className={`${panelClass} min-w-0 overflow-hidden p-4 sm:p-5`}>
          <div className="flex items-center justify-between gap-3 border-b border-[#e7ece8] pb-3">
            <div>
              <p className="mb-1 text-[0.6rem] font-extrabold uppercase tracking-[0.14em] text-[#819089]">
                Хронология
              </p>
              <h3 className="font-extrabold tracking-[-0.03em] text-[#26332d]">
                {period === 'day' ? 'Интервалы дня' : 'Интервалы недели'}
              </h3>
            </div>
            <span
              className={`grid h-8 min-w-8 place-items-center rounded-xl px-2 text-xs font-extrabold ${
                isMobile
                  ? 'bg-[#ebe8ff] text-[#6d5dfc]'
                  : 'bg-blue-50 text-blue-700'
              }`}
            >
              {timeline.length +
                dayViews.reduce((sum, day) => sum + day.events.length, 0)}
            </span>
          </div>

          {!isMobile ? (
            <DesktopHorizontalTimelines
              days={dayViews}
              timers={timers}
              period={period}
            />
          ) : period === 'day' ? (
            <div className="pt-4">
              <DurationTimelineChart
                segments={dayViews[0]?.segments ?? []}
                events={dayViews[0]?.events ?? []}
                timers={timers}
              />
            </div>
          ) : (
            <div className="pt-4">
              <MobileWeekTimeline
                days={dayViews}
                timers={timers}
                startHour={weekScale.startHour}
                endHour={weekScale.endHour}
              />
            </div>
          )}
        </section>
      </div>

      {isMobile && (
        <div className="fixed inset-x-0 bottom-0 z-[100] px-3 pb-[max(0.55rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-md">
            <div className="mb-2 flex items-center gap-2">
              <div className="inline-flex h-11 shrink-0 items-center rounded-2xl border border-[#d8e0db] bg-white p-1 shadow-[0_6px_24px_rgba(23,35,31,0.14)]">
                {(['day', 'week'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPeriod(value)}
                    className={`h-9 min-w-[4.75rem] rounded-xl px-3 text-xs font-bold transition ${
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
              <TimerEventButtons
                compact
                busy={eventBusy}
                lastRecorded={lastRecordedEvent}
                onRecord={(kind) => void markTimerEvent(kind)}
              />
            </div>
            <div className="rounded-[1.7rem] bg-[#17231f] px-2 py-2.5 shadow-[0_-8px_32px_rgba(23,35,31,0.22)]">
              <div className="flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {timers.map((timer) => {
                  const running = snapshot?.state.activeTimerId === timer.id
                  return (
                    <button
                      key={timer.id}
                      type="button"
                      disabled={commandBusy}
                      onClick={() => void runTimerCommand(timer)}
                      className="flex min-w-[3.75rem] flex-1 shrink-0 flex-col items-center gap-1 rounded-2xl py-1 text-white/75 outline-none transition active:scale-95 disabled:opacity-45"
                      aria-label={
                        running
                          ? `Остановить ${timer.name}`
                          : `Запустить ${timer.name}`
                      }
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
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
