#!/bin/bash
# Смоук по безопасности и живучести обработчика. Гоняется против запущенного сервиса.
#
# ⚠ Проверяет ровно то, что панель ревью нашла сломанным: подделку установки, подделку
# события, загрязнение прототипа и переполнение тела. Это не замена тестам — это
# доказательство, что собранный сервис ведёт себя как задумано.
#
# ⚠ Сверяем КОД И ТЕЛО ответа. Раньше сверялся только код, и «установка от постороннего
# отвергнута» проходила бы по совершенно другой причине — например, потому что домен не
# в реестре, ни разу не задев проверку токена. Найдено вторым циклом ревью.
#
#   BASE=http://localhost:3000 DOMAIN=client.bitrix24.ru bash scripts/smoke.sh
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
DOMAIN="${DOMAIN:-client.bitrix24.ru}"
fails=0

# имя, ожидаемый код, ожидаемая подстрока тела (или -), фактический «код|тело»
check() {
  local name="$1" want_code="$2" want_body="$3" got="$4"
  local code="${got%%|*}" body="${got#*|}"
  if [ "$code" != "$want_code" ]; then
    printf '  ПРОВАЛ  %s\n          ждали код %s, получили %s\n' "$name" "$want_code" "$code"
    fails=$((fails + 1))
  elif [ "$want_body" != '-' ] && [[ "$body" != *"$want_body"* ]]; then
    printf '  ПРОВАЛ  %s\n          в теле нет «%s»: %s\n' "$name" "$want_body" "$body"
    fails=$((fails + 1))
  else
    printf '  ok      %s\n' "$name"
  fi
}

post() { curl -s -w '|%{http_code}' -X POST "$1" -d "$2" | awk -F'|' '{print $NF "|" substr($0, 1, length($0)-length($NF)-1)}'; }
get()  { curl -s -w '|%{http_code}' "$1" | awk -F'|' '{print $NF "|" substr($0, 1, length($0)-length($NF)-1)}'; }

echo "Смоук против $BASE"

check "health отвечает" 200 '"status"' "$(get "$BASE/health")"

# ⚠ Часть проверок имеет смысл только для домена ИЗ РЕЕСТРА: для чужого сервис отвечает
# «не наш портал» раньше, чем доходит до проверки подлинности. Без этой подсказки прогон
# давал загадочный провал — замечание второго цикла ревью.
registry_probe="$(post "$BASE/b24/handler" "event=ONTASKADD&data[FIELDS_AFTER][ID]=1&auth[domain]=$DOMAIN&auth[application_token]=ПОДДЕЛКА")"
if [[ "${registry_probe#*|}" == *'"ignored":"portal"'* ]]; then
  echo
  echo "  ⚠ Домен $DOMAIN не найден в реестре сервиса."
  echo "    Проверки подлинности события пропущены: для чужого портала сервис отвечает"
  echo "    «не наш» раньше, чем сверяет токен. Запустите с DOMAIN из B24_PORTAL_* в .env."
  echo
  SKIP_REGISTRY_CHECKS=1
fi

# ⚠ Токен установки не подтверждён вызовом на настоящий портал.
check "установка с непроверенным токеном отвергнута" 403 'not_verified' \
  "$(post "$BASE/b24/install" "event=ONAPPINSTALL&auth[domain]=$DOMAIN&auth[member_id]=m&auth[application_token]=ЧУЖОЙ&auth[access_token]=подделка&auth[refresh_token]=rt&auth[server_endpoint]=https://evil.example/rest/")"

# ⚠ Ответ обязан совпадать с предыдущим: разные ответы превращают роут в оракул,
# по которому перебором доменов выясняется список клиентов.
check "чужой портал в установке неотличим от отказа по токену" 403 'not_verified' \
  "$(post "$BASE/b24/install" 'event=ONAPPINSTALL&auth[domain]=не-наш.bitrix24.ru&auth[application_token]=t&auth[access_token]=at&auth[refresh_token]=rt')"

# ⚠ Пустой токен приложения записал бы хэш пустой строки — портал онемел бы навсегда.
check "установка без токена приложения отвергнута" 400 'no_application_token' \
  "$(post "$BASE/b24/install" "event=ONAPPINSTALL&auth[domain]=$DOMAIN&auth[access_token]=at&auth[refresh_token]=rt")"

if [ -z "${SKIP_REGISTRY_CHECKS:-}" ]; then
  check "событие с подделанным токеном отвергнуто" 401 'application_token' "$registry_probe"
fi

check "чужой портал игнорируется молча" 200 '"ignored":"portal"' \
  "$(post "$BASE/b24/handler" 'event=ONTASKADD&data[FIELDS_AFTER][ID]=1&auth[domain]=не-наш.bitrix24.ru&auth[application_token]=t')"

check "событие без auth отличимо от чужого портала" 200 '"ignored":"no_auth"' \
  "$(post "$BASE/b24/handler" 'event=ONTASKADD&data[FIELDS_AFTER][ID]=1')"

# ⚠ Тело подаём потоком, а не аргументом: 200 КБ в командной строке curl не помещаются.
# ⚠ Генерируем средствами самого shell: python3 на боевом сервере может отсутствовать,
# и тогда проверка молча зависала (замерено на живом сервере).
big_body() { printf 'x='; head -c 200000 /dev/zero | tr '\0' 'a'; }
check "тело сверх потолка отбито" 413 'body_too_large' \
  "$(big_body | curl -s -w '|%{http_code}' -X POST "$BASE/b24/handler" --data-binary @- | awk -F'|' '{print $NF "|" substr($0, 1, length($0)-length($NF)-1)}')"

# ⚠ Раньше здесь проверялось только «процесс жив» — а загрязнение прототипа процесс и
# не роняет, то есть проверка не могла провалиться по названной причине.
curl -s -o /dev/null -X POST "$BASE/b24/handler" -d 'data[__proto__][polluted]=yes&event=ONTASKADD&data[FIELDS_AFTER][ID]=1'
health_after="$(get "$BASE/health")"
if [[ "${health_after#*|}" == *polluted* ]]; then
  printf '  ПРОВАЛ  прототип загрязнён: ключ polluted проступил в ответе /health\n'
  fails=$((fails + 1))
else
  check "прототип не загрязняется" 200 '"status"' "$health_after"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "Всё чисто."
else
  echo "Провалов: $fails"
fi
exit "$fails"
