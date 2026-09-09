import 'server-only'

/**
 * Who is legally selling the bread.
 *
 * Iranian e-commerce rules, and the eNamad review that enforces them, require a
 * shop to publish the identity behind it: a registered name, a national or
 * registration number, a street address somebody could visit, and a telephone a
 * person answers. None of that is a fact about this codebase — it is a fact
 * about whoever deployed it — so it is read from the environment rather than
 * written into a page.
 *
 * Read from `process.env` at render time, not baked in at build. The legal
 * pages are `force-dynamic`, so a deployment can correct a phone number by
 * restarting rather than by rebuilding.
 *
 * **Nothing here is invented.** A missing value is reported as missing and the
 * page says so plainly, because a placeholder address on a legal page is worse
 * than an empty one: an empty one is obviously unfinished, and a plausible fake
 * is a false statement about a real business. The same rule governs the trust
 * seal below — a badge nobody earned is a forgery, not a placeholder.
 */
export interface LegalIdentity {
  /** The registered name, exactly as it appears on the registration document. */
  legalNameFa?: string
  /** The trading name customers know, when it differs from the registered one. */
  tradingNameFa?: string
  /** شناسهٔ ملی for a company, or کد ملی for a sole trader. */
  nationalId?: string
  /** شمارهٔ ثبت, for a registered company. */
  registrationNumber?: string
  /** Where the business actually is — a postal address, not a PO box. */
  addressFa?: string
  postalCode?: string
  /** A number a person answers during working hours. */
  phone?: string
  supportEmail?: string
  /** Working hours, in words, so nobody phones an empty office at midnight. */
  supportHoursFa?: string
}

export interface TrustSeal {
  /** The eNamad `id` and `Code` from the panel, after the domain is approved. */
  enamadId?: string
  enamadCode?: string
  /** ساماندهی, when the domain has one. */
  samandehiId?: string
}

export function legalIdentity(): LegalIdentity {
  return compact<LegalIdentity>({
    legalNameFa: process.env['LEGAL_ENTITY_NAME_FA'],
    tradingNameFa: process.env['LEGAL_TRADING_NAME_FA'],
    nationalId: process.env['LEGAL_NATIONAL_ID'],
    registrationNumber: process.env['LEGAL_REGISTRATION_NUMBER'],
    addressFa: process.env['LEGAL_ADDRESS_FA'],
    postalCode: process.env['LEGAL_POSTAL_CODE'],
    phone: process.env['LEGAL_SUPPORT_PHONE'],
    supportEmail: process.env['LEGAL_SUPPORT_EMAIL'],
    supportHoursFa: process.env['LEGAL_SUPPORT_HOURS_FA'],
  })
}

export function trustSeal(): TrustSeal {
  return compact<TrustSeal>({
    enamadId: process.env['ENAMAD_ID'],
    enamadCode: process.env['ENAMAD_CODE'],
    samandehiId: process.env['SAMANDEHI_ID'],
  })
}

/**
 * What is still missing before this deployment is lawfully complete.
 *
 * Returned as a list rather than a boolean so the operator's page can name the
 * variables instead of saying "incomplete". The identity fields are the ones
 * eNamad checks; the seal is not on this list because it cannot be obtained
 * until the identity is published, and listing it would make the page look
 * broken during the fortnight that takes.
 */
export function missingLegalFields(identity: LegalIdentity = legalIdentity()): readonly string[] {
  const required: ReadonlyArray<[keyof LegalIdentity, string]> = [
    ['legalNameFa', 'LEGAL_ENTITY_NAME_FA'],
    ['nationalId', 'LEGAL_NATIONAL_ID'],
    ['addressFa', 'LEGAL_ADDRESS_FA'],
    ['phone', 'LEGAL_SUPPORT_PHONE'],
  ]
  return required.filter(([key]) => !identity[key]).map(([, variable]) => variable)
}

/**
 * The eNamad seal's two URLs, or null until the badge has actually been issued.
 *
 * Both halves are required. A seal rendered from a guessed code is a claim that
 * a regulator has verified this business when it has not, which is a worse
 * thing to ship than no seal at all — so a half-configured deployment shows
 * nothing rather than something that looks official.
 */
export function enamadSeal(seal: TrustSeal = trustSeal()): { href: string; src: string } | null {
  if (!seal.enamadId || !seal.enamadCode) return null
  // Only digits and letters reach the query string; anything else is a value
  // somebody mistyped, and interpolating it would put arbitrary text into a URL
  // this page hands the browser.
  if (!/^\d{1,12}$/.test(seal.enamadId) || !/^[A-Za-z0-9]{1,64}$/.test(seal.enamadCode)) {
    return null
  }
  const query = `id=${seal.enamadId}&Code=${seal.enamadCode}`
  return {
    href: `https://trustseal.enamad.ir/?${query}`,
    src: `https://trustseal.enamad.ir/logo.aspx?${query}`,
  }
}

/**
 * Drops the keys that have no value.
 *
 * An unset variable and one set to whitespace are the same thing: not
 * configured. Without this, a stray space in a deployment file would publish an
 * address one space long. The key is removed rather than set to `undefined`
 * because `exactOptionalPropertyTypes` treats "absent" and "present and
 * undefined" as different, and only the first is what these fields mean.
 */
function compact<T>(source: Readonly<Record<string, string | undefined>>): T {
  const kept = Object.entries(source)
    .map(([key, value]) => [key, value?.trim()] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  return Object.fromEntries(kept) as T
}
