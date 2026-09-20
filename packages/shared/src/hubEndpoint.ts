/** Hub routes are the only supported path-based environments; other URLs keep upstream semantics. */
export function hubEnvironmentPrefix(url: URL): string {
  return /^\/hub\/environments\/[A-Za-z0-9_.-]+(?=\/|$)/.exec(url.pathname)?.[0] ?? "";
}
