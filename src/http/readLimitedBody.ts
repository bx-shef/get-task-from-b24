import { readRawBody, getRequestHeader, type H3Event } from 'h3'

/**
 * Чтение тела с потолком по размеру.
 *
 * ⚠ `readRawBody` собирает поток целиком в память и лимита не знает. Оба наших роута
 * открыты миру и читают тело ДО всякой проверки подлинности — то есть один запрос с
 * телом в несколько гигабайт клал бы процесс по OOM, а вместе с ним и воркеры очереди,
 * которые живут в том же процессе. Найдено панелью ревью.
 *
 * ⚠ Событие Битрикс24 — единицы килобайт (в нём приходит только ID задачи), так что
 * потолок в 128 КБ не отсекает ничего настоящего.
 */
export const MAX_BODY_BYTES = 128 * 1024

/** @returns `null`, если тело больше потолка. */
export async function readLimitedBody(event: H3Event, limit: number = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > limit) return null

  const raw = await readRawBody(event, 'utf8')
  if (raw === undefined) return ''
  // ⚠ Проверяем и фактический размер: content-length приходит от клиента и может врать.
  return Buffer.byteLength(raw, 'utf8') > limit ? null : raw
}
