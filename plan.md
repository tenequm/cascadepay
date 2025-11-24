# CascadePay Protocol Update Plan

**Date:** 2025-11-18
**Status:** Planning

---

## Overview

This document captures the security audit findings and planned improvements for the CascadePay protocol. The changes are prioritized by criticality and grouped by implementation phase.

---

## Confirmed Fixes Required

### Critical Security

| # | Issue | Location | Description | Effort |
|---|-------|----------|-------------|--------|
| 1 | **Unclaimed funds re-split** | `execute_split.rs:46` | Uses raw `vault_balance` without deducting `total_unclaimed`. Anyone can repeatedly call `execute_split` to drain unclaimed funds to other recipients. | Low |

### High Security

| # | Issue | Location | Description | Effort |
|---|-------|----------|-------------|--------|
| 2 | **Missing bounds check** | `execute_split.rs:73` | Accesses `remaining_accounts[i]` without verifying length >= recipient_count + 1. Can panic/DoS. | Low |

### Medium Security

| # | Issue | Location | Description | Effort |
|---|-------|----------|-------------|--------|
| 3 | **Missing validations in update_split_config** | `update_split_config.rs` | No duplicate recipient check, no zero address check, no zero percentage check (all present in create). | Low |
| 4 | **Missing vault constraint in ExecuteSplit** | `execute_split.rs:26-27` | No `constraint = vault.key() == split_config.vault`. Poor errors, inconsistent. | Trivial |

### Low Security

| # | Issue | Location | Description | Effort |
|---|-------|----------|-------------|--------|
| 5 | **Unchecked `.sum()` for percentages** | `create_split_config.rs`, `update_split_config.rs` | Should use `checked_add` for consistency. | Trivial |

---

### Product/Design Enhancements

| # | Issue | Description | Effort |
|---|-------|-------------|--------|
| 6 | **PDA seed collision** | Add `unique_id` to seeds to allow multiple configs per authority/mint. Breaking change - redeploy. | Medium |
| 7 | **Protocol wallet config** | Make protocol fee wallet updatable via config PDA instead of hardcoded constant. | Low |
| 8 | **Close instruction** | Add `close_split_config` to allow rent recovery. | Low |
| 9 | **MIN_RECIPIENTS = 1** | Allow single recipient for simple forwarding use cases. | Trivial |
| 10 | **Zero-copy with fixed arrays** | Use `#[account(zero_copy)]` with fixed `[Recipient; 20]` arrays for ~50% serialization CU savings. | Medium |
| 11 | **Self-healing execute_split** | Clear unclaimed amounts in same instruction. Remove `claim_unclaimed`. Single idempotent flow. | Low-Medium |
| 12 | **Protocol unclaimed tracking** | Add `protocol_unclaimed: u64` field to track unclaimed protocol fees. Enables permissionless support for any token. | Low |

---

## Rejected / Not Valid

### Security Claims - Not Valid

| Claim | Reason |
|-------|--------|
| **Vault.mint not validated in ExecuteSplit** | Token program CPI validates mint match implicitly. Not exploitable. |
| **Vault as recipient (circular)** | Self-harm only - authority controls config. Low priority foot-gun. |

### Design Decisions - Keep As-Is

| Decision | Reason |
|----------|--------|
| **Hardcoded 1% protocol fee** | Transparency for integrators. Avoid calculation complexity. Redeploy if change needed. |
| **Empty vault requirement for updates** | Ensures funds split by rules active when received. Prevents race conditions. |
| **Keep update_split_config** | Vault address is stable public interface. Payers shouldn't need to update when business arrangements change. |
| **Streaming/partial splits** | Different product (Streamflow, Zebec). CascadePay is for instant atomic splits. |
| **Native SOL support** | Unnecessary complexity. Use wrapped SOL. |
| **Multi-sig authority** | Use Squads as authority instead. Works with current design. |

---

## Implementation Priority

### Phase 1: Critical (Before any deployment)

**Goal:** Make `execute_split` truly idempotent and secure.

1. **#1 + #11 + #12 - Self-healing idempotent execute_split**
   - Deduct `total_unclaimed + protocol_unclaimed` from `vault_balance`
   - After distributing new funds, attempt to clear all unclaimed amounts
   - Track protocol fees in `protocol_unclaimed` field when protocol ATA missing
   - Pre-validate ATA with `data_is_empty()` before transfer (avoid wasted CPI cost)
   - Remove `claim_unclaimed` instruction entirely
   - Single idempotent flow for facilitators

2. **#2 - Bounds check on remaining_accounts**
   - Add `require!(remaining_accounts.len() >= recipient_count + 1)` (recipients + protocol_ata)

3. **#4 - Add vault constraint to ExecuteSplit**
   - `constraint = vault.key() == split_config.vault @ ErrorCode::InvalidVault`

### Phase 2: Breaking changes (Redeploy)

**Note:** No existing users, simple redeploy. Old test configs left as-is on old program.

4. **#6 - PDA seeds with unique_id**
   - Add `unique_id: Pubkey` to SplitConfig
   - Update seeds: `[b"split_config", authority, mint, unique_id]`
   - SDK returns `uniqueId` from `createSplitConfig()`
   - All subsequent calls require `uniqueId`

5. **#10 - Zero-copy with fixed arrays**
   - Use `#[account(zero_copy)]` and `#[repr(C)]` for SplitConfig
   - Fixed arrays: `[Recipient; 20]`, `[UnclaimedAmount; 20]`
   - Add `recipient_count: u8` field
   - ~50% serialization CU savings, critical for high-throughput

### Phase 3: Other fixes

6. **#3 - Add validations to update_split_config**
   - Copy validation loop from `create_split_config`
   - Zero address, zero percentage, duplicate checks
   - All recipient ATAs must exist

7. **#5 - Checked sum**
   - Use `try_fold(0u32, |acc, r| acc.checked_add(...))`

8. **#7 - Protocol wallet config**
   - Add `ProtocolConfig` account (authority, fee_wallet)
   - Add `initialize_protocol` instruction (one-time)
   - Add `update_protocol_config` instruction
   - Replace `PROTOCOL_WALLET` constant lookup

9. **#8 - Close instruction**
   - Add `close_split_config` with `close = authority` constraint
   - Require vault empty

10. **#9 - MIN_RECIPIENTS = 1**
    - Change constant from 2 to 1

---

## Technical Details

### Self-Healing execute_split Algorithm

```rust
pub fn handler(ctx: Context<ExecuteSplit>) -> Result<()> {
    let vault_balance = ctx.accounts.vault.amount;
    let recipient_count = ctx.accounts.split_config.recipient_count as usize;

    // Bounds check (recipients + protocol_ata)
    require!(
        ctx.remaining_accounts.len() >= recipient_count + 1,
        ErrorCode::InsufficientRemainingAccounts
    );

    // 1. Calculate available funds (protect all unclaimed)
    let total_unclaimed: u64 = split_config.unclaimed_amounts
        .iter()
        .take(recipient_count)  // Only iterate active entries
        .filter(|u| u.amount > 0)
        .try_fold(0u64, |acc, u| acc.checked_add(u.amount))
        .ok_or(ErrorCode::MathOverflow)?;

    let available_to_split = vault_balance
        .checked_sub(total_unclaimed)
        .ok_or(ErrorCode::MathUnderflow)?
        .checked_sub(split_config.protocol_unclaimed)
        .ok_or(ErrorCode::MathUnderflow)?;

    // 2. Distribute NEW funds only
    let mut distributed = 0u64;
    let mut held_as_unclaimed = 0u64;

    if available_to_split > 0 {
        for i in 0..recipient_count {
            let recipient = &split_config.recipients[i];
            let amount = available_to_split * recipient.percentage_bps as u64 / 10000;
            let ata = &remaining_accounts[i];

            if ata.data_is_empty() {
                // Add to unclaimed
                add_to_unclaimed(recipient.address, amount);
                held_as_unclaimed += amount;
            } else {
                transfer(ata, amount)?;
                distributed += amount;
            }
        }

        // Protocol fee (1% + dust) - only from successfully distributed + dust
        let protocol_fee = available_to_split
            .checked_sub(distributed)?
            .checked_sub(held_as_unclaimed)?;
        let protocol_ata = remaining_accounts.last().unwrap();

        if protocol_ata.data_is_empty() {
            split_config.protocol_unclaimed += protocol_fee;
        } else {
            transfer(protocol_ata, protocol_fee)?;
        }
    }

    // 3. Attempt to clear recipient unclaimed (self-healing)
    for i in 0..recipient_count {
        let unclaimed_entry = &mut split_config.unclaimed_amounts[i];
        if unclaimed_entry.amount > 0 {
            let ata = &remaining_accounts[i];

            // Cheap check first (~100 CU vs ~1000 CU for failed CPI)
            if ata.data_is_empty() {
                continue; // Still missing, skip
            }

            // Validate and transfer
            transfer(ata, unclaimed_entry.amount)?;
            unclaimed_entry.amount = 0;  // Clear the entry
        }
    }

    // 4. Attempt to clear protocol unclaimed
    if split_config.protocol_unclaimed > 0 {
        let protocol_ata = remaining_accounts.last().unwrap();

        if !protocol_ata.data_is_empty() {
            transfer(protocol_ata, split_config.protocol_unclaimed)?;
            split_config.protocol_unclaimed = 0;
        }
    }

    Ok(())
}
```

### Fixed Space Calculation (Zero-Copy)

```rust
pub const SPLIT_CONFIG_SIZE: usize =
    8 +                     // discriminator
    1 +                     // version
    32 +                    // authority
    32 +                    // mint
    32 +                    // vault
    32 +                    // unique_id
    1 +                     // bump
    1 +                     // recipient_count
    (34 * 20) +             // recipients [Recipient; 20]
    (48 * 20) +             // unclaimed_amounts [UnclaimedAmount; 20]
    8;                      // protocol_unclaimed
    // Total: ~1,787 bytes
```

---

## Summary

| Category | Count |
|----------|-------|
| Security fixes | 5 |
| Product enhancements | 7 |
| **Total changes** | **12** |
| Rejected claims | 8 |

---

## Notes

- Old test configs on devnet will be left as-is (unreachable by new program)
- SDK should set explicit CU limits for micropayment optimization
- Protocol wallet config enables fee wallet rotation without redeploy
- Self-healing design maintains single idempotent interface for facilitators
- Protocol unclaimed tracking enables permissionless support for any token without pre-creating ATAs
- New error codes needed: `InsufficientRemainingAccounts`, `InvalidVault`
- SplitExecuted event should include unclaimed clearing metrics for indexing

## Compute Optimizations

- **Zero-copy with fixed arrays** - ~50% serialization CU savings (~1,350 CU saved)
- **Stored bumps** - Use `split_config.bump` and `protocol_config.bump` instead of `find_program_address` (~1,300 CU saved per PDA)
- **Minimal logging** - Production builds use `#[cfg(feature = "verbose")]` for debug logs (~200-400 CU saved)
- **Pre-validate ATAs** - Check `data_is_empty()` before transfer attempts (~900 CU saved per failed CPI avoided)
