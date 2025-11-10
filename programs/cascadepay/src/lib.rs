use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{AssociatedToken, get_associated_token_address_with_program_id},
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
    token,
    token_2022,
};

declare_id!("Bi1y2G3hteJwbeQk7QAW9Uk7Qq2h9bPbDYhPCKSuE2W2");

// Security contact information (embedded on-chain)
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "CascadePay",
    project_url: "https://cascadepay.io",
    contacts: "email:hello@cascadepay.io,link:https://github.com/tenequm/cascadepay/security",
    policy: "https://github.com/tenequm/cascadepay/blob/main/SECURITY.md",
    source_code: "https://github.com/tenequm/cascadepay"
}

// Protocol wallet for mainnet (receives 1% fee)
pub const PROTOCOL_WALLET: Pubkey = pubkey!("2zMEvEkyQKTRjiGkwYPXjPsJUp8eR1rVjoYQ7PzVVZnP");
pub const PROTOCOL_FEE_BPS: u16 = 100;         // 1% = 100 basis points
pub const REQUIRED_SPLIT_TOTAL: u16 = 9900;    // Recipients MUST total 99%
pub const MIN_RECIPIENTS: usize = 2;
pub const MAX_RECIPIENTS: usize = 20;

// SplitConfig account size calculation (pre-allocated for MAX_RECIPIENTS)
pub const SPLIT_CONFIG_SIZE: usize =
    8 +   // discriminator (Anchor account discriminator)
    1 +   // version (u8)
    32 +  // authority (Pubkey)
    32 +  // mint (Pubkey)
    32 +  // vault (Pubkey)
    4 + (34 * MAX_RECIPIENTS) +  // recipients Vec (4 byte length + Recipient * max)
    4 + (48 * MAX_RECIPIENTS) +  // unclaimed_amounts Vec (4 byte length + UnclaimedAmount * max)
    1;    // bump (u8)

#[program]
pub mod cascadepay {
    use super::*;

    /// Creates a new split configuration with vault
    /// Validates recipient ATAs on-chain (defense in depth)
    pub fn create_split_config<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateSplitConfig<'info>>,
        mint: Pubkey,
        recipients: Vec<Recipient>,
    ) -> Result<()> {
        require!(
            recipients.len() >= MIN_RECIPIENTS && recipients.len() <= MAX_RECIPIENTS,
            ErrorCode::InvalidRecipientCount
        );

        // Validate shares sum to 9900 (99%)
        let sum: u32 = recipients.iter().map(|r| r.percentage_bps as u32).sum();
        require!(sum == REQUIRED_SPLIT_TOTAL as u32, ErrorCode::InvalidSplitTotal);

        // Validate recipient ATAs passed via remaining_accounts
        require!(
            ctx.remaining_accounts.len() == recipients.len(),
            ErrorCode::RecipientATACountMismatch
        );

        for (i, recipient) in recipients.iter().enumerate() {
            let recipient_ata_info = &ctx.remaining_accounts[i];

            // Validate recipient address is not zero
            require!(recipient.address != Pubkey::default(), ErrorCode::ZeroAddress);
            require!(recipient.percentage_bps > 0, ErrorCode::ZeroPercentage);

            // Check for duplicate recipients (prevent same address appearing twice)
            for j in (i+1)..recipients.len() {
                require!(
                    recipient.address != recipients[j].address,
                    ErrorCode::DuplicateRecipient
                );
            }

            // Validate remaining_accounts entry is read-only during creation
            require!(
                !recipient_ata_info.is_writable,
                ErrorCode::RecipientATAShouldBeReadOnly
            );

            // Validate ATA exists and is valid
            require!(!recipient_ata_info.data_is_empty(), ErrorCode::RecipientATADoesNotExist);

            // Validate owned by token program (SPL Token or Token-2022)
            let valid_owner = recipient_ata_info.owner == &token::ID
                || recipient_ata_info.owner == &token_2022::ID;
            require!(valid_owner, ErrorCode::RecipientATAInvalidOwner);

            let recipient_ata = InterfaceAccount::<'info, TokenAccount>::try_from(recipient_ata_info)
                .map_err(|_| ErrorCode::RecipientATAInvalid)?;

            require!(recipient_ata.owner == recipient.address, ErrorCode::RecipientATAWrongOwner);
            require!(recipient_ata.mint == mint, ErrorCode::RecipientATAWrongMint);
        }

        let config = &mut ctx.accounts.split_config;
        config.version = 1;  // Current version
        config.authority = ctx.accounts.authority.key();
        config.mint = mint;
        config.vault = ctx.accounts.vault.key();
        config.recipients = recipients.clone();
        config.unclaimed_amounts = Vec::new();
        config.bump = ctx.bumps.split_config;

        emit!(SplitConfigCreated {
            config: config.key(),
            authority: config.authority,
            mint: config.mint,
            vault: config.vault,
            recipients_count: recipients.len() as u8,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Executes a payment split by draining vault
    /// Permissionless - anyone can call
    /// Gracefully handles missing recipient ATAs (holds as unclaimed)
    pub fn execute_split<'info>(
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

    /// Recipients claim their unclaimed funds
    pub fn claim_unclaimed(ctx: Context<ClaimUnclaimed>) -> Result<()> {
        let claimer = ctx.accounts.recipient.key();
        let config_key = ctx.accounts.split_config.key();

        // Capture seeds values before any mutations
        let authority = ctx.accounts.split_config.authority;
        let mint = ctx.accounts.split_config.mint;
        let bump = ctx.accounts.split_config.bump;

        // Find and remove unclaimed entry
        let split_config = &mut ctx.accounts.split_config;
        let index = split_config.unclaimed_amounts.iter()
            .position(|u| u.recipient == claimer)
            .ok_or(ErrorCode::NothingToClaim)?;

        let unclaimed = split_config.unclaimed_amounts.remove(index);

        // Transfer from vault to recipient
        let seeds = &[
            b"split_config",
            authority.as_ref(),
            mint.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.recipient_ata.to_account_info(),
            authority: ctx.accounts.split_config.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, unclaimed.amount, ctx.accounts.mint.decimals)?;

        emit!(UnclaimedFundsClaimed {
            config: config_key,
            recipient: claimer,
            amount: unclaimed.amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Updates split configuration
    /// Only callable by authority, requires vault empty
    pub fn update_split_config<'info>(
        ctx: Context<'_, '_, 'info, 'info, UpdateSplitConfig<'info>>,
        new_recipients: Vec<Recipient>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.split_config;
        let old_recipients_count = config.recipients.len() as u8;

        // Require vault empty
        require!(ctx.accounts.vault.amount == 0, ErrorCode::VaultNotEmpty);

        // Validate new recipients
        require!(
            new_recipients.len() >= MIN_RECIPIENTS && new_recipients.len() <= MAX_RECIPIENTS,
            ErrorCode::InvalidRecipientCount
        );

        let sum: u32 = new_recipients.iter().map(|r| r.percentage_bps as u32).sum();
        require!(sum == REQUIRED_SPLIT_TOTAL as u32, ErrorCode::InvalidSplitTotal);

        // Validate new recipient ATAs
        require!(
            ctx.remaining_accounts.len() == new_recipients.len(),
            ErrorCode::RecipientATACountMismatch
        );

        for (i, recipient) in new_recipients.iter().enumerate() {
            let recipient_ata_info = &ctx.remaining_accounts[i];

            require!(!recipient_ata_info.data_is_empty(), ErrorCode::RecipientATADoesNotExist);

            let recipient_ata = InterfaceAccount::<'info, TokenAccount>::try_from(recipient_ata_info)
                .map_err(|_| ErrorCode::RecipientATAInvalid)?;

            require!(recipient_ata.owner == recipient.address, ErrorCode::RecipientATAWrongOwner);
            require!(recipient_ata.mint == config.mint, ErrorCode::RecipientATAWrongMint);
        }

        config.recipients = new_recipients.clone();

        emit!(SplitConfigUpdated {
            config: config.key(),
            authority: config.authority,
            old_recipients_count,
            new_recipients_count: new_recipients.len() as u8,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // Note: close_split_config temporarily removed due to Bumps trait complexity
    // Can be added back in future iteration
}

/// Helper function to validate recipient ATA and send tokens
/// Enhanced validation to provide better error messages for debugging
fn validate_and_send_to_recipient<'info>(
    recipient_ata_info: &'info AccountInfo<'info>,
    recipient: &Recipient,
    amount: u64,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    split_config_info: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    // Validate account exists and has data
    require!(!recipient_ata_info.data_is_empty(), ErrorCode::RecipientATADoesNotExist);

    // Validate account is owned by token program (SPL Token or Token-2022)
    let valid_owner = recipient_ata_info.owner == &token::ID
        || recipient_ata_info.owner == &token_2022::ID;
    require!(valid_owner, ErrorCode::RecipientATAInvalidOwner);

    // Try to deserialize as token account
    let recipient_ata = InterfaceAccount::<'info, TokenAccount>::try_from(recipient_ata_info)
        .map_err(|_| ErrorCode::RecipientATAInvalid)?;

    // Verify owner and mint match expected values
    require!(recipient_ata.owner == recipient.address, ErrorCode::RecipientATAWrongOwner);
    require!(recipient_ata.mint == mint.key(), ErrorCode::RecipientATAWrongMint);

    // Transfer tokens
    let cpi_accounts = TransferChecked {
        from: vault.to_account_info(),
        mint: mint.to_account_info(),
        to: recipient_ata.to_account_info(),
        authority: split_config_info.clone(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::transfer_checked(cpi_ctx, amount, mint.decimals)?;

    Ok(())
}

// Account Structs

#[derive(Accounts)]
#[instruction(mint: Pubkey, recipients: Vec<Recipient>)]
pub struct CreateSplitConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = SPLIT_CONFIG_SIZE,
        seeds = [b"split_config", authority.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub split_config: Account<'info, SplitConfig>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = split_config,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

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

#[derive(Accounts)]
pub struct ClaimUnclaimed<'info> {
    pub recipient: Signer<'info>,

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

    #[account(
        mut,
        associated_token::mint = split_config.mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(new_recipients: Vec<Recipient>)]
pub struct UpdateSplitConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [b"split_config", authority.key().as_ref(), split_config.mint.as_ref()],
        bump = split_config.bump
    )]
    pub split_config: Box<Account<'info, SplitConfig>>,

    #[account(
        mut,
        constraint = vault.key() == split_config.vault @ ErrorCode::InvalidVault
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
}

// Note: CloseSplitConfig temporarily removed
// #[derive(Accounts)]
// pub struct CloseSplitConfig<'info> {
//     ...
// }

// Data Structures

#[account]
pub struct SplitConfig {
    pub version: u8,                            // 1 (for future migrations)
    pub authority: Pubkey,                      // 32
    pub mint: Pubkey,                           // 32
    pub vault: Pubkey,                          // 32
    pub recipients: Vec<Recipient>,             // 4 + (34 * n)
    pub unclaimed_amounts: Vec<UnclaimedAmount>,// 4 + (48 * n)
    pub bump: u8,                               // 1
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Recipient {
    pub address: Pubkey,           // 32
    pub percentage_bps: u16,       // 2
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnclaimedAmount {
    pub recipient: Pubkey,         // 32
    pub amount: u64,               // 8
    pub timestamp: i64,            // 8
}

// Events

#[event]
pub struct SplitConfigCreated {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub recipients_count: u8,
    pub timestamp: i64,
}

#[event]
pub struct SplitExecuted {
    pub config: Pubkey,
    pub vault: Pubkey,
    pub total_amount: u64,
    pub recipients_distributed: u64,
    pub protocol_fee: u64,
    pub held_count: u64,
    pub executor: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct RecipientPaymentHeld {
    pub config: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub reason: String,
    pub timestamp: i64,
}

#[event]
pub struct UnclaimedFundsClaimed {
    pub config: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct SplitConfigUpdated {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub old_recipients_count: u8,
    pub new_recipients_count: u8,
    pub timestamp: i64,
}

// Note: SplitConfigClosed event temporarily removed
// #[event]
// pub struct SplitConfigClosed {
//     pub config: Pubkey,
//     pub authority: Pubkey,
//     pub timestamp: i64,
// }

// Error Codes

#[error_code]
pub enum ErrorCode {
    #[msg("Recipients must total exactly 9900 basis points (99%)")]
    InvalidSplitTotal,

    #[msg("Must have between 2 and 20 recipients")]
    InvalidRecipientCount,

    #[msg("Duplicate recipient address detected")]
    DuplicateRecipient,

    #[msg("Recipient address cannot be zero")]
    ZeroAddress,

    #[msg("Recipient percentage cannot be zero")]
    ZeroPercentage,

    #[msg("Vault balance must be 0 to update or close config")]
    VaultNotEmpty,

    #[msg("Provided vault account does not match config vault")]
    InvalidVault,

    #[msg("Math overflow occurred")]
    MathOverflow,

    #[msg("Math underflow occurred")]
    MathUnderflow,

    #[msg("Number of recipient ATAs passed doesn't match recipients length")]
    RecipientATACountMismatch,

    #[msg("Recipient ATA does not exist. Create it first.")]
    RecipientATADoesNotExist,

    #[msg("Recipient account is not a valid token account")]
    RecipientATAInvalid,

    #[msg("Recipient ATA has wrong owner (doesn't belong to recipient)")]
    RecipientATAWrongOwner,

    #[msg("Recipient ATA has wrong mint (not for this token)")]
    RecipientATAWrongMint,

    #[msg("Recipient ATA is owned by wrong program (not Token or Token-2022)")]
    RecipientATAInvalidOwner,

    #[msg("Recipient ATA should be read-only during config creation")]
    RecipientATAShouldBeReadOnly,

    #[msg("Too many unclaimed entries (max 20)")]
    TooManyUnclaimedEntries,

    #[msg("Protocol fee account was not provided in remaining_accounts")]
    MissingProtocolAccount,

    #[msg("Protocol fee recipient must be the designated protocol wallet ATA")]
    InvalidProtocolFeeRecipient,

    #[msg("Recipient has no unclaimed funds to claim")]
    NothingToClaim,

    #[msg("Config still has unclaimed funds - cannot close")]
    UnclaimedFundsExist,
}
