/**
 * The one piece of `process` this app is allowed to see.
 *
 * Expo's build inlines `process.env.EXPO_PUBLIC_*` into the bundle, so the
 * literal expression has to survive into the source — but nothing else about
 * Node exists at runtime on a phone. Pulling in `@types/node` to satisfy one
 * lookup would tell TypeScript that `Buffer`, `fs` and friends are available
 * too, and the first person to believe it would ship code that crashes on a
 * device rather than failing to compile.
 *
 * Declared as possibly-undefined because a build that forgot to set it is a
 * real state this app handles rather than an impossible one.
 */
declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>
}
