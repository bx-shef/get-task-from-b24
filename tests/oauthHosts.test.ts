/**
 * Allow-list сервера авторизации: туда уезжает `client_secret`, поэтому адрес из тела
 * запроса принимается только если он в точном списке.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_OAUTH_ENDPOINT, isKnownOauthHost, tokenEndpoint } from '../src/b24/oauthHosts.js'

describe('allow-list сервера авторизации', () => {
  it('пропускает известные хосты', () => {
    expect(isKnownOauthHost('https://oauth.bitrix24.tech/rest/')).toBe(true)
    expect(isKnownOauthHost('https://oauth.bitrix.info/rest/')).toBe(true)
    expect(isKnownOauthHost(DEFAULT_OAUTH_ENDPOINT)).toBe(true)
  })

  it('не пропускает чужой хост — иначе туда уедет client_secret', () => {
    expect(isKnownOauthHost('https://evil.tld/rest/')).toBe(false)
  })

  it('не обманывается логином в адресе', () => {
    // ⚠ hostname здесь `evil.tld`, но глазами читается как доверенный адрес.
    expect(isKnownOauthHost('https://oauth.bitrix24.tech@evil.tld/rest/')).toBe(false)
  })

  it('не пропускает поддомены и http', () => {
    expect(isKnownOauthHost('https://fake.oauth.bitrix24.tech/rest/')).toBe(false)
    expect(isKnownOauthHost('http://oauth.bitrix24.tech/rest/')).toBe(false)
  })

  it('мусор — это отказ, а не исключение', () => {
    expect(isKnownOauthHost('не адрес')).toBe(false)
    expect(isKnownOauthHost('')).toBe(false)
  })

  it('обмен токенов живёт по /oauth/token/ того же хоста', () => {
    expect(tokenEndpoint('https://oauth.bitrix24.tech/rest/')).toBe('https://oauth.bitrix24.tech/oauth/token/')
  })
})
