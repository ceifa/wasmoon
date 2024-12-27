import eslint from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import tseslint from 'typescript-eslint'

export default [
    {
        ignores: ['**/dist/*', '**/build/*', '**/rolldown.config.js', '**/utils/*', 'eslint.config.mjs'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintPluginPrettierRecommended,
    {
        files: ['test/**/*.mjs', 'bench/**/*.js'],
        rules: {
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            'no-undef': 'off',
        },
    },
    {
        files: ['**/*.js', '**/*.mjs', '**/*.ts'],
        ignores: ['**/test/*', '**/bench/*'],
        plugins: {
            'simple-import-sort': simpleImportSort,
        },
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 'latest',
            sourceType: 'script',
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        rules: {
            'no-console': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/restrict-plus-operands': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/camelcase': 'off',
            '@typescript-eslint/member-naming': 'off',

            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                },
            ],

            '@typescript-eslint/member-ordering': [
                'error',
                {
                    classes: [
                        'public-static-field',
                        'protected-static-field',
                        'private-static-field',
                        'public-static-method',
                        'protected-static-method',
                        'private-static-method',
                        'public-instance-field',
                        'protected-instance-field',
                        'private-instance-field',
                        'public-constructor',
                        'protected-constructor',
                        'private-constructor',
                        'public-instance-method',
                        'protected-instance-method',
                        'private-instance-method',
                    ],
                },
            ],

            'curly': ['error', 'all'],
            'eqeqeq': 'error',
            'max-classes-per-file': 'error',
            'no-alert': 'error',
            'no-caller': 'error',
            'no-eval': 'error',
            'no-extend-native': 'error',
            'no-extra-bind': 'error',
            'no-implicit-coercion': 'error',
            'no-labels': 'error',
            'no-new': 'error',
            'no-new-func': 'error',
            'no-new-wrappers': 'error',
            'no-octal-escape': 'error',
            'no-return-assign': 'error',
            'no-self-compare': 'error',
            'no-sequences': 'error',
            'no-throw-literal': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-useless-call': 'error',
            'no-useless-concat': 'error',
            'no-void': 'error',
            'prefer-promise-reject-errors': 'error',
            'radix': ['error', 'always'],
            'no-shadow': 'off',

            'no-duplicate-imports': 'error',
            'prefer-numeric-literals': 'error',
            'prefer-template': 'error',
            'symbol-description': 'error',

            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                },
            ],

            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],

            '@typescript-eslint/explicit-function-return-type': [
                'error',
                {
                    allowExpressions: true,
                    allowTypedFunctionExpressions: true,
                    allowHigherOrderFunctions: true,
                },
            ],

            '@typescript-eslint/interface-name-prefix': 'off',
            '@typescript-eslint/no-redundant-type-constituents': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-parameter-properties': 'off',
            '@typescript-eslint/no-require-imports': 'error',
            '@typescript-eslint/no-useless-constructor': 'error',
            '@typescript-eslint/prefer-for-of': 'error',
            'prettier/prettier': 'error',
        },
    },
]
