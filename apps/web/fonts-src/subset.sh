#!/bin/bash
#
# Builds the one font the site serves from the full Vazirmatn in this folder.
#
# Why: the font is the heaviest file on a first visit — 111KB, more than all
# the stylesheets together — and on a slow Iranian mobile connection it is what
# keeps text in the fallback face longest. Most of it was characters Persian
# never uses: Latin Extended, the Arabic presentation-form code points (shaping
# reaches those glyphs through GSUB, not through the code points), currency and
# maths symbols. The subset is 81KB.
#
# Kept: Basic Latin and Latin-1 (addresses, the domain, «», ×, ÷, nbsp), the
# whole Arabic block and Arabic Supplement, all of General Punctuation —
# including U+200C, the zero-width non-joiner Persian spelling depends on, and
# the bidi marks — plus U+2212 (minus) and U+25CC (the dotted circle a lone
# diacritic sits on). Every layout feature and the whole wght axis (100–900).
#
# Verified by rendering every letter in every joining position, lam-alef, the
# diacritics, ZWNJ words, both digit sets and the Latin the site shows, at four
# weights, with the full font and with the subset: zero differing pixels.
#
# Licence: OFL 1.1 with no Reserved Font Name, so a subset may keep the name;
# the licence travels with it in public/fonts/OFL.txt.
#
# Needs fonttools with brotli: pip install fonttools brotli

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

pyftsubset "$here/vazirmatn-variable.full.woff2" \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0600-06FF,U+0750-077F,U+2000-206F,U+2212,U+25CC" \
  --layout-features='*' \
  --flavor=woff2 \
  --output-file="$here/../public/fonts/vazirmatn-variable.woff2"

ls -l "$here/../public/fonts/vazirmatn-variable.woff2"
