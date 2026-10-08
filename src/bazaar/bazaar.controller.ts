import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { BazaarService } from './bazaar.service';

const submitListingSchema = z.object({
  kind: z.enum(['facilitator', 'resource']),
  name: z.string().max(200).optional(),
  // https only: listings are shown to other developers, and a plain-http
  // or non-URL value there is either a mistake or a phishing attempt.
  url: z.string().url().refine((u) => u.startsWith('https://'), 'listing URL must use https'),
  description: z.string().min(1).max(2000),
  network: z.string().max(100).optional(),
  scheme: z.string().max(50).optional(),
  contact_email: z.string().email().optional(),
});

// No AuthGuard — a discovery manifest and its submission endpoint are, by
// definition, called by parties with no prior relationship to Konfirm
// (same reasoning already documented on x402.controller.ts and
// deposits.controller.ts).
@Controller('bazaar')
export class BazaarController {
  constructor(private readonly bazaar: BazaarService) {}

  // Cheap, no side effects, meant to be polled by any resource server or
  // facilitator doing discovery — same higher-ceiling reasoning as
  // x402.controller.ts's /supported.
  @Get('manifest')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  getManifest() {
    return this.bazaar.getManifest();
  }

  // A write with real abuse potential (anyone can propose anything) —
  // tighter ceiling, matching deposits.controller.ts's default tier for
  // the same reason: rate limiting is the only protection an unauthed
  // write endpoint like this has.
  @Post('listings')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@Body(new ZodValidationPipe(submitListingSchema)) body: z.infer<typeof submitListingSchema>) {
    return this.bazaar.submit(body);
  }
}
