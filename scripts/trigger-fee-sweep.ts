// One-off manual trigger for verifying FeeCollectionSweepService end-to-end
// without waiting for its @Cron() interval. Not part of the app's normal
// runtime -- delete after verification.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import { FacilitatorModule } from '../src/facilitator/facilitator.module';
import { FeeCollectionSweepService } from '../src/facilitator/fee-collection-sweep.service';

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [FacilitatorModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.get(FeeCollectionSweepService).sweep();
  await app.close();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
