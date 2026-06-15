import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'wasm']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // 미사용 인자/변수는 `_` 접두사로 의도를 표시한다 (예: Express 에러 미들웨어의 _next).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // react-compiler/HMR 계열 규칙은 점진 도입 단계. 기존 코드(트레이딩 핵심 훅 등)에
      // 의도된 패턴이 많아, 우선 warn 으로 가시화만 하고 빌드/CI 는 막지 않는다.
      // 추후 별도 리팩터 PR 에서 단계적으로 error 로 승격한다.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  // Prettier must be last to disable conflicting rules
  prettier,
]);
