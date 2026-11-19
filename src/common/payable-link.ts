import { BadRequestException } from '@nestjs/common';

// The subset of a link row that decides whether it can still take a payment.
// Shared by PaymentsService.loadPayableLink() and SessionsService.reserve()
// so the two paths can't drift on what "payable" means.
export interface PayableLinkRow {
  active: boolean;
  expires_at: Date | string | null;
  merchant_status: string;
}

// Throws BadRequestException for a link that must not accept a new payment:
// inactive, expired, or belonging to a suspended merchant. Callers that need
// extra rules (use caps, amount, address) apply them on top of this.
export function assertLinkPayable(link: PayableLinkRow): void {
  if (!link.active) throw new BadRequestException('link is not active');
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    throw new BadRequestException('link has expired');
  }
  // A suspended merchant's links stop accepting payment immediately — the
  // real teeth of a suspension, not just locking them out of their own
  // dashboard (see auth.guard.ts). Not restricted to merchant_status =
  // 'active': a 'pending' (not yet email-verified) merchant can still log
  // in and accept payments — only 'suspended' blocks checkout.
  if (link.merchant_status === 'suspended') {
    throw new BadRequestException('this merchant is not currently accepting payments');
  }
}
