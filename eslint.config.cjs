module.exports = [
  {
    ignores: [
      'node_modules/**',
      'downloads/**',
      'releases/**',
      'images/**',
      'uploads/**',
      'installer/**',
      '*.min.js',
      '*.min.css'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: true,
        document: true,
        navigator: true,
        process: true,
        crypto: true,
        fetch: true,
        localStorage: true,
        sessionStorage: true,
        indexedDB: true,
        Notification: true
      }
    },
    extends: ['eslint:recommended', 'prettier'],
    rules: {
      'no-console': 'off'
    }
  }
];
