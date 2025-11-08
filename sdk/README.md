# cascadepay SDK

TypeScript SDK for integrating with the cascadepay payment splitting protocol on Solana.

## Installation

```bash
npm install @cascadepay/sdk @coral-xyz/anchor
```

## Quick Start

```typescript
import { createCascadepayClient, IDL } from "@cascadepay/sdk";
import * as anchor from "@coral-xyz/anchor";

// Initialize
const connection = new anchor.web3.Connection("https://api.devnet.solana.com");
const wallet = new anchor.Wallet(yourKeypair);

const sdk = await createCascadepayClient(connection, wallet, IDL);

// Create split config (99% total for recipients, 1% protocol fee)
const recipients = [
  { address: new anchor.web3.PublicKey("Platform..."), percentageBps: 900 },  // 9%
  { address: new anchor.web3.PublicKey("Merchant..."), percentageBps: 9000 }, // 90%
];

const configPDA = await sdk.createSplitConfig({
  mint: new anchor.web3.PublicKey("USDC_MINT"),
  recipients,
});

// Share vault address with customers
const config = await sdk.getSplitConfig(configPDA);
console.log("Payment vault:", config.vault.toString());

// Execute split (permissionless)
await sdk.executeSplit(configPDA);
```

## API Reference

### `createCascadepayClient()`

Creates a new SDK instance.

```typescript
import { createCascadepayClient, IDL } from "@cascadepay/sdk";

async function createCascadepayClient(
  connection: Connection,
  wallet: anchor.Wallet,
  idl: Idl
): Promise<Cascadepay>
```

**Parameters:**
- `connection` - Solana RPC connection
- `wallet` - Anchor wallet for signing transactions
- `idl` - Program IDL (use the bundled `IDL` export from this package)

### `sdk.createSplitConfig(params)`

Creates a new split configuration with vault.

**Parameters:**
- `params.mint` - Token mint address (e.g., USDC, USDT)
- `params.recipients` - Array of recipients with percentages (must sum to 9900 bps = 99%)

**Returns:** PDA address of created split config

**Example:**
```typescript
import * as anchor from "@coral-xyz/anchor";

const configPDA = await sdk.createSplitConfig({
  mint: new anchor.web3.PublicKey("USDC_MINT"),
  recipients: [
    { address: recipient1, percentageBps: 4950 }, // 49.5%
    { address: recipient2, percentageBps: 4950 }, // 49.5%
  ],
});
```

### `sdk.executeSplit(splitConfigPDA)`

Executes payment split by draining vault to recipients.

**Permissionless:** Anyone can call this function.

**Parameters:**
- `splitConfigPDA` - Address of split configuration

**Returns:** Transaction signature

**Example:**
```typescript
const tx = await sdk.executeSplit(configPDA);
console.log("Split executed:", tx);
```

### `sdk.getSplitConfig(splitConfigPDA)`

Fetches split configuration from on-chain PDA.

**Parameters:**
- `splitConfigPDA` - Address of split configuration

**Returns:** `SplitConfig` object

**Example:**
```typescript
const config = await sdk.getSplitConfig(configPDA);
console.log("Vault:", config.vault.toString());
console.log("Recipients:", config.recipients.length);
```

### `sdk.claimUnclaimed(splitConfigPDA, recipient)`

Recipients claim their unclaimed funds (if ATA was missing during split).

**Parameters:**
- `splitConfigPDA` - Address of split configuration
- `recipient` - Recipient keypair (must sign)

**Returns:** Transaction signature

**Example:**
```typescript
const tx = await sdk.claimUnclaimed(configPDA, recipientKeypair);
```

### `sdk.updateSplitConfig(splitConfigPDA, newRecipients)`

Updates split configuration with new recipients.

**Requirements:** Vault must be empty (execute all pending splits first).

**Parameters:**
- `splitConfigPDA` - Address of split configuration
- `newRecipients` - New recipients array (must sum to 9900 bps)

**Returns:** Transaction signature

### `sdk.closeSplitConfig(splitConfigPDA)`

Closes split configuration and reclaims rent.

**Requirements:** Vault must be empty and no unclaimed funds.

**Parameters:**
- `splitConfigPDA` - Address of split configuration

**Returns:** Transaction signature

### `sdk.deriveSplitConfigPDA(authority, mint)`

Helper to derive split config PDA address.

**Parameters:**
- `authority` - Authority public key
- `mint` - Token mint address

**Returns:** PDA public key

### `Cascadepay.percentagesToShares(percentages)`

Static helper to convert percentages to basis points.

**Parameters:**
- `percentages` - Array of percentages (must sum to 99%)

**Returns:** Array of basis points

**Example:**
```typescript
const bps = Cascadepay.percentagesToShares([59, 30, 10]);
// Returns: [5900, 3000, 1000]
```

### `detectSplitVault(destination, connection, programId)`

Detects if a payment destination is a cascadepay vault.

**Use case:** x402 facilitators (PayAI, Coinbase CDP) can auto-detect split vaults and bundle transfer + execute in one transaction.

**Parameters:**
- `destination` - Payment destination address to check
- `connection` - Solana connection
- `programId` - cascadepay program ID

**Returns:** `DetectionResult` with `isSplitVault` boolean and optional `splitConfig` PDA

**Example:**
```typescript
import { detectSplitVault } from "@cascadepay/sdk";
import * as anchor from "@coral-xyz/anchor";

const result = await detectSplitVault(
  paymentAddress,
  connection,
  programId
);

if (result.isSplitVault) {
  console.log("Detected split vault!");

  // Facilitator bundles transfer + execute_split atomically
  const transferIx = /* create transfer instruction */;
  const splitIx = await sdk.buildExecuteSplitInstruction(result.splitConfig);

  const tx = new anchor.web3.Transaction()
    .add(transferIx)
    .add(splitIx);

  // User signs once, both execute atomically
  await provider.sendAndConfirm(tx);
}
```

### `sdk.buildExecuteSplitInstruction(splitConfigPDA)`

Builds the execute_split instruction without sending it. For facilitators to bundle atomically with transfer.

**Parameters:**
- `splitConfigPDA` - Address of split configuration

**Returns:** `TransactionInstruction`

**Example:**
```typescript
// Build instruction for atomic bundling
const splitIx = await sdk.buildExecuteSplitInstruction(configPDA);

// Combine with user's transfer
const tx = new anchor.web3.Transaction()
  .add(userTransferInstruction)
  .add(splitIx);
```

## Types

```typescript
import * as anchor from "@coral-xyz/anchor";

interface Recipient {
  address: anchor.web3.PublicKey;
  percentageBps: number; // 0-9900 (must total 99%)
}

interface SplitConfig {
  authority: anchor.web3.PublicKey;
  mint: anchor.web3.PublicKey;
  vault: anchor.web3.PublicKey;
  recipients: Recipient[];
  unclaimedAmounts: UnclaimedAmount[];
  bump: number;
  version: number;
}

interface UnclaimedAmount {
  recipient: anchor.web3.PublicKey;
  amount: anchor.BN;
  timestamp: anchor.BN;
}

interface DetectionResult {
  isSplitVault: boolean;
  splitConfig?: anchor.web3.PublicKey;
}
```

## Examples

See [`src/example.ts`](./src/example.ts) for comprehensive usage examples including:

1. Creating split configurations
2. Executing payment splits
3. Claiming unclaimed funds
4. x402 facilitator integration (auto-detection)
5. Using percentage helpers
6. Updating configurations
7. Closing configurations

## Protocol Details

- **Protocol Fee:** Fixed 1% enforced by program
- **Recipients:** 2-20 recipients, must total 99% (9900 basis points)
- **Token Support:** Both SPL Token and Token-2022
- **Graceful Degradation:** Failed recipient payments held as "unclaimed" for later claim

## License

MIT
