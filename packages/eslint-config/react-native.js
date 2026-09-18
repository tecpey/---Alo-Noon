import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.expo/**', '**/eslint.config.js'] },
  {
    extends: [...tseslint.configs.recommended],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      /**
       * React Native's own `Text` and `TextInput` render in the system font.
       *
       * For Persian that is Geeza Pro on iOS and Noto Naskh on Android —
       * legible, and not the typeface the brand was built with. There is no
       * theme provider for type in React Native and a `<View>` passes no font
       * down, so a screen that imports the raw components silently opts out of
       * Vazirmatn for every label inside it. Nothing throws and nothing logs;
       * the app just stops looking like itself.
       *
       * `@alo-noon/mobile-ui` exports both with the family already applied, and
       * a style that names a heavier family still wins. Importing from there
       * costs one line and cannot be got wrong.
       */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['Text', 'TextInput'],
              message:
                "Import Text and TextInput from '@alo-noon/mobile-ui' — they carry Vazirmatn. React Native's own render Persian in the system font (Geeza Pro on iOS), silently.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
