import type { ErrorEvent } from '@sentry/node';
import { scrubEvent } from './sentry';

function event(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return { event_id: 'test', type: 'event', ...overrides } as ErrorEvent;
}

describe('scrubEvent', () => {
  it('passes through allowed extra keys unchanged', () => {
    const result = scrubEvent(
      event({ extra: { message: 'timeout', code: 'ETIMEDOUT', name: 'Error', stack: 'Error\n  at …' } }),
    );
    expect(result.extra).toEqual({
      message: 'timeout',
      code: 'ETIMEDOUT',
      name: 'Error',
      stack: 'Error\n  at …',
    });
  });

  it('strips unknown keys from extra', () => {
    const result = scrubEvent(
      event({ extra: { message: 'err', requestBody: '{"password":"s3cr3t"}', userId: 42 } }),
    );
    expect(result.extra).toEqual({ message: 'err' });
    expect(result.extra).not.toHaveProperty('requestBody');
    expect(result.extra).not.toHaveProperty('userId');
  });

  it('scrubs unknown keys from every context entry', () => {
    const result = scrubEvent(
      event({
        contexts: {
          response: { status: 500, body: '{"password":"s3cr3t"}' },
        },
      }),
    );
    expect(result.contexts?.['response']).toEqual({ status: 500 });
    expect(result.contexts?.['response']).not.toHaveProperty('body');
  });

  it('leaves contexts without unknown keys untouched', () => {
    const result = scrubEvent(
      event({
        contexts: {
          os: { name: 'Linux', version: '6.1' },
        },
      }),
    );
    expect(result.contexts?.['os']).toEqual({ name: 'Linux', version: '6.1' });
  });

  it('handles undefined extra and contexts gracefully', () => {
    const result = scrubEvent(event());
    expect(result.extra).toBeUndefined();
    expect(result.contexts).toBeUndefined();
  });
});
