module.exports = {
  env: {
    browser: true,
    es2021: true,
  },
  extends: [
    'eslint:recommended',
    'prettier',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['tsconfig.json'],
  },
  plugins: ['@typescript-eslint', 'header'],
  rules: {
    '@typescript-eslint/restrict-template-expressions': [
      'error',
      {
        allowNumber: true,
        allowBoolean: true,
        allowAny: false,
        allowNullish: true,
        allowRegExp: false,
      },
    ],
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'warnning',
    'header/header': [
      2,
      'line',
      [
        {
          pattern:
            ' Copyright \\d{4}(-\\d{4})? SubQuery Pte Ltd authors & contributors',
          template:
            ' Copyright 2020-2022 SubQuery Pte Ltd authors & contributors',
        },
        ' SPDX-License-Identifier: Apache-2.0',
      ],
      2,
    ],
  },
};
