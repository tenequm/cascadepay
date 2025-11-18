use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token,
    token_2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{MAX_RECIPIENTS, MIN_RECIPIENTS, REQUIRED_SPLIT_TOTAL, SPLIT_CONFIG_SIZE},
    errors::ErrorCode,
    events::SplitConfigCreated,
    state::{Recipient, SplitConfig},
};

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

/// Creates a new split configuration with vault
/// Validates recipient ATAs on-chain (defense in depth)
pub fn handler<'info>(
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
