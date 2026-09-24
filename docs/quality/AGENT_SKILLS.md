# Agent skills — what was reviewed, what was chosen, and why

Agent skills are instruction sets an AI coding agent loads on demand. They run
with full agent permissions, so this file is the review record: what was read,
what was kept, what was rejected, and what none of them cover.

Skills are **not committed**. `.claude/` and `.agents/` are ignored (see
`.gitignore`), which is the existing policy — a skill is a local operator
choice, not part of the build. This document is what makes that choice
reproducible.

## How the field was surveyed

The catalogue came from the Best Skills open dataset, which merges the three
registries — skills.sh, ClawHub and Tencent SkillHub — plus GitHub and social
mentions, refreshed daily as CSV.

> Data from Best Skills (https://github.com/LinklyAI/best-skills) by @BlueeonY —
> CC BY 4.0. Snapshot read: 2026-09-24.

Two things about the rankings had to be worked around, both stated by the
dataset's own documentation:

- **Installs are bundle-level.** Installing a repository counts once for every
  skill inside it, so a vendor who ships 25 skills in one repository puts 25
  entries in the Top 100. Microsoft's Azure skills occupy 20 of the top 35 that
  way, and none of them apply to this stack.
- **`category` and the quality flags are a model's judgement**, not a number a
  registry reported.

So rank was used to find candidates and nothing else. Every skill below was
chosen by **reading its `SKILL.md`**. The two security skills have the smallest
install counts on the list (933 and 768) and are among the most useful — which
is the clearest evidence that install count is not the signal here.

## Installed

Run from the repository root. Each lands in `.agents/skills/<name>` with a
symlink from `.claude/skills/<name>`.

```bash
npx skills add https://github.com/vercel-labs/agent-skills --skill web-design-guidelines
npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit
npx skills add https://github.com/addyosmani/agent-skills --skill security-and-hardening
npx skills add https://github.com/addyosmani/web-quality-skills --skill accessibility
npx skills add https://github.com/mcollina/skills --skill fastify-best-practices
npx skills add https://github.com/prisma/skills --skill prisma-upgrade-v7
npx skills add https://github.com/prisma/skills --skill prisma-client-api
npx skills add https://github.com/prisma/skills --skill prisma-driver-adapter-implementation
npx skills add https://github.com/anthropics/skills --skill webapp-testing
npx skills add https://github.com/microsoft/playwright-cli --skill playwright-cli
npx skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-best-practices
```

| Skill                                  | Publisher   | Why this one, for this product                                                                                                                                                         |
| -------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-design-guidelines`                | Vercel      | 190 lines of concrete interface rules — focus states, form attributes, touch behaviour, safe areas, `Intl`, anti-patterns — checked as `file:line`. The one that paid off immediately. |
| `security-audit`                       | Cloudflare  | Trust-boundary-first. Refuses to record a finding without a concrete affected principal, resource or outcome. That discipline is worth more here than any checklist.                   |
| `security-and-hardening`               | Addy Osmani | The design-time counterpart: threat-model before controls, OWASP Top Ten, secret handling, PII. Complements the audit skill rather than repeating it.                                  |
| `accessibility`                        | Addy Osmani | WCAG 2.2, evidence-led — run the audit, use the failures to localise the component, fix, re-run. Extends our contrast checks to keyboard, landmarks and screen readers.                |
| `fastify-best-practices`               | mcollina    | Written by Fastify's lead maintainer. The whole API is Fastify 5.                                                                                                                      |
| `prisma-upgrade-v7`                    | Prisma      | We are on Prisma 7 with `@prisma/adapter-pg`. v7 is recent enough that a model's own memory of Prisma is usually v6.                                                                   |
| `prisma-client-api`                    | Prisma      | Query and transaction surface for the version actually installed.                                                                                                                      |
| `prisma-driver-adapter-implementation` | Prisma      | Transaction lifecycle, savepoints and original-error preservation — exactly the layer the ledger sits on.                                                                              |
| `webapp-testing`                       | Anthropic   | Drive the real app in a real browser. Chromium and Playwright are already installed in the dev container.                                                                              |
| `playwright-cli`                       | Microsoft   | Accessibility-tree snapshots and element refs, which is the cheap way to exercise a flow end to end.                                                                                   |
| `vercel-react-best-practices`          | Vercel      | React 19 / Next.js 16 performance patterns.                                                                                                                                            |

Licences: MIT or Apache-2.0 throughout.

## Read and rejected

- **The Azure family (20+ entries in the Top 35), Supabase, Neon, Convex, Vercel
  deploy, Cloudflare Workers.** Wrong stack. We self-host PostgreSQL 16 and
  deploy with Docker Compose.
- **Everything from ClawHub and Tencent SkillHub.** Those install with
  `openclaw skills install`, a different agent ecosystem. The highest-download
  entries there are also the weakest: `skill-vetter` (274k) and `SkillScan`
  (182k) are security gates whose own descriptions use the "every skill MUST
  pass this first" pattern that the dataset flags as `coercive`.
- **SEO, marketing, video and image generation skills.** Not this product.
- **`frontend-design` (Anthropic, rank 2).** Good, but it gives aesthetic
  direction for new UI. We already have design tokens, a type scale and a
  Persian-first layout; taking direction from it would pull against them.
- **`obra/superpowers` — `verification-before-completion`,
  `systematic-debugging`.** Genuinely well written, and their rules ("no
  completion claim without fresh verification evidence", "no fix without root
  cause") are already how `AGENTS.md` and this repository work. Left out to
  avoid a second, differently-worded copy of a rule we already keep.

## What no registry has

Searching all three registries — roughly 3,400 skills — for `rtl`, `i18n`,
`localization`, `persian` and `farsi` returns nothing usable. Nothing covers:

- RTL layout and bidirectional text
- Persian typography, Persian digits, or `«»` in place of `“”`
- Jalali dates
- Rial/Toman, or any Iranian payment gateway
- Iranian mobile-number and national-ID formats

That matters more than it sounds, because **an imported skill will actively
mislead on this surface**. `web-design-guidelines` asks for Title Case headings,
curly quotes `“ ”`, and "numerals for counts" — all correct for English and all
wrong here. Its rules were applied selectively for that reason, and the
Persian-facing rules stay where they already live: `AGENTS.md` ("Preserve
Persian-first RTL behavior"), the design tokens, and
`apps/web/src/app/mobile-first.test.ts`.

## What the first pass found

`web-design-guidelines` was applied to `apps/web`. Most of its rules were
already satisfied — no `transition: all`, no `<div onClick>`, no disabled zoom,
`Intl.DateTimeFormat('fa-IR')` throughout, `autocomplete` and `inputMode` on
every phone and code field, safe-area insets, `prefers-reduced-motion`,
`tabular-nums` on money. Three findings were real, and all three are now fixed
and held by tests:

1. **The header search box had no visible focus indicator.** Its own outline was
   removed and the replacement was a colour shift on the wrapper — not an
   indicator under WCAG 2.4.7. It now draws a ring.
2. **The touch floor only applied to height.** `styles.css` sets
   `min-block-size` and nothing on the inline axis, so the basket's quantity
   buttons rendered 30px wide and 44px tall, and the product page's 42px. The
   readiness note meanwhile claimed nothing was under 44px. Fixed at the three
   controls, and a test now reads the declared width of anything that looks like
   a control.
3. **No `touch-action: manipulation` anywhere**, so every tap waited out the
   browser's double-tap window before firing.
