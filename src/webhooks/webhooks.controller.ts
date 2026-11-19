import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { zodBody } from '../common/zod-to-openapi';
import { WebhooksService } from './webhooks.service';

// https only: a webhook body carries payment amounts and payer addresses, and
// the HMAC secret is replayed on every delivery — over plain http both are
// readable by anyone on the path. http is allowed only for localhost so a
// merchant can develop against a local receiver.
const webhookUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  }, 'url must be https (http is allowed only for localhost)');

const configureWebhookSchema = z.object({
  url: webhookUrlSchema,
  // Omitted on first configure: the server generates one and returns it once.
  secret: z.string().min(16).max(256).optional(),
  enabled: z.boolean().optional(),
});

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: "Get the authenticated merchant's webhook configuration",
    description: 'Returns the configured endpoint, or null. The signing secret is never returned by reads.',
  })
  @ApiResponse({ status: 200, description: 'Webhook configuration or null.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  get(@Req() req: AuthedRequest) {
    return this.webhooks.get(req.merchant.id);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Configure the webhook endpoint',
    description:
      'Creates or replaces the merchant\'s single webhook endpoint. ' +
      'Omit `secret` to have one generated. The secret is returned in this response only — ' +
      'store it to verify the `x-konfirm-signature` header on deliveries. ' +
      'Events fired: payment.paid, payment.held, payment.disputed.',
  })
  @ApiBody(zodBody(configureWebhookSchema, 'Configure webhook'))
  @ApiResponse({ status: 200, description: 'Saved configuration, including the signing secret.' })
  @ApiResponse({ status: 400, description: 'Invalid request body.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  configure(
    @Body(new ZodValidationPipe(configureWebhookSchema)) body: z.infer<typeof configureWebhookSchema>,
    @Req() req: AuthedRequest,
  ) {
    return this.webhooks.upsert(req.merchant.id, body);
  }

  @Delete()
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({ summary: 'Remove the webhook endpoint', description: 'Stops all future deliveries.' })
  @ApiResponse({ status: 200, description: 'Removed. Returns { ok: true }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 404, description: 'No webhook configured.' })
  async remove(@Req() req: AuthedRequest) {
    await this.webhooks.remove(req.merchant.id);
    return { ok: true };
  }
}
