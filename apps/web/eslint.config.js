import next from '@alo-noon/eslint-config/next'

/**
 * The shared Next configuration, plus the one file it cannot parse.
 *
 * `public/sw.js` is a service worker: plain JavaScript, served verbatim, and
 * deliberately outside the TypeScript project — it is not bundled, imported or
 * type-checked, because a service worker that went through a build step would
 * be a service worker whose deployed contents nobody has read.
 *
 * That leaves the shared config's TypeScript parser trying to find it in a
 * tsconfig, and failing. The easy answer is to ignore `public/`. The wrong
 * answer is the same one: this file decides what a customer is shown when the
 * network is slow, and it is the last file in the repository that should go
 * unlinted. So it gets its own block with a plain parser and the globals a
 * worker actually has.
 */
export default [
  ...next,
  {
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      // The shared block sets `parserOptions.project`, which makes the
      // TypeScript parser insist the file belongs to a tsconfig. It does not
      // and should not. Turning the project off keeps the parser — it reads
      // plain JavaScript perfectly well — and drops only the type-aware rules,
      // which have nothing to say about a file with no types in it.
      parserOptions: { project: false },
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        console: 'readonly',
      },
    },
    // The TypeScript rules the shared config applies do not apply to a file it
    // does not parse; what is wanted here is the base rule set.
    rules: {},
  },
]
