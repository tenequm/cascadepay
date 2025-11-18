use anchor_lang::prelude::*;

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
