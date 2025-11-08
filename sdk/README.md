# cascadepay SDK

TypeScript SDK for integrating with the cascadepay payment splitting protocol on Solana.

## Installation

```bash
npm install @cascadepay/sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token
# or
yarn add @cascadepay/sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token
# or
pnpm add @cascadepay/sdk @coral-xyz/anchor @solana/web3.js @solana/spl-token
```

## Quick Start

```typescript
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { createCascadepayClient } from "@cascadepay/sdk";
import * as anchor from "@coral-xyz/anchor";

// Initialize SDK
const connection = new Connection("https://api.devnet.solana.com");
const wallet = new anchor.Wallet(yourKeypair);
const idl = require("./cascadepay.json"); // Load IDL (contains program ID)

const sdk = await createCascadepayClient(
  connection,
  wallet,
  idl
);

// Create split configuration
const recipients = [
  { address: new PublicKey("Alice..."), percentageBps: 5900 }, // 59%
  { address: new PublicKey("Bob..."), percentageBps: 4000 },   // 40%
]; // Total: 9900 bps = 99% (protocol receives 1%)

const configPDA = await sdk.createSplitConfig({
  mint: USDC_MINT,
  recipients,
});

// Get vault address for payments
const config = await sdk.getSplitConfig(configPDA);
console.log("Send payments to:", config.vault.toString());

// Execute split (permissionless - anyone can call)
const tx = await sdk.executeSplit(configPDA);
```

## API Reference

### `createCascadepayClient()`

Creates a new SDK instance.

```typescript
async function createCascadepayClient(
  connection: Connection,
  wallet: anchor.Wallet,
  idl: Idl
): Promise<Cascadepay>
```

**Parameters:**
- `connection` - Solana RPC connection
- `wallet` - Anchor wallet for signing transactions
- `idl` - Program IDL (contains program ID in metadata)

### `sdk.createSplitConfig(params)`

Creates a new split configuration with vault.

**Parameters:**
- `params.mint` - Token mint address (e.g., USDC, USDT)
- `params.recipients` - Array of recipients with percentages (must sum to 9900 bps = 99%)

**Returns:** PDA address of created split config

**Example:**
```typescript
const configPDA = await sdk.createSplitConfig({
  mint: new PublicKey("USDC_MINT"),
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

const result = await detectSplitVault(
  paymentAddress,
  connection,
  programId
);

if (result.isSplitVault) {
  console.log("Detected split vault!");
  // Facilitator can bundle: transfer + execute_split
}
```

## Types

```typescript
interface Recipient {
  address: PublicKey;
  percentageBps: number; // 0-9900 (must total 99%)
}

interface SplitConfig {
  authority: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  recipients: Recipient[];
  unclaimedAmounts: UnclaimedAmount[];
  bump: number;
  version: number;
}

interface UnclaimedAmount {
  recipient: PublicKey;
  amount: anchor.BN;
  timestamp: anchor.BN;
}

interface DetectionResult {
  isSplitVault: boolean;
  splitConfig?: PublicKey;
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
