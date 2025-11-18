use anchor_lang::prelude::*;

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
