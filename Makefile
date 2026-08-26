.PHONY: help self-update compose-update ps logs logs-tail doctor transfers portals clients \
        client-add client-disable client-enable client-forget \
        prod-up prod-down prod-pull prod-redeploy backup

# Единственный интерфейс к боевому серверу. На сервере нет ни репозитория, ни pnpm —
# только docker-compose.prod.yml, этот Makefile и .env (docs/DEPLOY.md).
#
# ⚠ Параметры оператора передаются ПЕРЕД make: `CONFIRM=1 make compose-update`.
#
# ⚠ Причина — замерена, и она НЕ та, что была написана здесь раньше. Проверено:
#   make цель VAR='$(shell touch /tmp/PWNED)x'      → файл СОЗДАН
#   make -n цель VAR='$(shell touch /tmp/PWNED)x'   → файл НЕ создан
# То есть опасен обычный запуск, а `-n` как раз безопасен: `$${VAR:-}` сам make не
# раскрывает, но переменные командной строки он экспортирует в окружение рецепта, а
# при экспорте раскрывает их значение. Прежняя формулировка утверждала обратное и
# описывала гарантию, которой нет, — а на ней держится вся конвенция. Найдено ревью.
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
# ⚠ Проверяется СКАЧАННЫЙ файл, а не слияние его с текущим: `$(COMPOSE)` уже несёт свой
# `-f`, и два `-f` заставляют docker compose валидировать объединение. Тогда правка,
# удаляющая сервис, проходит проверку (слиянием удаление не воспроизводится), а битый
# YAML нового файла маскируется старым. Найдено ревью.
#
# ⚠ Диф печатается ЦЕЛИКОМ и с числом строк. Обрезанная страховка хуже отсутствующей:
# оператор видит начало, решает «выглядит нормально» и теряет правку, ради защиты от
# которой диф и показывают.
compose-update:
	@t=$$(mktemp /tmp/compose.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/docker-compose.prod.yml" \
	  && docker compose --project-directory . -f "$$t" config -q \
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
#
# ⚠ Проверки параметров вынесены в переменные и стоят во ВСЕХ целях, а не в одной.
# Ревью доказало прогоном, во что обходится пропуск: `DOMAIN='.*' make client-disable`
# комментировал ВЕСЬ реестр, рапортуя об одном клиенте (домен подставлялся в регексп);
# `DOMAIN="x'; drop table …; --" make client-forget` уничтожал таблицу в базе (склейка
# строк в SQL); перевод строки в `CLIENT_SECRET` дописывал в .env произвольные строки и
# переопределял `B24_TOKEN_ENC_KEY` — то есть делал нечитаемыми токены всех порталов.

# Домен: только буквы, цифры, точка и дефис. Снимает и метасимволы регекспа, и
# разделитель sed, и кавычки для SQL.
GUARD_DOMAIN = case "$$d" in ''|*[!a-zA-Z0-9.-]*) echo "[make] домен: допустимы только буквы, цифры, точка и дефис, получено «$$d»"; exit 1;; esac
# Ключи приложения: плюс подчёркивание и точка. Главное — никаких переводов строки.
GUARD_KEYS = case "$$ci$$cs" in ''|*[!a-zA-Z0-9._-]*) echo "[make] client_id/client_secret: допустимы буквы, цифры, точка, дефис и подчёркивание"; exit 1;; esac
# Точка в домене — метасимвол регекспа: экранируем перед подстановкой в grep и sed.
ESCAPE_DOMAIN = esc=$$(printf '%s' "$$d" | sed 's/\./\\./g')
# Домен приводится к тому же виду, в каком его хранит сервис: без схемы, без хвоста,
# в нижнем регистре. ⚠ Иначе оператор, добавивший клиента как `Client.Bitrix24.RU`,
# не смог бы отключить его тем домeном, который видит везде в логах и в базе.
NORMALIZE_DOMAIN = d=$$(printf '%s' "$$d" | tr 'A-Z' 'a-z' | sed -e 's|^https\?://||' -e 's|/.*$$||')
# ⚠ Все цели правят .env; его отсутствие обязано быть отказом, а не созданием огрызка.
REQUIRE_ENV = [ -f .env ] || { echo "[make] .env не найден: цель запускают в каталоге деплоя"; exit 1; }
# ⚠ Дописывание в файл без завершающего перевода строки склеивает новую строку с
# последней. Ревью воспроизвело: клиент не добавлялся, существующий портился, и сервис
# после prod-redeploy не стартовал ВООБЩЕ — потому что нечитаемая строка реестра
# роняет старт целиком.
ENSURE_NEWLINE = [ ! -s .env ] || [ -z "$$(tail -c1 .env)" ] || printf '\n' >> .env
# Реестр порталов живёт в .env, по строке на клиента. Формат описан в .env.example —
# здесь не дублируем, чтобы не разошлось. Правится этими целями, а не руками: строка
# длинная, а ошибка в ней тихая.

## Показать подключённых клиентов (секреты не печатаются)
clients:
	@$(REQUIRE_ENV)
	@awk '/^#?B24_PORTAL_/{ c++; \
	    off=(substr($$0,1,1)=="#"); line=$$0; sub(/^#/,"",line); \
	    name=line; sub(/=.*$$/,"",name); \
	    val=line; sub(/^[^=]*=/,"",val); \
	    split(val,f,","); \
	    printf "  %-14s %-28s исполнитель=%-8s группа=%-6s %s\n", \
	      name, f[1], f[2], (f[5]==""?"0":f[5]), (off?"[ОТКЛЮЧЁН]":"") } \
	    END{ if(NR==0 || c==0) print "  реестр пуст" }' .env

## Подключить клиента: DOMAIN=… RESPONSIBLE=… CLIENT_ID=… CLIENT_SECRET=… [GROUP=0] make client-add
#
# ⚠ Дубль домена ломает сервис на старте намеренно (какой из двух наборов ключей
# применится, зависело бы от порядка строк, то есть от случайности) — поэтому
# проверяем заранее и отказываем понятно.
#
# ⚠ Номер подбирается ПЕРВЫЙ СВОБОДНЫЙ, а не «число строк + 1»: после удаления строки
# счётчик столкнулся бы с существующим именем, дубликат ключа в .env схлопнулся бы до
# последнего значения ещё до старта сервиса, и клиент пропал бы молча — мимо защиты от
# дублей домена. Найдено ревью.
#
# ⚠ Числовые параметры проверяются ЗДЕСЬ, а не только парсером реестра. Найдено ревью:
# `GROUP=проект` записывалось в .env молча, а падало на следующем `make prod-redeploy` —
# и не для одного клиента, а для ВСЕХ сразу, потому что нечитаемая строка реестра
# роняет старт целиком. Отказ обязан приходить в момент правки, а не в момент деплоя.
client-add:
	@d="$${DOMAIN:-}"; r="$${RESPONSIBLE:-}"; ci="$${CLIENT_ID:-}"; cs="$${CLIENT_SECRET:-}"; g="$${GROUP:-0}"; \
	if [ -z "$$d" ] || [ -z "$$r" ] || [ -z "$$ci" ] || [ -z "$$cs" ]; then \
	  echo "Нужно: DOMAIN=portal.example.by RESPONSIBLE=17 CLIENT_ID=local.xxx CLIENT_SECRET=yyy [GROUP=0] make client-add"; exit 1; fi; \
	$(REQUIRE_ENV); \
	$(NORMALIZE_DOMAIN); \
	$(GUARD_DOMAIN); \
	$(GUARD_KEYS); \
	case "$$r" in ''|*[!0-9]*) echo "[make] RESPONSIBLE должен быть числом (id сотрудника у клиента), получено «$$r»"; exit 1;; esac \
	&& case "$$g" in ''|*[!0-9]*) echo "[make] GROUP должен быть числом (0 — без группы), получено «$$g»"; exit 1;; esac \
	&& $(ESCAPE_DOMAIN) \
	&& { grep -qi "^#\?B24_PORTAL_[A-Za-z0-9_]*=$$esc," .env \
	     && { echo "[make] $$d уже есть в реестре. Посмотреть: make clients"; exit 1; } || true; } \
	&& n=1 && while grep -q "^#\?B24_PORTAL_$$(printf '%02d' $$n)=" .env; do n=$$((n+1)); done \
	&& n=$$(printf '%02d' $$n) \
	&& cp .env ".env.bak-$$(date +%Y%m%d-%H%M%S)" \
	&& { $(ENSURE_NEWLINE); } \
	&& printf 'B24_PORTAL_%s=%s,%s,%s,%s,%s\n' "$$n" "$$d" "$$r" "$$ci" "$$cs" "$$g" >> .env \
	&& echo "[make] добавлен B24_PORTAL_$$n = $$d (группа $$g). Применить: make prod-redeploy"

## Отключить клиента (строка остаётся закомментированной): DOMAIN=… make client-disable
#
# ⚠ Токены портала при этом ОСТАЮТСЯ в базе — отключение обратимо. Убрать их совсем:
# make client-forget.
client-disable:
	@d="$${DOMAIN:-}"; [ -n "$$d" ] || { echo "Нужно: DOMAIN=portal.example.by make client-disable"; exit 1; }; \
	$(REQUIRE_ENV) \
	&& $(NORMALIZE_DOMAIN) \
	&& $(GUARD_DOMAIN) \
	&& $(ESCAPE_DOMAIN) \
	&& { [ "$$(grep -c "^B24_PORTAL_[A-Za-z0-9_]*=$$esc," .env)" = "1" ] \
	     || { echo "[make] для $$d ожидалась ровно одна активная строка. Смотреть: make clients"; exit 1; }; } \
	&& cp .env ".env.bak-$$(date +%Y%m%d-%H%M%S)" \
	&& sed -i "s|^\(B24_PORTAL_[A-Za-z0-9_]*=$$esc,.*\)$$|#\1|" .env \
	&& echo "[make] $$d отключён (строка закомментирована). Применить: make prod-redeploy"

## Включить обратно ранее отключённого: DOMAIN=… make client-enable
client-enable:
	@d="$${DOMAIN:-}"; [ -n "$$d" ] || { echo "Нужно: DOMAIN=portal.example.by make client-enable"; exit 1; }; \
	$(REQUIRE_ENV) \
	&& $(NORMALIZE_DOMAIN) \
	&& $(GUARD_DOMAIN) \
	&& $(ESCAPE_DOMAIN) \
	&& { [ "$$(grep -c "^#B24_PORTAL_[A-Za-z0-9_]*=$$esc," .env)" = "1" ] \
	     || { echo "[make] для $$d ожидалась ровно одна отключённая строка. Смотреть: make clients"; exit 1; }; } \
	&& cp .env ".env.bak-$$(date +%Y%m%d-%H%M%S)" \
	&& sed -i "s|^#\(B24_PORTAL_[A-Za-z0-9_]*=$$esc,.*\)$$|\1|" .env \
	&& echo "[make] $$d включён. Применить: make prod-redeploy"

## Забыть клиента совсем: удалить его токены из базы (нужен CONFIRM=1)
#
# ⚠ Необратимо: вернуть портал можно будет только переустановкой приложения САМИМ
# клиентом. Журнал переносов при этом сохраняется — он история, а не доступ.
#
# ⚠ Домен уходит в SQL ПАРАМЕТРОМ (`-v d=… :'d'`), а не склейкой строк. Ревью
# доказало прогоном, что склейка исполнялась: `DOMAIN="x'; drop table …; --"`
# уничтожил таблицу, а цель отчиталась успехом. Роль `app` в образе Postgres — ещё и
# суперпользователь, то есть цена такой опечатки не «ошибка», а «уронил базу».
#
# ⚠ Требует, чтобы клиент был СНАЧАЛА отключён. Иначе получалось полусостояние:
# токенов нет, а строка реестра активна — сервис продолжает принимать события портала
# и валить каждый перенос на отсутствии токенов. Найдено ревью.
client-forget:
	@d="$${DOMAIN:-}"; [ -n "$$d" ] || { echo "Нужно: DOMAIN=portal.example.by CONFIRM=1 make client-forget"; exit 1; }; \
	$(REQUIRE_ENV) \
	&& $(NORMALIZE_DOMAIN) \
	&& $(GUARD_DOMAIN) \
	&& $(ESCAPE_DOMAIN) \
	&& { grep -q "^B24_PORTAL_[A-Za-z0-9_]*=$$esc," .env \
	     && { echo "[make] $$d ещё активен в реестре. Сначала: DOMAIN=$$d make client-disable"; exit 1; } || true; } \
	&& { [ "$${CONFIRM:-}" = "1" ] || { \
	       echo "[make] удалит токены портала $$d из базы. Вернуть можно будет только переустановкой у клиента."; \
	       echo "[make] повторите: DOMAIN=$$d CONFIRM=1 make client-forget"; exit 1; }; } \
	&& $(COMPOSE) exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -v d="$$d" \
	     -c "delete from portal_tokens where domain = :'"'"'d'"'"';"

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

## Живой лог приложения: последние 200 строк и дальше хвостом (Ctrl+C чтобы выйти)
logs:
	@$(COMPOSE) logs --tail=200 -f app

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
	@umask 077; $(COMPOSE) exec -T db pg_dump -U app app | gzip > "backup-$$(date +%F).sql.gz"
	@ls -lh backup-*.sql.gz | tail -1
	@echo "[make] ⚠ дамп содержит зашифрованные токены порталов, а ключ от них — в .env рядом."
	@echo "[make]   Храните их в РАЗНЫХ местах, иначе шифрование не даёт ничего."

