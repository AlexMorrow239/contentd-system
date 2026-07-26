import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'runs',
      'runs-dev',
      'data',
      '.remotion',
      'node_modules',
      'channels-dev',
      'sandbox',
    ],
  },
  {
    files: ['src/**/*.ts', 'remotion/**/*.ts', 'deploy/**/*.ts', 'vitest.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
  },
  {
    // Mocking with vi.fn()/untyped fixtures inherently produces `any`-typed
    // values and object methods detached from their instance — these rules
    // catch real bugs in application code but are just noise in tests.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
)
