import { HttpMailer, LogMailer, mailerFromEnv, UnconfiguredMailer } from './mailer';

describe('mailerFromEnv', () => {
  it('uses the HTTP relay when a webhook is configured', () => {
    expect(mailerFromEnv({ MAIL_WEBHOOK_URL: 'https://relay.example/send', NODE_ENV: 'production' })).toBeInstanceOf(HttpMailer);
  });

  it('uses the logging mailer in development', () => {
    expect(mailerFromEnv({ NODE_ENV: 'development' })).toBeInstanceOf(LogMailer);
  });

  it('never falls back to logging in production', () => {
    expect(mailerFromEnv({ NODE_ENV: 'production' })).toBeInstanceOf(UnconfiguredMailer);
  });
});

describe('HttpMailer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts the message with a bearer token and throws on a non-2xx relay response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const mailer = new HttpMailer('https://relay.example/send', 'secret-token');
    await expect(mailer.send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toThrow(/500/);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ to: 'a@b.co', subject: 's', text: 't' });
  });
});
