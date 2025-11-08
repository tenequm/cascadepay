/**
 * cascadepay TypeScript SDK
 * Payment splitting infrastructure for Solana
 *
 * Uses @solana/kit for modern Solana operations
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
} from "@solana-program/token";
import {
  address,
  type Address,
} from "@solana/kit";

// Convert @solana/kit Address constants to Anchor PublicKey for .accounts() calls
const ASSOCIATED_TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);

// Re-export Anchor types for API compatibility
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;
type Connection = anchor.web3.Connection;

// Export transaction types for facilitator integration (via Anchor re-export)
export type Transaction = anchor.web3.Transaction;
export type TransactionInstruction = anchor.web3.TransactionInstruction;

// Types matching on-chain program
export interface Recipient {
  address: PublicKey;
  percentageBps: number; // 0-9900 (recipients must total 99%)
}

export interface UnclaimedAmount {
  recipient: PublicKey;
  amount: anchor.BN;
  timestamp: anchor.BN;
}

export interface SplitConfig {
  authority: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  recipients: Recipient[];
  unclaimedAmounts: UnclaimedAmount[];
  bump: number;
  version: number;
}

export interface CreateSplitConfigParams {
  mint: PublicKey;
  recipients: Recipient[]; // Must sum to 9900 bps (99%)
}

export interface DetectionResult {
  isSplitVault: boolean;
  splitConfig?: PublicKey;
}

/**
 * Helper: Convert Anchor PublicKey to @solana/kit Address
 */
function toAddress(pubkey: PublicKey): Address {
  return address(pubkey.toBase58());
}

/**
 * Helper: Convert @solana/kit Address to Anchor PublicKey
 */
function toPublicKey(addr: Address): PublicKey {
  return new anchor.web3.PublicKey(addr);
}

/**
 * Helper function to detect which token program a mint uses
 * @param connection - Solana connection
 * @param mint - Mint public key
 * @returns TOKEN_PROGRAM_ADDRESS (supports both Token and Token-2022)
 */
async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<Address> {
  const mintInfo = await connection.getAccountInfo(mint);

  if (!mintInfo) {
    throw new Error(`Mint account ${mint.toString()} does not exist`);
  }

  // Return TOKEN_PROGRAM_ADDRESS which works for both Token and Token-2022
  // The @solana-program/token package handles both automatically
  return TOKEN_PROGRAM_ADDRESS;
}

export class Cascadepay {
  constructor(
    private program: Program,
    private provider: AnchorProvider
  ) {}

  /**
   * Creates a new split configuration with vault
   * @param params.mint - Token mint address (USDC, USDT, etc.)
   * @param params.recipients - Array of recipients with percentages (must sum to 9900 bps = 99%)
   * @returns PDA address of created split config
   */
  async createSplitConfig(
    params: CreateSplitConfigParams
  ): Promise<PublicKey> {
    const { mint, recipients } = params;

    // Validate inputs
    const sum = recipients.reduce((acc, r) => acc + r.percentageBps, 0);
    if (sum !== 9900) {
      throw new Error("Recipient shares must sum to 9900 basis points (99%). Protocol gets 1%.");
    }

    if (recipients.length < 2 || recipients.length > 20) {
      throw new Error("Must have between 2 and 20 recipients");
    }

    // Derive split config PDA
    const [splitConfigPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("split_config"),
        this.provider.wallet.publicKey.toBuffer(),
        mint.toBuffer()
      ],
      this.program.programId
    );

    // Detect token program
    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, mint);
    const tokenProgramPubkey = toPublicKey(tokenProgramAddr);

    // Derive vault ATA
    const [vaultAta] = await findAssociatedTokenPda({
      mint: toAddress(mint),
      owner: toAddress(splitConfigPDA),
      tokenProgram: tokenProgramAddr,
    });

    // Get recipient ATAs for validation
    const recipientAtas = await Promise.all(
      recipients.map(r => findAssociatedTokenPda({
        mint: toAddress(mint),
        owner: toAddress(r.address),
        tokenProgram: tokenProgramAddr,
      }).then(([ata]) => toPublicKey(ata)))
    );

    // Create split config
    await this.program.methods
      .createSplitConfig(mint, recipients)
      .accounts({
        splitConfig: splitConfigPDA,
        vault: toPublicKey(vaultAta),
        mint,
        authority: this.provider.wallet.publicKey,
        tokenProgram: tokenProgramPubkey,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(
        recipientAtas.map(ata => ({
          pubkey: ata,
          isSigner: false,
          isWritable: false,
        }))
      )
      .rpc();

    return splitConfigPDA;
  }

  /**
   * Executes a payment split by draining vault
   * Permissionless - anyone can call
   * @param splitConfigPDA - Address of split configuration
   * @returns Transaction signature
   */
  async executeSplit(splitConfigPDA: PublicKey): Promise<string> {
    const config = await this.getSplitConfig(splitConfigPDA);

    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, config.mint);
    const tokenProgramPubkey = toPublicKey(tokenProgramAddr);

    // Get recipient ATAs
    const recipientAtas = await Promise.all(
      config.recipients.map(r =>
        findAssociatedTokenPda({
          mint: toAddress(config.mint),
          owner: toAddress(r.address),
          tokenProgram: tokenProgramAddr,
        }).then(([ata]) => toPublicKey(ata))
      )
    );

    // Protocol wallet
    const protocolWallet = new anchor.web3.PublicKey("Fo2EYEYbnJTnBnbAgnjnG1c2fixpFn1vSUUHSeoHhRP");
    const [protocolAta] = await findAssociatedTokenPda({
      mint: toAddress(config.mint),
      owner: toAddress(protocolWallet),
      tokenProgram: tokenProgramAddr,
    });

    const tx = await this.program.methods
      .executeSplit()
      .accounts({
        splitConfig: splitConfigPDA,
        vault: config.vault,
        mint: config.mint,
        protocolFeeRecipient: toPublicKey(protocolAta),
        executor: this.provider.wallet.publicKey,
        tokenProgram: tokenProgramPubkey,
      })
      .remainingAccounts(
        recipientAtas.map(ata => ({
          pubkey: ata,
          isSigner: false,
          isWritable: true,
        }))
      )
      .rpc();

    return tx;
  }

  /**
   * Recipients claim their unclaimed funds
   * @param splitConfigPDA - Address of split configuration
   * @param recipient - Recipient keypair
   * @returns Transaction signature
   */
  async claimUnclaimed(
    splitConfigPDA: PublicKey,
    recipient: Keypair
  ): Promise<string> {
    const config = await this.getSplitConfig(splitConfigPDA);

    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, config.mint);
    const tokenProgramPubkey = toPublicKey(tokenProgramAddr);

    const [recipientAta] = await findAssociatedTokenPda({
      mint: toAddress(config.mint),
      owner: toAddress(recipient.publicKey),
      tokenProgram: tokenProgramAddr,
    });

    const tx = await this.program.methods
      .claimUnclaimed()
      .accounts({
        recipient: recipient.publicKey,
        splitConfig: splitConfigPDA,
        vault: config.vault,
        mint: config.mint,
        recipientAta: toPublicKey(recipientAta),
        tokenProgram: tokenProgramPubkey,
      })
      .signers([recipient])
      .rpc();

    return tx;
  }

  /**
   * Fetches split configuration from on-chain PDA
   * @param splitConfigPDA - Address of split configuration
   * @returns Split configuration data
   */
  async getSplitConfig(splitConfigPDA: PublicKey): Promise<SplitConfig> {
    interface RawSplitConfig {
      authority: PublicKey;
      mint: PublicKey;
      vault: PublicKey;
      recipients: Recipient[];
      unclaimedAmounts: UnclaimedAmount[];
      bump: number;
      version: number;
    }

    const splitConfigAccount = this.program.account['splitConfig'];
    const config = await splitConfigAccount.fetch(splitConfigPDA) as RawSplitConfig;

    return {
      authority: config.authority,
      mint: config.mint,
      vault: config.vault,
      recipients: config.recipients,
      unclaimedAmounts: config.unclaimedAmounts,
      bump: config.bump,
      version: config.version,
    };
  }

  /**
   * Updates split configuration recipients
   * Requires vault to be empty
   * @param splitConfigPDA - Address of split configuration
   * @param newRecipients - New recipients array (must sum to 9900 bps)
   * @returns Transaction signature
   */
  async updateSplitConfig(
    splitConfigPDA: PublicKey,
    newRecipients: Recipient[]
  ): Promise<string> {
    const sum = newRecipients.reduce((acc, r) => acc + r.percentageBps, 0);
    if (sum !== 9900) {
      throw new Error("Recipients must sum to 9900 basis points (99%)");
    }

    const config = await this.getSplitConfig(splitConfigPDA);

    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, config.mint);

    const recipientAtas = await Promise.all(
      newRecipients.map(r => findAssociatedTokenPda({
        mint: toAddress(config.mint),
        owner: toAddress(r.address),
        tokenProgram: tokenProgramAddr,
      }).then(([ata]) => toPublicKey(ata)))
    );

    const tx = await this.program.methods
      .updateSplitConfig(newRecipients)
      .accounts({
        authority: this.provider.wallet.publicKey,
        splitConfig: splitConfigPDA,
        vault: config.vault,
        mint: config.mint,
      })
      .remainingAccounts(
        recipientAtas.map(ata => ({
          pubkey: ata,
          isSigner: false,
          isWritable: false,
        }))
      )
      .rpc();

    return tx;
  }

  /**
   * Closes split configuration and vault
   * Requires vault empty and no unclaimed funds
   * @param splitConfigPDA - Address of split configuration
   * @returns Transaction signature
   */
  async closeSplitConfig(splitConfigPDA: PublicKey): Promise<string> {
    const config = await this.getSplitConfig(splitConfigPDA);

    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, config.mint);
    const tokenProgramPubkey = toPublicKey(tokenProgramAddr);

    const tx = await this.program.methods
      .closeSplitConfig()
      .accounts({
        splitConfig: splitConfigPDA,
        vault: config.vault,
        authority: this.provider.wallet.publicKey,
        tokenProgram: tokenProgramPubkey,
      })
      .rpc();

    return tx;
  }

  /**
   * Helper: Derives split config PDA for authority and mint
   * @param authority - Authority public key
   * @param mint - Token mint address
   * @returns PDA address
   */
  deriveSplitConfigPDA(authority: PublicKey, mint: PublicKey): PublicKey {
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("split_config"), authority.toBuffer(), mint.toBuffer()],
      this.program.programId
    );
    return pda;
  }

  /**
   * Helper: Convert percentages to basis points
   * @param percentages - Array of percentages (must sum to 99%)
   * @returns Array of basis points
   */
  static percentagesToShares(percentages: number[]): number[] {
    const sum = percentages.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 99) > 0.01) {
      throw new Error("Percentages must sum to 99% (protocol gets 1%)");
    }

    return percentages.map(pct => Math.round((pct / 100) * 10000));
  }

  /**
   * Builds execute_split instruction WITHOUT sending it
   * Facilitators use this to bundle with transfer instruction
   *
   * @param splitConfigPDA - Split configuration address
   * @param executor - Optional executor (defaults to provider wallet)
   * @returns TransactionInstruction ready to add to Transaction
   */
  async buildExecuteSplitInstruction(
    splitConfigPDA: PublicKey,
    executor?: PublicKey
  ): Promise<anchor.web3.TransactionInstruction> {
    const config = await this.getSplitConfig(splitConfigPDA);

    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, config.mint);
    const tokenProgramPubkey = toPublicKey(tokenProgramAddr);

    // Get recipient ATAs
    const recipientAtas = await Promise.all(
      config.recipients.map(r =>
        findAssociatedTokenPda({
          mint: toAddress(config.mint),
          owner: toAddress(r.address),
          tokenProgram: tokenProgramAddr,
        }).then(([ata]) => toPublicKey(ata))
      )
    );

    // Protocol wallet
    const protocolWallet = new anchor.web3.PublicKey("Fo2EYEYbnJTnBnbAgnjnG1c2fixpFn1vSUUHSeoHhRP");
    const [protocolAta] = await findAssociatedTokenPda({
      mint: toAddress(config.mint),
      owner: toAddress(protocolWallet),
      tokenProgram: tokenProgramAddr,
    });

    const executorKey = executor || this.provider.wallet.publicKey;

    // Use .instruction() instead of .rpc() to get TransactionInstruction
    return await this.program.methods
      .executeSplit()
      .accounts({
        splitConfig: splitConfigPDA,
        vault: config.vault,
        mint: config.mint,
        protocolFeeRecipient: toPublicKey(protocolAta),
        executor: executorKey,
        tokenProgram: tokenProgramPubkey,
      })
      .remainingAccounts(
        recipientAtas.map(ata => ({
          pubkey: ata,
          isSigner: false,
          isWritable: true,
        }))
      )
      .instruction();
  }

  /**
   * Builds claim_unclaimed instruction WITHOUT sending it
   *
   * @param splitConfigPDA - Split configuration address
   * @param recipient - Recipient public key (who has unclaimed funds)
   * @returns TransactionInstruction ready to add to Transaction
   */
  async buildClaimUnclaimedInstruction(
    splitConfigPDA: PublicKey,
    recipient: PublicKey
  ): Promise<anchor.web3.TransactionInstruction> {
    const config = await this.getSplitConfig(splitConfigPDA);

    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, config.mint);
    const tokenProgramPubkey = toPublicKey(tokenProgramAddr);

    const [recipientAta] = await findAssociatedTokenPda({
      mint: toAddress(config.mint),
      owner: toAddress(recipient),
      tokenProgram: tokenProgramAddr,
    });

    // Use .instruction() instead of .rpc()
    return await this.program.methods
      .claimUnclaimed()
      .accounts({
        recipient,
        splitConfig: splitConfigPDA,
        vault: config.vault,
        mint: config.mint,
        recipientAta: toPublicKey(recipientAta),
        tokenProgram: tokenProgramPubkey,
      })
      .instruction();
  }

  /**
   * Builds bundled transaction: [transfer to vault, execute_split]
   * This is the PRIMARY facilitator integration method
   *
   * @param splitConfigPDA - Split configuration address
   * @param transferAmount - Amount to transfer in token base units (e.g., lamports for SOL, smallest unit for tokens)
   * @param payer - Who's sending the payment
   * @param executor - Optional executor for the split (defaults to payer)
   * @returns Complete Transaction ready to sign and send (atomic execution)
   */
  async buildBundledTransaction(
    splitConfigPDA: PublicKey,
    transferAmount: bigint,
    payer: PublicKey,
    executor?: PublicKey
  ): Promise<anchor.web3.Transaction> {
    const config = await this.getSplitConfig(splitConfigPDA);
    const tokenProgramAddr = await detectTokenProgram(this.provider.connection, config.mint);

    // Get payer's ATA
    const [payerAta] = await findAssociatedTokenPda({
      mint: toAddress(config.mint),
      owner: toAddress(payer),
      tokenProgram: tokenProgramAddr,
    });

    // Fetch mint decimals for transfer_checked
    const mintInfo = await this.provider.connection.getAccountInfo(config.mint);
    if (!mintInfo) {
      throw new Error(`Mint ${config.mint.toString()} does not exist`);
    }
    const decimals = mintInfo.data[44];

    // Build transfer instruction using @solana-program/token
    const { getTransferCheckedInstruction } = await import("@solana-program/token");
    const transferIxKit = getTransferCheckedInstruction({
      source: payerAta, // Already an Address from findAssociatedTokenPda
      mint: toAddress(config.mint),
      destination: toAddress(config.vault),
      authority: toAddress(payer), // Owner/delegate of source account
      amount: transferAmount,
      decimals,
    });

    // Convert Kit instruction to Anchor TransactionInstruction
    const transferIx = new anchor.web3.TransactionInstruction({
      keys: transferIxKit.accounts.map(acc => ({
        pubkey: toPublicKey(acc.address),
        isSigner: acc.role === 2 || acc.role === 3,
        isWritable: acc.role === 1 || acc.role === 3,
      })),
      programId: toPublicKey(transferIxKit.programAddress),
      data: Buffer.from(transferIxKit.data),
    });

    // Build execute split instruction
    const executeSplitIx = await this.buildExecuteSplitInstruction(
      splitConfigPDA,
      executor || payer
    );

    // Bundle atomically
    const transaction = new anchor.web3.Transaction()
      .add(transferIx)
      .add(executeSplitIx);

    return transaction;
  }

}

/**
 * Detects if a destination address is a split vault
 * @param destination - Payment destination to check
 * @param connection - Solana connection
 * @param programId - cascadepay program ID
 * @returns Detection result
 */
export async function detectSplitVault(
  destination: PublicKey,
  connection: Connection,
  programId: PublicKey
): Promise<DetectionResult> {
  try {
    // Check if account exists
    const accountInfo = await connection.getAccountInfo(destination);
    if (!accountInfo) return { isSplitVault: false };

    // Check if it's a token account (owned by Token Program or Token-2022)
    const TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(TOKEN_PROGRAM_ADDRESS);
    const TOKEN_2022_PROGRAM_ID = new anchor.web3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

    const isTokenAccount =
      accountInfo.owner.equals(TOKEN_PROGRAM_ID) ||
      accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);

    if (!isTokenAccount) return { isSplitVault: false };

    // Parse token account data to get the authority field
    // Token account structure: https://github.com/solana-labs/solana-program-library/blob/master/token/program/src/state.rs
    // First 32 bytes: mint, next 32 bytes: owner/authority
    if (accountInfo.data.length < 165) return { isSplitVault: false };

    const authorityBytes = accountInfo.data.slice(32, 64);
    const authority = new anchor.web3.PublicKey(authorityBytes);

    // Try to fetch split config account at authority address
    // Create minimal wallet for read-only operations
    const wallet: anchor.Wallet = {
      publicKey: anchor.web3.PublicKey.default,
      signTransaction: async () => { throw new Error("Read-only wallet"); },
      signAllTransactions: async () => { throw new Error("Read-only wallet"); },
    };
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

    // Fetch program IDL from chain
    const idl = await Program.fetchIdl(programId, provider);
    if (!idl) return { isSplitVault: false };

    const program = new Program(idl, provider);

    try {
      interface RawSplitConfig {
        vault: PublicKey;
      }

      const splitConfigAccount = program.account['splitConfig'];
      const config = await splitConfigAccount.fetch(authority) as RawSplitConfig;

      // Verify it's actually a split config by checking if vault matches destination
      if (config.vault.equals(destination)) {
        return {
          isSplitVault: true,
          splitConfig: authority
        };
      }
    } catch {
      // Not a valid split config
      return { isSplitVault: false };
    }

    return { isSplitVault: false };
  } catch {
    return { isSplitVault: false };
  }
}

/**
 * Factory function to create SDK instance
 * @param connection - Solana connection
 * @param wallet - Anchor wallet
 * @param idl - Program IDL (contains program ID in metadata)
 * @returns Cascadepay SDK instance
 */
export async function createCascadepayClient(
  connection: Connection,
  wallet: anchor.Wallet,
  idl: Idl
): Promise<Cascadepay> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const program = new Program(idl, provider);
  return new Cascadepay(program, provider);
}
