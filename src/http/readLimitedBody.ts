import { getRequestHeader, type H3Event } from 'h3'

/**
 * Чтение тела с потолком по размеру — потоком, а не целиком.
 *
 * ⚠ Первая версия звала `readRawBody` и меряла результат ПОСЛЕ. Ревью доказало
 * прогоном, что это не защита: запрос на 200 МБ с `Transfer-Encoding: chunked` (то есть
 * вообще без `content-length`) поднимал RSS процесса со 100 МБ до 680 МБ и только потом
 * получал 413. В проде с `mem_limit: 512m` контейнер умирает раньше — а вместе с ним
 * воркеры очереди, потому что живут в том же процессе. События Битрикс24 не ретраятся,
 * значит один анонимный запрос стирает задачи всех клиентов. Поэтому считаем байты по
 * мере поступления и рвём соединение на превышении.
 *
 * ⚠ Событие Битрикс24 — единицы килобайт (в нём приходит только ID задачи), так что
 * потолок в 128 КБ не отсекает ничего настоящего.
 */
export const MAX_BODY_BYTES = 128 * 1024

/** @returns `null`, если тело больше потолка. */
export function readLimitedBody(event: H3Event, limit: number = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(getRequestHeader(event, 'content-length'))
  // ⚠ Ранний отказ по заголовку — оптимизация, а не защита: заголовок пишет клиент.
  if (Number.isFinite(declared) && declared > limit) return Promise.resolve(null)

  const request = event.node.req

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // ⚠ Рвём соединение, а не «дочитываем и отвечаем 413»: иначе отправитель
        // продолжает лить, и потолок защищает только на бумаге.
        request.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    request.on('aborted', () => finish(null))
    request.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}
