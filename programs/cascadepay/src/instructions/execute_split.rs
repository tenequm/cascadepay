use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token,
    token_2022,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{MAX_RECIPIENTS, PROTOCOL_WALLET},
    errors::ErrorCode,
    events::{RecipientPaymentHeld, SplitExecuted},
    state::{SplitConfig, UnclaimedAmount},
    utils::validate_and_send_to_recipient,
};

#[derive(Accounts)]
pub struct ExecuteSplit<'info> {
    #[account(
        mut,
        seeds = [b"split_config", split_config.authority.as_ref(), split_config.mint.as_ref()],
        bump = split_config.bump
    )]
    pub split_config: Box<Account<'info, SplitConfig>>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = mint.key() == split_config.mint
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Can be anyone (permissionless execution)
    pub executor: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Executes a payment split by draining vault
/// Permissionless - anyone can call
/// Gracefully handles missing recipient ATAs (holds as unclaimed)
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteSplit<'info>>,
) -> Result<()> {
    let vault_balance = ctx.accounts.vault.amount;
    if vault_balance == 0 {
        return Ok(()); // No-op if vault empty
    }

    let mut distributed = 0u64;
    let mut held_as_unclaimed = 0u64;

    // Setup PDA signer (capture values before any mutations)
    let authority = ctx.accounts.split_config.authority;
    let mint = ctx.accounts.split_config.mint;
    let bump = ctx.accounts.split_config.bump;
    let config_key = ctx.accounts.split_config.key();

    let seeds = &[
        b"split_config",
        authority.as_ref(),
        mint.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    // Clone recipients to avoid borrow issues
    let recipients = ctx.accounts.split_config.recipients.clone();

    // Distribute to configured recipients
    for (i, recipient) in recipients.iter().enumerate() {
        let recipient_ata_info = &ctx.remaining_accounts[i];

        // Calculate amount (floor division)
        let amount = (vault_balance as u128)
            .checked_mul(recipient.percentage_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(10000u128)
            .ok_or(ErrorCode::MathOverflow)?
            .try_into()
            .map_err(|_| ErrorCode::MathOverflow)?;

        if amount > 0 {
            // Attempt to send to recipient
            match validate_and_send_to_recipient(
                recipient_ata_info,
                recipient,
                amount,
                &ctx.accounts.mint,
                &ctx.accounts.vault,
                &ctx.accounts.split_config.to_account_info(),
                &ctx.accounts.token_program,
                signer_seeds,
            ) {
                Ok(()) => {
                    distributed = distributed.checked_add(amount)
                        .ok_or(ErrorCode::MathOverflow)?;
                }
                Err(e) => {
                    // Hold as unclaimed - STAYS IN VAULT
                    let split_config = &mut ctx.accounts.split_config;
                    if let Some(existing) = split_config.unclaimed_amounts.iter_mut()
                        .find(|u| u.recipient == recipient.address)
                    {
                        existing.amount = existing.amount.checked_add(amount)
                            .ok_or(ErrorCode::MathOverflow)?;
                        existing.timestamp = Clock::get()?.unix_timestamp;
                    } else {
                        // Check we don't exceed maximum unclaimed entries
                        require!(
                            split_config.unclaimed_amounts.len() < MAX_RECIPIENTS,
                            ErrorCode::TooManyUnclaimedEntries
                        );

                        split_config.unclaimed_amounts.push(UnclaimedAmount {
                            recipient: recipient.address,
                            amount,
                            timestamp: Clock::get()?.unix_timestamp,
                        });
                    }

                    held_as_unclaimed = held_as_unclaimed.checked_add(amount)
                        .ok_or(ErrorCode::MathOverflow)?;

                    emit!(RecipientPaymentHeld {
                        config: config_key,
                        recipient: recipient.address,
                        amount,
                        reason: format!("{:?}", e),
                        timestamp: Clock::get()?.unix_timestamp,
                    });
                }
            }
        }
    }

    // Protocol receives: 1% + dust only (NOT unclaimed amounts)
    let protocol_fee = vault_balance
        .checked_sub(distributed)
        .ok_or(ErrorCode::MathUnderflow)?
        .checked_sub(held_as_unclaimed)
        .ok_or(ErrorCode::MathUnderflow)?;

    if protocol_fee > 0 {
        // 1. Derive expected protocol ATA (Token-2022 compatible)
        let expected_protocol_ata = get_associated_token_address_with_program_id(
            &PROTOCOL_WALLET,
            &ctx.accounts.mint.key(),
            &ctx.accounts.token_program.key()  // Uses actual token program (Token or Token-2022)
        );

        // 2. Get protocol ATA from remaining_accounts (should be LAST)
        let protocol_ata_info = ctx.remaining_accounts
            .last()
            .ok_or(ErrorCode::MissingProtocolAccount)?;

        // 3. Validate address matches expected derivation
        require!(
            protocol_ata_info.key() == expected_protocol_ata,
            ErrorCode::InvalidProtocolFeeRecipient
        );

        // 4. Validate account is writable
        require!(
            protocol_ata_info.is_writable,
            ErrorCode::InvalidProtocolFeeRecipient
        );

        // 5. If protocol ATA doesn't exist, skip protocol fee (graceful degradation)
        if protocol_ata_info.data_is_empty() {
            // Protocol ATA doesn't exist yet - protocol fee stays in vault
            // Protocol can create ATA later and re-execute split to claim fees
            msg!("Protocol ATA doesn't exist, skipping protocol fee transfer");
        } else {
            // 6. Validate account is owned by token program (SPL Token or Token-2022)
            let valid_owner = protocol_ata_info.owner == &token::ID
                || protocol_ata_info.owner == &token_2022::ID;
            require!(valid_owner, ErrorCode::InvalidProtocolFeeRecipient);

            // 7. Deserialize and validate token account fields
            let protocol_ata = InterfaceAccount::<'info, TokenAccount>::try_from(protocol_ata_info)
                .map_err(|_| ErrorCode::InvalidProtocolFeeRecipient)?;

            require!(
                protocol_ata.owner == PROTOCOL_WALLET,
                ErrorCode::InvalidProtocolFeeRecipient
            );
            require!(
                protocol_ata.mint == ctx.accounts.mint.key(),
                ErrorCode::InvalidProtocolFeeRecipient
            );

            // 8. Transfer protocol fee
            let cpi_accounts = TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: protocol_ata.to_account_info(),
                authority: ctx.accounts.split_config.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, protocol_fee, ctx.accounts.mint.decimals)?;
        }
    }

    emit!(SplitExecuted {
        config: config_key,
        vault: ctx.accounts.vault.key(),
        total_amount: vault_balance,
        recipients_distributed: distributed,
        protocol_fee,
        held_count: held_as_unclaimed,
        executor: ctx.accounts.executor.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
