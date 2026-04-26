import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Markup, Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
const dailyExportTime = process.env.TELEGRAM_DAILY_EXPORT_TIME ?? "";
const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? "";
const openRouterModel =
  process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-8b-instruct:free";
const openRouterApiUrl =
  process.env.OPENROUTER_API_URL ??
  "https://openrouter.ai/api/v1/chat/completions";
const llmTone = process.env.LLM_TONE ?? "мягкий";

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment");
  process.exit(1);
}

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Missing SUPABASE_URL/SUPABASE_ANON_KEY (or VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY) in environment"
  );
  process.exit(1);
}

const bot = new Telegraf(token);
const sessions = new Map();
const pendingLogins = new Map();
const lastDailyExportByChat = new Map();
const menuAliases = {
  checklist: "✅ Чек-лист",
  habits: "📋 Мои привычки",
  dailyExport: "📤 Выгрузка дня",
  advice: "🧠 Персональный совет",
  month: "📈 Итоги за 30 дней",
  help: "❓ Помощь",
};
const mainMenuButtons = [
  [menuAliases.checklist, menuAliases.habits],
  [menuAliases.dailyExport, menuAliases.advice],
  [menuAliases.month, menuAliases.help],
];

function mainMenuKeyboard() {
  return Markup.keyboard(mainMenuButtons).resize();
}

function dateKeyNow() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rollingDayKeysEndingToday(dayCount) {
  const keys = [];
  const base = new Date();
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    keys.push(dateKeyFromDate(d));
  }
  return keys;
}

function formatDayKeyRu(key) {
  const [y, m, d] = key.split("-");
  return `${d}.${m}.${y}`;
}

function countMarkedDays(habitId, completions, dayKeys) {
  const map = completions[habitId];
  if (!map) return 0;
  let n = 0;
  for (const k of dayKeys) if (map[k]) n += 1;
  return n;
}

function buildMonthStatsText(state, dayKeys) {
  const fromKey = dayKeys[0];
  const toKey = dayKeys[dayKeys.length - 1];
  const n = dayKeys.length;
  const habits = state.habits.filter((h) => !h.archived);
  if (habits.length === 0) {
    return `За последние ${n} дней (${formatDayKeyRu(fromKey)} — ${formatDayKeyRu(toKey)}) активных привычек нет.`;
  }
  const good = habits.filter((h) => !h.negative);
  const negative = habits.filter((h) => h.negative);
  const line = (h) => {
    const done = countMarkedDays(h.id, state.completions, dayKeys);
    const pct = n > 0 ? Math.round((done / n) * 100) : 0;
    return `${done}/${n} (${pct}%) — ${h.emoji} ${h.name}`;
  };
  const block = (title, items) => {
    if (items.length === 0) return `${title}\n— в списке пусто`;
    return `${title}\n${items.map((h) => `• ${line(h)}`).join("\n")}`;
  };
  return [
    `Вот как прошли последние ${n} дней.`,
    `Период: ${formatDayKeyRu(fromKey)} — ${formatDayKeyRu(toKey)}.`,
    `Ниже — сколько дней из ${n} ты отметил по каждой привычке.`,
    "",
    block("Хорошие привычки", good),
    "",
    block("Негативные привычки", negative),
    "",
    "Если цифры ниже, чем хочется, начни с одной привычки и маленького шага на этой неделе.",
  ].join("\n");
}

function buildAdviceStats(state, dayKeys) {
  const todayKey = dayKeys[dayKeys.length - 1];
  const habits = state.habits.filter((h) => !habitHidden(h, todayKey));
  const good = habits.filter((h) => !h.negative);
  const negative = habits.filter((h) => h.negative);
  const recentWindow = dayKeys.slice(-7);
  const previousWindow = dayKeys.slice(-14, -7);
  const toStat = (h) => {
    const done = countMarkedDays(h.id, state.completions, dayKeys);
    const missed = Math.max(dayKeys.length - done, 0);
    const recentDone = countMarkedDays(h.id, state.completions, recentWindow);
    const previousDone = countMarkedDays(h.id, state.completions, previousWindow);
    const trend = recentDone - previousDone;
    const pct = dayKeys.length > 0 ? Math.round((done / dayKeys.length) * 100) : 0;
    return { name: h.name, emoji: h.emoji, done, missed, pct, recentDone, previousDone, trend };
  };
  const goodStats = good.map(toStat).sort((a, b) => b.pct - a.pct);
  const negativeStats = negative.map(toStat).sort((a, b) => b.pct - a.pct);
  return {
    periodDays: dayKeys.length,
    fromKey: dayKeys[0],
    toKey: dayKeys[dayKeys.length - 1],
    goodStats,
    negativeStats,
  };
}

function getHabitActionTip(name, negative) {
  const n = name.toLowerCase();
  if (!negative) {
    if (/(чтен|книг)/.test(n)) {
      return "Положи книгу на видное место и зафиксируй 10 минут чтения сразу после ужина.";
    }
    if (/(встав|подъем|просып|сон)/.test(n)) {
      return "Подготовь вечерний ритуал заранее: убери телефон за 30 минут до сна и поставь будильник подальше от кровати.";
    }
    if (/(цифров|телефон|соцсет|экран)/.test(n)) {
      return "Сделай один безэкранный блок на 25 минут и включи режим фокус прямо перед ним.";
    }
    if (/(спорт|трен|бег|ходьб|зарядк)/.test(n)) {
      return "Снизь порог входа: минимум 5 минут движения в одно и то же время каждый день.";
    }
    return "Привяжи привычку к стабильному триггеру дня и начни с минимального шага на 5-10 минут.";
  }
  if (/(энергет|кофе|кофеин)/.test(n)) {
    return "Подготовь замену заранее: вода + короткая прогулка на 5 минут в момент тяги к энергетикам.";
  }
  if (/(сладк|фастфуд|джанк)/.test(n)) {
    return "Убери быстрый доступ к триггеру и подготовь более безопасный перекус заранее.";
  }
  if (/(курен|сигар|вейп|никотин)/.test(n)) {
    return "В момент триггера делай паузу 3 минуты и переключайся на заранее выбранное действие-замену.";
  }
  return "Определи главный триггер срыва и заранее подготовь одну конкретную замену этому действию.";
}

function buildAdvicePrompt(stats) {
  const goodLines =
    stats.goodStats.length === 0
      ? "нет"
      : stats.goodStats
          .map(
            (s) =>
              `${s.emoji} ${s.name}: отметки ${s.done}/${stats.periodDays} (${s.pct}%), пропуски ${s.missed}, последние 7 дней ${s.recentDone}, прошлые 7 дней ${s.previousDone}, тренд ${s.trend >= 0 ? "+" : ""}${s.trend}`
          )
          .join("\n");
  const negativeLines =
    stats.negativeStats.length === 0
      ? "нет"
      : stats.negativeStats
          .map(
            (s) =>
              `${s.emoji} ${s.name}: срывы/отметки ${s.done}/${stats.periodDays} (${s.pct}%), дни без срыва ${s.missed}, последние 7 дней ${s.recentDone}, прошлые 7 дней ${s.previousDone}, тренд ${s.trend >= 0 ? "+" : ""}${s.trend}`
          )
          .join("\n");
  return [
    "Ты ассистент по привычкам.",
    `Тон: ${llmTone}.`,
    "Пиши по-русски, коротко и человечно.",
    "Ответ: 5-8 строк, без воды, без морализаторства, без медицинских рекомендаций.",
    "Структура: 1 строка похвалы/поддержки, 1-2 наблюдения, 2-3 конкретных шага на завтра.",
    "Для негативных привычек трактуй более высокий процент как более частые срывы.",
    "Обязательно учитывай и отмеченные дни, и пропуски, и тренд последних 7 дней против предыдущих 7 дней.",
    "Пропуски считаются только внутри этого периода до сегодняшнего дня.",
    "Дай персональные советы по названиям привычек, а не общие фразы.",
    `Период: ${formatDayKeyRu(stats.fromKey)} - ${formatDayKeyRu(stats.toKey)} (${stats.periodDays} дней).`,
    "Хорошие привычки:",
    goodLines,
    "Негативные привычки:",
    negativeLines,
  ].join("\n");
}

async function generateAdviceText(stats) {
  if (!openRouterApiKey) {
    return "LLM пока не настроена. Добавь OPENROUTER_API_KEY и перезапусти бота.";
  }
  const prompt = buildAdvicePrompt(stats);
  const body = {
    model: openRouterModel,
    messages: [
      {
        role: "system",
        content: "Ты коуч привычек. Ответ всегда на русском языке.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
  };
  const response = await fetch(openRouterApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${text}`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned empty response");
  return text;
}

function buildAdviceFallback(stats) {
  const periodDays = stats.periodDays;
  const bestGood = stats.goodStats[0];
  const worstGood = stats.goodStats[stats.goodStats.length - 1];
  const worstNegative = stats.negativeStats[0];
  const lines = [];
  lines.push(
    `За ${periodDays} дней до сегодняшнего дня у тебя уже есть движение вперед, это важно.`
  );
  if (bestGood) {
    lines.push(
      `Сильная сторона: ${bestGood.emoji} ${bestGood.name} — ${bestGood.done}/${periodDays} (${bestGood.pct}%), пропуски ${bestGood.missed}.`
    );
  }
  if (worstGood) {
    lines.push(
      `Зона роста: ${worstGood.emoji} ${worstGood.name} — ${worstGood.done}/${periodDays} (${worstGood.pct}%), пропуски ${worstGood.missed}.`
    );
  }
  if (worstNegative) {
    lines.push(
      `Обрати внимание: ${worstNegative.emoji} ${worstNegative.name} — срывы ${worstNegative.done}/${periodDays} (${worstNegative.pct}%), без срывов ${worstNegative.missed}.`
    );
  }
  if (worstGood) {
    lines.push(
      `По привычке «${worstGood.name}»: ${getHabitActionTip(worstGood.name, false)}`
    );
  }
  if (worstNegative) {
    lines.push(
      `По привычке «${worstNegative.name}»: ${getHabitActionTip(
        worstNegative.name,
        true
      )}`
    );
  }
  if (!worstGood && !worstNegative) {
    lines.push("Выбери одну привычку и закрепи конкретный минимальный шаг на завтра.");
  }
  return lines.join("\n");
}

async function replyLong(ctx, text) {
  const max = 3900;
  for (let i = 0; i < text.length; i += max) {
    await ctx.reply(text.slice(i, i + max));
  }
}

async function sendLongMessageToChat(chatId, text) {
  const max = 3900;
  for (let i = 0; i < text.length; i += max) {
    await bot.telegram.sendMessage(chatId, text.slice(i, i + max));
  }
}

async function createUserClient(session) {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  await client.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  return client;
}

function cloneCompletions(c) {
  const o = {};
  for (const k of Object.keys(c)) o[k] = { ...c[k] };
  return o;
}

function applyEvent(state, event) {
  switch (event.kind) {
    case "state_snapshot": {
      const p = event.payload;
      return {
        habits: p.habits.map((h) => ({ ...h })),
        completions: cloneCompletions(p.completions),
      };
    }
    case "habit_upsert": {
      const h = { ...event.payload };
      const i = state.habits.findIndex((x) => x.id === h.id);
      const habits =
        i >= 0
          ? state.habits.map((x) => (x.id === h.id ? h : x))
          : [...state.habits, h];
      return { ...state, habits };
    }
    case "habit_delete": {
      const habits = state.habits.filter((x) => x.id !== event.payload.id);
      const completions = { ...state.completions };
      delete completions[event.payload.id];
      return { habits, completions };
    }
    case "mark_set": {
      const { habitId, dayKey, marked } = event.payload;
      const prevMap = state.completions[habitId] ?? {};
      const nextMap = { ...prevMap };
      if (marked) nextMap[dayKey] = true;
      else delete nextMap[dayKey];
      return {
        ...state,
        completions: { ...state.completions, [habitId]: nextMap },
      };
    }
    default:
      return state;
  }
}

function habitHidden(habit, todayKey) {
  if (habit.postponedUntil && todayKey < habit.postponedUntil) return true;
  if (habit.deadline && todayKey > habit.deadline) return true;
  if (habit.archived) return true;
  return false;
}

function formatHabitsList(state, dayKey) {
  const visible = state.habits.filter((h) => !habitHidden(h, dayKey));
  if (visible.length === 0) return "У тебя нет активных привычек.";
  return visible
    .map((h) => {
      const marked = Boolean(state.completions[h.id]?.[dayKey]);
      return `${marked ? "✅" : "⬜️"} ${h.emoji} ${h.name}`;
    })
    .join("\n");
}

function buildChecklistKeyboard(state, dayKey) {
  const visible = state.habits.filter((h) => !habitHidden(h, dayKey));
  const rows = visible.map((h) => {
    const marked = Boolean(state.completions[h.id]?.[dayKey]);
    return [
      Markup.button.callback(
        `${marked ? "✅" : "⬜️"} ${h.emoji} ${h.name}`,
        `toggle:${h.id}`
      ),
    ];
  });
  return Markup.inlineKeyboard(rows);
}

function buildDailyExportText(state, dayKey) {
  const visible = state.habits.filter((h) => !habitHidden(h, dayKey));
  if (visible.length === 0) {
    return `Ежедневная выгрузка за ${dayKey}\nСегодня активных привычек нет, можно выдохнуть и настроить план на завтра.`;
  }

  const good = visible.filter((h) => !h.negative);
  const negative = visible.filter((h) => h.negative);

  const countDone = (items) =>
    items.reduce(
      (sum, h) => sum + (state.completions[h.id]?.[dayKey] ? 1 : 0),
      0
    );

  const formatGroup = (title, emptyText, items) => {
    if (items.length === 0) return `${title}\n${emptyText}`;
    const lines = items.map((h) => {
      const marked = Boolean(state.completions[h.id]?.[dayKey]);
      return `${marked ? "✅" : "⬜️"} ${h.emoji} ${h.name}`;
    });
    return `${title}\n${lines.join("\n")}`;
  };

  const doneAll = countDone(visible);
  const doneGood = countDone(good);
  const doneNegative = countDone(negative);

  return [
    `Ежедневная выгрузка за ${dayKey}`,
    `Ты в процессе, и это уже круто.`,
    `Прогресс за сегодня: ${doneAll}/${visible.length}`,
    `Хорошие привычки: ${doneGood}/${good.length}`,
    `Негативные привычки под контролем: ${doneNegative}/${negative.length}`,
    "",
    formatGroup(
      "Не забудь выполнить это:",
      "Сегодня здесь пусто — можно добавить новую полезную привычку.",
      good
    ),
    "",
    formatGroup(
      "Обрати внимание и не срывайся на:",
      "Отлично, негативных привычек в списке нет.",
      negative
    ),
    "",
    doneAll === visible.length
      ? "Отличный день, ты закрыл все пункты."
      : "Маленький шаг сейчас сильно поможет тебе завтра.",
  ].join("\n");
}

async function loadState(client, userId) {
  let after = 0;
  let state = { habits: [], completions: {} };
  while (true) {
    const { data, error } = await client
      .from("sync_events")
      .select("seq,kind,payload")
      .eq("user_id", userId)
      .gt("seq", after)
      .order("seq", { ascending: true })
      .limit(800);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      state = applyEvent(state, { kind: row.kind, payload: row.payload });
      after = row.seq;
    }
  }
  return state;
}

async function pushMarkEvent(client, userId, habitId, dayKey, marked) {
  const row = {
    user_id: userId,
    client_event_id: `tg-${randomUUID()}`,
    kind: "mark_set",
    payload: { habitId, dayKey, marked },
  };
  const { error } = await client.from("sync_events").insert([row]);
  if (error) throw error;
}

async function withAuth(ctx, fn) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = sessions.get(chatId);
  if (!session) {
    await ctx.reply(
      "Сначала войди: /login\nМожно сразу так: /login email@example.com password"
    );
    return;
  }
  const client = await createUserClient(session);
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) {
    sessions.delete(chatId);
    await ctx.reply("Сессия истекла. Войди заново: /login");
    return;
  }
  await fn({ client, user: data.user, dayKey: dateKeyNow() });
}

async function sendChecklist(ctx, client, user, dayKey) {
  const state = await loadState(client, user.id);
  const keyboard = buildChecklistKeyboard(state, dayKey);
  if (keyboard.reply_markup.inline_keyboard.length === 0) {
    await ctx.reply("Активных привычек нет.");
    return;
  }
  await ctx.reply(
    `Чек-лист на ${dayKey}\nНажми на привычку, чтобы переключить отметку.`,
    keyboard
  );
}

async function sendDailyExport(ctx, client, user, dayKey) {
  const state = await loadState(client, user.id);
  const exportText = buildDailyExportText(state, dayKey);
  const dayKeys = rollingDayKeysEndingToday(30);
  const stats = buildAdviceStats(state, dayKeys);
  if (stats.goodStats.length === 0 && stats.negativeStats.length === 0) {
    await ctx.reply(exportText, mainMenuKeyboard());
    return;
  }
  let adviceText = "";
  try {
    adviceText = await generateAdviceText(stats);
  } catch (error) {
    console.error("Advice generation error:", error);
    adviceText = buildAdviceFallback(stats);
  }
  await replyLong(ctx, `${exportText}\n\nПерсональный совет:\n${adviceText}`);
}

async function sendDailyExportToChat(chatId, client, user, dayKey) {
  const state = await loadState(client, user.id);
  const exportText = buildDailyExportText(state, dayKey);
  const dayKeys = rollingDayKeysEndingToday(30);
  const stats = buildAdviceStats(state, dayKeys);
  if (stats.goodStats.length === 0 && stats.negativeStats.length === 0) {
    await bot.telegram.sendMessage(chatId, exportText);
    return;
  }
  let adviceText = "";
  try {
    adviceText = await generateAdviceText(stats);
  } catch (error) {
    console.error("Advice generation error:", error);
    adviceText = buildAdviceFallback(stats);
  }
  await sendLongMessageToChat(
    chatId,
    `${exportText}\n\nПерсональный совет:\n${adviceText}`
  );
}

bot.start((ctx) => {
  const firstName = ctx.from?.first_name ?? "друг";
  return ctx.reply(
    `Привет, ${firstName}! Я бот трекера привычек.

Команды:
/login — вход по email и паролю
/logout — выйти из аккаунта
/habits — посмотреть привычки на сегодня
/checklist — кнопки для отметок
/daily_export — ежедневная выгрузка за сегодня
/month — выполнение за последние 30 дней
/advice — персональная рекомендация от LLM

Сайт: https://z-urvancev.github.io/bilbo/`,
    mainMenuKeyboard()
  );
});

bot.help((ctx) => {
  return ctx.reply(
    "Команды:\n/start\n/help\n/login\n/logout\n/habits\n/checklist\n/daily_export\n/month\n/advice\n\nСайт: https://z-urvancev.github.io/bilbo/",
    mainMenuKeyboard()
  );
});

bot.command("login", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    const email = parts[1];
    const password = parts.slice(2).join(" ");
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) {
      await ctx.reply("Не удалось войти. Проверь email/пароль.");
      return;
    }
    sessions.set(chatId, {
      userId: data.user.id,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      email,
    });
    pendingLogins.delete(chatId);
    await ctx.reply(`Вход выполнен: ${email}`, mainMenuKeyboard());
    return;
  }
  pendingLogins.set(chatId, { step: "email" });
  await ctx.reply("Введи email отдельным сообщением.", mainMenuKeyboard());
});

bot.command("logout", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  sessions.delete(chatId);
  pendingLogins.delete(chatId);
  await ctx.reply("Ты вышел из аккаунта.", mainMenuKeyboard());
});

async function handleHabits(ctx) {
  await withAuth(ctx, async ({ client, user, dayKey }) => {
    const state = await loadState(client, user.id);
    await ctx.reply(`Твои привычки на ${dayKey}\n\n${formatHabitsList(state, dayKey)}`);
  });
}

async function handleChecklist(ctx) {
  await withAuth(ctx, async ({ client, user, dayKey }) => {
    await sendChecklist(ctx, client, user, dayKey);
  });
}

async function handleDailyExport(ctx) {
  await withAuth(ctx, async ({ client, user, dayKey }) => {
    await sendDailyExport(ctx, client, user, dayKey);
  });
}

async function handleMonth(ctx) {
  await withAuth(ctx, async ({ client, user }) => {
    const state = await loadState(client, user.id);
    const dayKeys = rollingDayKeysEndingToday(30);
    await replyLong(ctx, buildMonthStatsText(state, dayKeys));
  });
}

async function handleAdvice(ctx) {
  await withAuth(ctx, async ({ client, user }) => {
    const state = await loadState(client, user.id);
    const dayKeys = rollingDayKeysEndingToday(30);
    const stats = buildAdviceStats(state, dayKeys);
    if (stats.goodStats.length === 0 && stats.negativeStats.length === 0) {
      await ctx.reply("Пока нет активных привычек для анализа. Добавь хотя бы одну в приложении.");
      return;
    }
    try {
      const text = await generateAdviceText(stats);
      await replyLong(ctx, text);
    } catch (error) {
      console.error("Advice generation error:", error);
      await replyLong(ctx, buildAdviceFallback(stats));
    }
  });
}

bot.command("habits", handleHabits);
bot.command("checklist", handleChecklist);
bot.command("daily_export", handleDailyExport);
bot.command("month", handleMonth);
bot.command("advice", handleAdvice);

bot.hears(menuAliases.habits, handleHabits);
bot.hears(menuAliases.checklist, handleChecklist);
bot.hears(menuAliases.dailyExport, handleDailyExport);
bot.hears(menuAliases.month, handleMonth);
bot.hears(menuAliases.advice, handleAdvice);
bot.hears(menuAliases.help, (ctx) =>
  ctx.reply(
    "Команды:\n/start\n/help\n/login\n/logout\n/habits\n/checklist\n/daily_export\n/month\n/advice",
    mainMenuKeyboard()
  )
);

bot.on("text", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const flow = pendingLogins.get(chatId);
  if (!flow) return;
  const value = (ctx.message?.text ?? "").trim();
  if (!value) return;
  if (flow.step === "email") {
    pendingLogins.set(chatId, { step: "password", email: value });
    await ctx.reply("Теперь введи пароль отдельным сообщением.");
    return;
  }
  if (flow.step === "password" && flow.email) {
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithPassword({
      email: flow.email,
      password: value,
    });
    if (error || !data.session || !data.user) {
      pendingLogins.delete(chatId);
      await ctx.reply("Не удалось войти. Запусти снова: /login");
      return;
    }
    sessions.set(chatId, {
      userId: data.user.id,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      email: flow.email,
    });
    pendingLogins.delete(chatId);
    await ctx.reply(`Вход выполнен: ${flow.email}`, mainMenuKeyboard());
  }
});

bot.action(/^toggle:(.+)$/, async (ctx) => {
  await withAuth(ctx, async ({ client, user, dayKey }) => {
    const habitId = ctx.match[1];
    const state = await loadState(client, user.id);
    const exists = state.habits.some((h) => h.id === habitId);
    if (!exists) {
      await ctx.answerCbQuery("Привычка не найдена");
      return;
    }
    const current = Boolean(state.completions[habitId]?.[dayKey]);
    await pushMarkEvent(client, user.id, habitId, dayKey, !current);
    const nextState = await loadState(client, user.id);
    const keyboard = buildChecklistKeyboard(nextState, dayKey);
    await ctx.editMessageReplyMarkup(keyboard.reply_markup);
    await ctx.answerCbQuery(!current ? "Отмечено" : "Снято");
  });
});

function dailyExportScheduleEnabled() {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyExportTime);
}

if (dailyExportScheduleEnabled()) {
  setInterval(async () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    if (`${hh}:${mm}` !== dailyExportTime) return;
    const today = dateKeyNow();
    for (const [chatId, session] of sessions.entries()) {
      if (lastDailyExportByChat.get(chatId) === today) continue;
      try {
        const client = await createUserClient(session);
        const { data } = await client.auth.getUser();
        if (!data?.user) continue;
        await sendDailyExportToChat(chatId, client, data.user, today);
        lastDailyExportByChat.set(chatId, today);
      } catch (error) {
        console.error("Daily export error:", error);
      }
    }
  }, 30_000);
}

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

bot
  .launch()
  .then(async () => {
    await bot.telegram.setMyDescription(
      "Бот календаря привычек: отметки, выгрузки и персональные советы.\nСайт: https://z-urvancev.github.io/bilbo/"
    );
    await bot.telegram.setMyShortDescription("Календарь привычек + советы LLM");
    console.log("Telegram bot started in long polling mode");
  })
  .catch((error) => {
    console.error("Telegram bot launch error:", error);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
