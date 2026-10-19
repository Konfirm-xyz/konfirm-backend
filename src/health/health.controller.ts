import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { pool } from '../db/pool';

// Hand-rolled rather than pulling in @nestjs/terminus for a single check.
// Railway's deploy.healthcheckPath (railway.json) points here, so a bound
// port alone no longer counts as healthy — the pool has to actually answer
// a query. The pool connects lazily and its connectionTimeoutMillis defaults
// to "no timeout", so the bound here is what keeps a dead database from
// hanging the probe instead of failing it.
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`health check timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Railway's own prober polls this — it must never be rate limited into a
// false "unhealthy".
@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  @HttpCode(200)
  async check(): Promise<{ status: 'ok'; db: 'ok' }> {
    try {
      await withTimeout(pool.query('SELECT 1'), HEALTH_CHECK_TIMEOUT_MS);
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'unreachable' });
    }
    return { status: 'ok', db: 'ok' };
  }
}
