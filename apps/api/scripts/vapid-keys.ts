/**
 * Prints one VAPID key pair, ready to paste into a deployment's environment.
 *
 * `pnpm --filter @alo-noon/api vapid-keys`
 *
 * A pair is generated once per deployment and then left alone. Rotating it is
 * not a routine act: every subscription a browser has made is bound to the
 * public key it subscribed with, so a new pair silently stops every existing
 * one working and every customer has to be asked again — and a customer who
 * already granted notification permission is never re-prompted, so they simply
 * stop hearing anything. If a rotation is unavoidable, expect to clear the
 * browser rows and let them re-subscribe.
 *
 * The private key is a signing key. It belongs in the environment beside the
 * authentication peppers, not in the repository, and not in a commit message.
 * The public key is published to every browser by design and is not a secret.
 */
import { generateVapidKeys } from '../src/providers/web-push-crypto.js'

const keys = generateVapidKeys()

process.stdout.write(
  [
    '# Web push (RFC 8292). All three together or none — the configuration',
    '# schema refuses a partial set, because a public key without its private',
    '# key makes the shop ask for a notification permission it can never use,',
    '# and on most browsers a refusal cannot be asked about again.',
    `WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `WEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`,
    '# A contact a push service operator could reach. Theirs, when they decide',
    '# this server is misbehaving, is the alternative to being blocked silently.',
    'WEB_PUSH_SUBJECT=mailto:',
    '',
  ].join('\n'),
)
