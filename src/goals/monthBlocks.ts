export const MONTH_BLOCKS = [1, 2, 3, 4] as const

export function monthBlockRange(year: number, month: number, block: number) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('Invalid month')
  }
  if (!Number.isInteger(block) || block < 1 || block > 4) {
    throw new RangeError('Invalid month block')
  }

  const daysInMonth = new Date(year, month, 0).getDate()
  return {
    start: Math.round(((block - 1) * daysInMonth) / 4) + 1,
    end: Math.round((block * daysInMonth) / 4),
  }
}

export function monthBlockForDay(year: number, month: number, day: number) {
  return MONTH_BLOCKS.find((block) => day <= monthBlockRange(year, month, block).end) ?? 4
}
