# Alo Noon brand asset governance

## Current repository status

No approved Alo Noon logo master is tracked in this repository. The governance
record in
[`ALO_NOON_PROJECT_GOVERNANCE_FA.md`](../../00-governance/ALO_NOON_PROJECT_GOVERNANCE_FA.md)
and the Phase 2D review in
[`PHASE_2D_SERVER_CART_QUOTE.md`](../../architecture/PHASE_2D_SERVER_CART_QUOTE.md)
state that previously supplied raster files were references, not a production
master. Those files are not present on `main`.

For that reason, this documentation change does **not** redraw, approximate,
recolor, trace, or manufacture an Alo Noon logo. The README hero uses a clearly
identified temporary text heading, not an official logo or permanent brand
lockup.

A raster composition was supplied in the documentation conversation, but its
temporary attachment path was unavailable to the repository build and could not
be preserved byte-for-byte. It also includes the phrase «نان داغ، زندگی گرم»,
which conflicts with the binding **fresh bread, never hot bread** product
promise. Neither the inaccessible attachment nor an AI-cleaned approximation is
committed. A separately supplied app-icon/favicon attachment was also
unavailable; no icon was inferred from it.

## Required approved source

Before any logo file is added here, Brand/Product ownership must provide and
approve a source package containing:

- the canonical vector master;
- horizontal and compact/mark compositions;
- light, dark, monochrome, and reversed-use rules;
- clear-space and minimum-size rules;
- approved color values and background constraints;
- written confirmation that repository use is authorized.

Font files are not required and must not be committed unless their license and
repository distribution rights are explicitly approved.

## Reserved output paths

After approval, a dedicated brand-only change may populate these paths without
changing README structure:

| Reserved path                              | Status                           | Intended use                               |
| ------------------------------------------ | -------------------------------- | ------------------------------------------ |
| `alo-noon-logo-horizontal-transparent.png` | Blocked — approved source absent | README hero and wide documentation headers |
| `alo-noon-logo-mark-transparent.png`       | Blocked — approved source absent | Compact footer and square placements       |
| `alo-noon-logo-light.png`                  | Blocked — approved source absent | Approved light-background placement        |
| `alo-noon-logo-dark.png`                   | Blocked — approved source absent | Approved dark-background placement         |
| `alo-noon-app-icon.png`                    | Blocked — source unavailable     | Application icon; never inferred from text |
| `alo-noon-favicon.png`                     | Blocked — source unavailable     | Browser icon; never inferred from text     |

No dimensions or background compatibility can be specified responsibly until the
source package is approved. Original source artwork must be preserved unchanged
alongside provenance metadata when it is eventually introduced.

## Modification limits

- Do not infer the logo from application text, screenshots, typography, or the
  capability labels in `../badges/`.
- Do not use capability-label shapes as brand marks.
- Do not stretch, recolor, crop, trace, or add effects to approved artwork.
- Do not expose proprietary source font files.
- Treat every derived raster as reproducible output from the approved master,
  with documented dimensions and background use.
