import { BadRequestException, Body, Controller, Get, Logger, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { pool } from '../db/pool';
import { WithdrawalsService } from './withdrawals.service';
import { zodBody } from '../common/zod-to-openapi';

const tokenSchema = z.object({ transaction: z.string().min(1) });
const startSchema = z.object({ currency: z.enum(['XLM', 'USDC']), token: z.string().min(1) });
const prepareSchema = z.object({
  currency: z.enum(['XLM', 'USDC']),
  token: z.string().min(1),
  id: z.string().min(1),
});

// The account a cash-out moves from is always the logged-in merchant's own
// registered address — never a client-supplied field, for the same reason
// links.controller.ts stopped trusting a client-supplied merchant_id.
//
// Every method here calls out to the external anchor (testanchor.stellar.org)
// — a controller-wide throttle is simpler than tuning each one, and there's
// no legitimate reason a real cash-out flow needs more than this per minute.
@ApiTags('Withdrawals')
@Controller('withdrawals')
@UseGuards(AuthGuard)
@ApiCookieAuth('merchant-session')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class WithdrawalsController {
  private readonly logger = new Logger(WithdrawalsController.name);

  constructor(private readonly withdrawals: WithdrawalsService) {}

  // Every endpoint that acts on the merchant's account goes through this, so
  // none of them can be called directly to get past the missing-address case.
  private requireStellarAddress(req: AuthedRequest): string {
    const address = req.merchant.stellar_base_address;
    if (!address) {
      throw new BadRequestException('no Stellar address on file for this account');
    }
    return address;
  }

  @Get('challenge')
  @ApiOperation({
    summary: 'Get a SEP-10 challenge from the anchor',
    description:
      'Proxies a SEP-10 challenge transaction from the anchor (testanchor.stellar.org) for the ' +
      "merchant's registered Stellar address. The merchant signs this and submits to /withdrawals/token.",
  })
  @ApiResponse({ status: 200, description: 'SEP-10 challenge transaction envelope (XDR).' })
  @ApiResponse({ status: 400, description: 'No Stellar address on file for this account.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  challenge(@Req() req: AuthedRequest) {
    return this.withdrawals.getChallenge(this.requireStellarAddress(req));
  }

  @Post('token')
  @ApiOperation({
    summary: 'Exchange a signed SEP-10 challenge for an anchor JWT',
    description: 'Submits the merchant-signed SEP-10 challenge to the anchor and returns a short-lived JWT for the subsequent SEP-24 flow.',
  })
  @ApiBody(zodBody(tokenSchema, 'Signed SEP-10 challenge transaction'))
  @ApiResponse({ status: 200 | 201, description: 'Anchor JWT token.' })
  @ApiResponse({ status: 400, description: 'Invalid or malformed challenge transaction.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  token(@Body(new ZodValidationPipe(tokenSchema)) body: z.infer<typeof tokenSchema>) {
    return this.withdrawals.exchangeToken(body.transaction);
  }

  @Post('start')
  @ApiOperation({
    summary: 'Open a SEP-24 interactive withdrawal session',
    description:
      "Starts a SEP-24 interactive withdrawal against the anchor for the merchant's registered address. " +
      'Returns the anchor-hosted interactive URL. Also records a best-effort admin-visibility row ' +
      '(a tracking-insert failure never blocks the cash-out).',
  })
  @ApiBody(zodBody(startSchema, 'Start withdrawal request'))
  @ApiResponse({ status: 200 | 201, description: 'Anchor interactive URL and transaction ID.' })
  @ApiResponse({ status: 400, description: 'Invalid token or no Stellar address on file.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  async start(@Body(new ZodValidationPipe(startSchema)) body: z.infer<typeof startSchema>, @Req() req: AuthedRequest) {
    const result = await this.withdrawals.startWithdrawal(body.token, body.currency, this.requireStellarAddress(req));
    // Best-effort — this is purely an admin-visibility record, and a
    // tracking-insert failure must never block the merchant's actual
    // cash-out, which has already succeeded on the anchor's side by now.
    try {
      await pool.query(
        `INSERT INTO withdrawal_attempts (merchant_id, currency, anchor_tx_id, token) VALUES ($1, $2, $3, $4)
         ON CONFLICT (anchor_tx_id) DO NOTHING`,
        [req.merchant.id, body.currency, result.id, body.token],
      );
    } catch (err) {
      this.logger.warn('could not record admin-visibility tracking row', err);
    }
    return result;
  }

  // Polled every 3s for the duration of an in-progress cash-out (which can
  // take minutes if the anchor's popup is slow) — the controller's default
  // 20/min would be right at that boundary, so this gets its own headroom.
  @Get('status')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Poll anchor transaction status',
    description:
      'Polls the anchor for the current status of a withdrawal transaction. ' +
      'Rate-limited to 60 req/min (the checkout page polls every 3 s).',
  })
  @ApiQuery({ name: 'token', required: true, description: 'Anchor JWT from /withdrawals/token', type: 'string' })
  @ApiQuery({ name: 'id', required: true, description: 'Anchor transaction ID from /withdrawals/start', type: 'string' })
  @ApiResponse({ status: 200, description: 'Anchor transaction status object.' })
  @ApiResponse({ status: 400, description: 'Missing token or id parameters.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  status(@Query('token') token: string, @Query('id') id: string) {
    if (!token || !id) throw new BadRequestException('token and id are both required');
    return this.withdrawals.getStatus(token, id);
  }

  @Post('prepare-payment')
  @ApiOperation({
    summary: 'Build the on-chain payment to the anchor',
    description:
      'Once the anchor is `pending_user_transfer_start`, builds the unsigned Stellar payment ' +
      "from the merchant's account to the anchor. The merchant signs this in Freighter and submits it.",
  })
  @ApiBody(zodBody(prepareSchema, 'Prepare withdrawal payment request'))
  @ApiResponse({ status: 200 | 201, description: 'Unsigned XDR payment transaction.' })
  @ApiResponse({ status: 400, description: 'Anchor not yet ready or invalid parameters.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  async preparePayment(
    @Body(new ZodValidationPipe(prepareSchema)) body: z.infer<typeof prepareSchema>,
    @Req() req: AuthedRequest,
  ) {
    const address = this.requireStellarAddress(req);
    const txn = await this.withdrawals.getStatus(body.token, body.id);
    return this.withdrawals.prepareWithdrawalTx(address, body.currency, txn);
  }
}
