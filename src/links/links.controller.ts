import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { nonNegativeDecimalStringSchema } from '../common/numeric-validation';
import { LinksService } from './links.service';
import { zodBody } from '../common/zod-to-openapi';

// merchant_id is deliberately absent from this schema — it used to be a
// client-supplied field, which meant any caller who knew or guessed a UUID
// could create a Link against someone else's account. It now comes only
// from the authenticated session (req.merchant.id).
const createLinkSchema = z.object({
  // A link with amount_usdc = "0" is unpayable: the Stellar SDK rejects
  // Operation.payment({ amount: "0" }), so payers would hit a generic 500.
  // Reject zero (and any non-positive value) at creation time with a 400.
  amount_usdc: nonNegativeDecimalStringSchema('amount_usdc', 7, 999_999_999_999_999_999n)
    .refine((value) => Number(value) > 0, {
      message: 'amount_usdc must be greater than 0',
    })
    .optional(),
  currency: z.enum(['USDC', 'EURC', 'XLM']).optional(),
  description: z.string().max(500).optional(),
  // When false the link is automatically deactivated after its first
  // confirmed payment, preventing any further checkouts against it.
  reusable: z.boolean().optional(),
  // Hard cap on the total number of confirmed payments accepted. Once
  // COUNT(payments WHERE link_id = this AND status = 'paid') reaches this
  // value the link is deactivated automatically. NULL means unlimited.
  max_uses: z.number().int().positive().optional(),
  // ISO 8601 datetime string; the link is rejected at checkout after this
  // instant. NULL means no expiry.
  expires_at: z.string().datetime({ offset: true }).optional(),
  // Client-supplied. A retry with the same key returns the original link
  // instead of creating a second one (scoped per merchant).
  idempotency_key: z.string().min(1).max(255).optional(),
});

@ApiTags('Links')
@Controller('links')
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Create a payment link',
    description:
      'Creates a new payment link for the authenticated merchant. ' +
      '`merchant_id` is never accepted from the client — it is always derived from the session. ' +
      'Supplying an `idempotency_key` makes retries safe: the same key returns the original link. ' +
      'Optional lifecycle controls: `max_uses` caps the total confirmed payments accepted before ' +
      'the link auto-deactivates; `expires_at` (ISO 8601) sets a hard cutoff time; ' +
      '`reusable: false` deactivates the link after its very first confirmed payment.',
  })
  @ApiBody(zodBody(createLinkSchema, 'Create link request'))
  @ApiResponse({ status: 201, description: 'Payment link created.' })
  @ApiResponse({ status: 400, description: 'Invalid request body.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  create(
    @Body(new ZodValidationPipe(createLinkSchema)) body: z.infer<typeof createLinkSchema>,
    @Req() req: AuthedRequest,
  ) {
    return this.links.create({ ...body, merchant_id: req.merchant.id });
  }

  // Merchant-scoped by session, same shape as payments.controller.ts's
  // GET /payments/mine — a merchant can create a link but, until this
  // route existed, had no way to ever see it again.
  @Get('mine')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: "List the authenticated merchant's payment links",
    description: 'Returns links newest-first with a live use_count (confirmed payments only). Use limit and offset to paginate past 50.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max results per page (1–500, default 50)', type: 'number' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of results to skip (default 0)', type: 'number' })
  @ApiResponse({ status: 200, description: 'Array of link records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  listMine(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.links.listForMerchant(
      req.merchant.id,
      limit !== undefined ? parseInt(limit, 10) : undefined,
      offset !== undefined ? parseInt(offset, 10) : undefined,
    );
  }

  @Get(':id/public')
  @ApiOperation({
    summary: 'Get public projection of a payment link',
    description:
      'Returns a narrow, public-safe projection of the link: amount, currency, description, ' +
      'merchant name, and merchant Stellar address. Safe to call from a checkout page without auth.',
  })
  @ApiParam({ name: 'id', description: 'Payment link UUID', type: 'string' })
  @ApiResponse({ status: 200, description: 'Public link details.' })
  @ApiResponse({ status: 404, description: 'Link not found.' })
  getPublic(@Param('id') id: string) {
    return this.links.getPublic(id);
  }

  // Scoped to the authenticated merchant's own links — a link id from
  // another merchant's account 404s rather than confirming it exists.
  @Post(':id/deactivate')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: "Deactivate one of the authenticated merchant's own payment links",
    description:
      'Sets `active = false`. Idempotent — deactivating an already-inactive link is a no-op. ' +
      'No path back to active today; create a new link instead.',
  })
  @ApiParam({ name: 'id', description: 'Payment link UUID', type: 'string' })
  @ApiResponse({ status: 200, description: 'Updated link record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 404, description: 'Link not found, or does not belong to this merchant.' })
  deactivate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.links.deactivate(id, req.merchant.id);
  }
}
