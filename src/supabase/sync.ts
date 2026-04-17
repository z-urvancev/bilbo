import type { Completions, Habit, Persisted } from '../types'
import { supabase } from '../lib/supabase'

type DbHabitRow = {
  id: string
  user_id: string
  name: string
  emoji: string
  negative: boolean
  monthly_goal: number
}

type DbMarkRow = {
  habit_id: string
  user_id: string
  day: string
}

function habitFromRow(r: DbHabitRow): Habit {
  return {
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    negative: r.negative,
    monthlyGoal: r.monthly_goal,
  }
}

function completionsFromMarks(rows: DbMarkRow[]): Completions {
  const c: Completions = {}
  for (const row of rows) {
    if (!c[row.habit_id]) c[row.habit_id] = {}
    c[row.habit_id]![row.day] = true
  }
  return c
}

export async function pullFromSupabase(userId: string): Promise<Persisted | null> {
  if (!supabase) return null
  const { data: hRows, error: e1 } = await supabase
    .from('habits')
    .select('id, user_id, name, emoji, negative, monthly_goal')
    .eq('user_id', userId)
  if (e1) throw e1
  const { data: mRows, error: e2 } = await supabase
    .from('habit_marks')
    .select('habit_id, user_id, day')
    .eq('user_id', userId)
  if (e2) throw e2
  const habits = (hRows as DbHabitRow[]).map(habitFromRow)
  const completions = completionsFromMarks((mRows ?? []) as DbMarkRow[])
  return { habits, completions }
}

export async function pushToSupabase(
  userId: string,
  habits: Habit[],
  completions: Completions,
): Promise<void> {
  if (!supabase) return
  const localIds = habits.map((h) => h.id)
  const { data: remoteHabits, error: e0 } = await supabase
    .from('habits')
    .select('id')
    .eq('user_id', userId)
  if (e0) throw e0
  const toRemove = (remoteHabits ?? [])
    .map((r: { id: string }) => r.id)
    .filter((id: string) => !localIds.includes(id))
  if (toRemove.length) {
    const { error: eDel } = await supabase.from('habits').delete().in('id', toRemove)
    if (eDel) throw eDel
  }
  if (habits.length) {
    const rows = habits.map((h) => ({
      id: h.id,
      user_id: userId,
      name: h.name,
      emoji: h.emoji,
      negative: h.negative,
      monthly_goal: h.monthlyGoal,
      updated_at: new Date().toISOString(),
    }))
    const { error: eUp } = await supabase.from('habits').upsert(rows, {
      onConflict: 'id',
    })
    if (eUp) throw eUp
  }
  const { data: existingMarks, error: e1 } = await supabase
    .from('habit_marks')
    .select('habit_id, day')
    .eq('user_id', userId)
  if (e1) throw e1
  const desired = new Set<string>()
  for (const h of habits) {
    const m = completions[h.id]
    if (!m) continue
    for (const day of Object.keys(m)) {
      if (m[day]) desired.add(`${h.id}|${day}`)
    }
  }
  const existing = new Set(
    (existingMarks as { habit_id: string; day: string }[]).map(
      (r) => `${r.habit_id}|${r.day}`,
    ),
  )
  const toDelete: { habit_id: string; day: string }[] = []
  for (const key of existing) {
    if (!desired.has(key)) {
      const [habit_id, day] = key.split('|')
      if (habit_id && day) toDelete.push({ habit_id, day })
    }
  }
  const toInsert: { habit_id: string; user_id: string; day: string }[] = []
  for (const key of desired) {
    if (!existing.has(key)) {
      const [habit_id, day] = key.split('|')
      if (habit_id && day)
        toInsert.push({ habit_id, user_id: userId, day })
    }
  }
  for (const row of toDelete) {
    const { error: ed } = await supabase
      .from('habit_marks')
      .delete()
      .eq('habit_id', row.habit_id)
      .eq('day', row.day)
      .eq('user_id', userId)
    if (ed) throw ed
  }
  if (toInsert.length) {
    const { error: ei } = await supabase.from('habit_marks').insert(toInsert)
    if (ei) throw ei
  }
}
