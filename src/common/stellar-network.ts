import { Networks } from '@stellar/stellar-sdk';
import { DEFAULT_TESTNET_RPC_URL, USDC_TESTNET_ADDRESS } from '@x402/stellar';
import assets from './stellar-assets.json';

// Every Stellar identifier the backend depends on, in one place.
//
// Each value comes from the environment if set, otherwise from the preset for
// the selected network. The testnet preset is complete. The mainnet preset has
// no values of its own, so mainnet must set each variable explicitly, and
// assertNetworkReady() refuses to boot until it does. That way mainnet can't
// silently pick up a testnet issuer or contract.

export type StellarNetworkName = 'testnet' | 'mainnet';
export type ContractId = `C${string}`;
export type AccountId = `G${string}`;

const TESTNET_CONTRACTS = {
  compliance: 'CDDVLE2DZQAYFY3Z2Z74TUNNPC4ROUACSBXOB2P64IT75EZFAQXSRSXY',
  payment: 'CCYRA6JT2L4NS5FG4B5TP52JPCGCPYSP7M6LUDUY2QA37V5UBXWJBRHV',
  treasury: 'CD77HPVBGIRYQGXC4JVCEO35X6FKFFJ2C4EZ63EQCOXGR6OL4TVEPZ2T',
  channel: 'CDS2Y4CQMQWFLCG5GHVKX7UIXHYPM6IJDJZTEXSASSHGHLESGLGLNPL6',
};

// Deployer and facilitator. The compliance simulation uses the deployer as its
// read-only source account.
const TESTNET_ACCOUNTS = {
  deployer: 'GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS',
  treasurySigners: [
    'GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS',
    'GBRUR4UZHKPQ76S4S7X7INENL6QJ4UGNFIQ3F6VAYJQZRO3F4XBZAIND',
    'GCP57AJNZIVVTPPSD4MJ2SQDMTN4QEAUP64U2OZ4HXSAU4O4A6NOWY2Z',
  ],
};

const PRESETS = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: DEFAULT_TESTNET_RPC_URL,
    passphrase: Networks.TESTNET,
    caip2: 'stellar:testnet' as const,
    usdcIssuer: assets.testnet.USDC,
    eurcIssuer: assets.testnet.EURC,
    usdcSacId: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    x402UsdcAddress: USDC_TESTNET_ADDRESS,
    anchorAuthUrl: 'https://testanchor.stellar.org/auth',
    anchorTransferServer: 'https://testanchor.stellar.org/sep24',
    contracts: TESTNET_CONTRACTS,
    deployer: TESTNET_ACCOUNTS.deployer,
    facilitator: TESTNET_ACCOUNTS.deployer,
    treasurySigners: TESTNET_ACCOUNTS.treasurySigners,
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    passphrase: Networks.PUBLIC,
    caip2: 'stellar:pubnet' as const,
    usdcIssuer: undefined as string | undefined,
    eurcIssuer: undefined as string | undefined,
    usdcSacId: undefined as string | undefined,
    x402UsdcAddress: undefined as string | undefined,
    anchorAuthUrl: undefined as string | undefined,
    anchorTransferServer: undefined as string | undefined,
    contracts: { compliance: undefined, payment: undefined, treasury: undefined, channel: undefined } as Record<
      'compliance' | 'payment' | 'treasury' | 'channel',
      string | undefined
    >,
    deployer: undefined as string | undefined,
    facilitator: undefined as string | undefined,
    treasurySigners: [] as string[],
  },
};

export function resolveStellarNetwork(env: NodeJS.ProcessEnv = process.env): StellarNetworkName {
  const name = env.STELLAR_NETWORK ?? 'testnet';
  if (name !== 'testnet' && name !== 'mainnet') {
    throw new Error(`STELLAR_NETWORK must be "testnet" or "mainnet", got "${name}"`);
  }
  return name;
}

export const STELLAR_NETWORK = resolveStellarNetwork();
const PRESET = PRESETS[STELLAR_NETWORK];

// Environment variable names for each overridable value. Listed so the boot
// error can name exactly what to set.
export const ENV_NAMES = {
  usdcIssuer: 'USDC_ISSUER',
  eurcIssuer: 'EURC_ISSUER',
  usdcSacId: 'USDC_SAC_ID',
  x402UsdcAddress: 'X402_USDC_ADDRESS',
  anchorAuthUrl: 'ANCHOR_AUTH_URL',
  anchorTransferServer: 'ANCHOR_TRANSFER_SERVER',
  compliance: 'COMPLIANCE_CONTRACT_ID',
  payment: 'PAYMENT_CONTRACT_ID',
  treasury: 'TREASURY_CONTRACT_ID',
  channel: 'CHANNEL_CONTRACT_ID',
  deployer: 'DEPLOYER_ADDRESS',
  facilitator: 'FACILITATOR_ADDRESS',
  treasurySigners: 'TREASURY_SIGNERS',
} as const;

const pick = (envName: string, fallback: string | undefined): string | undefined => process.env[envName] || fallback;

export const HORIZON_URL: string = process.env.HORIZON_URL ?? PRESET.horizonUrl;
export const RPC_URL: string = process.env.SOROBAN_RPC_URL ?? PRESET.rpcUrl;
export const NETWORK_PASSPHRASE: string = PRESET.passphrase;
export const NETWORK_CAIP2 = PRESET.caip2;

export const USDC_ISSUER = pick(ENV_NAMES.usdcIssuer, PRESET.usdcIssuer) as string;
export const EURC_ISSUER = pick(ENV_NAMES.eurcIssuer, PRESET.eurcIssuer) as string;
export const USDC_SAC_ID = pick(ENV_NAMES.usdcSacId, PRESET.usdcSacId) as string;
export const X402_USDC_ADDRESS = pick(ENV_NAMES.x402UsdcAddress, PRESET.x402UsdcAddress) as string;
export const ANCHOR_AUTH_URL = pick(ENV_NAMES.anchorAuthUrl, PRESET.anchorAuthUrl) as string;
export const ANCHOR_TRANSFER_SERVER = pick(ENV_NAMES.anchorTransferServer, PRESET.anchorTransferServer) as string;
export const COMPLIANCE_CONTRACT_ID = pick(ENV_NAMES.compliance, PRESET.contracts.compliance) as string;
export const PAYMENT_CONTRACT_ID = pick(ENV_NAMES.payment, PRESET.contracts.payment) as string;
export const TREASURY_CONTRACT_ID = pick(ENV_NAMES.treasury, PRESET.contracts.treasury) as string;
export const CHANNEL_CONTRACT_ID = pick(ENV_NAMES.channel, PRESET.contracts.channel) as string;
// The read-only simulation source for contract calls, and the deployer account.
export const DEPLOYER_ADDRESS = pick(ENV_NAMES.deployer, PRESET.deployer) as string;
export const FACILITATOR_ADDRESS = pick(ENV_NAMES.facilitator, PRESET.facilitator) as string;
export const TREASURY_SIGNERS: string[] = process.env[ENV_NAMES.treasurySigners]
  ? process.env[ENV_NAMES.treasurySigners]!.split(',').map((s) => s.trim()).filter(Boolean)
  : [...PRESET.treasurySigners];

// Checked at boot. On mainnet, every value that has no testnet default must be
// set explicitly. Testnet always passes.
export function missingForNetwork(network: StellarNetworkName = STELLAR_NETWORK, env: NodeJS.ProcessEnv = process.env): string[] {
  if (network === 'testnet') return [];
  const required: Array<[string, string | undefined]> = [
    [ENV_NAMES.usdcIssuer, env[ENV_NAMES.usdcIssuer]],
    [ENV_NAMES.eurcIssuer, env[ENV_NAMES.eurcIssuer]],
    [ENV_NAMES.usdcSacId, env[ENV_NAMES.usdcSacId]],
    [ENV_NAMES.x402UsdcAddress, env[ENV_NAMES.x402UsdcAddress]],
    [ENV_NAMES.anchorAuthUrl, env[ENV_NAMES.anchorAuthUrl]],
    [ENV_NAMES.anchorTransferServer, env[ENV_NAMES.anchorTransferServer]],
    [ENV_NAMES.compliance, env[ENV_NAMES.compliance]],
    [ENV_NAMES.payment, env[ENV_NAMES.payment]],
    [ENV_NAMES.treasury, env[ENV_NAMES.treasury]],
    [ENV_NAMES.channel, env[ENV_NAMES.channel]],
    [ENV_NAMES.deployer, env[ENV_NAMES.deployer]],
    [ENV_NAMES.facilitator, env[ENV_NAMES.facilitator]],
    [ENV_NAMES.treasurySigners, env[ENV_NAMES.treasurySigners]],
  ];
  return required.filter(([, v]) => !v).map(([name]) => name);
}

export function assertNetworkReady(network: StellarNetworkName = STELLAR_NETWORK, env: NodeJS.ProcessEnv = process.env): void {
  const missing = missingForNetwork(network, env);
  if (missing.length > 0) {
    throw new Error(`STELLAR_NETWORK=${network} needs these set explicitly: ${missing.join(', ')}`);
  }
}

