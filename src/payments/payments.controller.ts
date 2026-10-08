import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Calls Horizon and the compliance contract over Soroban RPC — real
  // external services, not a cheap DB read. 20/min per
  // IP is far more than a real checkout attempt ever needs.
  @Get('prepare-tx')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  prepareTx(
    @Query('linkId') linkId: string,
    @Query('muxed_id') muxedId: string,
    @Query('payer') payer: string,
  ) {
    if (!linkId || !muxedId || !payer) {
      throw new BadRequestException('linkId, muxed_id, and payer are all required');
    }
    return this.payments.prepareTx(linkId, muxedId, payer);
  }

  @Get('pay-uri')
  buildPayUri(@Query('linkId') linkId: string, @Query('muxed_id') muxedId: string) {
    if (!linkId || !muxedId) {
      throw new BadRequestException('linkId and muxed_id are both required');
    }
    return this.payments.buildPayUri(linkId, muxedId);
  }

  // Merchant-scoped by session, never by a Stellar address in the URL. The
  // old /by-merchant/:address routes returned any merchant's sales to anyone
  // who knew their address. The checkout page's per-payment check moved to
  // GET /links/:linkId/sessions/:muxedId, which only ever shows that one
  // payer's own payment.
  @Get('mine')
  @UseGuards(AuthGuard)
  listMine(@Req() req: AuthedRequest) {
    return this.payments.listForMerchant(req.merchant.id);
  }

  @Get('mine/pending')
  @UseGuards(AuthGuard)
  pendingMine(@Req() req: AuthedRequest) {
    return this.payments.hasPendingSession(req.merchant.id);
  }
}
