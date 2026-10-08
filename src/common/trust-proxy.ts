// How many reverse-proxy hops sit in front of the API, so req.ip is the real
// client rather than the proxy. Without this, Express keys every rate limit
// on the proxy's address, so one bucket covers every user. Behind Railway's
// edge there is one hop, which is the production default.
//
// Set it to the exact hop count. Trusting more hops than exist lets a client
// forge X-Forwarded-For and dodge the limits. Set TRUST_PROXY_HOPS=0 to trust
// no proxy (e.g. running the API directly).
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') return env.NODE_ENV === 'production' ? 1 : 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error(`TRUST_PROXY_HOPS must be an integer from 0 to 10, got "${raw}"`);
  }
  return hops;
}
