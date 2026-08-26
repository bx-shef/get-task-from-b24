.PHONY: help self-update compose-update ps logs logs-tail doctor transfers portals clients \
        client-add client-disable client-enable client-forget \
        prod-up prod-down prod-pull prod-redeploy backup dev

# Единственный интерфейс к боевому серверу. На сервере нет ни репозитория, ни pnpm —
# только docker-compose.prod.yml, этот Makefile и .env (docs/DEPLOY.md).
#
# ⚠ Параметры оператора передаются ПЕРЕД make: `CONFIRM=1 make compose-update`.
# Значение, заданное как `make цель VAR=…`, раскрывается ДО всякого шелла — поэтому
# `make -n цель VAR='$(shell …)'` выполняет код прямо в режиме «только показать», то
# есть осторожный оператор детонирует вместо того, чтобы защититься. Все параметры в
# рецептах читаются как `$${VAR:-}` — эта форма из окружения не раскрывается.
#
# ⚠ REF намеренно НЕ задаётся из командной строки по той же причине.
override REF := main
RAW := https://raw.githubusercontent.com/bx-shef/get-task-from-b24/$(REF)
COMPOSE := docker compose -f docker-compose.prod.yml

.DEFAULT_GOAL := help

## Список целей с описаниями
#
# ⚠ Запоминает ПОСЛЕДНЮЮ строку `##` и печатает её у ближайшей следующей цели.
# Наивный `grep -B1` этого не умеет: у половины целей между описанием и самой целью
# лежит ещё несколько строк комментария, и они молча выпадали из списка — то есть
# справка врала о том, что вообще можно запустить.
help:
	@awk '/^## /{d=substr($$0,4)} \
	      /^[a-z][a-z0-9-]*:/{if(d!=""){split($$0,a,":"); printf "  %-16s %s\n", a[1], d; d=""}}' $(MAKEFILE_LIST)

# ─── Обновление самого инструмента ───────────────────────────────────

## Обновить САМ этот Makefile из репозитория (новые цели появляются только так)
#
# ⚠ Без этой цели остальные бесполезны: Makefile кладётся на сервер один раз при
# развёртывании и дальше живёт своей жизнью, поэтому цель, добавленная в репозиторий,
# на сервере просто не существует.
#
# ⚠ Файл — от `mktemp`, а НЕ фиксированный `/tmp/Makefile.new`. Предсказуемое имя в
# общем `/tmp` кто угодно может заранее подложить симлинком, и `curl -o` пройдёт по
# нему насквозь, перезаписав цель. `mktemp` создаёт файл атомарно.
#
# ⚠ Скачанное проверяется по признаку, который есть в ЛЮБОЙ версии файла (`.PHONY` и
# давняя цель `prod-redeploy`), а не по свежей: проверка по новой цели блокировала бы
# ровно то обновление, ради которого написана.
self-update:
	@t=$$(mktemp /tmp/Makefile.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/Makefile" \
	  && grep -q '^\.PHONY:' "$$t" \
	  && make -n -f "$$t" prod-redeploy >/dev/null 2>&1 \
	  && { b="./Makefile.bak-$$(date +%Y%m%d-%H%M%S)"; \
	       cp ./Makefile "$$b" && cp "$$t" ./Makefile \
	       && echo "[make] Makefile обновлён из $(REF), копия прежнего: $$b"; \
	       echo "[make] цели:"; make help; }

## Обновить docker-compose.prod.yml из репозитория (сперва покажет диф; применить — CONFIRM=1)
#
# ⚠ Диф печатается ЦЕЛИКОМ и с числом строк. Обрезанная страховка хуже отсутствующей:
# оператор видит начало, решает «выглядит нормально» и теряет правку, ради защиты от
# которой диф и показывают.
compose-update:
	@t=$$(mktemp /tmp/compose.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/docker-compose.prod.yml" \
	  && $(COMPOSE) --project-directory . -f "$$t" config -q \
	  && { d=$$(diff -u ./docker-compose.prod.yml "$$t" | tail -n +3); \
	       n=$$(printf '%s\n' "$$d" | grep -c . || true); \
	       echo "[make] отличия текущего файла от $(REF) — $$n строк (- сервер, + репозиторий):"; \
	       printf '%s\n' "$$d"; \
	       if [ "$${CONFIRM:-}" = "1" ]; then \
	         b="./docker-compose.prod.yml.bak-$$(date +%Y%m%d-%H%M%S)"; \
	         cp ./docker-compose.prod.yml "$$b" && cp "$$t" ./docker-compose.prod.yml \
	         && echo "[make] заменён, копия прежнего: $$b. Применить: make prod-redeploy"; \
	       else echo "[make] это был показ. Применить: CONFIRM=1 make compose-update"; fi; }

# ─── Клиенты ─────────────────────────────────────────────────────────
# Реестр порталов живёт в .env: одна строка на клиента,
#   B24_PORTAL_NN=домен,id исполнителя у клиента,client_id,client_secret[,id группы у нас]
# Правится этими целями, а не руками: строка длинная, а ошибка в ней тихая.

## Показать подключённых клиентов (секреты не печатаются)
clients:
	@awk -F= '/^#?B24_PORTAL_/{ \
	    off=(substr($$1,1,1)=="#"); name=$$1; sub(/^#/,"",name); \
	    split($$2,f,","); \
	    printf "  %-14s %-28s исполнитель=%-8s группа=%-6s %s\n", \
	      name, f[1], f[2], (f[5]==""?"0":f[5]), (off?"[ОТКЛЮЧЁН]":"") }' .env \
	  || echo "  реестр пуст"

## Подключить клиента: DOMAIN=… RESPONSIBLE=… CLIENT_ID=… CLIENT_SECRET=… [GROUP=0] make client-add
#
# ⚠ Дубль домена ломает сервис на старте намеренно (какой из двух наборов ключей
# применится, зависело бы от порядка строк, то есть от случайности) — поэтому
# проверяем заранее и отказываем понятно.
client-add:
	@d="$${DOMAIN:-}"; r="$${RESPONSIBLE:-}"; ci="$${CLIENT_ID:-}"; cs="$${CLIENT_SECRET:-}"; g="$${GROUP:-0}"; \
	if [ -z "$$d" ] || [ -z "$$r" ] || [ -z "$$ci" ] || [ -z "$$cs" ]; then \
	  echo "Нужно: DOMAIN=portal.example.by RESPONSIBLE=17 CLIENT_ID=local.xxx CLIENT_SECRET=yyy [GROUP=0] make client-add"; exit 1; fi; \
	case "$$d$$r$$ci$$cs$$g" in *,*) echo "[make] запятая в значении: она разделяет поля реестра и здесь недопустима"; exit 1;; esac; \
	if grep -qi "^#\?B24_PORTAL_[A-Za-z0-9_]*=$$d," .env; then \
	  echo "[make] $$d уже есть в реестре. Посмотреть: make clients"; exit 1; fi; \
	n=$$(awk -F= '/^#?B24_PORTAL_/{c++} END{printf "%02d", c+1}' .env); \
	cp .env ".env.bak-$$(date +%Y%m%d-%H%M%S)"; \
	printf 'B24_PORTAL_%s=%s,%s,%s,%s,%s\n' "$$n" "$$d" "$$r" "$$ci" "$$cs" "$$g" >> .env; \
	echo "[make] добавлен B24_PORTAL_$$n = $$d (группа $$g). Применить: make prod-redeploy"

## Отключить клиента (строка остаётся закомментированной): DOMAIN=… make client-disable
#
# ⚠ Токены портала при этом ОСТАЮТСЯ в базе — отключение обратимо. Убрать их совсем:
# make client-forget.
client-disable:
	@d="$${DOMAIN:-}"; [ -n "$$d" ] || { echo "Нужно: DOMAIN=portal.example.by make client-disable"; exit 1; }; \
	grep -q "^B24_PORTAL_[A-Za-z0-9_]*=$$d," .env || { echo "[make] активной строки для $$d нет. Смотреть: make clients"; exit 1; }; \
	cp .env ".env.bak-$$(date +%Y%m%d-%H%M%S)"; \
	sed -i "s|^\(B24_PORTAL_[A-Za-z0-9_]*=$$d,.*\)$$|#\1|" .env; \
	echo "[make] $$d отключён (строка закомментирована). Применить: make prod-redeploy"

## Включить обратно ранее отключённого: DOMAIN=… make client-enable
client-enable:
	@d="$${DOMAIN:-}"; [ -n "$$d" ] || { echo "Нужно: DOMAIN=portal.example.by make client-enable"; exit 1; }; \
	grep -q "^#B24_PORTAL_[A-Za-z0-9_]*=$$d," .env || { echo "[make] отключённой строки для $$d нет. Смотреть: make clients"; exit 1; }; \
	cp .env ".env.bak-$$(date +%Y%m%d-%H%M%S)"; \
	sed -i "s|^#\(B24_PORTAL_[A-Za-z0-9_]*=$$d,.*\)$$|\1|" .env; \
	echo "[make] $$d включён. Применить: make prod-redeploy"

## Забыть клиента совсем: удалить его токены из базы (нужен CONFIRM=1)
#
# ⚠ Необратимо: вернуть портал можно будет только переустановкой приложения САМИМ
# клиентом. Журнал переносов при этом сохраняется — он история, а не доступ.
client-forget:
	@d="$${DOMAIN:-}"; [ -n "$$d" ] || { echo "Нужно: DOMAIN=portal.example.by CONFIRM=1 make client-forget"; exit 1; }; \
	if [ "$${CONFIRM:-}" != "1" ]; then \
	  echo "[make] удалит токены портала $$d из базы. Вернуть можно будет только переустановкой у клиента."; \
	  echo "[make] повторите: DOMAIN=$$d CONFIRM=1 make client-forget"; exit 1; fi; \
	$(COMPOSE) exec -T db psql -U app -d app -c "delete from portal_tokens where domain = '$$d';"

# ─── Прод ────────────────────────────────────────────────────────────

## Поднять стек (первый запуск)
prod-up:
	@$(COMPOSE) up -d && $(COMPOSE) ps

## Остановить стек
prod-down:
	@$(COMPOSE) down

## Скачать свежий образ (без перезапуска)
prod-pull:
	@$(COMPOSE) pull

## Подтянуть свежий образ и перезапустить (он же — применить правки .env)
prod-redeploy:
	@$(COMPOSE) pull && $(COMPOSE) up -d && docker image prune -f && $(COMPOSE) ps

## Что крутится
ps:
	@$(COMPOSE) ps

## Живой лог приложения (Ctrl+C чтобы выйти)
logs:
	@$(COMPOSE) logs -f app

## Последние 50 строк лога без слежения — удобно на мобильном
logs-tail:
	@$(COMPOSE) logs --tail=50 --no-log-prefix app

# ─── Диагностика ─────────────────────────────────────────────────────

## Живо ли: контейнеры и health приложения
doctor:
	@echo "— контейнеры —"; $(COMPOSE) ps
	@echo "— health —"; $(COMPOSE) exec -T app wget -qO- http://localhost:3000/health || echo "приложение не отвечает"

## Последние 20 записей журнала переносов
transfers:
	@$(COMPOSE) exec -T db psql -U app -d app -c \
		"select domain, source_task_id, target_task_id, status, left(coalesce(reason,''),60) as reason, updated_at \
		 from transfers order by updated_at desc limit 20;"

## Какие порталы установлены и когда продлевались их токены
portals:
	@$(COMPOSE) exec -T db psql -U app -d app -c \
		"select domain, member_id, expires_at, updated_at from portal_tokens order by domain;"

## Бэкап базы в backup-ГГГГ-ММ-ДД.sql.gz
#
# ⚠ Дамп содержит зашифрованные токены порталов, а ключ от них — в .env рядом.
# Храните их в РАЗНЫХ местах, иначе шифрование не даёт ничего (docs/DEPLOY.md).
backup:
	@$(COMPOSE) exec -T db pg_dump -U app app | gzip > "backup-$$(date +%F).sql.gz"
	@ls -lh backup-*.sql.gz | tail -1

# ─── Локальная разработка ────────────────────────────────────────────

## Дев-сервер (только из репозитория, не на сервере)
dev:
	pnpm dev
