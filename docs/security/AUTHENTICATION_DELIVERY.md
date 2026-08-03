# Authentication delivery security and operations

## Verified implementation boundary

The authentication-delivery foundation is provider-neutral. It supplies a
versioned delivery SPI, deterministic registry, tenant-scoped provider
configuration, opaque credential references, durable OTP challenges, delivery
attempts, rolling abuse events, forced RLS, audit/outbox events, and a
two-transaction orchestrator.

No Iranian SMS provider has been approved in repository governance. No real
adapter, vendor endpoint, sender identity, template, or credential ships with
this foundation. Production therefore fails closed and `/ready` reports the
authentication-delivery dependency unavailable until an approved non-test
adapter is registered. Automated tests use only an isolated deterministic test
adapter and never send SMS.

Production readiness also rejects a database application role that is a member
of any `SUPERUSER`/`BYPASSRLS` role or owns the protected authentication tables.
Schema migration credentials must therefore be separate from the least-privilege
runtime `DATABASE_URL` role. Tenant configuration is checked per request; the
global readiness probe does not enumerate tenant/provider configuration.

## Provider onboarding

Provider onboarding requires a separate reviewed change with:

1. an approved provider and official API contract;
2. documented Iranian sender/template and data-processing requirements;
3. a production adapter implementing authentication delivery SPI v1;
4. mocked timeout, malformed-response, rejection, and redaction tests;
5. a tenant-owned `AuthDeliveryProviderConfiguration` referencing a secret as
   `env://AUTH_SMS_*`, `vault://`, or an approved secret-manager URI;
6. exactly one enabled default configuration for each tenant/environment;
7. sandbox evidence and an operational rollback plan.

Raw credentials must never be placed in PostgreSQL, configuration metadata,
logs, traces, audit, outbox, fixtures, or documentation. The current runtime
resolver accepts only `env://AUTH_SMS_*` references; other URI schemes are
reserved for future resolver implementations.

## OTP and abuse policy

| Control                                 |       Default |      Enforced bounds |
| --------------------------------------- | ------------: | -------------------: |
| OTP digits                              |             6 |                fixed |
| OTP lifetime                            |     5 minutes |         2–10 minutes |
| resend cooldown                         |    60 seconds | 30 seconds–5 minutes |
| failures per challenge                  |             5 |                  3–8 |
| sends per phone digest                  |        5/hour |                 2–10 |
| sends per source-IP digest              | 20/10 minutes |                5–100 |
| sends per tenant                        |      500/hour |           10–100,000 |
| sends per tenant provider configuration |    300/minute |             1–10,000 |
| verification failures per source IP     | 25/10 minutes |  fixed runtime guard |
| circuit threshold                       |    5 failures |                 2–20 |
| circuit-open interval                   |     5 minutes |         1–60 minutes |
| provider timeout                        |     5 seconds |       0.5–30 seconds |

Phone and source-IP dimensions are HMAC-tokenized before abuse records are
written. Counters are checked and written in `SERIALIZABLE` transactions.
Throttling and cooldown decisions return the same generic acceptance envelope;
they do not expose account existence or the private policy decision. Fastify
trusts no forwarded proxy hop by default. `API_TRUST_PROXY_HOPS` may be set only
to the reviewed number of reverse-proxy hops (0–3); an unavailable reliable
source IP fails closed.

Authentication HMAC inputs use explicit `otp`, `session`, `mobile`, `source-ip`,
and `request-fingerprint` purpose namespaces. Production additionally rejects
configuration that reuses one pepper across OTP, session, and abuse purposes.
Pepper rotation is an operationally coordinated invalidation boundary:

- rotating `AUTH_OTP_PEPPER` invalidates every active OTP challenge;
- rotating `AUTH_SESSION_PEPPER` invalidates every active session;
- rotating `AUTH_ABUSE_PEPPER` changes identifier tokens and therefore must wait
  for the longest abuse window to drain, or the old-key counters must remain
  enforced during a separately reviewed dual-key migration.

Rotate during a controlled security event or maintenance window, revoke affected
state explicitly, and never change these values on only part of a running fleet.
HMAC tokenization is pseudonymization, not encryption or irreversible
anonymization: compromise of `AUTH_ABUSE_PEPPER` permits offline testing of the
bounded Iranian mobile-number space. Treat a suspected leak as a credential and
privacy incident and rotate using the coordinated procedure above.

## Transaction and recovery model

Transaction A establishes transaction-local `app.tenant_id`, selects exactly one
eligible provider, enforces persisted limits, creates or replays a challenge,
stores only the OTP HMAC digest, and writes the initialized attempt plus audit
and outbox intent. Credential resolution and adapter execution then occur
outside PostgreSQL. Transaction B locks the attempt and atomically persists the
normalized result, challenge state, provider health/circuit state, audit, and
outbox record.

The model does not claim exactly-once external delivery. A timeout is `UNKNOWN`,
not a safe retry. If a process disappears after invocation, replay initially
returns a stable uncertain result; after two provider-timeout intervals it
finalizes the stale initialized attempt as `UNKNOWN` without another send. Known
failed attempts do not become verifiable. Successful verification consumes the
challenge and creates its session in one `SERIALIZABLE` transaction, so a
session-persistence failure rolls back consumption and concurrent verification
can create only one session.

## Privacy and observability

Audit/outbox events contain tenant-safe challenge and attempt IDs, provider
code, adapter/SPI versions, normalized state, correlation ID, and a bounded safe
code. They exclude phone numbers, OTPs, credentials, provider payloads,
authorization headers, and raw provider messages. Runtime warnings log only
stable error codes.

Automatic Fastify request logging is disabled in the production server path, and
the logger redacts request IP/port, `Authorization`, and cookie bindings from
manual request logs. Authentication handlers never attach request bodies or raw
provider errors to logs.

The environment resolver copies credential text into a mutable buffer and
overwrites that buffer after invocation as a best-effort reduction of exposure.
JavaScript strings and environment storage are runtime-managed, so this is not
guaranteed memory erasure; process, secret-manager, and crash-dump controls
remain required.

`AuthOtpChallenge.mobileE164` is the bounded delivery/recovery destination and
is protected by forced tenant RLS, but it remains personal data visible to an
authorized PostgreSQL administrator and in protected backups. Database access,
encryption at rest, backup access, and challenge/attempt retention must be
approved before a real provider is enabled. HMAC digests do not replace this
data-classification requirement.

The service exposes a non-authoritative low-cardinality observer port for
delivery outcome, provider code, suppression count, and latency. Exporting these
signals to a production metrics backend is deferred to observability deployment;
observer failure never changes authentication truth. Alerting should cover:

- provider `UNKNOWN` or failure rate and latency;
- circuit-open state and repeated readiness failure;
- tenant/provider budget saturation;
- request suppression and verification-lock trends;
- stale initialized attempts requiring investigation.

Never use full phone numbers, tenant names, challenge IDs, IP addresses, or
credential references as metric labels or trace attributes.

Expired `AuthAbuseEvent` rows may be deleted under tenant context for bounded
retention. Updates and deletion before `expiresAt` remain database-rejected.
Deployments must schedule tenant-scoped cleanup using the indexed `expiresAt`
column; otherwise high-volume abuse traffic will grow the table indefinitely.

The synchronous endpoint can have different latency for a suppressed request and
a real provider invocation. It performs no account-existence lookup, but recent
request activity could still be statistically inferred once a real adapter is
enabled. Provider onboarding therefore requires an edge/WAF control and a
separately reviewed asynchronous or latency-normalized public-delivery design
before production activation.

## Troubleshooting and rollback

- `OTP_DELIVERY_UNAVAILABLE`: confirm a single enabled default configuration,
  compatible non-test adapter, environment, circuit state, and resolvable opaque
  credential reference. Do not print the credential.
- Persistent generic acceptance without an SMS: inspect tenant-scoped audit
  events for suppression or uncertain delivery; do not infer customer status.
- `IDEMPOTENCY_KEY_CONFLICT`: the client reused a key for a different canonical
  phone request and must issue a new random key.
- Circuit open: disable traffic operationally and investigate normalized safe
  codes before changing provider configuration.

Rollback means rolling back application code while retaining the additive
migration and immutable security history, followed by a forward corrective
migration if needed. Do not drop challenge, attempt, abuse, audit, or outbox
history during an incident.
