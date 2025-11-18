use anchor_lang::prelude::*;

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
