-- Records whether the payer granted this facilitator delegated_closer
-- authority when opening the channel (konfirm-contracts contracts/channel's
-- open_channel 6th arg, an Option<Address>). NULL means not granted --
-- that channel has no idle-close safety net and ChannelKeeperService's
-- sweepIdleClose skips it (see channel.service.ts's openChannel).
ALTER TABLE x402_channels
    ADD COLUMN IF NOT EXISTS delegated_closer TEXT;
