// Jest config for the Zernio integration tests.
// Run from the repo root: pnpm exec jest -c libraries/nestjs-libraries/src/integrations/zernio/jest.config.js
const path = require('path');

const root = path.resolve(__dirname, '../../../../..');

module.exports = {
  rootDir: root,
  testEnvironment: 'node',
  roots: ['<rootDir>/libraries/nestjs-libraries/src/integrations/zernio'],
  testMatch: ['**/*.spec.ts'],
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          isolatedModules: true,
          target: 'es2021',
          module: 'commonjs',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
  },
};
