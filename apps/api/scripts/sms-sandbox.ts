/**
 * A stand-in for the SMS gateway, so a launch can be rehearsed end to end
 * without texting a real person or spending the tenant's credit.
 *
 * It answers in LimooSMS's documented shape and appends every message it is
 * asked to send to a file. That file is how you read the one-time code during a
 * local sign-in — which is the whole point: without it, the only way to test
 * the customer journey is to have working SMS, and the only way to get working
 * SMS is to have already launched.
 *
 * Point the API at it with `AUTH_SMS_LIMOSMS_ENDPOINT=http://127.0.0.1:4010`.
 *
 * It is deliberately not a mock of the real gateway's failure modes. It says
 * yes to everything, because its job is to unblock the rest of the journey, not
 * to prove the adapter — the adapter has its own tests against the real
 * contract.
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = Number(process.env['SMS_SANDBOX_PORT'] ?? 4010)
const LOG = process.env['SMS_SANDBOX_LOG'] ?? '/tmp/alo-noon-sms.log'

createServer((request, response) => {
  let body = ''
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString()
  })
  request.on('end', () => {
    appendFileSync(LOG, `${new Date().toISOString()} ${body}\n`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ Success: true, Message: 'ارسال شد', MessageId: [`sandbox-${Date.now()}`] }),
    )
  })
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`SMS sandbox listening on ${PORT}, writing to ${LOG}\n`)
})
