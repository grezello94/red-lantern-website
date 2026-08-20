module.exports = {
  testEnvironment: 'jsdom',
  testPathIgnorePatterns: ['/node_modules/', '/releases/', '/downloads/', '/tests/'],
  setupFilesAfterEnv: ['@testing-library/jest-dom'],
};
