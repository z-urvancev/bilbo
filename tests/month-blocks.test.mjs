import assert from 'node:assert/strict'
import test from 'node:test'

import { MONTH_BLOCKS, monthBlockForDay, monthBlockRange } from '../src/goals/monthBlocks.ts'

test('month blocks cover each day exactly once and differ by at most one day', () => {
  for (const [year, month, days] of [
    [2025, 2, 28],
    [2024, 2, 29],
    [2026, 4, 30],
    [2026, 1, 31],
  ]) {
    const ranges = MONTH_BLOCKS.map((block) => monthBlockRange(year, month, block))
    assert.equal(ranges[0].start, 1)
    assert.equal(ranges[3].end, days)
    for (let index = 1; index < ranges.length; index += 1) {
      assert.equal(ranges[index].start, ranges[index - 1].end + 1)
    }
    const lengths = ranges.map(({ start, end }) => end - start + 1)
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1)
    for (let day = 1; day <= days; day += 1) {
      const block = monthBlockForDay(year, month, day)
      const range = monthBlockRange(year, month, block)
      assert.ok(day >= range.start && day <= range.end)
    }
  }
})
