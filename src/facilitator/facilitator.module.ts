import { Module } from '@nestjs/common';
import { FacilitatorSpendGuardService } from './facilitator-spend-guard.service';
import { FacilitatorSweepService } from './facilitator-sweep.service';
import { FeeCollectionSweepService } from './fee-collection-sweep.service';

@Module({
  providers: [FacilitatorSpendGuardService, FacilitatorSweepService, FeeCollectionSweepService],
  exports: [FacilitatorSpendGuardService],
})
export class FacilitatorModule {}
