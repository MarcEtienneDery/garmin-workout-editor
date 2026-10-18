module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/fixtures/'],
  maxWorkers: 1,
  // @garmin/fitsdk ships as ES modules only: ts-jest turns it into CommonJS for the tests (node 22 requires it as it is)
  transformIgnorePatterns: ['/node_modules/(?!@garmin/fitsdk/)'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { esModuleInterop: true } }],
    '/node_modules/@garmin/fitsdk/.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, esModuleInterop: true, checkJs: false }, diagnostics: false }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};
