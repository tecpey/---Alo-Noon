import reactNative from '@alo-noon/eslint-config/react-native'

/**
 * The shared React Native configuration, plus the tests that live outside the
 * app's TypeScript project.
 *
 * `fonts.test.ts` sits at the app root rather than under `src/` because it
 * reads files, which means `node:fs`, and `src/env.d.ts` exists to keep Node's
 * types out of this app — telling TypeScript that `fs` and `Buffer` are
 * available on a phone is how somebody ships code that crashes on a device
 * rather than failing to compile.
 *
 * The tsconfig therefore does not cover it, and the type-aware parser refuses
 * to lint a file it cannot place in a project. Turning the project off for that
 * one file keeps it linted.
 */
export default [
  ...reactNative,
  {
    files: ['fonts.test.ts'],
    languageOptions: {
      parserOptions: { project: false },
    },
  },
]
