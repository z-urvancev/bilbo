import type { Completions, Habit, Persisted } from './types'

export const DATA_FILE = 'habit-calendar-data.json'

export type PersistedBundleFull = {
  format: 'habit-calendar-export'
  version: 1
  savedAt: string
  habits: Habit[]
  completions: Completions
}

export type PersistedBundleHabitsOnly = {
  format: 'habit-calendar-export'
  version: 1
  savedAt: string
  habits: Habit[]
  habitsOnly: true
}

export type PersistedBundle = PersistedBundleFull | PersistedBundleHabitsOnly

export function toBundle(
  data: Persisted,
  includeProgress: boolean,
): PersistedBundle {
  const base = {
    format: 'habit-calendar-export' as const,
    version: 1 as const,
    savedAt: new Date().toISOString(),
    habits: data.habits,
  }
  if (!includeProgress) {
    return { ...base, habitsOnly: true }
  }
  return { ...base, completions: data.completions }
}

export function mergeCompletionsForImportedHabits(
  newHabits: Habit[],
  prev: Completions,
): Completions {
  const ids = new Set(newHabits.map((h) => h.id))
  const next: Completions = {}
  for (const id of ids) {
    if (prev[id]) next[id] = { ...prev[id] }
  }
  return next
}

const STORE = 'kv'
const DB_NAME = 'habit-calendar-db'
const KEY_DIR = 'dirHandle'

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore(STORE)
    }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

export async function idbSetDirHandle(h: FileSystemDirectoryHandle) {
  const db = await openDb()
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(h, KEY_DIR)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

export async function idbGetDirHandle(): Promise<
  FileSystemDirectoryHandle | undefined
> {
  const db = await openDb()
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly')
    const q = tx.objectStore(STORE).get(KEY_DIR)
    q.onsuccess = () =>
      res(q.result as FileSystemDirectoryHandle | undefined)
    q.onerror = () => rej(q.error)
  })
}

export async function idbClearDirHandle() {
  const db = await openDb()
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(KEY_DIR)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

export async function writeBundleToDirectory(
  dir: FileSystemDirectoryHandle,
  data: Persisted,
) {
  const fh = await dir.getFileHandle(DATA_FILE, { create: true })
  const w = await fh.createWritable()
  await w.write(JSON.stringify(toBundle(data, true), null, 2))
  await w.close()
}

export async function readBundleFromDirectory(
  dir: FileSystemDirectoryHandle,
): Promise<Persisted | null> {
  try {
    const fh = await dir.getFileHandle(DATA_FILE)
    const file = await fh.getFile()
    const text = await file.text()
    const parsed = parseBundleJson(text)
    if (!parsed) return null
    if (parsed.kind === 'full') return parsed.data
    return {
      habits: parsed.habits,
      completions: {},
    }
  } catch {
    return null
  }
}

export function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const w = window as unknown as {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  }
  if (!w.showDirectoryPicker) return Promise.resolve(null)
  return w.showDirectoryPicker()
}

export function downloadJsonFile(
  data: Persisted,
  includeProgress: boolean,
) {
  const bundle = toBundle(data, includeProgress)
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  const url = URL.createObjectURL(blob)
  a.href = url
  a.download = includeProgress
    ? DATA_FILE
    : 'habit-calendar-habits.json'
  a.click()
  URL.revokeObjectURL(url)
}

export type ParsedBundle =
  | { kind: 'full'; data: Persisted }
  | { kind: 'habits'; habits: Habit[] }

export function parseBundleJson(text: string): ParsedBundle | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    if (j.format !== 'habit-calendar-export' || !Array.isArray(j.habits))
      return null
    if (j.habitsOnly === true) {
      return { kind: 'habits', habits: j.habits as Habit[] }
    }
    if (j.completions && typeof j.completions === 'object') {
      return {
        kind: 'full',
        data: {
          habits: j.habits as Habit[],
          completions: j.completions as Completions,
        },
      }
    }
    return { kind: 'habits', habits: j.habits as Habit[] }
  } catch {
    return null
  }
}
