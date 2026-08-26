/**
 * Токены порталов клиентов: пишутся при установке, обновляются при продлении.
 * В базе лежат зашифрованными (src/crypto.ts).
 */
import { decryptSecret, encryptSecret, hashToken, tokenMatchesHash } from '../crypto.js'
import type { Pool } from './db.js'

export interface PortalAuth {
  accessToken: string
  refreshToken: string
  clientEndpoint: string
  serverEndpoint: string
}

export interface StoredPortal extends PortalAuth {
  domain: string
  memberId: string
  expiresAt: Date
}

interface Row {
  domain: string
  member_id: string
  application_token_hash: string
  auth_enc: string
  expires_at: Date
}

export interface SaveInstallInput {
  domain: string
  memberId: string
  applicationToken: string
  auth: PortalAuth
  expiresAt: Date
}

/**
 * ⚠ Повторная установка на том же портале обязана перезаписывать запись, а не падать:
 * клиент переустанавливает приложение именно тогда, когда что-то пошло не так, и
 * отказ в этот момент означает портал, который больше не подключить.
 */
export async function saveInstall(pool: Pool, input: SaveInstallInput, encKey: string): Promise<void> {
  await pool.query(
    `insert into portal_tokens (domain, member_id, application_token_hash, auth_enc, expires_at)
     values ($1, $2, $3, $4, $5)
     on conflict (domain) do update set
       -- ⚠ Пустым значением сохранённый member_id не затираем: он охраняет установку
       -- от перехвата, а затёртый выключает проверку навсегда (находка ревью).
       member_id = coalesce(nullif(excluded.member_id, ''), portal_tokens.member_id),
       application_token_hash = excluded.application_token_hash,
       auth_enc = excluded.auth_enc,
       expires_at = excluded.expires_at,
       updated_at = now()`,
    [
      input.domain,
      input.memberId,
      hashToken(input.applicationToken),
      encryptSecret(JSON.stringify(input.auth), encKey),
      input.expiresAt,
    ],
  )
}

export async function getPortal(pool: Pool, domain: string, encKey: string): Promise<StoredPortal | null> {
  const { rows } = await pool.query<Row>('select * from portal_tokens where domain = $1', [domain])
  const row = rows[0]
  if (!row) return null

  const auth = JSON.parse(decryptSecret(row.auth_enc, encKey)) as PortalAuth
  return { domain: row.domain, memberId: row.member_id, expiresAt: row.expires_at, ...auth }
}

/**
 * Сверка `application_token` из события с сохранённым при установке.
 *
 * ⚠ Единственное, что отличает событие портала от подделки: эндпоинт открыт миру.
 * Портала нет в базе — отказ, а не «пропустим, разберёмся в очереди».
 */
export async function verifyApplicationToken(pool: Pool, domain: string, token: string): Promise<boolean> {
  const { rows } = await pool.query<{ application_token_hash: string }>(
    'select application_token_hash from portal_tokens where domain = $1',
    [domain],
  )
  const hash = rows[0]?.application_token_hash
  if (!hash) return false
  return tokenMatchesHash(token, hash)
}

export async function updateAuth(
  pool: Pool,
  domain: string,
  auth: PortalAuth,
  expiresAt: Date,
  encKey: string,
): Promise<void> {
  await pool.query(
    `update portal_tokens set auth_enc = $2, expires_at = $3, updated_at = now() where domain = $1`,
    [domain, encryptSecret(JSON.stringify(auth), encKey), expiresAt],
  )
}

/**
 * Удаление портала при `ONAPPUNINSTALL`.
 *
 * ⚠ Копить токены удалённых приложений незачем: они уже недействительны, а в базе
 * остаются как действующая установка — и портал выглядит подключённым, ничего не
 * перенося.
 */
export async function deletePortal(pool: Pool, domain: string): Promise<void> {
  await pool.query('delete from portal_tokens where domain = $1', [domain])
}
