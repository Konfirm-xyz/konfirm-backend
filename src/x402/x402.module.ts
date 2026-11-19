import { Module } from '@nestjs/common';
import { X402Controller } from './x402.controller';
import { X402Service } from './x402.service';
import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';
import { ChannelKeeperService } from './channel-keeper.service';

@Module({
  controllers: [X402Controller, ChannelController],
  providers: [X402Service, ChannelService, ChannelKeeperService],
  // ChannelService is exported so the admin token-allowlist endpoint
  // (backend#191) can reuse its set_token_allowed submission path.
  exports: [ChannelService],
})
export class X402Module {}
