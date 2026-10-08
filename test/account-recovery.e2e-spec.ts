import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';
import { MAILER, Mailer, OutgoingMail } from '../src/mail/mailer';

// Forgot-password and reset, end to end, with the mailer swapped for one that
// records what it was asked to send. The token is read out of the email, the
// same way a merchant would use it.
describe('account recovery (e2e)', () => {
  let app: INestApplication;
  const sent: OutgoingMail[] = [];
  const capture: Mailer = { send: async (mail) => void sent.push(mail) };
  const stamp = Date.now();
  const email = `Recover-${stamp}@Example.COM`;
  const oldPassword = 'original-passphrase';
  const newPassword = 'replacement-passphrase';
  const stellar = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';
  let cookie: string;

  const tokenFromLastMail = (): string => {
    const match = sent[sent.length - 1].text.match(/token=([A-Za-z0-9_-]+)/);
    if (!match) throw new Error('no reset link in the last email');
    return match[1];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(capture)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const signup = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password: oldPassword, name: 'Recovery Test', stellar_base_address: stellar })
      .expect(201);
    cookie = signup.headers['set-cookie'][0].split(';')[0];
  });

  afterAll(async () => {
    await pool.query('DELETE FROM password_reset_tokens WHERE merchant_id IN (SELECT id FROM merchants WHERE email = $1)', [email.toLowerCase()]);
    await pool.query('DELETE FROM merchants WHERE email = $1', [email.toLowerCase()]);
    await app.close();
    await pool.end();
  });

  it('stores and matches emails regardless of case', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: email.toUpperCase(), password: oldPassword })
      .expect(200);
  });

  it('refuses to create a second account that differs only by case', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: email.toLowerCase(), password: oldPassword, name: 'Dupe', stellar_base_address: stellar })
      .expect(409);
  });

  it('rejects a password longer than bcrypt can use', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: `long-${stamp}@example.com`, password: 'é'.repeat(40), name: 'Long', stellar_base_address: stellar })
      .expect(400);
  });

  it('answers the same way for an unknown email, and sends nothing', async () => {
    const before = sent.length;
    const res = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: `nobody-${stamp}@example.com` })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent.length).toBe(before);
  });

  it('sends a reset link for a real account, without revealing anything in the response', async () => {
    const before = sent.length;
    const res = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: email.toLowerCase() })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent.length).toBe(before + 1);
    expect(sent[sent.length - 1].to).toBe(email.toLowerCase());
  });

  it('keeps only the stored hash, never the token itself', async () => {
    const token = tokenFromLastMail();
    const { rows } = await pool.query(
      `SELECT token_hash FROM password_reset_tokens WHERE merchant_id = (SELECT id FROM merchants WHERE email = $1) AND used_at IS NULL`,
      [email.toLowerCase()],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a made-up token', async () => {
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'x'.repeat(40), password: newPassword })
      .expect(400);
  });

  it('resets the password once, and that signs out the old session', async () => {
    const token = tokenFromLastMail();
    await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie).expect(200);

    await request(app.getHttpServer()).post('/auth/reset-password').send({ token, password: newPassword }).expect(200);

    await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ email, password: oldPassword }).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ email, password: newPassword }).expect(200);
  });

  it('will not accept the same link twice', async () => {
    const token = tokenFromLastMail();
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, password: 'a-third-passphrase' })
      .expect(400);
  });

  it('will not accept an expired link', async () => {
    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(200);
    const token = tokenFromLastMail();
    await pool.query(
      `UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute'
       WHERE merchant_id = (SELECT id FROM merchants WHERE email = $1) AND used_at IS NULL`,
      [email.toLowerCase()],
    );
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, password: 'a-fourth-passphrase' })
      .expect(400);
  });

  it('a newer request invalidates the older link', async () => {
    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(200);
    const older = tokenFromLastMail();
    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email }).expect(200);
    const newer = tokenFromLastMail();
    expect(newer).not.toBe(older);

    await request(app.getHttpServer()).post('/auth/reset-password').send({ token: older, password: 'older-link-passphrase' }).expect(400);
    await request(app.getHttpServer()).post('/auth/reset-password').send({ token: newer, password: 'newer-link-passphrase' }).expect(200);
  });
});
