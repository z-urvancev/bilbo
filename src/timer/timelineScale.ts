export type TimelineSegmentBounds = {
  startMinute: number
  endMinute: number
}

export type TimelinePoint = {
  minute: number
}

export type TimelineScale = {
  startHour: number
  endHour: number
}

const DEFAULT_START_HOUR = 8
const DEFAULT_END_HOUR = 20

export function calculateTimelineScale(
  segments: TimelineSegmentBounds[],
  points: TimelinePoint[],
): TimelineScale {
  let startHour = DEFAULT_START_HOUR
  let endHour = DEFAULT_END_HOUR

  for (const segment of segments) {
    startHour = Math.min(startHour, Math.floor(segment.startMinute / 60))
    endHour = Math.max(endHour, Math.ceil(segment.endMinute / 60))
  }
  for (const point of points) {
    startHour = Math.min(startHour, Math.floor(point.minute / 60))
    endHour = Math.max(endHour, Math.ceil(point.minute / 60))
  }

  return {
    startHour: Math.max(0, startHour),
    endHour: Math.min(24, endHour),
  }
}

export function timelineTicks({
  startHour,
  endHour,
}: TimelineScale): number[] {
  const range = endHour - startHour
  const step = [1, 2, 3, 4, 6, 8, 12].find(
    (candidate) => Math.ceil(range / candidate) <= 4,
  ) ?? range
  const ticks = [startHour]

  for (let hour = startHour + step; hour < endHour; hour += step) {
    if (endHour - hour < step / 2) break
    ticks.push(hour)
  }
  ticks.push(endHour)
  return ticks
}
