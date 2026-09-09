# Releasing الو نون for Android

Everything in this repository is ready to build. What is not here is anything
that belongs to an account rather than to the code — a project id, a signing
key, a Firebase file. This is the list of those, in the order they are needed.

## What is already set

| Thing                              | Where                                         |
| ---------------------------------- | --------------------------------------------- |
| Package name `ir.alonoon.customer` | `app.json` → `android.package`                |
| Version `1.0.0`                    | `app.json` → `version`                        |
| Build profiles                     | `eas.json`                                    |
| Adaptive icon and splash           | `assets/`                                     |
| Notification icon and channel      | `app.json` → `plugins` → `expo-notifications` |

`versionCode` is deliberately absent. `eas.json` sets
`cli.appVersionSource: "remote"`, so EAS keeps the build number itself and
increments it on every production build. That is one fewer number to forget and
one fewer merge conflict; the trade is that a build outside EAS needs it set
locally.

## What you have to provide

### 1. An Expo account, and a project

```bash
npm install -g eas-cli
eas login
cd apps/customer-mobile
eas init          # creates the project and writes extra.eas.projectId into app.json
```

That id is also what push notifications need. `src/push.ts` already checks for
it and returns `NOT_CONFIGURED` when it is missing, falling back to SMS — which
is why the app works today without it, and why nothing will tell you it is
missing except this file.

### 2. The API's address

The app reads `EXPO_PUBLIC_API_BASE_URL` and refuses anything that is not an
`http`/`https` origin without a path. `eas.json` sets it only for the
`development` profile, pointing at `10.0.2.2:3001` — the Android emulator's name
for the machine it runs on.

`preview` and `production` deliberately do **not** set it here, because the
domain is not decided yet and a guessed URL committed to a repository is a build
that silently talks to nothing. Set it per profile in the Expo dashboard, or add
it to `eas.json` once the domain is real:

```jsonc
"production": { "env": { "EXPO_PUBLIC_API_BASE_URL": "https://<the real domain>" } }
```

An app built without it starts and says it is not configured, which is a state
`App.tsx` handles on purpose — better than a white screen, and still not
something to ship.

### 3. Push, if you want it

Android push goes through Firebase, so:

1. Create a Firebase project, add an Android app with package
   `ir.alonoon.customer`, download `google-services.json`.
2. Upload it to EAS (`eas credentials`) rather than committing it — it names
   your project and belongs with the signing key, not in git.
3. Point `app.json` at it:
   `"android": { "googleServicesFile": "./google-services.json" }`, and keep
   that file out of the repository.

Skip all of this and the app is still complete: every order message also goes by
SMS, which is the path `push.ts` was written to fall back to.

### 4. Signing

`eas build` offers to generate and keep an Android keystore the first time. Let
it. A keystore that lives on somebody's laptop is a keystore that eventually
means the app can never be updated again.

## Building

```bash
cd apps/customer-mobile

eas build --profile preview    --platform android   # an APK to install by hand
eas build --profile production --platform android   # an AAB for Google Play
```

`preview` produces an APK, which is what you send somebody to try. Play needs
the `production` profile's app bundle.

## Before the first submission

- **Screenshots** — at least two phone screenshots. Play rejects a listing
  without them.
- **Feature graphic** — 1024×500.
- **Privacy policy URL** — `https://<domain>/legal/privacy`, which already
  exists and is already reachable without signing in.
- **Data safety form** — the app collects a mobile number, an address and
  location. All three are declared in the privacy page; the form has to agree
  with it.

## Iran, and the stores

Google Play does not serve Iran, and an Iranian developer account cannot be
opened. In practice the APK from the `preview` profile is what gets distributed
— directly, and through Cafe Bazaar or Myket, both of which accept an APK and
have their own console. Nothing in this configuration is specific to Google Play
except the `production` profile's app bundle, which those stores do not need.

The PWA is the other half of that answer, and needs no store at all: once the
site is on HTTPS, `https://<domain>` installs to a home screen from the browser.
