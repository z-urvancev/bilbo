import type { AppSettings, DataSource } from './types'

const SETTINGS_KEY = 'habit-calendar-settings-v1'

export function loadSettings(): AppSettings {
  try {
    const r = localStorage.getItem(SETTINGS_KEY)
    if (r) {
      const j = JSON.parse(r) as Partial<AppSettings>
      let ds = (j.dataSource as DataSource) ?? 'local'
      if ((ds as string) === 'google') ds = 'local'
      return {
        dataSource: ds,
      }
    }
  } catch {
    void 0
  }
  return { dataSource: 'local' }
}

export function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}
