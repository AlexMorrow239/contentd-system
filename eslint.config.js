import eslintConfigPrettier from 'eslint-config-prettier'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

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
      '.claude/worktrees',
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
    files: ['remotion/**/*.tsx'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // Classic hooks-of-hooks/deps rules only — not the full v7 "recommended"
      // set, which is oriented at React Compiler adoption (immutability,
      // purity, gating, etc.) and doesn't apply here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // TypeScript validates props at compile time; the `prop-types` package
      // isn't even a dependency here.
      'react/prop-types': 'off',
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.browser,
    },
    settings: {
      react: {
        version: 'detect',
      },
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
  eslintConfigPrettier,
)
