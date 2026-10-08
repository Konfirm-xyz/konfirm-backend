import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

// The /deposits routes fund any Stellar address with testnet USDC or XLM.
// They exist for local development and the testnet pilot only, so they are
// off unless ENABLE_TESTNET_FAUCET=true. When off, they answer 404 as if the
// route didn't exist, so the production API doesn't advertise a faucet.
@Injectable()
export class TestnetFaucetGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (process.env.ENABLE_TESTNET_FAUCET !== 'true') {
      throw new NotFoundException();
    }
    return true;
  }
}
