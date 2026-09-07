# Brand images

## Drawn by hand

| File                  | What it is                                                      |
| --------------------- | --------------------------------------------------------------- |
| `app-icon.png`        | 512×512, the mark on a rounded square with transparent corners. |
| `logo-lockup.png`     | The mark with the wordmark beside it, for wide spaces.          |
| `logo-mark.png`       | The mark alone, on paper.                                       |
| `logo-mark-light.png` | The mark alone, for dark surfaces.                              |

## Derived — do not edit by hand

These four are generated from the two above and are what
[`app/manifest.ts`](../../src/app/manifest.ts) points a phone at. Edit the
sources, regenerate, commit the results.

| File                    | Purpose    | Derived from                    |
| ----------------------- | ---------- | ------------------------------- |
| `icon-192.png`          | `any`      | `app-icon.png`, resized         |
| `icon-512.png`          | `any`      | `app-icon.png`, resized         |
| `icon-maskable-192.png` | `maskable` | the Android app's adaptive icon |
| `icon-maskable-512.png` | `maskable` | the Android app's adaptive icon |

### Why the maskable ones are a different picture

Android does not put the `any` icon on a home screen. It takes a `maskable` one
and cuts it into whatever shape the launcher uses — a circle, a squircle, a
teardrop — so anything near the edge is lost, and transparent corners come out
as a logo floating in a grey blob.

So the maskable pair is built from
`apps/customer-mobile/assets/adaptive-icon.png`, the same foreground layer the
Android app ships, cropped to the inner **66%** a launcher actually shows and
composited on the brand orange `#ED8732` with the alpha channel removed. The
result is that the icon somebody installs from the web and the icon they install
from the store are the same icon, and neither can be clipped: the mark sits
about **24%** in from every edge, where the maskable safe zone asks for at least
10%.

`app/manifest.test.ts` checks the files exist, match their declared sizes and
carry no alpha channel. It cannot check the safe zone — that is what the 66%
crop is for, and why it is written down here.

### Regenerating

Needs `sharp`, which is present as a transitive dependency of Next rather than
declared, so this is a paste-and-run rather than a package script — a script
that silently depends on somebody else's dependency is a script that breaks on
an upgrade nobody connected to it.

```js
// node this from the repository root
const sharp = require('sharp')
const OUT = 'apps/web/public/brand'
const BRAND = '#ED8732'

for (const size of [192, 512]) {
  sharp(`${OUT}/app-icon.png`)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/icon-${size}.png`)
}

const inner = Math.round(1024 * 0.66)
const offset = Math.round((1024 - inner) / 2)
sharp('apps/customer-mobile/assets/adaptive-icon.png')
  .extract({ left: offset, top: offset, width: inner, height: inner })
  .toBuffer()
  .then(async (cropped) => {
    for (const size of [192, 512]) {
      await sharp({
        create: { width: size, height: size, channels: 4, background: BRAND },
      })
        .composite([
          { input: await sharp(cropped).resize(size, size).toBuffer() },
        ])
        .flatten({ background: BRAND })
        .removeAlpha()
        .png({ compressionLevel: 9 })
        .toFile(`${OUT}/icon-maskable-${size}.png`)
    }
  })
```
