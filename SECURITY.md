# Security

Never include API keys, pairing files, authenticated launch URLs, private
strategies or backtest exports in a public issue. Rotate exposed keys at the
provider and replace exposed pairing files before continuing.

For a suspected vulnerability, use the repository's private vulnerability
reporting feature, if enabled. Otherwise open a minimal issue asking for a
private reporting channel without describing exploit details or secrets.

The server binds to localhost and authenticates requests. Keep the bridge
token private, review strategy changes before using them beyond research,
and run only releases from a trusted source. This technical beta has not
received an independent security audit. Only the latest release is maintained.
