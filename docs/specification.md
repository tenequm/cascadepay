# cascadepay Protocol Specification

**Version:** 1.0
**Domain:** [cascadepay.io](https://cascadepay.io)
**Target:** Solana payment infrastructure

---

## Overview

cascadepay is a non-custodial payment splitting protocol for Solana that automatically distributes incoming payments to multiple recipients based on pre-configured percentages.

**Key Features:**
- Accept payments to a single vault address
- Automatically split funds to 2-20 recipients
- Mandatory 1% protocol fee
- Supports SPL Token and Token-2022
- Graceful handling of failed payments
- Integration with x402 payment facilitators

---

## How It Works

### 1. Setup
Authority creates a **split config** defining:
- Token mint (USDC, USDT, etc.)
- Recipients and their percentages (must total 99%)
- Vault address for receiving payments

### 2. Payment Flow

```
Payment → Vault (PDA-owned) → execute_split() → Recipients (99%) + Protocol (1%)
```

**Without Facilitator:**
1. Payment sent to vault
2. Anyone calls `execute_split()`
3. Funds distributed

**With x402 Facilitator (e.g., PayAI):**
1. Payment + execute bundled in single transaction
2. Instant atomic distribution
3. User sees automatic split

---

## Core Concepts

### PDA Vault Pattern
- Vault is an Associated Token Account owned by a Program Derived Address (PDA)
- No private keys = truly non-custodial
- Funds can only be moved by program instructions

### Graceful Degradation
If recipient account is invalid/missing:
- Funds held as "unclaimed" in vault
- Recipient can claim later (no expiry)
- Other recipients still receive their shares

### Protocol Fee
- **Fixed 1%** enforced by program
- Recipients control the remaining 99%
- Example: `[90%, 9%]` = 99% total ✅
- Invalid: `[90%, 10%]` = 100% total ❌

---

## Account Structure

### SplitConfig (PDA)
```rust
pub struct SplitConfig {
    pub authority: Pubkey,              // Can update config
    pub mint: Pubkey,                   // Token mint
    pub vault: Pubkey,                  // Payment destination
    pub recipients: Vec<Recipient>,     // Max 20, sum = 9900 bps
    pub unclaimed_amounts: Vec<UnclaimedAmount>,
    pub bump: u8,
}

pub struct Recipient {
    pub address: Pubkey,
    pub percentage_bps: u16,            // 0-9900 (0-99%)
}
```

**Seeds:** `[b"split_config", authority, mint]`

---

## Instructions

### create_split_config
Creates payment split configuration.

**Validation:**
- 2-20 recipients
- Total exactly 9900 bps (99%)
- No duplicates or zero values
- All recipient ATAs must exist

*Note: Requiring pre-existing ATAs protects payment facilitators from ATA creation costs (0.002 SOL × recipients). Config creators ensure their recipients are ready before setup.*

**Example:**
```typescript
await createSplitConfig({
  authority: merchantKeypair,
  mint: USDC_MINT,
  recipients: [
    { address: platform, percentageBps: 900 },   // 9%
    { address: merchant, percentageBps: 9000 },  // 90%
  ],
});
```

### execute_split
Distributes vault balance to recipients.

**Authorization:** Permissionless (anyone can trigger)

**Logic:**
1. Calculate each recipient's share (floor division)
2. Attempt transfer to each recipient
3. If transfer fails → hold as unclaimed
4. Protocol receives 1% + rounding dust
5. Vault retains unclaimed amounts

**Example Distribution (100 USDC):**
```
Platform (9%):  9.00 USDC
Merchant (90%): 90.00 USDC
Protocol (1%):  1.00 USDC
```

### claim_unclaimed
Recipients claim held payments.

**Requirements:**
- Recipient must have valid ATA
- Signature required

### update_split_config
Authority updates recipient list.

**Requirements:**
- Vault must be empty (execute first)
- Same validation as create

### close_split_config
Closes config and reclaims rent.

**Requirements:**
- Vault empty
- No unclaimed funds

---

## x402 Integration

### Automatic Detection

x402 facilitators (PayAI, Coinbase CDP) can detect split vaults by checking if payment destination is a token account owned by a SplitConfig PDA:

```typescript
async function detectSplitVault(destination: PublicKey) {
  const accountInfo = await connection.getAccountInfo(destination);
  const tokenAccount = decodeTokenAccount(accountInfo.data);

  // Check if authority is SplitConfig PDA
  const splitConfig = await program.account.splitConfig.fetch(
    tokenAccount.authority
  );

  return splitConfig.vault.equals(destination);
}
```

### Atomic Execution

When split vault detected, facilitator bundles:
```typescript
const tx = new Transaction()
  .add(transferInstruction(vault, amount))
  .add(executeSplitInstruction(config));
```

User signs once → payment + split happen atomically.

---

## Token Support

| Token Type | Support | Notes |
|------------|---------|-------|
| SPL Token | ✅ Full | Standard tokens |
| Token-2022 | ✅ Full | All extensions supported |
| Native SOL | ❌ No | Use wrapped SOL |

**Token-2022 Transfer Fees:**
If token has transfer fee extension, recipients receive net amounts after token's fees are deducted. This is separate from the 1% protocol fee.

---

## Events

All operations emit events for indexing:

- `SplitConfigCreated` - New config created
- `SplitExecuted` - Payment distributed
- `RecipientPaymentHeld` - Payment held as unclaimed
- `UnclaimedFundsClaimed` - Recipient claimed funds
- `SplitConfigUpdated` - Config modified
- `SplitConfigClosed` - Config deleted

**Use Case:** Build indexer to track all configs, executions, and analytics.

---

## Security

### Implemented Protections
- ✅ No custody (PDA-owned vaults)
- ✅ Overflow/underflow checks (all math uses `checked_*`)
- ✅ Duplicate recipient validation
- ✅ Bounded account size (max 20 recipients)
- ✅ Protocol fee enforcement (cannot be bypassed)

### Known Limitations
- No pause mechanism
- Protocol wallet hardcoded (v1)
- Unclaimed funds never expire

---

## Example Use Cases

### Marketplace Split
```
Payment: $100
├── Platform (9%):  $9
├── Merchant (90%): $90
└── Protocol (1%):  $1
```

### Revenue Share
```
Payment: $1000
├── Founder 1 (40%): $400
├── Founder 2 (29%): $290
├── Investor (20%):  $200
├── Advisor (10%):   $100
└── Protocol (1%):   $10
```

### Subscription Split
```
Payment: $50/month
├── Service (50%):   $25
├── Affiliate (30%): $15
├── Platform (19%):  $9.50
└── Protocol (1%):   $0.50
```

---

## Technical Details

**Dependencies:**
```toml
anchor-lang = "0.32.1"
anchor-spl = "0.32.1"
```

**Constants:**
```rust
PROTOCOL_FEE_BPS: 100        // 1%
REQUIRED_SPLIT_TOTAL: 9900   // 99%
MIN_RECIPIENTS: 2
MAX_RECIPIENTS: 20
```

**Program ID:** TBD (deployed post-development)

---

## Resources

- **Website:** https://cascadepay.io
- **Documentation:** https://docs.cascadepay.io
- **GitHub:** https://github.com/tenequm/cascadepay
- **Contact:** hello@cascadepay.io

---

**Last Updated:** 2025-11-08
