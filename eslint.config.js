import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'coverage', 'test-results', 'playwright-report', 'evidence', '.wrangler'] },
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
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use src/api/client.ts for network requests.' },
        { name: 'XMLHttpRequest', message: 'Use src/api/client.ts for network requests.' },
      ],
      'no-restricted-properties': ['error', ...['window', 'self', 'globalThis'].map((object) => ({ object, property: 'fetch', message: 'Use src/api/client.ts for network requests.' }))],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='WebSocket']",
          message: 'Use the API client for network requests.',
        },
        {
          selector: "CallExpression[callee.object.name='navigator'][callee.property.name='sendBeacon']",
          message: 'Do not send telemetry.',
        },
      ],
    },
  },
  {
    files: ['src/api/**/*.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    files: ['worker/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.worker, ...globals.serviceworker, ...globals.node } },
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off', 'react-hooks/rules-of-hooks': 'off' },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
