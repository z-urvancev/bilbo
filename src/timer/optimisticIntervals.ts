import type { TimerInterval, TimerSnapshot } from './types'

export function reconcileOptimisticIntervals(
  snapshot: TimerSnapshot,
  optimisticIntervals: Map<number, TimerInterval>,
): TimerSnapshot {
  const serverIds = new Set(snapshot.intervals.map((interval) => interval.id))
  for (const id of serverIds) optimisticIntervals.delete(id)
  if (optimisticIntervals.size === 0) return snapshot

  return {
    ...snapshot,
    intervals: [
      ...snapshot.intervals,
      ...Array.from(optimisticIntervals.values()).filter(
        (interval) => !serverIds.has(interval.id),
      ),
    ],
  }
}
