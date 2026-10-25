import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AdminGuard, AuthedAdminRequest } from '../admin-auth/admin-auth.guard';
import { AdminMerchantsService } from './admin-merchants.service';
import { AdminActionsService } from './admin-actions.service';
import { AdminStatsService } from './admin-stats.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminPaymentNotesService } from './admin-payment-notes.service';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminReconcilerService } from './admin-reconciler.service';
import { AdminWithdrawalAttemptsService } from './admin-withdrawal-attempts.service';
import { AdminX402SettlementsService } from './admin-x402-settlements.service';
import { AdminLinksService } from './admin-links.service';
import { AdminBlockchainService } from './admin-blockchain.service';
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminTreasuryService } from './admin-treasury.service';
import { AdminFeeRevenueService } from './admin-fee-revenue.service';
import { AdminUsersService } from './admin-users.service';
import { AdminWalletsService } from './admin-wallets.service';
import { AdminExchangeRateService } from './admin-exchange-rate.service';
import { AdminReferralsService } from './admin-referrals.service';
import { AdminBazaarService } from './admin-bazaar.service';
import { AdminTeamService } from './admin-team.service';
import { FacilitatorSpendGuardService } from '../facilitator/facilitator-spend-guard.service';
import { AuthService } from '../auth/auth.service';
import { zodBody } from '../common/zod-to-openapi';

const passwordResetSchema = z.object({
  reason: z.string().min(3).max(500),
});

const setMerchantStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().max(500).optional(),
});

const setMerchantTierSchema = z.object({
  risk_tier: z.enum(['unverified', 'standard', 'established', 'enterprise']),
  reason: z.string().max(500).optional(),
});

const setMerchantFeeBpsSchema = z.object({
  fee_bps: z.number().int().min(0).max(1000),
  reason: z.string().max(500).optional(),
});

const setPaymentStatusSchema = z.object({
  status: z.enum(['paid', 'held', 'disputed']),
  reason: z.string().max(500).optional(),
});

const blockAddressSchema = z.object({
  stellar_address: z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a valid Stellar G... address'),
  reason: z.string().max(500).optional(),
});

const rewindCursorSchema = z.object({
  cursor: z.string().min(1),
});

const setBazaarListingStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional(),
});

// Admin-assisted profile override (issue #38). All fields optional so the
// caller only sends what needs changing.
const updateMerchantProfileSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    stellar_base_address: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/, 'must be a valid Stellar G... address')
      .optional(),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.email !== undefined || b.stellar_base_address !== undefined,
    { message: 'at least one of name, email, or stellar_base_address must be provided' },
  );

const addPaymentNoteSchema = z.object({
  // 5 000 characters is generous for an investigation note; enforced at the
  // API boundary so the DB never has to truncate mid-sentence.
  body: z.string().min(1).max(5000),
});

// One controller for the whole admin resource surface rather than one per
// domain. This has grown past the "5 resources" this comment used to say —
// it's 18 services and ~30 routes now — but the reason still holds: every
// route is a one- or two-line delegation to its own service plus an audit
// log call, so the controller stays a thin router, not a place logic
// accumulates. If a resource ever needs route-level middleware or guards
// its neighbors don't, that's the signal to split it out, not the line
// count alone. Each resource still gets its own service for testability.
@ApiTags('Admin')
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly merchants: AdminMerchantsService,
    private readonly actions: AdminActionsService,
    private readonly stats: AdminStatsService,
    private readonly payments: AdminPaymentsService,
    private readonly paymentNotes: AdminPaymentNotesService,
    private readonly compliance: AdminComplianceService,
    private readonly reconciler: AdminReconcilerService,
    private readonly withdrawalAttempts: AdminWithdrawalAttemptsService,
    private readonly x402Settlements: AdminX402SettlementsService,
    private readonly links: AdminLinksService,
    private readonly blockchain: AdminBlockchainService,
    private readonly notifications: AdminNotificationsService,
    private readonly treasury: AdminTreasuryService,
    private readonly feeRevenue: AdminFeeRevenueService,
    private readonly users: AdminUsersService,
    private readonly wallets: AdminWalletsService,
    private readonly exchangeRate: AdminExchangeRateService,
    private readonly referrals: AdminReferralsService,
    private readonly bazaar: AdminBazaarService,
    private readonly facilitatorSpendGuard: FacilitatorSpendGuardService,
    private readonly auth: AuthService,
    private readonly adminTeam: AdminTeamService,
  ) {}

  @Get('stats')
  @ApiOperation({
    summary: 'Overview dashboard aggregates',
    description:
      'Real Postgres aggregates: merchant counts by status, today\'s payment count/volume, ' +
      'a zero-filled 7-day daily volume series.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard stats object.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getStats() {
    return this.stats.get();
  }

  // --- Merchants ---

  @Get('merchants')
  @ApiOperation({ summary: 'List all merchants', description: 'All merchants, newest first. Supports pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: 'number', description: 'Max results (default 50)' })
  @ApiQuery({ name: 'offset', required: false, type: 'number', description: 'Pagination offset' })
  @ApiResponse({ status: 200, description: 'Array of merchant records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listMerchants(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.merchants.list(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  @Patch('merchants/:id/status')
  @ApiOperation({
    summary: 'Set merchant status',
    description:
      'Suspend or reactivate a merchant. Takes effect immediately — an already-issued session ' +
      'cookie stops working at the next request once suspended (AuthGuard re-checks status per request).',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(setMerchantStatusSchema, 'Set merchant status'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async setMerchantStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantStatusSchema)) body: z.infer<typeof setMerchantStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const merchant = await this.merchants.setStatus(id, body.status);
    await this.actions.log(req.admin.id, `merchant.${body.status === 'suspended' ? 'suspend' : 'reactivate'}`, 'merchant', id, {
      reason: body.reason,
    });
    return merchant;
  }

  @Patch('merchants/:id/tier')
  @ApiOperation({
    summary: 'Set merchant risk tier',
    description:
      'Sets the merchant risk_tier. Note this is a risk classification only — it does not ' +
      'change the fee rate charged at checkout (see the fee-bps route for that).',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(setMerchantTierSchema, 'Set merchant risk tier'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async setMerchantTier(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantTierSchema)) body: z.infer<typeof setMerchantTierSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const merchant = await this.merchants.setTier(id, body.risk_tier);
    await this.actions.log(req.admin.id, 'merchant.tier', 'merchant', id, {
      risk_tier: body.risk_tier,
      reason: body.reason,
    });
    return merchant;
  }

  @Patch('merchants/:id/fee-bps')
  @ApiOperation({
    summary: 'Set merchant base fee rate',
    description:
      'Sets the merchant base fee_bps charged at checkout (e.g. for a negotiated deal or a manual comp). ' +
      'This is the base rate; any active referral promo_fee_bps still overrides it while it lasts. ' +
      'Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(setMerchantFeeBpsSchema, 'Set merchant fee rate (bps)'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 400, description: 'Invalid fee_bps.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async setMerchantFeeBps(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantFeeBpsSchema)) body: z.infer<typeof setMerchantFeeBpsSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const merchant = await this.merchants.setFeeBps(id, body.fee_bps);
    await this.actions.log(req.admin.id, 'merchant.fee-bps', 'merchant', id, {
      fee_bps: body.fee_bps,
      reason: body.reason,
    });
    return merchant;
  }

  // Admin-assisted profile override (issue #38).
  // Bypasses the two-step email-verification flow that self-service uses — an
  // admin applying a correction on behalf of a merchant doesn't need the
  // merchant to confirm it at their new inbox. Does NOT bump session_version
  // so the merchant is not unexpectedly signed out by a support action.
  @Patch('merchants/:id/profile')
  @ApiOperation({
    summary: 'Update merchant profile fields',
    description:
      'Admin override for name, email, and/or stellar_base_address. ' +
      'All three fields are optional — send only what needs changing. ' +
      'Email changes are applied directly without the merchant\'s two-step verification. ' +
      'Existing merchant sessions are not revoked. Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(updateMerchantProfileSchema, 'Update merchant profile'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 400, description: 'No fields provided or conflicting data.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  @ApiResponse({ status: 409, description: 'New email already taken by another merchant.' })
  async updateMerchantProfile(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMerchantProfileSchema)) body: z.infer<typeof updateMerchantProfileSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const { reason, ...fields } = body;
    const merchant = await this.merchants.updateProfile(id, fields);
    await this.actions.log(req.admin.id, 'merchant.update-profile', 'merchant', id, {
      updated: Object.keys(fields),
      reason,
    });
    return merchant;
  }

  // --- Payments ---

  @Get('payments')
  @ApiOperation({ summary: 'List all payments', description: 'All payments across every merchant, newest first. Filter by status, paginate with limit/offset.' })
  @ApiQuery({ name: 'status', required: false, type: 'string', description: 'Filter by status: paid | held | disputed' })
  @ApiQuery({ name: 'limit', required: false, type: 'number', description: 'Max results' })
  @ApiQuery({ name: 'offset', required: false, type: 'number', description: 'Pagination offset' })
  @ApiResponse({ status: 200, description: 'Array of payment records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listPayments(@Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.payments.list(status, limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  @Patch('payments/:id/status')
  @ApiOperation({
    summary: 'Set payment status',
    description: 'Manually override a payment status (paid/held/disputed). Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Payment UUID', type: 'string' })
  @ApiBody(zodBody(setPaymentStatusSchema, 'Set payment status'))
  @ApiResponse({ status: 200, description: 'Updated payment record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Payment not found.' })
  async setPaymentStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setPaymentStatusSchema)) body: z.infer<typeof setPaymentStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const payment = await this.payments.setStatus(id, body.status);
    await this.actions.log(req.admin.id, 'payment.status', 'payment', id, {
      status: body.status,
      reason: body.reason,
    });
    return payment;
  }

  // Notes are independent of status changes — an admin reviewing a held
  // payment can leave context ("confirmed with merchant via email, releasing")
  // without necessarily changing the status yet. The body is also logged to
  // admin_actions so the note appears in the global activity feed in addition
  // to being attached to the payment itself.
  @Post('payments/:id/notes')
  @ApiOperation({
    summary: 'Add an investigation note to a payment',
    description:
      'Appends a free-text note to the payment\'s investigation thread. ' +
      'Independent of status changes — no status change is required or implied. ' +
      'Logged to admin_actions as payment.note-added.',
  })
  @ApiParam({ name: 'id', description: 'Payment UUID', type: 'string' })
  @ApiBody(zodBody(addPaymentNoteSchema, 'Add payment note'))
  @ApiResponse({ status: 201, description: 'Created note record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Payment not found.' })
  async addPaymentNote(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addPaymentNoteSchema)) body: z.infer<typeof addPaymentNoteSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const note = await this.paymentNotes.create(id, req.admin.id, body.body);
    await this.actions.log(req.admin.id, 'payment.note-added', 'payment', id, {
      note_id: note.id,
      // First 120 chars in the audit log so the activity feed gives enough
      // context without storing the entire note body twice.
      body_preview: body.body.length > 120 ? body.body.slice(0, 120) + '…' : body.body,
    });
    return note;
  }

  @Get('payments/:id/notes')
  @ApiOperation({
    summary: 'List investigation notes for a payment',
    description: 'Returns the full notes thread for a payment, oldest first.',
  })
  @ApiParam({ name: 'id', description: 'Payment UUID', type: 'string' })
  @ApiResponse({ status: 200, description: 'Array of note records, oldest first.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Payment not found.' })
  listPaymentNotes(@Param('id') id: string) {
    return this.paymentNotes.list(id);
  }

  // --- Compliance ---

  @Get('compliance/blocked-addresses')
  @ApiOperation({ summary: 'List blocked Stellar addresses', description: 'The admin-managed compliance blocklist.' })
  @ApiResponse({ status: 200, description: 'Array of blocked address records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listBlockedAddresses() {
    return this.compliance.list();
  }

  @Post('compliance/blocked-addresses')
  @ApiOperation({
    summary: 'Block a Stellar address',
    description: 'Adds a Stellar address to the blocklist. Logged to admin_actions.',
  })
  @ApiBody(zodBody(blockAddressSchema, 'Block a Stellar address'))
  @ApiResponse({ status: 201, description: 'Created blocklist entry.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async blockAddress(
    @Body(new ZodValidationPipe(blockAddressSchema)) body: z.infer<typeof blockAddressSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const blocked = await this.compliance.block(body.stellar_address, req.admin.id, body.reason);
    await this.actions.log(req.admin.id, 'compliance.block-address', 'stellar_address', body.stellar_address, {
      reason: body.reason,
    });
    return blocked;
  }

  @Delete('compliance/blocked-addresses/:id')
  @ApiOperation({
    summary: 'Unblock a Stellar address',
    description: 'Removes a Stellar address from the blocklist. Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'blocked_addresses row UUID', type: 'string' })
  @ApiResponse({ status: 200, description: 'Returns { ok: true }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async unblockAddress(@Param('id') id: string, @Req() req: AuthedAdminRequest) {
    const removed = await this.compliance.unblock(id);
    await this.actions.log(req.admin.id, 'compliance.unblock-address', 'blocked_address', id, {
      stellar_address: removed.stellar_address,
      originalReason: removed.reason,
    });
    return { ok: true };
  }

  // Backward-only, enforced in AdminReconcilerService — the exact "never
  // advance past unprocessed payments" rule from docs/RUNBOOK.md §4.
  @Post('reconciler/rewind')
  @ApiOperation({
    summary: 'Rewind the reconciler cursor',
    description:
      'Sets the reconciler\'s Horizon cursor to an earlier position. ' +
      'Backward-only, enforced in code — moving forward past unprocessed payments would permanently skip real transactions. ' +
      'Does not add process-level coordination; if the reconciler is running, the same race as the CLI set-cursor still exists.',
  })
  @ApiBody(zodBody(rewindCursorSchema, 'Rewind cursor request'))
  @ApiResponse({ status: 200, description: 'Previous and new cursor values.' })
  @ApiResponse({ status: 400, description: 'Cursor would move forward — rejected.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async rewindReconciler(
    @Body(new ZodValidationPipe(rewindCursorSchema)) body: z.infer<typeof rewindCursorSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const result = await this.reconciler.rewind(body.cursor);
    await this.actions.log(req.admin.id, 'reconciler.rewind', 'reconciler_cursor', 'cursor', {
      previous: result.previous,
      new: body.cursor,
    });
    return result;
  }

  @Patch('bazaar/listings/:id/status')
  @ApiOperation({
    summary: 'Approve or reject a Bazaar listing',
    description: 'Sets a Bazaar listing status. Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Listing UUID', type: 'string' })
  @ApiBody(zodBody(setBazaarListingStatusSchema, 'Set Bazaar listing status'))
  @ApiResponse({ status: 200, description: 'Updated listing record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Listing not found.' })
  async setBazaarListingStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setBazaarListingStatusSchema)) body: z.infer<typeof setBazaarListingStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const { previous_status, ...listing } = await this.bazaar.setStatus(id, body.status, req.admin.id);
    await this.actions.log(req.admin.id, `bazaar-listing.${body.status}`, 'bazaar_listing', id, {
      reason: body.reason,
      previousStatus: previous_status,
    });
    return listing;
  }
}
