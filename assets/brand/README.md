# Alo Noon brand-source governance

This directory preserves the four raster files supplied and approved by the Alo
Noon founder for repository provenance. They are **founder-approved raster
sources**, not canonical vector masters, transparent exports, print-ready
artwork, or automatic approval for production placement.

The files were committed byte-for-byte as supplied. This record establishes
repository provenance and permitted handling only; it does not assert trademark
registration, legal clearance, or ownership beyond repository evidence.

## Authoritative source inventory

| Path                                            | Classification and permitted use                                                                                                                                                                                      | Properties                                                                                                       | SHA-256                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `source/alo-noon-app-icon-light-source.jpeg`    | **App-icon candidate** and founder-approved raster source. Preserve as supplied; a production icon must be approved separately.                                                                                       | JPEG, 709×719, 49,396 bytes, RGB/sRGB, baked light rounded-square artwork with dark corner background, no alpha  | `7c729150bfe64a59e0481b22d286f57d1735583c3adc95a6f4222338325deb75` |
| `source/alo-noon-app-icon-orange-source.jpeg`   | **App-icon candidate** and founder-approved raster source. Preserve as supplied; a production icon must be approved separately.                                                                                       | JPEG, 709×718, 49,855 bytes, RGB/sRGB, baked orange rounded-square artwork with dark corner background, no alpha | `dcfc277694e797566714ae98c5d681f740376651c1d5e971e39b46e7b63b1161` |
| `source/alo-noon-mark-dark-source.jpeg`         | **Dark-placement candidate** and founder-approved raster source. Suitable only for review as supplied, not as a transparent or production-ready mark.                                                                 | JPEG, 1320×1649, 127,299 bytes, Display P3 profile, baked dark background, no alpha                              | `1d8554588b746c4e6a375828cb00fc4140390bfb1509593b2877c65272f077f6` |
| `source/alo-noon-primary-lockup-fa-source.jpeg` | **Founder-approved raster source, provenance-only for current product presentation.** It is rejected for README hero, marketing, and product-message use because it contains the unsupported slogan documented below. | JPEG, 1306×1555, 139,886 bytes, Display P3 profile, baked light background, no alpha                             | `b7da72aed11ad7b99d964ad9554e58744217069a92b19b2c1b1052ee7b4b10be` |

All four files decode successfully as baseline JPEG images. Visible raster
softness and compression are properties of the supplied files, not repository
transformations. The two portrait sources contain non-sensitive EXIF creation
timestamps and the description `Screenshot`; none of the four files exposes GPS
coordinates or an observed person/device identifier.

## Product-language restriction

`alo-noon-primary-lockup-fa-source.jpeg` includes the historical phrase «نان
داغ، زندگی گرم». It is preserved solely because it is part of the supplied
raster source. It must not be extracted, repeated, or treated as the Alo Noon
product promise. Binding product language is **fresh bread, never hot bread**
(«نان تازه»، نه «نان داغ»), and remains Persian-first and Iran-first.

## Handling rules

- Preserve every file in `source/` byte-for-byte. Do not redraw, trace,
  vectorize, crop, recolor, upscale, denoise, clean, or remove its background in
  place.
- Do not describe these JPEGs as transparent, adaptive, vector, print-ready,
  production-ready, or canonical masters.
- Do not infer a logo from capability badges, typography, screenshots, or
  application text.
- Do not connect a candidate to a README hero, favicon, application manifest, or
  shipping UI without a separate brand-only review and founder approval.
- Preserve source artwork whenever an approved derivative is later introduced,
  and document the derivative's source hash, dimensions, color profile,
  background constraints, and approval status.
- Do not commit proprietary font files without documented distribution rights.

## Deliverables still required

These raster sources do not automatically provide an approved transparent PNG,
SVG/vector master, favicon set, adaptive application icon, print-ready CMYK or
monochrome variant, horizontal slogan-free lockup, clear-space rule,
minimum-size rule, or definitive color specification. Those remain separate
brand deliverables and must not be fabricated from these files.

The README therefore continues to use a text heading. The compatibility index at
[`docs/assets/brand/README.md`](../../docs/assets/brand/README.md) points back
to this file as the single source of brand-asset governance.
