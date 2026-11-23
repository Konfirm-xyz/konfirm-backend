import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { PaymentPayload, PaymentRequirements } from './x402.types';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { X402Service } from './x402.service';
import { zodBody } from '../common/zod-to-openapi';

const paymentRequirementsSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  extra: z.record(z.string(), z.unknown()).default({}),
});

const paymentPayloadSchema = z.object({
  x402Version: z.number(),
  resource: z.looseObject({ url: z.string() }).optional(),
  accepted: paymentRequirementsSchema,
  payload: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

const x402RequestSchema = z.object({
  x402Version: z.number(),
  paymentPayload: paymentPayloadSchema,
  paymentRequirements: paymentRequirementsSchema,
});

type X402Request = z.infer<typeof x402RequestSchema>;

// No AuthGuard — a facilitator is inherently called by parties with no
// prior relationship to Konfirm, by design (same reasoning
// deposits.controller.ts already documents for its own guard-less
// controller). Throttled conservatively since every call does a real
// Soroban RPC round-trip, matching the precedent set for other
// external-service-calling controllers like withdrawals.controller.ts.
@ApiTags('x402')
@Controller('x402')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class X402Controller {
  constructor(private readonly x402: X402Service) {}

  // Cheap, in-memory, no RPC round-trip — a resource server calls this once
  // at its own startup (per @x402/core's HTTPFacilitatorClient.getSupported())
  // to confirm this facilitator declares the scheme/network it needs, so it
  // gets a higher ceiling than the RPC-backed verify/settle routes below.
  @Get('supported')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Get supported x402 schemes and networks',
    description:
      'Returns the schemes and networks this facilitator supports. ' +
      'Resource servers call this once at startup via @x402/core\'s HTTPFacilitatorClient.getSupported(). ' +
      'In-memory, no RPC round-trip. Unauthenticated.',
  })
  @ApiResponse({ status: 200, description: 'Supported schemes/networks object.' })
  supported() {
    return this.x402.getSupported();
  }

  // Cast at this one boundary: the zod schema validates shape (and rejects
  // malformed requests before they reach the service), but its inferred
  // type is deliberately looser than @x402/core's — the package's own
  // verify()/settle() are the real, stricter validators for anything
  // scheme-specific underneath `payload`/`extra`.
  @Post('verify')
  @ApiOperation({
    summary: 'Verify an x402 payment',
    description:
      'Verifies that a payment payload satisfies the stated requirements. ' +
      'Calls @x402/core\'s verify() — the Zod schema here validates shape only; ' +
      'scheme-specific validation happens inside the package. ' +
      'Rate-limited to 20 req/min (Soroban RPC round-trip). Unauthenticated.',
  })
  @ApiBody(zodBody(x402RequestSchema, 'x402 verify request'))
  @ApiResponse({ status: 201, description: 'Verification result (success or failure with reason).' })
  @ApiResponse({ status: 422, description: 'Malformed request body.' })
  verify(@Body(new ZodValidationPipe(x402RequestSchema)) body: X402Request) {
    return this.x402.verify(
      body.x402Version,
      body.paymentPayload as unknown as PaymentPayload,
      body.paymentRequirements as unknown as PaymentRequirements,
    );
  }

  @Post('settle')
  @ApiOperation({
    summary: 'Settle an x402 payment',
    description:
      'Settles a verified payment on-chain. Calls @x402/core\'s settle(). ' +
      'Rate-limited to 20 req/min. Unauthenticated.',
  })
  @ApiBody(zodBody(x402RequestSchema, 'x402 settle request'))
  @ApiResponse({ status: 201, description: 'Settlement result.' })
  @ApiResponse({ status: 422, description: 'Malformed request body.' })
  settle(@Body(new ZodValidationPipe(x402RequestSchema)) body: X402Request) {
    return this.x402.settle(
      body.x402Version,
      body.paymentPayload as unknown as PaymentPayload,
      body.paymentRequirements as unknown as PaymentRequirements,
    );
  }
}
