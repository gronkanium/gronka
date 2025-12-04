import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'temp/**',
      'logs/**',
      '*.log',
      'dist/**',
      'build/**',
      'coverage/**',
      '.vscode/**',
      '.idea/**',
      'src/public/assets/**',
      '**/*.svelte',
      'vendor/**',
      '_site/**',
    ],
  },
  eslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
    },
  },
  {
    files: ['src/webui/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        WebSocket: 'readonly',
        MutationObserver: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['functions/**/*.js'],
    languageOptions: {
      globals: {
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        TransformStream: 'readonly',
        crypto: 'readonly',
        caches: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
];
