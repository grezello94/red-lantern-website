const { builtinRules } = require('eslint/use-at-your-own-risk');
const prettier = require('eslint-config-prettier');

const recommendedRules = Object.fromEntries(
  [...builtinRules]
    .filter(([, rule]) => rule.meta?.docs?.recommended)
    .map(([name]) => [name, 'error'])
);

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'downloads/**',
      'releases/**',
      'images/**',
      'uploads/**',
      'installer/**',
      'test-results/**',
      'playwright-report/**',
      '*.min.js',
      '*.min.css',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: Object.fromEntries(
        [
          'AbortController',
          'Blob',
          'Buffer',
          'CustomEvent',
          'Event',
          'EventSource',
          'File',
          'FileReader',
          'FormData',
          'Image',
          'Headers',
          'IntersectionObserver',
          'MutationObserver',
          'Notification',
          'Response',
          'ResizeObserver',
          'URL',
          'URLSearchParams',
          '__dirname',
          '__filename',
          'alert',
          'atob',
          'caches',
          'clearInterval',
          'clearTimeout',
          'confirm',
          'console',
          'crypto',
          'clients',
          'data',
          'document',
          'describe',
          'exports',
          'expect',
          'fetch',
          'getComputedStyle',
          'history',
          'indexedDB',
          'jest',
          'localStorage',
          'load',
          'location',
          'module',
          'navigator',
          'performance',
          'process',
          'prompt',
          'queueMicrotask',
          'require',
          'sessionStorage',
          'setInterval',
          'setTimeout',
          'self',
          'structuredClone',
          'test',
          'window',
        ].map((name) => [name, 'readonly'])
      ),
    },
    rules: {
      ...recommendedRules,
      ...prettier.rules,
      'no-console': 'off',
      // Existing browser scripts intentionally wrap and replace declared
      // functions to add persistence and offline behaviour.
      'no-func-assign': 'off',
      // Empty catches are used for optional browser/storage capabilities.
      'no-empty': 'off',
      // Legacy files contain intentionally unused compatibility bindings.
      'no-unused-vars': 'off',
      // Generated print HTML needs escaped closing script tags.
      'no-useless-escape': 'off',
      // Preserve-cause is useful for libraries but would change established
      // user-facing errors throughout this CommonJS/browser application.
      'preserve-caught-error': 'off',
    },
  },
];
