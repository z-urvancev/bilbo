import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateTimelineScale,
  timelineTicks,
} from '../src/timer/timelineScale.ts'

test('timeline defaults to the working-day window', () => {
  assert.deepEqual(calculateTimelineScale([], []), {
    startHour: 8,
    endHour: 20,
  })
})

test('items inside the working-day window do not shrink the scale', () => {
  assert.deepEqual(
    calculateTimelineScale(
      [{ startMinute: 10 * 60 + 15, endMinute: 18 * 60 + 40 }],
      [{ minute: 12 * 60 }],
    ),
    { startHour: 8, endHour: 20 },
  )
})

test('scale expands to whole hours around outlying intervals and points', () => {
  assert.deepEqual(
    calculateTimelineScale(
      [{ startMinute: 7 * 60 + 30, endMinute: 20 * 60 + 1 }],
      [{ minute: 23 * 60 + 10 }],
    ),
    { startHour: 7, endHour: 24 },
  )
})

test('ticks keep the default scale readable', () => {
  assert.deepEqual(timelineTicks({ startHour: 8, endHour: 20 }), [
    8, 11, 14, 17, 20,
  ])
})
