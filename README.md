# Habit Calendar Telegram Bot Integrations

Этот файл кратко описывает 3 ключевых подключения в проекте:

1. Telegram (`telegraf`)
2. Supabase (`@supabase/supabase-js`)
3. LLM через OpenRouter (`fetch` в Chat Completions API)

Основной файл интеграций: `scripts/telegram-bot.mjs`.

## 1) Telegram integration

### ENV

- `TELEGRAM_BOT_TOKEN`

### Базовое подключение

```js
import { Markup, Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment");
  process.exit(1);
}

const bot = new Telegraf(token);
```

### Запуск

- Локально: `npm run bot:dev`
- На сервере/Railway: `npm run bot:start`

## 2) Supabase integration

### ENV

- `SUPABASE_URL` или `VITE_SUPABASE_URL`
- `SUPABASE_ANON_KEY` или `VITE_SUPABASE_ANON_KEY`

### Базовое подключение

```js
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Missing SUPABASE_URL/SUPABASE_ANON_KEY (or VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY) in environment"
  );
  process.exit(1);
}
```

### Создание клиентской сессии пользователя

```js
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
```

## 3) LLM integration (OpenRouter)

### ENV

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `OPENROUTER_API_URL` (по умолчанию: `https://openrouter.ai/api/v1/chat/completions`)
- `LLM_TONE`

### Базовое подключение

```js
const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? "";
const openRouterModel =
  process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-8b-instruct:free";
const openRouterApiUrl =
  process.env.OPENROUTER_API_URL ??
  "https://openrouter.ai/api/v1/chat/completions";
const llmTone = process.env.LLM_TONE ?? "мягкий";
```

### Вызов OpenRouter

```js
async function generateAdviceText(stats) {
  if (!openRouterApiKey) {
    return "LLM пока не настроена. Добавь OPENROUTER_API_KEY и перезапусти бота.";
  }

  const prompt = buildAdvicePrompt(stats);
  const body = {
    model: openRouterModel,
    messages: [
      { role: "system", content: "Ты коуч привычек. Ответ всегда на русском языке." },
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
```

## Минимальный `.env`

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_DAILY_EXPORT_TIME=07:00
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openrouter/auto
OPENROUTER_API_URL=https://openrouter.ai/api/v1/chat/completions
LLM_TONE=мягкий
```

## Полезные заметки

- Если LLM недоступна или модель уперлась в лимит (`429`), бот использует fallback-совет.
- Для стабильной работы в проде лучше использовать `OPENROUTER_MODEL=openrouter/auto` или добавить резервные модели.
- Не публикуй реальные токены в репозиторий и в публичные чаты.
