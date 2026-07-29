# Phase 2C customer application integration

## Status

- **Implemented in this phase:** active-city discovery, allow-listed
  credential-aware CORS, a contract-validating customer API client, OTP and
  revocable cookie-session UX, foreground-location serviceability checks, and
  catalog rendering.
- **Planned:** approved SMS delivery-provider configuration and address
  persistence.
- **Deferred:** cart, server-side quote, order creation, payment, background
  location, and push notifications.
- **Open decision:** production mobile API hostname and the approved Iranian SMS
  provider.

## Customer flow

1. The application restores the current server-side session through
   `GET /api/v1/auth/session`.
2. A signed-out customer requests and verifies OTP. The temporary challenge ID
   exists only in component memory. The API never returns the opaque session
   token in JSON.
3. The client loads `GET /api/v1/serviceability/cities`; no city name, UUID, or
   Babol-specific record is hardcoded in production code.
4. After foreground-location consent, the client submits coordinates to
   `POST /api/v1/serviceability/check`.
5. Only a serviceable result with an operational zone can load
   `GET /api/v1/catalog/products`.
6. Logout revokes the server-side session and clears the cookie.

## Contract and security rules

- Every successful response is validated against the versioned Zod contract
  before the UI trusts it.
- Requests use `credentials: include`; no bearer token, raw OTP, mobile number,
  or session identifier is written to localStorage or sessionStorage.
- Browser origins and the customer API base URL reject wildcards, URL paths,
  query strings, fragments, and credential-bearing URLs.
- Device location is requested only in the foreground and only when the customer
  explicitly starts serviceability evaluation.
- Error UI uses bounded product-safe messages and does not show database,
  provider, or transport internals.

## Product-promise rule

Only a catalog item whose fulfillment class is `SIGNATURE_FRESH` and whose
freshness claim is `FRESHLY_PRODUCED` receives fresh-production language.
Traditional, fantasy, and dietary packaged products are explicitly labelled as
packaged. A signature item with any other freshness claim is shown as a special
product without a fresh-production promise.

## Runtime configuration

The customer Expo application requires `EXPO_PUBLIC_API_BASE_URL`. Browser
clients also require their exact origins in the API `CORS_ORIGINS`
comma-separated allow-list. Production SMS delivery remains unavailable until an
approved provider and its secrets are configured outside the repository.

## Verification

The phase includes contract-envelope tests, city-discovery and CORS API tests,
API-client transport and response-validation tests, mobile-number normalization,
integer-string money formatting, and freshness-label policy tests. The root
format, lint, typecheck, test, and build gates remain mandatory.
