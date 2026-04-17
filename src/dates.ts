export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

export function dateKey(y: number, m0: number, d: number): string {
  return `${y}-${pad2(m0 + 1)}-${pad2(d)}`
}

export function parseKey(key: string): { y: number; m0: number; d: number } {
  const [ys, ms, ds] = key.split('-')
  return { y: +ys, m0: +ms - 1, d: +ds }
}

export function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate()
}

export function monthLabel(y: number, m0: number, locale = 'ru-RU'): string {
  return new Date(y, m0, 1).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
  })
}

const WD_SHORT_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const

export function weekdayShortRu(y: number, m0: number, day: number): string {
  const dt = new Date(y, m0, day)
  const mon0 = (dt.getDay() + 6) % 7
  return WD_SHORT_RU[mon0]!
}

export function weekdayMon0(d: Date): number {
  const wd = d.getDay()
  return wd === 0 ? 6 : wd - 1
}

export function isoWeekNumber(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((+t - +yStart) / 86400000 + 1) / 7)
}
