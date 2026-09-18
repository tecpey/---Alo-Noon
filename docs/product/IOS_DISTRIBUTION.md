# Alo Noon on iPhone

What exists today, what blocks an App Store release, and what each remaining
route would cost. Written because "can we do an iOS version?" has a technical
answer and a commercial one, and they disagree.

The status column is meant to be checkable against the code, not against a plan.

## The short version

The code is close. The App Store is closed.

Apple does not accept developer enrollments from Iran, and states the reason in
the rejection itself:

> Unfortunately, there is no App Store available for the territory of Iran.
> Additionally, apps facilitating transactions for businesses or entities based
> in Iran may not comply with the Iranian Transactions Sanctions Regulations (31
> CFR Part 560) when hosted on the App Store. For these reasons, we are unable
> to accept your application at this time.

Both sentences apply here. Alo Noon is operated from Iran, and it moves money
for bakeries and couriers based in Iran — which is the second sentence
precisely, not a technicality that a careful filing gets around.

The Enterprise-certificate workaround was tried at scale by Iranian companies
after the 2017 App Store removals. Apple revoked those certificates worldwide in
2019 and the apps stopped launching on every phone at once, without warning.
Anything built on that route inherits that failure mode.

An iPhone can still run this product. It is the _store_ that is unavailable, not
the device.

## What the repository already has

| Capability                    | Where                                                          | Status                                                                                                   |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| iOS bundle identifiers        | `apps/*/app.json`                                              | `ir.alonoon.customer`, `ir.alonoon.courier`                                                              |
| iOS permission strings        | `apps/customer-mobile/app.json`                                | location and `ITSAppUsesNonExemptEncryption` declared, in Persian                                        |
| iOS simulator build profile   | `apps/*/eas.json`                                              | `preview.ios.simulator` only                                                                             |
| RTL layout                    | both Expo apps                                                 | hand-built (`row-reverse`, `textAlign`), so platform-independent — no `I18nManager.forceRTL` to go wrong |
| Installable web app           | `apps/web/src/app/manifest.ts`                                 | manifest, service worker, maskable icons, shortcuts                                                      |
| iOS home-screen metadata      | `apps/web/src/app/layout.tsx`                                  | title, status bar style, 180px touch icon                                                                |
| Web push                      | `apps/api/src/providers/web-push*.ts`, `apps/web/public/sw.js` | RFC 8291 + RFC 8292; a second transport on `CustomerPushDevice`, prompted above a live order             |
| Persian font in the Expo apps | —                                                              | **not implemented**; no `expo-font`, no `fontFamily` anywhere                                            |

## Defects fixed in `821f47a`

All three were invisible from a desktop browser and from the test suite, and all
three affected only iOS.

**Every `env(safe-area-inset-*)` computed to zero.** Safari's default viewport
is `viewport-fit=auto`: it fits the page inside the safe area itself and reports
all four insets as `0px`. The header's clearance under the sensor housing, the
footer's over the home indicator, the basket's checkout button above the gesture
bar — each written for a notched iPhone, each commented as such — did nothing
there. `viewportFit: 'cover'` turns them on.

The guard test asserted the stylesheets _use_ the insets and passed throughout.
Checking the CSS and the viewport separately is what let them disagree; they are
now asserted together.

**Content between the header and the footer had no inset.** Held sideways, a
notched iPhone puts 44px of sensor housing over one edge. The header and footer
carry their own insets because their backgrounds are full-bleed and must stay
that way, which left everything between them exposed once the insets became
real. `main` now carries one, in physical properties — the page is RTL, but the
notch is on whichever side the hardware puts it.

**The home-screen icon had black corners.** `apple-icon.png` was 11.5%
transparent with fully clear corners. iOS composites a home-screen icon against
black and then applies its own squircle, so the installed icon showed black
corners around its own rounded ones. Flattened onto the brand ember — the same
plate Android's maskable icon uses, so the icon installed from Safari and the
icon installed from Android are now one icon.

**`apple-mobile-web-app-capable` restored.** Next.js emits only the standard
`mobile-web-app-capable` now, to silence a Chrome deprecation warning, and iOS
does not read that name. Standalone display survives because Safari takes it
from the manifest; the launch image does not — iOS paints one only when the
deprecated tag is present, and that tag is also Safari's fallback when the
manifest fails to load, which on a slow connection is not hypothetical.

## The three routes

### 1. Installed web app, from Safari

No Apple account, no review, no revocation risk, and the same codebase the web
already ships. This is what Iranian services do in practice.

Done since this was written:

- **Web push.** The recommendation below — treat web push as the real
  deliverable — is implemented. `CustomerPushDevice` carries a second transport
  beside Expo, the payload is encrypted to the browser under RFC 8291 and the
  server identifies itself under RFC 8292, both verified against the RFCs' own
  worked examples. A deployment turns it on with three environment variables
  (`pnpm --filter @alo-noon/api vapid-keys`); with none of them the shop behaves
  exactly as it did before and every message goes by SMS.

  The permission is asked for on the orders screen, above an order that is
  actually moving, and nowhere else. A browser gives one prompt and treats a
  refusal as final, so the moment it is spent decides whether this customer can
  ever be told their bread arrived.

Remaining work:

- **Verification on a real iPhone.** The encryption is proved against the
  specification, not against Safari. Nothing here has shown a notification on
  Apple hardware, and the failure mode if something is wrong is silence rather
  than an error.
- **Launch images.** iOS wants `apple-touch-startup-image` per device size; a
  PWA without them shows a white screen on cold start.

What it cannot do: appear in App Store search, or use anything the web platform
withholds on iOS.

### 2. Native build under a non-Iranian legal entity

Needs a company outside Iran and an Apple Developer account under it. The
technical work is real but ordinary:

- iOS build and submit profiles in `eas.json`; the current `development` profile
  hardcodes `10.0.2.2`, which is the **Android emulator's** loopback alias and
  resolves to nothing on an iOS simulator.
- Vazirmatn bundled via `expo-font`. Today no `fontFamily` is set anywhere in
  either Expo app, so iOS falls back to Geeza Pro for Persian — an Arabic face
  with wrong shaping for `گ`, `چ`, `پ` and `ژ`. The typography work done for the
  web never reached the phone apps.
- APNs key, push entitlement, and a review pass over the permission strings.

The risk is not the engineering. By Apple's own wording an app transacting for
Iran-based businesses does not comply with 31 CFR 560 regardless of who filed
the paperwork, so removal remains possible after launch — and a removed iOS app
cannot be reinstalled by the customers who had it.

### 3. Iranian iOS stores

Sibche, Sibapp and Anardoni distribute via Enterprise certificates. Apple
revoked those worldwide in 2019 and millions of installed apps stopped opening.
Least durable of the three; worth considering only if neither other route is
possible.

## Recommendation

Route 1, and treat web push as the real deliverable rather than the install
prompt. The install itself already works; being able to tell a customer their
bread is at the door is what makes an installed shop an app.

Route 2 is worth starting only once a foreign entity exists as a fact rather
than a plan — the engineering is a few days, the corporate structure is not, and
doing the engineering first does not bring the launch forward.

## Sources

- Apple's enrollment rejection text, and the 2017 removals:
  [BuzzFeed News](https://www.buzzfeednews.com/article/pranavdixit/apple-is-pulling-apps-by-iranian-developers-from-the-app),
  [AppleInsider](https://appleinsider.com/articles/17/08/25/apple-removes-iranian-apps-from-app-store-cites-us-sanctions)
- The 2019 Enterprise-certificate revocation:
  [Center for Human Rights in Iran](https://iranhumanrights.org/2019/03/millions-of-iphone-users-unable-to-use-iranian-apps-due-to-apple-certificate-revocation/)
- iOS PWA behaviour, including the launch-image dependency on
  `apple-mobile-web-app-capable`: [firt.dev](https://firt.dev/notes/pwa-ios/)
- Next.js dropping the Apple-specific tag:
  [vercel/next.js#70272](https://github.com/vercel/next.js/issues/70272),
  [vercel/next.js#74524](https://github.com/vercel/next.js/issues/74524)
