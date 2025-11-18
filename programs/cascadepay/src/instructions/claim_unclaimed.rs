use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    errors::ErrorCode,
    events::UnclaimedFundsClaimed,
    state::SplitConfig,
};

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

/// Recipients claim their unclaimed funds
pub fn handler(ctx: Context<ClaimUnclaimed>) -> Result<()> {
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
