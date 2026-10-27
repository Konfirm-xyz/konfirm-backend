import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard, AuthedAdminRequest } from '../admin-auth/admin-auth.guard';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { zodBody } from '../common/zod-to-openapi';
import { AdminActionsService } from './admin-actions.service';
import { AdminTreasurySettlementsService } from './admin-treasury-settlements.service';

// Deliberately a separate controller/route group from AdminController
// (admin.controller.ts) rather than added to it -- see backend#217 and
// docs/VERIFY.md: that file does not currently compile, and new work
// should not depend on it until it's fixed.
//
// Every propose_settlement/approve_settlement/execute_settlement call
// requires require_signer -- a real treasury signer's own key. This
// controller never holds or relays that key itself: the three
// build-tx endpoints below only build and return an unsigned transaction
// for the admin's connected wallet (Freighter) to sign, exactly like
// fees.controller.ts's merchant-facing settlement endpoints do for a
// merchant's own key. The admin operates whichever signer identity
// (deployer/signer2/signer3) they pass as the *_address field -- there is
// no session-bound signer the way fees.ts has a session-bound merchant.
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const amountSchema = z.string().regex(/^\d+(\.\d{1,7})?$/, 'must be a decimal amount with up to 7 places');

const proposeSchema = z.object({
  proposer_address: z.string().regex(STELLAR_ADDRESS, 'must be a valid Stellar G... address'),
  merchant_address: z.string().regex(STELLAR_ADDRESS, 'must be a valid Stellar G... address'),
  amount: amountSchema,
});

const approveSchema = z.object({
  signer_address: z.string().regex(STELLAR_ADDRESS, 'must be a valid Stellar G... address'),
});

const executeSchema = z.object({
  caller_address: z.string().regex(STELLAR_ADDRESS, 'must be a valid Stellar G... address'),
});

const submitSchema = z.object({
  signed_xdr: z.string().min(20).max(20_000),
  build_token: z.string().uuid(),
});

function parseSettlementId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException('settlement id must be a non-negative integer');
  }
  return BigInt(raw);
}

@ApiTags('admin-treasury-settlements')
@Controller('admin/treasury/settlements')
@UseGuards(AdminGuard)
export class AdminTreasurySettlementsController {
  constructor(
    private readonly settlements: AdminTreasurySettlementsService,
    private readonly actions: AdminActionsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List tracked treasury settlements',
    description:
      'Settlements this backend has been told about via sync -- the contract has no "list all" primitive. ' +
      'Pending ones sort first.',
  })
  @ApiResponse({ status: 200, description: 'Array of tracked settlement records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  list() {
    return this.settlements.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a tracked settlement by its on-chain id' })
  @ApiParam({ name: 'id', description: 'on-chain settlement id', type: 'string' })
  @ApiResponse({ status: 200, description: 'The tracked settlement record.' })
  @ApiResponse({ status: 404, description: 'Not tracked yet -- call sync first.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async get(@Param('id') id: string) {
    const row = await this.settlements.get(parseSettlementId(id));
    if (!row) {
      throw new NotFoundException('settlement not tracked yet -- call POST .../sync first');
    }
    return row;
  }

  @Post(':id/sync')
  @ApiOperation({
    summary: 'Re-read a settlement from chain and record it',
    description:
      'Call this right after a connected wallet submits propose_settlement, approve_settlement, or ' +
      'execute_settlement on this id -- re-reads the real on-chain Settlement and upserts the mirror row. ' +
      'Never trusts a claimed amount/merchant/status, only what get_settlement actually returns.',
  })
  @ApiParam({ name: 'id', description: 'on-chain settlement id', type: 'string' })
  @ApiResponse({ status: 200, description: 'The freshly-synced settlement record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async sync(@Param('id') id: string, @Req() req: AuthedAdminRequest) {
    const onchainSettlementId = parseSettlementId(id);
    const row = await this.settlements.registerOrResync(onchainSettlementId);
    await this.actions.log(req.admin.id, 'treasury_settlement.sync', 'treasury_settlement', id, {
      status: row.status,
      approvals_count: row.approvals_count,
    });
    return row;
  }

  @Post('propose')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Build an unsigned propose_settlement transaction',
    description:
      'Builds a propose_settlement call with the given signer as the transaction source, so Soroban\'s ' +
      'source-account auth shortcut covers require_signer once the admin signs it in Freighter. Returns ' +
      'unsigned XDR -- Konfirm never holds or sees a signer\'s key. Call POST .../submit with what Freighter ' +
      'returns.',
  })
  @ApiBody(zodBody(proposeSchema, 'Proposer address, merchant address, and amount'))
  @ApiResponse({ status: 200 | 201, description: '{ build_token, unsigned_xdr, network_passphrase, tx_hash }.' })
  @ApiResponse({ status: 400, description: 'Invalid input or simulation failed.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async propose(
    @Body(new ZodValidationPipe(proposeSchema)) body: z.infer<typeof proposeSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const built = await this.settlements.buildProposeTx(body.proposer_address, body.merchant_address, body.amount);
    await this.actions.log(req.admin.id, 'treasury_settlement.build_propose', 'treasury_settlement', 'pending', {
      proposer_address: body.proposer_address,
      merchant_address: body.merchant_address,
      amount: body.amount,
      tx_hash: built.tx_hash,
    });
    return built;
  }

  @Post(':id/approve')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Build an unsigned approve_settlement transaction',
    description: 'Same build-then-sign pattern as POST .../propose, for a signer approving an existing settlement id.',
  })
  @ApiParam({ name: 'id', description: 'on-chain settlement id', type: 'string' })
  @ApiBody(zodBody(approveSchema, 'Signer address'))
  @ApiResponse({ status: 200 | 201, description: '{ build_token, unsigned_xdr, network_passphrase, tx_hash }.' })
  @ApiResponse({ status: 400, description: 'Invalid input or simulation failed.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async approve(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approveSchema)) body: z.infer<typeof approveSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const settlementId = parseSettlementId(id);
    const built = await this.settlements.buildApproveTx(body.signer_address, settlementId);
    await this.actions.log(req.admin.id, 'treasury_settlement.build_approve', 'treasury_settlement', id, {
      signer_address: body.signer_address,
      tx_hash: built.tx_hash,
    });
    return built;
  }

  @Post(':id/execute')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Build an unsigned execute_settlement transaction',
    description: 'Same build-then-sign pattern as POST .../propose, for a signer executing a settlement that already met threshold.',
  })
  @ApiParam({ name: 'id', description: 'on-chain settlement id', type: 'string' })
  @ApiBody(zodBody(executeSchema, 'Caller (signer) address'))
  @ApiResponse({ status: 200 | 201, description: '{ build_token, unsigned_xdr, network_passphrase, tx_hash }.' })
  @ApiResponse({ status: 400, description: 'Invalid input or simulation failed.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async execute(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(executeSchema)) body: z.infer<typeof executeSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const settlementId = parseSettlementId(id);
    const built = await this.settlements.buildExecuteTx(body.caller_address, settlementId);
    await this.actions.log(req.admin.id, 'treasury_settlement.build_execute', 'treasury_settlement', id, {
      caller_address: body.caller_address,
      tx_hash: built.tx_hash,
    });
    return built;
  }

  @Post('submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Submit a signed treasury transaction',
    description:
      'Verifies the signed XDR hashes to exactly what Konfirm built for this build_token, then submits it and ' +
      'polls for confirmation. Re-syncs the settlement mirror row from chain afterward -- never from anything ' +
      'the client claims.',
  })
  @ApiBody(zodBody(submitSchema, 'Signed XDR and the build_token returned by propose/approve/execute'))
  @ApiResponse({ status: 200 | 201, description: 'The freshly-synced settlement record, plus tx_hash.' })
  @ApiResponse({ status: 400, description: 'Hash mismatch, malformed XDR, or the network rejected it.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'build_token not found.' })
  async submit(
    @Body(new ZodValidationPipe(submitSchema)) body: z.infer<typeof submitSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const result = await this.settlements.submitSigned(body.signed_xdr, body.build_token);
    await this.actions.log(req.admin.id, 'treasury_settlement.submit', 'treasury_settlement', result.onchain_settlement_id, {
      status: result.status,
      approvals_count: result.approvals_count,
      tx_hash: result.tx_hash,
    });
    return result;
  }
}
