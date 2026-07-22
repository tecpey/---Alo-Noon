# Security Policy

Do not disclose security vulnerabilities through public GitHub issues.

Until a dedicated security mailbox is published, report suspected vulnerabilities privately to the repository owner. Never include production credentials, personal data, payment details, call recordings, access tokens, or customer addresses in issues, commits, screenshots, or logs.

## Baseline rules

- Secrets must be supplied through a secrets manager or environment variables.
- Production and test data must remain isolated.
- Wallet balances are derived from immutable ledger entries; direct balance mutation is prohibited.
- Every privileged action must be authenticated, authorized, auditable, and attributable.
- Telephony recording and retention must follow applicable consent and privacy requirements.
