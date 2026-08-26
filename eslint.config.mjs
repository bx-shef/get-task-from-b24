import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['.nitro/**', '.output/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Ловим забытый await у REST-вызовов: молча проглоченная ошибка сети здесь
      // означает потерянную задачу клиента.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
)
