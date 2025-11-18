use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
mod utils;

use instructions::*;
use state::Recipient;

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
        instructions::create_split_config::handler(ctx, mint, recipients)
    }

    /// Executes a payment split by draining vault
    /// Permissionless - anyone can call
    /// Gracefully handles missing recipient ATAs (holds as unclaimed)
    pub fn execute_split<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteSplit<'info>>,
    ) -> Result<()> {
        instructions::execute_split::handler(ctx)
    }

    /// Recipients claim their unclaimed funds
    pub fn claim_unclaimed(ctx: Context<ClaimUnclaimed>) -> Result<()> {
        instructions::claim_unclaimed::handler(ctx)
    }

    /// Updates split configuration
    /// Only callable by authority, requires vault empty
    pub fn update_split_config<'info>(
        ctx: Context<'_, '_, 'info, 'info, UpdateSplitConfig<'info>>,
        new_recipients: Vec<Recipient>,
    ) -> Result<()> {
        instructions::update_split_config::handler(ctx, new_recipients)
    }
}
