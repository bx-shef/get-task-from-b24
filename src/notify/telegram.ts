/**
 * Отправка сообщений в Telegram. Отдельный шаг очереди: упавшее сообщение не должно
 * приводить к повторному созданию задачи (docs/PROCESSING.md).
 */
export interface TelegramTarget {
  botToken: string
  chatId: string
}

export class TelegramError extends Error {}

/**
 * ⚠ Telegram отвергает сообщения длиннее 4096 символов ЦЕЛИКОМ. В тексте едут название
 * задачи клиента и текст ошибки — то есть обрезать обязаны мы, иначе сигнал об аварии
 * не доходит ровно в аварии. Найдено вторым циклом ревью.
 */
export const MAX_MESSAGE_LENGTH = 4000

export function clampMessage(text: string): string {
  return text.length <= MAX_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
}

export async function sendTelegramMessage(target: TelegramTarget, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: target.chatId,
      text: clampMessage(text),
      // ⚠ Без parse_mode намеренно: в тексте едут названия задач клиентов, а любой
      // «*» или «_» из чужого заголовка ломал бы отправку разметкой.
      disable_web_page_preview: true,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new TelegramError(`Telegram ответил ${response.status}: ${body.slice(0, 200)}`)
  }
}
