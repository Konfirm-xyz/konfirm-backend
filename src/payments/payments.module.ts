import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentAttestationService } from './payment-attestation.service';
import { PaymentAttestationSweeperService } from './payment-attestation-sweeper.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentAttestationService, PaymentAttestationSweeperService],
})
export class PaymentsModule {}
