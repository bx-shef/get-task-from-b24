import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  srcDir: 'server',
  compatibilityDate: '2026-08-26',
  // Роуты объявляем файлами в server/routes; никакого фронтенда у сервиса нет.
  preset: 'node-server',
})
