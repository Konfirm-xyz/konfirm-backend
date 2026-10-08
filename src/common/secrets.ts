// Signing secrets for session tokens. Outside production, an unset secret
// falls back to a fixed dev value with a loud warning, so `npm start` works
// on a laptop. In production there is no fallback: a missing, short, or
// dev-default secret stops the process at boot, before it can sign a single
// session. A forgeable session key is a complete auth bypass, so this fails
// closed rather than warning and carrying on.

export const MIN_PRODUCTION_SECRET_LENGTH = 32;

export function resolveSessionSecret(
  envName: string,
  devDefault: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): string {
  const value = env[envName];
  if (env.NODE_ENV === 'production') {
    if (!value) {
      throw new Error(`${envName} must be set in production — refusing to start with no session signing key`);
    }
    if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
      throw new Error(`${envName} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
    }
    if (value === devDefault) {
      throw new Error(`${envName} is set to the published dev default — generate a real one`);
    }
    return value;
  }
  if (value) return value;
  warn(`[secrets] ${envName} not set — using an insecure dev-only default. Set ${envName} before this ever leaves localhost.`);
  return devDefault;
}

// The merchant and admin cookies are signed with separate keys so a leaked
// merchant key can never mint an admin session. Enforcing that here means
// a copy-pasted secret fails at boot instead of quietly sharing a key.
export function assertDistinctSecrets(a: string, b: string, names: [string, string], env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && a === b) {
    throw new Error(`${names[0]} and ${names[1]} must be different values in production`);
  }
}
