# Единственный интерфейс к боевому серверу. На сервере нет ни репозитория, ни pnpm —
# только docker-compose.prod.yml, Makefile и .env (docs/DEPLOY.md).
#
# ⚠ REF намеренно НЕ задаётся из командной строки: значение параметра make
# раскрывается ДО шелла, поэтому `make -n цель REF='$(shell …)'` выполняет код
# прямо в режиме «только показать». Параметры оператора передаются ПЕРЕД make:
# `CONFIRM=1 make compose-update`.
override REF := main
RAW := https://raw.githubusercontent.com/bx-shef/get-task-from-b24/$(REF)
COMPOSE := docker compose -f docker-compose.prod.yml

.DEFAULT_GOAL := help

## показать список целей
help:
	@grep -B1 '^[a-z][a-z0-9-]*:' $(MAKEFILE_LIST) \
		| grep -A1 '^##' \
		| sed 's/^## /  /' \
		| awk '/^  /{d=$$0; next} /:/{split($$0,a,":"); printf "%-18s%s\n", a[1], d}'

## обновить сам Makefile из репозитория (делать первым)
self-update:
	@echo "Тяну Makefile из $(REF)…"
	@curl -fsSL "$(RAW)/Makefile" -o /tmp/Makefile.new
	@test -s /tmp/Makefile.new || { echo "Скачан пустой файл — отмена"; exit 1; }
	@grep -q '^self-update:' /tmp/Makefile.new || { echo "В скачанном файле нет self-update — отмена"; exit 1; }
	@cp Makefile Makefile.bak
	@mv /tmp/Makefile.new Makefile
	@echo "Готово. Прежний сохранён как Makefile.bak"

## обновить docker-compose.prod.yml (нужен CONFIRM=1 перед make)
compose-update:
	@test "$${CONFIRM:-}" = "1" || { echo "Перезапишет docker-compose.prod.yml. Повторите: CONFIRM=1 make compose-update"; exit 1; }
	@curl -fsSL "$(RAW)/docker-compose.prod.yml" -o /tmp/compose.new
	@test -s /tmp/compose.new || { echo "Скачан пустой файл — отмена"; exit 1; }
	@cp docker-compose.prod.yml docker-compose.prod.yml.bak
	@mv /tmp/compose.new docker-compose.prod.yml
	@echo "Готово. Прежний сохранён как docker-compose.prod.yml.bak"

## что крутится
ps:
	@$(COMPOSE) ps

## логи приложения (последние 200 строк, дальше — хвостом)
logs:
	@$(COMPOSE) logs --tail=200 -f app

## живо ли: health приложения и состояние контейнеров
doctor:
	@echo "— контейнеры —"; $(COMPOSE) ps
	@echo "— health —"; $(COMPOSE) exec -T app wget -qO- http://localhost:3000/health || echo "приложение не отвечает"

## что происходит с переносами: последние 20 записей журнала
transfers:
	@$(COMPOSE) exec -T db psql -U app -d app -c \
		"select domain, source_task_id, target_task_id, status, left(coalesce(reason,''),60) as reason, updated_at \
		 from transfers order by updated_at desc limit 20;"

## какие порталы установлены
portals:
	@$(COMPOSE) exec -T db psql -U app -d app -c \
		"select domain, member_id, expires_at, updated_at from portal_tokens order by domain;"

## подтянуть свежий образ и перезапустить
prod-redeploy:
	@$(COMPOSE) pull app
	@$(COMPOSE) up -d
	@$(COMPOSE) ps

## поднять всё (первый запуск)
prod-up:
	@$(COMPOSE) up -d
	@$(COMPOSE) ps

## бэкап базы в файл backup-ГГГГ-ММ-ДД.sql.gz
backup:
	@$(COMPOSE) exec -T db pg_dump -U app app | gzip > "backup-$$(date +%F).sql.gz"
	@ls -lh backup-*.sql.gz | tail -1

.PHONY: help self-update compose-update ps logs doctor transfers portals prod-redeploy prod-up backup
