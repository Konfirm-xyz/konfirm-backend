import { Logger } from '@nestjs/common';
import { flushSentry } from './sentry';

type ErrorLogger = Pick<Logger, 'error'>;

// The API and every @Cron job share one process, so a stray rejection
// anywhere takes every merchant's requests down with it. Sentry's default
// integrations only cover this when SENTRY_DSN is set; these handlers make
// sure there's always a log line through the app logger regardless.
//
// unhandledRejection is logged and the process keeps serving. An
// uncaughtException leaves the process in an unknown state, so that one is
// logged and then exits deliberately — the platform restarts it.
export function installProcessHandlers(
  logger: ErrorLogger = new Logger('Process'),
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  const onRejection = (reason: unknown) => {
    logger.error(`unhandled promise rejection: ${describe(reason)}`, stackOf(reason));
  };
  const onException = (err: unknown) => {
    logger.error(`uncaught exception, exiting: ${describe(err)}`, stackOf(err));
    // bufferLogs (main.ts) may still be holding this if the crash happened
    // before the pino logger took over.
    Logger.flush();
    void flushSentry(2_000).finally(() => exit(1));
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function stackOf(value: unknown): string | undefined {
  return value instanceof Error ? value.stack : undefined;
}
