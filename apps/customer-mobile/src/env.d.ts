/**
 * The one piece of `process` this app is allowed to see.
 *
 * Expo's build replaces `process.env.EXPO_PUBLIC_*` with a literal at bundle
 * time — but only where it is written as a property access. Written as
 * `process.env['EXPO_PUBLIC_API_BASE_URL']` the substitution never happens, the
 * bundle ships the lookup intact, and the app tells every user that it has not
 * been configured no matter what the build set. That is what this declaration
 * exists to prevent: naming the key here is what lets the code use dot access
 * under `noPropertyAccessFromIndexSignature`, which is what made the bracket
 * form look like the only option in the first place.
 *
 * Nothing else about Node exists at runtime on a phone. Pulling in `@types/node`
 * to satisfy one lookup would tell TypeScript that `Buffer`, `fs` and friends
 * are available too, and the first person to believe it would ship code that
 * crashes on a device rather than failing to compile.
 *
 * Declared as possibly-undefined because a build that forgot to set it is a
 * real state this app handles rather than an impossible one.
 */
declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_API_BASE_URL?: string
  }
}
