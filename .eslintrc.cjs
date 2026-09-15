module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/eslint-recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    browser: true,
    node: true,
    es2022: true,
    commonjs: true,
  },
  rules: {
    // Style
    quotes: ['error', 'single', { avoidEscape: true }],
    indent: ['error', 2, { SwitchCase: 1 }],
    'max-len': ['warn', { code: 210 }],
    'arrow-parens': ['error', 'as-needed'],
    'prefer-const': ['error', { destructuring: 'all' }],
    'max-classes-per-file': 'error',
    'no-console': 'warn',
    'no-alert': 'warn',
    'no-unused-labels': 'error',

    // Off — handled by TypeScript or @typescript-eslint equivalents
    'sort-imports': 'off',
    'no-unused-vars': 'off',
    'no-shadow': 'off',
    'no-unused-expressions': 'off',
    'no-inner-declarations': 'off',

    // TypeScript
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/unified-signatures': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-shadow': 'warn',
    '@typescript-eslint/ban-types': 'off',
    '@typescript-eslint/no-empty-interface': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        args: 'after-used',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
    '@typescript-eslint/member-ordering': [
      'warn',
      {
        default: [
          'constructor',
          'private-static-field',
          'protected-static-field',
          'public-static-field',
          'public-static-method',
          'protected-static-method',
          'private-static-method',
          'private-instance-field',
          'protected-instance-field',
          'public-instance-field',
          'public-instance-method',
          'protected-instance-method',
          'private-instance-method',
        ],
      },
    ],
  },
};
