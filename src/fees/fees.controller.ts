import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { FeesService } from './fees.service';
import { zodBody } from '../common/zod-to-openapi';

const submitSchema = z.object({
  signed_xdr: z.string().min(20).max(20_000),
});

const createSettlementSchema = z
  .object({
    amount: z.string().regex(/^\d+(\.\d{1,7})?$/).optional(),
    asset_code: z.enum(['XLM', 'USDC', 'EURC']).optional(),
    asset_issuer: z.string().nullable().optional(),
  })
  .refine((value) => (value.amount === undefined) === (value.asset_code === undefined), {
    message: 'amount and asset_code must be provided together',
  })
  .refine((value) => value.asset_issuer === undefined || value.amount !== undefined, {
    message: 'asset_issuer requires a partial settlement amount',
  })
  .optional();

// Merchant-facing fee settlement. Every route requires the merchant's session,
// and settlement ids are checked against the session's own merchant, so one
// merchant can't reach another's settlements.
@ApiTags('Fees')
@Controller('fees')
@UseGuards(AuthGuard)
@ApiCookieAuth('merchant-session')
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get('owed')
  @ApiOperation({
    summary: 'List owed fee totals',
    description: 'Returns owed platform fee totals grouped by asset for the authenticated merchant.',
  })
  @ApiResponse({ status: 200, description: 'Array of { asset_code, amount, payment_count }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  owed(@Req() req: AuthedRequest) {
    return this.fees.owed(req.merchant.id);
  }

  @Get('settlements')
  @ApiOperation({
    summary: 'List fee settlements',
    description: 'Returns recent fee settlement records (pending, signed, confirmed, disputed) for the authenticated merchant.',
  })
  @ApiResponse({ status: 200, description: 'Array of settlement records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  list(@Req() req: AuthedRequest) {
    return this.fees.listSettlements(req.merchant.id);
  }

  @Post('settlements')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create a fee settlement transaction',
    description:
      'Builds a full or partial unsigned settlement transaction. ' +
      'Omit body for a full settlement covering all owed assets. ' +
      'Provide `amount` + `asset_code` for a partial settlement.',
  })
  @ApiBody(zodBody(createSettlementSchema ?? z.object({}), 'Create settlement request (optional partial selection)'))
  @ApiResponse({ status: 201, description: 'Settlement record with unsigned XDR.' })
  @ApiResponse({ status: 400, description: 'Validation error or no owed fees.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  create(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(createSettlementSchema)) body: z.infer<typeof createSettlementSchema> = {},
  ) {
    const selection = body && body.amount !== undefined && body.asset_code !== undefined ? {
      amount: body.amount,
      asset_code: body.asset_code,
      asset_issuer: body.asset_issuer,
    } : undefined;
    return this.fees.createSettlement(req.merchant.id, selection);
  }

  @Post('settlements/:id/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Submit a signed fee settlement',
    description:
      'Verifies that the signed XDR matches the transaction Konfirm built, then submits it on-chain. ' +
      'Konfirm never holds the merchant key — the merchant signs in Freighter and submits the XDR here.',
  })
  @ApiParam({ name: 'id', description: 'Settlement UUID', type: 'string' })
  @ApiBody(zodBody(submitSchema, 'Signed settlement XDR'))
  @ApiResponse({ status: 201, description: 'Submission result.' })
  @ApiResponse({ status: 400, description: 'Invalid settlement ID or XDR mismatch.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 404, description: 'Settlement not found or not owned by this merchant.' })
  submit(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitSchema)) body: z.infer<typeof submitSchema>,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('invalid settlement id');
    return this.fees.submitSigned(req.merchant.id, id, body.signed_xdr);
  }

  @Post('settlements/:id/dispute')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Dispute a fee settlement',
    description:
      'Disputes a settlement before it is signed, releasing its fee claims back to owed status. ' +
      'Can only be done before the merchant has signed — once submitted on-chain it cannot be disputed.',
  })
  @ApiParam({ name: 'id', description: 'Settlement UUID', type: 'string' })
  @ApiResponse({ status: 201, description: 'Settlement marked as disputed.' })
  @ApiResponse({ status: 400, description: 'Invalid settlement ID or settlement already submitted.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 404, description: 'Settlement not found or not owned by this merchant.' })
  dispute(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('invalid settlement id');
    return this.fees.disputeSettlement(req.merchant.id, id);
  }
}
