import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, hashToken, tokenMatchesHash } from '../src/crypto.js'

const key = '0'.repeat(64)

describe('encryptSecret / decryptSecret', () => {
  it('расшифровывается обратно', () => {
    const enc = encryptSecret('refresh-token-value', key)
    expect(enc).not.toContain('refresh-token-value')
    expect(decryptSecret(enc, key)).toBe('refresh-token-value')
  })

  it('каждый раз разный шифротекст (свой IV)', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key))
  })

  // ⚠ GCM обязан ловить подмену: молча расшифрованный мусор ушёл бы в портал как токен.
  it('подделанный шифротекст не расшифровывается', () => {
    const enc = encryptSecret('secret', key)
    const parts = enc.split('.')
    const broken = [parts[0], parts[1], Buffer.from('другое').toString('base64url')].join('.')
    expect(() => decryptSecret(broken, key)).toThrow()
  })

  it('чужой ключ не расшифровывает', () => {
    const enc = encryptSecret('secret', key)
    expect(() => decryptSecret(enc, 'f'.repeat(64))).toThrow()
  })

  it('короткий ключ — ошибка на месте, а не потом', () => {
    expect(() => encryptSecret('x', 'abcd')).toThrow(/32 байт/)
  })
})

describe('tokenMatchesHash', () => {
  it('свой токен проходит, чужой нет', () => {
    const hash = hashToken('app-token')
    expect(tokenMatchesHash('app-token', hash)).toBe(true)
    expect(tokenMatchesHash('app-token-2', hash)).toBe(false)
    expect(tokenMatchesHash('', hash)).toBe(false)
  })

  it('мусор вместо хэша не проходит', () => {
    expect(tokenMatchesHash('app-token', 'не-хэш')).toBe(false)
  })
})
