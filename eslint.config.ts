import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'drizzle/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Fastify plugins and handlers are async by contract, even when the body has nothing to await.
      '@typescript-eslint/require-await': 'off',
      'no-console': 'error',
    },
  },
  // Dependency rule (Clean Architecture): domain depends on nothing; application depends only on domain.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/infrastructure/**', '**/http/**', '**/config.js'],
              message: 'The domain must not depend on outer layers.',
            },
            {
              group: [
                'fastify*',
                '@fastify/*',
                'drizzle-orm*',
                'pg',
                'pg-boss',
                'undici',
                'pino*',
                'zod*',
              ],
              message: 'The domain must stay free of frameworks and I/O libraries.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '**/http/**'],
              message:
                'The application layer talks to infrastructure only through ports (interfaces).',
            },
            {
              group: ['fastify*', '@fastify/*', 'drizzle-orm*', 'pg', 'pg-boss', 'undici'],
              message: 'The application layer must not depend on frameworks or drivers.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
