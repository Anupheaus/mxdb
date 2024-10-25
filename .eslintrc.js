module.exports = {
  settings: {
    'import/resolver': {
      node: {
        moduleDirectory: ['node_modules', 'src/']
      }
    },
    react: {
      version: 'detect',
    },
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2019,
    sourceType: 'module'
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
    es6: true,
    commonjs: true,
    mocha: true
  },
  rules: {
    quotes: [
      'error',
      'single',
      {
        avoidEscape: true
      }
    ],
    indent: [
      'error',
      2,
      {
        SwitchCase: 1
      }
    ],
    'max-len': [
      'warn',
      {
        code: 210
      }
    ],
    '@typescript-eslint/consistent-type-imports': 'error',
    'arrow-parens': ['error', 'as-needed'],
    'sort-imports': 'off',
    'no-unused-vars': 'off',
    'no-shadow': 'off',
    'no-unused-expressions': 'off',
    'no-unused-labels': 'error',
    'prefer-const': [
      'error',
      {
        destructuring: 'all'
      }
    ],
    'max-classes-per-file': 'error',
    'no-inner-declarations': 'off',
    'no-console': 'warn',
    'no-alert': 'warn',
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
          'private-instance-method'
        ]
      }
    ],
    '@typescript-eslint/ban-types': 'off',
    '@typescript-eslint/no-empty-interface': 'off',
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/indent': ['error', 2],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/unified-signatures': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-shadow': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        args: 'after-used',
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        ignoreRestSiblings: true
      }
    ]
  }
};
