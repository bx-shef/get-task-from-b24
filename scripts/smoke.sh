#!/bin/bash
# Смоук по безопасности и живучести обработчика. Гоняется против запущенного сервиса.
#
# ⚠ Проверяет ровно то, что панель ревью нашла сломанным: подделку установки, подделку
# события, загрязнение прототипа и переполнение тела. Это не замена тестам — это
# доказательство, что собранный сервис ведёт себя как задумано.
#
#   BASE=http://localhost:3000 DOMAIN=client.bitrix24.ru bash scripts/smoke.sh
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
DOMAIN="${DOMAIN:-client.bitrix24.ru}"
fails=0

check() { # имя, ожидаемый код, фактический код
  if [ "$2" = "$3" ]; then
    printf '  ok   %-52s %s\n' "$1" "$3"
  else
    printf '  ПРОВАЛ %-50s ждали %s, получили %s\n' "$1" "$2" "$3"
    fails=$((fails + 1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Смоук против $BASE"

check "health отвечает" 200 "$(code "$BASE/health")"

check "установка от постороннего отвергнута" 403 \
  "$(code -X POST "$BASE/b24/install" \
     -d "event=ONAPPINSTALL&auth[domain]=$DOMAIN&auth[member_id]=m&auth[application_token]=ЧУЖОЙ&auth[access_token]=подделка&auth[refresh_token]=rt&auth[server_endpoint]=https://evil.example/rest/")"

check "установка чужого портала отвергнута" 403 \
  "$(code -X POST "$BASE/b24/install" \
     -d 'event=ONAPPINSTALL&auth[domain]=не-наш.bitrix24.ru&auth[access_token]=at&auth[refresh_token]=rt')"

check "событие с подделанным токеном отвергнуто" 401 \
  "$(code -X POST "$BASE/b24/handler" \
     -d "event=ONTASKADD&data[FIELDS_AFTER][ID]=1&auth[domain]=$DOMAIN&auth[application_token]=ПОДДЕЛКА")"

check "чужой портал игнорируется молча" 200 \
  "$(code -X POST "$BASE/b24/handler" \
     -d 'event=ONTASKADD&data[FIELDS_AFTER][ID]=1&auth[domain]=не-наш.bitrix24.ru&auth[application_token]=t')"

check "гигантское тело отбито" 413 \
  "$(python3 -c "print('x=' + 'a' * 300000)" | curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/b24/handler" --data-binary @-)"

# ⚠ Загрязнение прототипа: если оно проходит, следующий же запрос ведёт себя иначе.
curl -s -o /dev/null -X POST "$BASE/b24/handler" -d 'data[__proto__][polluted]=yes&event=ONTASKADD&data[FIELDS_AFTER][ID]=1'
check "процесс жив после попытки загрязнить прототип" 200 "$(code "$BASE/health")"

echo
if [ "$fails" -eq 0 ]; then
  echo "Всё чисто."
else
  echo "Провалов: $fails"
fi
exit "$fails"
