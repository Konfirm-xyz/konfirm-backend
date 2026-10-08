import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { FeesService } from './fees.service';

const submitSchema = z.object({
  signed_xdr: z.string().min(20).max(20_000),
});

// Merchant-facing fee settlement. Every route requires the merchant's session,
// and settlement ids are checked against the session's own merchant, so one
// merchant can't reach another's settlements.
@Controller('fees')
@UseGuards(AuthGuard)
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get('owed')
  owed(@Req() req: AuthedRequest) {
    return this.fees.owed(req.merchant.id);
  }

  @Get('settlements')
  list(@Req() req: AuthedRequest) {
    return this.fees.listSettlements(req.merchant.id);
  }

  @Post('settlements')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Req() req: AuthedRequest) {
    return this.fees.createSettlement(req.merchant.id);
  }

  @Post('settlements/:id/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitSchema)) body: z.infer<typeof submitSchema>,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('invalid settlement id');
    return this.fees.submitSigned(req.merchant.id, id, body.signed_xdr);
  }
}
