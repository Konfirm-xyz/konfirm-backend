import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { nonNegativeIntegerStringSchema, POSTGRES_BIGINT_MAX } from '../common/numeric-validation';
import { SessionsService } from './sessions.service';
import { zodBody } from '../common/zod-to-openapi';

const muxedIdSchema = nonNegativeIntegerStringSchema(POSTGRES_BIGINT_MAX, 'muxed_id');
const reserveSchema = z.object({
  muxed_id: muxedIdSchema,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidLinkId(linkId: string): void {
  if (!UUID_RE.test(linkId)) {
    throw new BadRequestException('linkId must be a valid UUID');
  }
}

@ApiTags('Sessions')
@Controller('links/:linkId/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  // Unauthenticated public write — tighter than the global default (60/min)
  // to match the pattern for other public state-changing routes in this
  // codebase. Each call inserts a link_sessions row, so an unlimited rate
  // from a known linkId (pay links are public) is an easy DB-write amplifier.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @ApiOperation({
    summary: 'Reserve a session against a payment link',
    description:
      'Reserves a random muxed ID against a link before the payer chooses a wallet. ' +
      '409 on collision — client should retry with a new random ID. ' +
      'Unauthenticated. Rate-limited to 30 req/min per IP.',
  })
  @ApiParam({ name: 'linkId', description: 'Payment link UUID', type: 'string' })
  @ApiBody(zodBody(reserveSchema, 'Reserve session request'))
  @ApiResponse({ status: 201, description: 'Session reserved.' })
  @ApiResponse({ status: 400, description: 'Invalid muxed_id format (must be stringified u64), or the link is not payable (inactive, expired, or merchant suspended).' })
  @ApiResponse({ status: 404, description: 'Link not found.' })
  @ApiResponse({ status: 409, description: 'muxed_id already reserved for this link — retry with a new ID.' })
  reserve(
    @Param('linkId') linkId: string,
    @Body(new ZodValidationPipe(reserveSchema)) body: z.infer<typeof reserveSchema>,
  ) {
    requireUuidLinkId(linkId);
    return this.sessions.reserve(linkId, body.muxed_id);
  }

  // The checkout page's confirmation poll. The payer's random muxed_id is
  // the capability: only the person who reserved it can read this, and it
  // returns only that one payment. Replaces scanning a merchant's whole
  // history for a match.
  @Get(':muxedId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: "Poll the payer's session for payment confirmation",
    description:
      'Returns `{ confirmed, payment }` for this specific muxed ID. ' +
      'The random `muxedId` acts as a capability token — only the payer who reserved it can see this, ' +
      'and it reveals only their own payment (not the merchant\'s full history). ' +
      'The checkout page polls this every few seconds.',
  })
  @ApiParam({ name: 'linkId', description: 'Payment link UUID', type: 'string' })
  @ApiParam({ name: 'muxedId', description: 'Stringified u64 muxed ID reserved by the payer', type: 'string' })
  @ApiResponse({ status: 200, description: '{ confirmed: boolean, payment: object | null }' })
  @ApiResponse({ status: 400, description: 'muxedId is not a stringified u64.' })
  @ApiResponse({ status: 404, description: 'Link or session not found.' })
  status(@Param('linkId') linkId: string, @Param('muxedId') muxedId: string) {
    requireUuidLinkId(linkId);
    if (!muxedIdSchema.safeParse(muxedId).success) {
      throw new BadRequestException('muxedId must fit in a non-negative signed 64-bit integer');
    }
    return this.sessions.statusFor(linkId, muxedId);
  }
}
