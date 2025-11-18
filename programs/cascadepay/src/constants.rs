use anchor_lang::prelude::*;

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
