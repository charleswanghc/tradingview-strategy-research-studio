# Contributing

Use Node.js 22.12+ and run `npm run bootstrap`, `npm run build`, and `npm test`.
Before proposing a change, run `npm run audit:public`. Use synthetic fixtures
only. Never commit real strategies, reports, credentials, local settings,
browser profiles or screenshots containing private paths or account data.

TradingView adapters should reject ambiguous controls, stale results and
changed chart context. Preserve bounded batches and immutable strategy
versions. AI must not receive browser tools or unverified reports.

Contributions are accepted under the project's GPL-3.0-only license. Include
relevant tests and state which checks use fixtures versus a real account.
