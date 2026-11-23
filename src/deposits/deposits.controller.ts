import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { nonNegativeDecimalStringSchema } from '../common/numeric-validation';
import { DepositsService } from './deposits.service';
import { TestnetFaucetGuard } from './testnet-faucet.guard';
import { zodBody } from '../common/zod-to-openapi';

const tokenSchema = z.object({ transaction: z.string().min(1) });
const startSchema = z.object({
  currency: z.enum(['XLM', 'USDC']),
  token: z.string().min(1),
  account: z.string().regex(/^G[A-Z2-7]{55}$/),
});
const transferSchema = z.object({
  from: z.string().regex(/^G[A-Z2-7]{55}$/),
  to: z.string().regex(/^G[A-Z2-7]{55}$/),
  currency: z.enum(['XLM', 'USDC']),
  // amount=0 is unpayable: the Stellar SDK rejects Operation.payment({ amount: "0" })
  // — same fix applied to createLinkSchema in links.controller.ts (closed #64).
  amount: nonNegativeDecimalStringSchema('amount', 7, 9_223_372_036_854_775_807n).refine(
    (value) => Number(value) > 0,
    'amount must be greater than 0',
  ),
});

// No AuthGuard anywhere here — this exists to get test funds into *any*
// Stellar address, which has no relationship to a Konfirm merchant account.
// Two protections: the whole controller is off outside testnet (see
// TestnetFaucetGuard), and rate limiting bounds how hard it can hit the
// anchor or Horizon while it is on.
@ApiTags('Deposits')
@Controller('deposits')
@UseGuards(TestnetFaucetGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get('challenge')
  @ApiOperation({
    summary: 'Get a SEP-10 challenge for a deposit',
    description:
      'Proxies a SEP-10 challenge from the anchor for any Stellar address. ' +
      'Testnet-only — returns 404 unless ENABLE_TESTNET_FAUCET=true. Unauthenticated.',
  })
  @ApiQuery({ name: 'account', required: true, description: 'Stellar G... address to get challenge for', type: 'string' })
  @ApiResponse({ status: 200, description: 'SEP-10 challenge transaction envelope (XDR).' })
  @ApiResponse({ status: 400, description: 'Missing or invalid account address.' })
  @ApiResponse({ status: 404, description: 'Faucet not enabled (ENABLE_TESTNET_FAUCET not set).' })
  challenge(@Query('account') account: string) {
    if (!account) throw new BadRequestException('account is required');
    if (!/^G[A-Z2-7]{55}$/.test(account)) throw new BadRequestException('account must be a valid Stellar address');
    return this.deposits.getChallenge(account);
  }

  @Post('token')
  @ApiOperation({
    summary: 'Exchange a signed SEP-10 challenge for an anchor JWT',
    description: 'Testnet-only. Unauthenticated.',
  })
  @ApiBody(zodBody(tokenSchema, 'Signed SEP-10 challenge transaction'))
  @ApiResponse({ status: 200 | 201, description: 'Anchor JWT token.' })
  @ApiResponse({ status: 404, description: 'Faucet not enabled.' })
  token(@Body(new ZodValidationPipe(tokenSchema)) body: z.infer<typeof tokenSchema>) {
    return this.deposits.exchangeToken(body.transaction);
  }

  @Post('start')
  @ApiOperation({
    summary: 'Open a SEP-24 interactive deposit session',
    description:
      'Starts a SEP-24 interactive deposit on the testnet anchor for the given account. ' +
      'Returns the anchor-hosted interactive URL. Testnet-only. Unauthenticated.',
  })
  @ApiBody(zodBody(startSchema, 'Start deposit request'))
  @ApiResponse({ status: 200 | 201, description: 'Anchor interactive URL and transaction ID.' })
  @ApiResponse({ status: 404, description: 'Faucet not enabled.' })
  start(@Body(new ZodValidationPipe(startSchema)) body: z.infer<typeof startSchema>) {
    return this.deposits.startDeposit(body.token, body.currency, body.account);
  }

  // Polled every 3s while a deposit is in progress — same headroom reasoning
  // as withdrawals.controller.ts's status endpoint.
  @Get('status')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Poll anchor deposit transaction status',
    description: 'Polls the anchor for current deposit transaction status. Rate-limited to 60 req/min. Testnet-only.',
  })
  @ApiQuery({ name: 'token', required: true, description: 'Anchor JWT from /deposits/token', type: 'string' })
  @ApiQuery({ name: 'id', required: true, description: 'Anchor transaction ID from /deposits/start', type: 'string' })
  @ApiResponse({ status: 200, description: 'Anchor transaction status object.' })
  @ApiResponse({ status: 400, description: 'Missing token or id.' })
  @ApiResponse({ status: 404, description: 'Faucet not enabled.' })
  status(@Query('token') token: string, @Query('id') id: string) {
    if (!token || !id) throw new BadRequestException('token and id are both required');
    return this.deposits.getStatus(token, id);
  }

  @Post('transfer-payment')
  @ApiOperation({
    summary: 'Build a testnet transfer payment transaction',
    description:
      'Builds an unsigned Stellar payment transaction between two addresses. ' +
      'Used by the testnet harness scripts for exercising payments outside the browser. Testnet-only.',
  })
  @ApiBody(zodBody(transferSchema, 'Transfer payment request'))
  @ApiResponse({ status: 200 | 201, description: 'Unsigned XDR payment transaction.' })
  @ApiResponse({ status: 404, description: 'Faucet not enabled.' })
  prepareTransfer(@Body(new ZodValidationPipe(transferSchema)) body: z.infer<typeof transferSchema>) {
    return this.deposits.prepareTransferPayment(body.from, body.to, body.currency, body.amount);
  }
}
