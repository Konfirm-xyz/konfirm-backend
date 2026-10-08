// Wraps any external call with a hard timeout and exponential-backoff
// retry. Deliberately generic (works for an SDK method, a raw fetch, or
// anything else async) rather than reaching into stellar-sdk's internal
// HTTP client for a library-specific mechanism.
//
// This is safe to apply broadly to *reads* (loadAccount, status polls,
// challenge fetches) but not to every external call — a POST that creates
// state on the far side (starting a SEP-24 interactive session, for
// instance) can't be blindly retried on a timeout: if the first attempt
// actually succeeded and only the response was lost, a retry creates a
// second, orphaned transaction on the anchor's side. Call sites decide
// per-operation whether a retry is safe; this helper just does the
// mechanics once real anchor-specific idempotency guarantees are known.
export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseDelayMs = 300, timeoutMs = 10_000 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

// `withRetry` retries on anything the wrapped function throws — fine for a
// plain SDK call, but wrong for HTTP: a 400 means "this request is bad and
// always will be," and retrying it three times wastes time without any
// chance of a different outcome (unlike a network blip or a 5xx, which
// might genuinely resolve on a second attempt). This wraps `fetch` so only
// a transport-level failure or a 5xx response counts as retryable — a 4xx
// response is returned immediately for the caller to turn into whatever
// error message makes sense for that endpoint.
export async function fetchWithRetry(
  input: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return withRetry(
    async () => {
      const res = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500) {
        throw new Error(`upstream returned ${res.status}`);
      }
      return res;
    },
    { ...opts, timeoutMs: timeoutMs + 1_000 }, // outer race is just a backstop; AbortSignal does the real cancelling
  );
}

// Rejects if `p` hasn't settled within `ms`. The timer is cleared once `p`
// settles either way: a leftover timer keeps the process alive for its full
// length, which is why the test suite used to hang on exit.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`external call timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
