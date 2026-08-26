/**
 * A stand-in for Zarinpal's sandbox, speaking its v4 contract on its own paths.
 *
 * Zarinpal publishes a real sandbox, and it is what a deployment should point at
 * — `PAYMENT_ZARINPAL_ENDPOINT=https://sandbox.zarinpal.com`. This exists for the
 * networks that cannot reach it: a locked-down CI runner, an office behind a
 * proxy that will not tunnel to Iranian hosts, a laptop on a plane. Without it,
 * "does the money path work" is a question only answerable in production, and
 * the answer arrives as a customer's missing bread.
 *
 * It is deliberately not a mock. It issues its own authorities, remembers what
 * each one was for, refuses to verify one it never issued (-54), refuses one
 * that was never paid (-51), refuses one whose charge does not match the amount
 * being verified (-50), and reports a second verify as 101 rather than as a
 * fresh success. Those five behaviours are the entire contract the adapter
 * depends on, so a version of the adapter that gets them wrong fails here rather
 * than at a real gateway.
 *
 * Envelope shapes follow Zarinpal exactly, down to the awkward part: success
 * puts an object in `data` and an empty array in `errors`, and failure does the
 * reverse. An adapter that assumes `data` is always an object breaks on the
 * first declined payment, which is the worst possible moment to find out.
 *
 * Run it standalone with:
 *
 *     pnpm --filter @alo-noon/api exec tsx scripts/zarinpal-sandbox.ts
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/** Zarinpal's authorities are a fixed-width `A` followed by 35 characters. */
const AUTHORITY_LENGTH = 35
const AUTHORITY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface SandboxTransaction {
  authority: string
  /** What the merchant asked to charge, in IRR minor units. */
  requestedAmount: number
  /** What the card was actually charged. Differs only when a test asks it to. */
  chargedAmount: number
  callbackUrl: string
  description: string
  paid: boolean
  verifiedRefId: number | null
}

export interface StartZarinpalSandboxOptions {
  /** 0 (the default) takes an ephemeral port, which is what a test wants. */
  port?: number
  /**
   * What the card is actually charged for a given requested amount. The default
   * charges what was asked; returning anything else is how the -50 path — a
   * gateway confirming a different amount than the order is for — gets
   * exercised against real code rather than argued about.
   */
  chargeFor?: (requestedAmount: number) => number
  /**
   * The authorities the gateway already knows about. Pass a map in to keep them
   * across a restart, which is how "the gateway was down when the customer came
   * back, and the sweep finished the payment later" gets exercised.
   */
  state?: Map<string, SandboxTransaction>
}

export interface ZarinpalSandbox {
  readonly origin: string
  readonly transactions: ReadonlyMap<string, SandboxTransaction>
  close(): Promise<void>
}

export async function startZarinpalSandbox(
  options: StartZarinpalSandboxOptions = {},
): Promise<ZarinpalSandbox> {
  const transactions = options.state ?? new Map<string, SandboxTransaction>()
  const chargeFor = options.chargeFor ?? ((requested: number) => requested)

  const server = createServer((request, response) => {
    handle(request, response, transactions, chargeFor).catch(() => {
      // Zarinpal's own "unexpected error, contact support".
      sendJson(response, 500, { data: [], errors: { code: -52, message: 'sandbox failure' } })
    })
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${address.port}`,
    transactions,
    close: () => closeServer(server),
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  transactions: Map<string, SandboxTransaction>,
  chargeFor: (requestedAmount: number) => number,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (request.method === 'POST' && url.pathname === '/pg/v4/payment/request.json') {
    return purchase(request, response, transactions, chargeFor)
  }
  if (request.method === 'GET' && url.pathname.startsWith('/pg/StartPay/')) {
    return startPay(url, response, transactions)
  }
  if (request.method === 'POST' && url.pathname === '/pg/v4/payment/verify.json') {
    return verify(request, response, transactions)
  }
  sendJson(response, 404, { data: [], errors: { code: -54, message: 'no such endpoint' } })
}

/** POST /pg/v4/payment/request.json — issues an authority. */
async function purchase(
  request: IncomingMessage,
  response: ServerResponse,
  transactions: Map<string, SandboxTransaction>,
  chargeFor: (requestedAmount: number) => number,
): Promise<void> {
  const body = await readJson(request)
  const merchantId = stringField(body, 'merchant_id')
  const amount = numberField(body, 'amount')
  const callbackUrl = stringField(body, 'callback_url')
  const description = stringField(body, 'description')

  // Zarinpal's -9 is a validation refusal, and it is the code a merchant sees
  // when the request is malformed in any of these ways.
  if (!merchantId || amount === null || amount <= 0 || !callbackUrl || !description) {
    sendJson(response, 400, {
      data: [],
      errors: { code: -9, message: 'validation error', validations: [] },
    })
    return
  }
  // Zarinpal charges in Rial and takes `currency` explicitly. A request that
  // omits it is relying on the merchant panel's default, which is exactly the
  // ambiguity that turns an order into a bill ten times too small.
  if (stringField(body, 'currency') !== 'IRR') {
    sendJson(response, 400, {
      data: [],
      errors: { code: -9, message: 'currency must be stated explicitly', validations: [] },
    })
    return
  }

  const authority = issueAuthority()
  transactions.set(authority, {
    authority,
    requestedAmount: amount,
    chargedAmount: chargeFor(amount),
    callbackUrl,
    description,
    paid: false,
    verifiedRefId: null,
  })
  sendJson(response, 200, {
    data: { code: 100, message: 'Success', authority, fee_type: 'Merchant', fee: 0 },
    errors: [],
  })
}

/**
 * GET /pg/StartPay/:authority — where the customer's browser goes.
 *
 * The real page shows a card form; here, arriving is paying. `?outcome=nok`
 * stands in for the customer who backed out, which redirects with Status=NOK
 * exactly as Zarinpal does — the case where a callback arrives for a payment
 * that never happened.
 */
function startPay(
  url: URL,
  response: ServerResponse,
  transactions: Map<string, SandboxTransaction>,
): void {
  const authority = decodeURIComponent(url.pathname.slice('/pg/StartPay/'.length))
  const transaction = transactions.get(authority)
  if (!transaction) {
    sendJson(response, 404, { data: [], errors: { code: -54, message: 'invalid authority' } })
    return
  }

  const paid = url.searchParams.get('outcome') !== 'nok'
  transaction.paid = paid
  const target = new URL(transaction.callbackUrl)
  target.searchParams.set('Authority', authority)
  target.searchParams.set('Status', paid ? 'OK' : 'NOK')
  response.writeHead(302, { Location: target.toString() })
  response.end()
}

/** POST /pg/v4/payment/verify.json — the only step that settles anything. */
async function verify(
  request: IncomingMessage,
  response: ServerResponse,
  transactions: Map<string, SandboxTransaction>,
): Promise<void> {
  const body = await readJson(request)
  const authority = stringField(body, 'authority')
  const amount = numberField(body, 'amount')
  if (!stringField(body, 'merchant_id') || !authority || amount === null) {
    sendJson(response, 400, { data: [], errors: { code: -9, message: 'validation error' } })
    return
  }

  const transaction = transactions.get(authority)
  if (!transaction) {
    sendJson(response, 400, { data: [], errors: { code: -54, message: 'invalid authority' } })
    return
  }
  if (!transaction.paid) {
    sendJson(response, 400, { data: [], errors: { code: -51, message: 'payment failed' } })
    return
  }
  if (transaction.chargedAmount !== amount) {
    // The check that makes the amount an assertion rather than an echo: the
    // gateway compares what it charged against what the merchant is verifying.
    sendJson(response, 400, {
      data: [],
      errors: { code: -50, message: 'paid amount differs from the verified amount' },
    })
    return
  }

  const alreadyVerified = transaction.verifiedRefId !== null
  transaction.verifiedRefId ??= 100_000_000 + Math.floor(Math.random() * 899_999_999)
  sendJson(response, 200, {
    data: {
      code: alreadyVerified ? 101 : 100,
      message: 'Verified',
      card_hash: 'A'.repeat(64),
      card_pan: '502229******5995',
      ref_id: transaction.verifiedRefId,
      fee_type: 'Merchant',
      fee: 0,
    },
    errors: [],
  })
}

function issueAuthority(): string {
  const bytes = randomBytes(AUTHORITY_LENGTH)
  let authority = 'A'
  for (const byte of bytes) {
    authority += AUTHORITY_ALPHABET[byte % AUTHORITY_ALPHABET.length]
  }
  return authority
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringField(body: Record<string, unknown> | null, field: string): string | null {
  const value = body?.[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberField(body: Record<string, unknown> | null, field: string): number | null {
  const value = body?.[field]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(encoded.byteLength),
  })
  response.end(encoded)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
}

// Standalone: run it, point PAYMENT_ZARINPAL_ENDPOINT at what it prints.
if (process.argv[1]?.endsWith('zarinpal-sandbox.ts')) {
  const port = Number.parseInt(process.env['ZARINPAL_SANDBOX_PORT'] ?? '4180', 10)
  startZarinpalSandbox({ port })
    .then((sandbox) => {
      console.log(`Zarinpal sandbox stand-in listening on ${sandbox.origin}`)
      console.log(`  PAYMENT_ZARINPAL_ENDPOINT=${sandbox.origin}`)
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
}
