import reactNative from '@alo-noon/eslint-config/react-native'

/**
 * The shared React Native configuration, plus the tests that live outside the
 * app's TypeScript project.
 *
 * `release-config.test.ts` and `touch-targets.test.ts` sit at the app root
 * rather than under `src/`
 * because it reads files, which means `node:fs`, and `src/env.d.ts` exists to
 * keep Node's types out of this app — telling TypeScript that `fs` and `Buffer`
 * are available on a phone is how somebody ships code that crashes on a device
 * rather than failing to compile.
 *
 * The tsconfig therefore does not cover it, and the type-aware parser refuses
 * to lint a file it cannot place in a project. Turning the project off for this
 * one file keeps it linted, which is the point: it is the only thing standing
 * between a wrong package name and a twenty-minute build that fails.
 */
export default [
  ...reactNative,
  {
    files: ['release-config.test.ts', 'touch-targets.test.ts'],
    languageOptions: {
      parserOptions: { project: false },
    },
  },
]
