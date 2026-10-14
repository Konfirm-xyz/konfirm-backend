import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AdminGuard, AuthedAdminRequest } from '../admin-auth/admin-auth.guard';
import { AdminMerchantsService } from './admin-merchants.service';
import { AdminActionsService } from './admin-actions.service';
import { AdminStatsService } from './admin-stats.service';
import { AdminPaymentsService } from './admin-payments.service';
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
import { FacilitatorSpendGuardService } from '../facilitator/facilitator-spend-guard.service';
import { AuthService } from '../auth/auth.service';

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
});

const limitParamSchema = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? NaN : v),
    z.coerce
      .number({ invalid_type_error: 'limit must be a valid integer' })
      .int('limit must be an integer')
      .min(1, 'limit must be between 1 and 500')
      .max(500, 'limit must be between 1 and 500'),
  )
  .optional();

const offsetParamSchema = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? NaN : v),
    z.coerce
      .number({ invalid_type_error: 'offset must be a valid integer' })
      .int('offset must be an integer')
      .min(0, 'offset must be a non-negative integer')
      .max(100_000, 'offset must be at most 100000'),
  )
  .optional();

const daysParamSchema = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? NaN : v),
    z.coerce
      .number({ invalid_type_error: 'days must be a valid integer' })
      .int('days must be an integer')
      .min(1, 'days must be between 1 and 365')
      .max(365, 'days must be between 1 and 365'),
  )
  .optional();

export const paginationQuerySchema = z.object({
  limit: limitParamSchema,
  offset: offsetParamSchema,
});

export const statusPaginationQuerySchema = paginationQuerySchema.extend({
  status: z.string().optional(),
});

export const limitOnlyQuerySchema = z.object({
  limit: limitParamSchema,
});

export const daysQuerySchema = z.object({
  days: daysParamSchema,
});

// One controller for the whole admin resource surface rather than one per
// domain. This has grown past the "5 resources" this comment used to say —
// it's 18 services and ~30 routes now — but the reason still holds: every
// route is a one- or two-line delegation to its own service plus an audit
// log call, so the controller stays a thin router, not a place logic
// accumulates. If a resource ever needs route-level middleware or guards
// its neighbors don't, that's the signal to split it out, not the line
// count alone. Each resource still gets its own service for testability.
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly merchants: AdminMerchantsService,
    private readonly actions: AdminActionsService,
    private readonly stats: AdminStatsService,
    private readonly payments: AdminPaymentsService,
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
  ) {}

  @Get('stats')
  getStats() {
    return this.stats.get();
  }

  // --- Merchants ---

  @Get('merchants')
  listMerchants(
    @Query(new ZodValidationPipe(paginationQuerySchema))
    query: z.infer<typeof paginationQuerySchema> = {},
  ) {
    return this.merchants.list(query.limit, query.offset);
  }

  // For a merchant who has lost their password. Sends the same emailed link
  // the self-service flow does, and records who asked and why. Admins never
  // see or set the password.
  @Post('merchants/:id/password-reset')
  @HttpCode(200)
  async sendMerchantPasswordReset(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(passwordResetSchema)) body: z.infer<typeof passwordResetSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const email = await this.merchants.emailForPasswordReset(id);
    await this.auth.requestPasswordReset(email);
    await this.actions.log(req.admin.id, 'merchant.password-reset-sent', 'merchant', id, { reason: body.reason });
    return { ok: true };
  }

  @Patch('merchants/:id/status')
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
  async setMerchantTier(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantTierSchema)) body: z.infer<typeof setMerchantTierSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const merchant = await this.merchants.setTier(id, body.risk_tier);
    await this.actions.log(req.admin.id, 'merchant.set-tier', 'merchant', id, {
      risk_tier: body.risk_tier,
      reason: body.reason,
    });
    return merchant;
  }

  // --- Payments ---

  @Get('payments')
  listPayments(
    @Query(new ZodValidationPipe(statusPaginationQuerySchema))
    query: z.infer<typeof statusPaginationQuerySchema> = {},
  ) {
    return this.payments.list(query.status, query.limit, query.offset);
  }

  @Patch('payments/:id/status')
  async setPaymentStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setPaymentStatusSchema)) body: z.infer<typeof setPaymentStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const payment = await this.payments.setStatus(id, body.status);
    await this.actions.log(req.admin.id, `payment.set-status.${body.status}`, 'payment', id, { reason: body.reason });
    return payment;
  }

  // --- Compliance ---

  @Get('compliance/blocked-addresses')
  listBlockedAddresses() {
    return this.compliance.list();
  }

  @Post('compliance/blocked-addresses')
  async blockAddress(
    @Body(new ZodValidationPipe(blockAddressSchema)) body: z.infer<typeof blockAddressSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const blocked = await this.compliance.block(body.stellar_address, req.admin.id, body.reason);
    await this.actions.log(req.admin.id, 'compliance.block-address', 'stellar_address', body.stellar_address, { reason: body.reason });
    return blocked;
  }

  @Delete('compliance/blocked-addresses/:id')
  async unblockAddress(@Param('id') id: string, @Req() req: AuthedAdminRequest) {
    await this.compliance.unblock(id);
    await this.actions.log(req.admin.id, 'compliance.unblock-address', 'blocked_address', id);
    return { ok: true };
  }

  // --- Reconciler ---

  @Get('reconciler/status')
  getReconcilerStatus() {
    return this.reconciler.status();
  }

  // Backward-only, enforced in AdminReconcilerService — the exact "never
  // advance past unprocessed payments" rule from docs/RUNBOOK.md §4.
  @Post('reconciler/rewind')
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

  // --- Withdrawal attempts ---

  @Get('withdrawal-attempts')
  listWithdrawalAttempts() {
    return this.withdrawalAttempts.list();
  }

  // --- x402 settlements ---

  @Get('x402-settlements')
  listX402Settlements(
    @Query(new ZodValidationPipe(statusPaginationQuerySchema))
    query: z.infer<typeof statusPaginationQuerySchema> = {},
  ) {
    return this.x402Settlements.list(query.status, query.limit, query.offset);
  }

  // --- Pay links ---

  @Get('links')
  listLinks(
    @Query(new ZodValidationPipe(paginationQuerySchema))
    query: z.infer<typeof paginationQuerySchema> = {},
  ) {
    return this.links.list(query.limit, query.offset);
  }

  // --- Blockchain status ---

  @Get('blockchain/status')
  getBlockchainStatus() {
    return this.blockchain.status();
  }

  // --- Notifications ---

  @Get('notifications')
  listNotifications(
    @Query(new ZodValidationPipe(limitOnlyQuerySchema))
    query: z.infer<typeof limitOnlyQuerySchema> = {},
  ) {
    return this.notifications.list(query.limit);
  }

  // --- Treasury ---

  @Get('treasury/status')
  getTreasuryStatus() {
    return this.treasury.status();
  }

  // --- Fee revenue ---

  @Get('fee-revenue/summary')
  getFeeRevenueSummary() {
    return this.feeRevenue.summary();
  }

  @Get('fee-revenue/daily')
  getFeeRevenueDaily(
    @Query(new ZodValidationPipe(daysQuerySchema))
    query: z.infer<typeof daysQuerySchema> = {},
  ) {
    return this.feeRevenue.daily(query.days);
  }

  // --- Users ---
  // Every unique payments.payer_address, not a dedicated user account —
  // see AdminUsersService's comment for why that's the honest framing.

  @Get('users')
  listUsers(
    @Query(new ZodValidationPipe(paginationQuerySchema))
    query: z.infer<typeof paginationQuerySchema> = {},
  ) {
    return this.users.list(query.limit, query.offset);
  }

  // --- Wallets ---
  // Cross-references payer/merchant/blocked roles for the same address —
  // see AdminWalletsService for why this isn't a new data source.

  @Get('wallets')
  listWallets(
    @Query(new ZodValidationPipe(paginationQuerySchema))
    query: z.infer<typeof paginationQuerySchema> = {},
  ) {
    return this.wallets.list(query.limit, query.offset);
  }

  // --- Exchange rate ---

  @Get('exchange-rate/live')
  getLiveExchangeRate() {
    return this.exchangeRate.liveXlmUsdcRate();
  }

  @Get('exchange-rate/conversions')
  listExchangeRateConversions(
    @Query(new ZodValidationPipe(limitOnlyQuerySchema))
    query: z.infer<typeof limitOnlyQuerySchema> = {},
  ) {
    return this.exchangeRate.recentConversions(query.limit);
  }

  // --- Referrals ---

  @Get('referrals')
  listReferrals(
    @Query(new ZodValidationPipe(paginationQuerySchema))
    query: z.infer<typeof paginationQuerySchema> = {},
  ) {
    return this.referrals.list(query.limit, query.offset);
  }

  // --- Bazaar listings ---

  @Get('bazaar-listings')
  listBazaarListings(@Query('status') status?: string) {
    return this.bazaar.list(status);
  }

  @Patch('bazaar-listings/:id/status')
  async setBazaarListingStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setBazaarListingStatusSchema)) body: z.infer<typeof setBazaarListingStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const listing = await this.bazaar.setStatus(id, body.status, req.admin.id);
    await this.actions.log(req.admin.id, `bazaar-listing.${body.status}`, 'bazaar_listing', id);
    return listing;
  }

  // --- Facilitator spend guard ---
  // Bounds the blast radius of the facilitator's own sweep -- see
  // FacilitatorSpendGuardService's module comment for the threat model
  // (a compromised but still-legitimate signing process, not a leaked key).

  @Get('facilitator/status')
  getFacilitatorStatus() {
    return this.facilitatorSpendGuard.status();
  }

  @Post('facilitator/resume')
  async resumeFacilitator(@Req() req: AuthedAdminRequest) {
    await this.facilitatorSpendGuard.resume();
    await this.actions.log(req.admin.id, 'facilitator.resume', 'facilitator', 'spend-guard');
    return { ok: true };
  }

  // Surfaced back to the admin UI as a recent-activity feed rather than
  // just written and forgotten — an audit log nobody reads back isn't
  // accountability, it's a checkbox.
  @Get('activity')
  recentActivity(
    @Query(new ZodValidationPipe(limitOnlyQuerySchema))
    query: z.infer<typeof limitOnlyQuerySchema> = {},
  ) {
    return this.actions.recent(query.limit);
  }
}
