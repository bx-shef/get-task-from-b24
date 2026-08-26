/**
 * Шифрование OAuth-токенов портала перед записью в базу и сверка application_token.
 *
 * ⚠ Токены порталов — это полный доступ к задачам клиента. В базе они лежат
 * зашифрованными (AES-256-GCM, ключ B24_TOKEN_ENC_KEY), чтобы дамп базы не был
 * дампом доступов ко всем 20–30 порталам сразу.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex')
  // ⚠ Короткий ключ не «слабее шифрует», а роняет createCipheriv — и упасть об это
  // лучше на старте, чем в момент установки приложения у клиента.
  if (key.length !== 32) {
    throw new Error('B24_TOKEN_ENC_KEY: нужен ключ из 32 байт в hex (openssl rand -hex 32)')
  }
  return key
}

/** Возвращает строку `iv.tag.cipher` в base64url — самодостаточную для расшифровки. */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyFromHex(keyHex), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join('.')
}

export function decryptSecret(payload: string, keyHex: string): string {
  const parts = payload.split('.')
  if (parts.length !== 3) throw new Error('Зашифрованное значение повреждено: ожидались три части')
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer]

  const decipher = createDecipheriv(ALGORITHM, keyFromHex(keyHex), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/**
 * `application_token` хранится хэшем: сверять его можно и так, а красть из базы
 * становится нечего.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * ⚠ Сравнение постоянного времени. Обычное `===` на секрете, приходящем снаружи,
 * подсказывает подбирающему длину общего префикса.
 */
export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
