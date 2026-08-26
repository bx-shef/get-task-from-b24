# get-task-from-b24

> Last reviewed: 2026-08-26

Мелочь, которая принимает вебхуки о создании задач в одном Битрикс24 и заводит
такую же задачу в другом Битрикс24.

> **Статус:** 🧪 код собран и под тестами; между настоящими порталами не гонялся. Срез —
> [`docs/project-map.md`](docs/project-map.md), что и как переносим —
> [`docs/PROCESSING.md`](docs/PROCESSING.md), процесс разработки —
> [`docs/PROCESS.md`](docs/PROCESS.md).
> ⬜ Помеченное так — ещё не решено; открытые вопросы собраны в конце `PROCESSING.md`.

## Что это

Сетевой обработчик: клиент ставит у себя локальное приложение Битрикс24 «только API»,
оно шлёт нам событие о создании задачи; мы проверяем критерии и заводим задачу в нашем
Битрикс24, а в Telegram уходит сигнал «задача создана — иди делай».

```
Портал клиента (20–30 шт.) ──ONTASKADD──▶ наш обработчик ──▶ очередь ──▶ наш Б24 (вебхук)
                                                                  │
                                                                  └──▶ Telegram
```

**Критерии переноса** (оба обязательны): название задачи начинается с `#support`
и исполнитель — «особый» сотрудник, id которого указан рядом с доменом клиента в
переменных окружения.

**Переносим:** название · содержание · кто поставил · крайний срок · какой Б24 ·
ссылку на задачу у клиента. Подробности и разбор полей — [`docs/PROCESSING.md`](docs/PROCESSING.md).

## Быстрый старт

```bash
corepack enable && pnpm install

cp .env.example .env
# заполнить в .env ключ шифрования токенов (openssl rand -hex 32) и хотя бы один
# портал клиента в B24_PORTAL_01

docker compose up -d db redis   # локальные Postgres и Redis
pnpm dev                        # http://localhost:3000
```

Проверка: `curl localhost:3000/health` → `{"status":"ok","checks":{"db":true,"redis":true}}`
(`degraded` = не отвечает база или Redis; ⚠ мёртвый Redis особенно опасен — сервис
принимает события и теряет их).

## Требования

- **Node.js 22 LTS** и **pnpm** (через corepack, версия закреплена в `packageManager`)
- **Docker** — для локальных Postgres и Redis

## Документация

| Документ | О чём |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | карта модулей и конвенции (основной справочник) |
| [`docs/README.md`](docs/README.md) | индекс всех документов |
| [`docs/project-map.md`](docs/project-map.md) | карта разработки: цель, шаги, что сделано / сейчас / дальше |
| [`docs/PROCESS.md`](docs/PROCESS.md) | процесс: ветка → 5 проверяющих → PR → зелёный CI → мерж |
| [`docs/PROCESSING.md`](docs/PROCESSING.md) | критерии отбора, перенос полей, очередь, Telegram, ошибки |
| [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md) | контракт события `ONTASKADD` и учёт REST-методов |
| [`docs/CLIENT_APP.md`](docs/CLIENT_APP.md) | что заводит у себя клиент (локальное приложение «только API») |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | деплой (GHCR + Watchtower за общим nginx-proxy) |
| [`docs/IDEAS.md`](docs/IDEAS.md) | пожелания на будущее — делаем только по спросу |

## Разработка

- **В `main` не пушим — только через Pull Request с зелёным CI.** Настройка защиты
  `main` — в [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- Каждый PR проходит **панель из 5 проверяющих**, замечания устраняются до мержа —
  [`docs/PROCESS.md`](docs/PROCESS.md).
- Перед пушем — зелёный `pnpm check` (линт + типы + тесты); это же гоняет CI.
  ⚠ `pnpm check` **требует поднятую базу** (`docker compose up -d db redis`): часть тестов
  контрактные и проверяют поведение Postgres, а не заглушки.
- Инструкции для AI-агентов и карта модулей — в [`CLAUDE.md`](./CLAUDE.md).

## Лицензия

[MIT](./LICENSE)
