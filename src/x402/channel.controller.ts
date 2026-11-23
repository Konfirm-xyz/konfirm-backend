import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { nonNegativeIntegerStringSchema, POSTGRES_BIGINT_MAX } from '../common/numeric-validation';
import { ChannelService } from './channel.service';
import { zodBody } from '../common/zod-to-openapi';

// channel_id/nonce/cumulative_amount travel as decimal strings (JSON has no
// bigint) — validated as digit strings here, converted to BigInt at the
// service boundary. Signature as hex, matching how it's stored internally
// (src/common/channel-claim.ts, x402_channels.pending_signature).
const claimSchema = z.object({
  channel_id: nonNegativeIntegerStringSchema(POSTGRES_BIGINT_MAX, 'channel_id'),
  cumulative_amount: nonNegativeIntegerStringSchema((1n << 127n) - 1n, 'cumulative_amount'),
  nonce: nonNegativeIntegerStringSchema(POSTGRES_BIGINT_MAX, 'nonce'),
  signature: z.string().regex(/^[0-9a-fA-F]{128}$/, 'must be a 64-byte hex-encoded ed25519 signature'),
});

// The payer builds and signs the open_channel invocation entirely
// client-side (their own auth entry embedded, nothing submitted yet) and
// hands the facilitator the resulting transaction XDR to countersign as
// fee-sponsoring source and submit — everything else (payee, token,
// deposit) is extracted from the signed transaction itself, not repeated
// here, so there's nothing for the two to disagree about.
const openSchema = z.object({
  transaction: z.string().min(1),
  resource_url: z.string().url().optional(),
});

// Same client-signs shape as open — either party can request a close.
// Fund realization happens later via finalize_close, driven by the keeper
// once the challenge period elapses, not synchronously in this request.
const closeSchema = z.object({
  transaction: z.string().min(1),
});

// Same no-AuthGuard reasoning as x402.controller.ts — called by parties
// with no prior relationship to Konfirm. Sits at the same 20/60s tier as
// /x402/verify+/settle for /open (a real Soroban submission), but /claim
// gets the cheaper 60/60s no-RPC tier since it costs a Postgres round-trip
// and a local signature check, not a network call — the first endpoint in
// this codebase to actually need that third throttle tier.
@ApiTags('x402')
@Controller('x402/channel')
export class ChannelController {
  constructor(private readonly channel: ChannelService) {}

  @Post('claim')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Submit a payment channel claim',
    description:
      'Records a signed incremental payment claim against an open x402 payment channel. ' +
      'Validates the ed25519 signature locally — no Soroban RPC needed. ' +
      'Rate-limited to 60 req/min. Unauthenticated.',
  })
  @ApiBody(zodBody(claimSchema, 'Channel claim request'))
  @ApiResponse({ status: 201, description: 'Returns { accepted: true }.' })
  @ApiResponse({ status: 400, description: 'Claim rejected (invalid signature, stale nonce, unknown channel, etc.).' })
  async claim(@Body(new ZodValidationPipe(claimSchema)) body: z.infer<typeof claimSchema>) {
    const result = await this.channel.claim({
      onchainChannelId: BigInt(body.channel_id),
      cumulativeAmount: BigInt(body.cumulative_amount),
      nonce: BigInt(body.nonce),
      signature: Buffer.from(body.signature, 'hex'),
    });
    if (!result.accepted) {
      throw new BadRequestException(result.reason ?? 'claim_rejected');
    }
    return { accepted: true };
  }

  @Post('open')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Open an x402 payment channel',
    description:
      'Countersigns and submits a payer-built open_channel Soroban transaction. ' +
      'The payer builds and signs the invocation client-side (auth entry embedded); ' +
      'the facilitator countersigns as fee-sponsoring source and submits. ' +
      'Rate-limited to 20 req/min (Soroban submission). Unauthenticated.',
  })
  @ApiBody(zodBody(openSchema, 'Open channel request'))
  @ApiResponse({ status: 201, description: 'Returns { success: true, channel_id, transaction }.' })
  @ApiResponse({ status: 400, description: 'Channel open failed.' })
  async open(@Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>) {
    const result = await this.channel.openChannel({ transactionXdr: body.transaction, resourceUrl: body.resource_url });
    if (!result.success) {
      throw new BadRequestException(result.errorReason ?? 'open_failed');
    }
    return { success: true, channel_id: result.onchainChannelId, transaction: result.transaction };
  }

  @Post('close')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Close an x402 payment channel',
    description:
      'Initiates cooperative or unilateral channel close. ' +
      'Fund realization via finalize_close happens later, driven by the channel keeper once the challenge period elapses. ' +
      'Rate-limited to 20 req/min. Unauthenticated.',
  })
  @ApiBody(zodBody(closeSchema, 'Close channel request'))
  @ApiResponse({ status: 201, description: 'Returns { success: true, transaction }.' })
  @ApiResponse({ status: 400, description: 'Channel close failed.' })
  async close(@Body(new ZodValidationPipe(closeSchema)) body: z.infer<typeof closeSchema>) {
    const result = await this.channel.closeChannel({ transactionXdr: body.transaction });
    if (!result.success) {
      throw new BadRequestException(result.errorReason ?? 'close_failed');
    }
    return { success: true, transaction: result.transaction };
  }
}
