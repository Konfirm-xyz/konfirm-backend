import { installProcessHandlers } from './process-handlers';

describe('installProcessHandlers', () => {
  const realDsn = process.env.SENTRY_DSN;
  let errors: string[];
  let exitCodes: number[];
  let uninstall: () => void;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    errors = [];
    exitCodes = [];
    uninstall = installProcessHandlers({ error: (m: string) => void errors.push(m) }, (code) => void exitCodes.push(code));
  });
  afterEach(() => {
    uninstall();
    if (realDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = realDsn;
  });

  it('logs an unhandled rejection without SENTRY_DSN and keeps running', () => {
    process.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    expect(errors).toEqual(['unhandled promise rejection: boom']);
    expect(exitCodes).toEqual([]);
  });

  it('logs an uncaught exception and exits with code 1', async () => {
    // process.emit's typings don't list 'uncaughtException'.
    (process.emit as (event: string, ...args: unknown[]) => boolean)('uncaughtException', new Error('kaboom'), 'uncaughtException');
    expect(errors).toEqual(['uncaught exception, exiting: kaboom']);
    await new Promise((r) => setImmediate(r));
    expect(exitCodes).toEqual([1]);
  });

});
