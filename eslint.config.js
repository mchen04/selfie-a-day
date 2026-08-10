import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'coverage', 'test-results', 'playwright-report', 'evidence'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.serviceworker },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Guardrail for the whole point of this app: nothing may ship image bytes
      // off the device. Any network primitive in app code must be justified.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'This app is local-first: no app code may make network requests.' },
        { name: 'XMLHttpRequest', message: 'This app is local-first: no app code may make network requests.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='WebSocket']",
          message: 'This app is local-first: no app code may open sockets.',
        },
        {
          selector: "CallExpression[callee.object.name='navigator'][callee.property.name='sendBeacon']",
          message: 'This app is local-first: no telemetry.',
        },
      ],
    },
  },
  {
    // The service worker legitimately uses fetch/caches for offline app-shell
    // delivery. It never reads or transmits IndexedDB photo data.
    files: ['src/sw.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
