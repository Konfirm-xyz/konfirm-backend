import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminGuard, AuthedAdminRequest } from '../admin-auth/admin-auth.guard';
import { AdminActionsService } from './admin-actions.service';
import { AdminTreasurySettlementsService } from './admin-treasury-settlements.service';

// Deliberately a separate controller/route group from AdminController
// (admin.controller.ts) rather than added to it -- see backend#217 and
// docs/VERIFY.md: that file does not currently compile, and new work
// should not depend on it until it's fixed.
//
// Every propose_settlement/approve_settlement/execute_settlement call
// requires require_signer -- a real treasury signer's own key -- so this
// controller deliberately has no mutating endpoint for them. The admin UI
// builds and submits those transactions itself via a connected wallet
// (see docs/PRD.md M2); this controller only reads the on-chain result
// back (list/get) and records it (sync), so the backend never holds a
// signer key it has no business holding.
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
}
