use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::{MAX_RECIPIENTS, MIN_RECIPIENTS, REQUIRED_SPLIT_TOTAL},
    errors::ErrorCode,
    events::SplitConfigUpdated,
    state::{Recipient, SplitConfig},
};

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

/// Updates split configuration
/// Only callable by authority, requires vault empty
pub fn handler<'info>(
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
