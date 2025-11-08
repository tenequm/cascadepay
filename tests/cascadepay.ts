import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Cascadepay } from "../target/types/cascadepay";
import { assert } from "chai";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";

// Modern Solana imports
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  airdropFactory,
  lamports,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  address,
  type Address,
} from "@solana/kit";

import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeMintInstruction,
  getMintSize,
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getMintToInstruction,
  getTransferInstruction,
  fetchToken,
} from "@solana-program/token";

describe("cascadepay E2E Tests", () => {
  // Configure the client to use devnet
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cascadepay as Program<Cascadepay>;

  // Modern Solana RPC clients
  const rpcUrl = provider.connection.rpcEndpoint;
  const wsUrl = rpcUrl.replace("https://", "wss://").replace("http://", "ws://");
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);

  const airdrop = airdropFactory({ rpc, rpcSubscriptions });
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions
  });

  // Test accounts
  let feePayer: any; // @solana/kit signer created from Anchor wallet
  let mintAddress: Address;
  let recipient1Signer: any;
  let recipient2Signer: any;
  let recipient1AtaAddress: Address;
  let recipient2AtaAddress: Address;
  let protocolAtaAddress: Address;
  let splitConfigPda: anchor.web3.PublicKey;
  let vaultAtaAddress: Address;

  const PROTOCOL_WALLET = address("Fo2EYEYbnJTnBnbAgnjnG1c2fixpFn1vSUUHSeoHhRP");

  // Helper: Create mint with modern API
  async function createMint(feePayer: any, decimals: number): Promise<Address> {
    const mint = await generateKeyPairSigner();

    const space = BigInt(getMintSize());
    const rentResponse = await rpc.getMinimumBalanceForRentExemption(space).send();
    const rent = rentResponse;

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const createAccountIx = getCreateAccountInstruction({
      payer: feePayer,
      newAccount: mint,
      lamports: rent,
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    });

    const initializeMintIx = getInitializeMintInstruction({
      mint: mint.address,
      decimals,
      mintAuthority: feePayer.address,
      freezeAuthority: null,
    });

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([createAccountIx, initializeMintIx], tx)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });

    return mint.address;
  }

  // Helper: Create ATA
  async function createATA(feePayer: any, mint: Address, owner: Address): Promise<Address> {
    const [ataAddress] = await findAssociatedTokenPda({
      mint,
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const createAtaIx = await getCreateAssociatedTokenInstructionAsync({
      payer: feePayer,
      mint,
      owner,
    });

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([createAtaIx], tx)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });

    return ataAddress;
  }

  // Helper: Mint tokens
  async function mintTokens(feePayer: any, mint: Address, destination: Address, amount: bigint) {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const mintToIx = getMintToInstruction({
      mint,
      token: destination,
      mintAuthority: feePayer,
      amount,
    });

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions([mintToIx], tx)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });
  }

  // Helper: Transfer tokens (using Anchor Transaction for reliability)
  async function transferTokens(source: Address, destination: Address, amount: bigint) {
    // Import legacy spl-token for transfer
    const { createTransferCheckedInstruction } = await import("@solana/spl-token");

    const sourcePubkey = toPublicKey(source);
    const destPubkey = toPublicKey(destination);

    const transferIx = createTransferCheckedInstruction(
      sourcePubkey,      // source
      toPublicKey(mintAddress),  // mint
      destPubkey,        // destination
      provider.wallet.publicKey, // owner
      amount,            // amount
      6                  // decimals
    );

    const tx = new anchor.web3.Transaction().add(transferIx);
    await provider.sendAndConfirm(tx);
  }

  // Helper: Get token balance using @solana/kit RPC API
  async function getTokenBalance(tokenAccount: Address): Promise<bigint> {
    const response = await rpc.getTokenAccountBalance(tokenAccount).send();
    return BigInt(response.value.amount);
  }

  // Helper: Convert Address to Anchor PublicKey
  function toPublicKey(addr: Address): anchor.web3.PublicKey {
    return new anchor.web3.PublicKey(addr);
  }

  // Helper: Convert Anchor PublicKey to Address
  function toAddress(pubkey: anchor.web3.PublicKey): Address {
    return address(pubkey.toBase58());
  }

  before(async () => {
    console.log("\n🔧 Setting up test environment...\n");

    // Convert Anchor wallet to @solana/kit signer
    // The Anchor provider wallet already has SOL from deployment
    const anchorWallet = provider.wallet as anchor.Wallet;
    const keypairBytes = anchorWallet.payer.secretKey;
    feePayer = await createKeyPairSignerFromBytes(keypairBytes);
    console.log(`Using deployer wallet: ${feePayer.address}`);

    // Create test token mint
    console.log("\nCreating test token mint...");
    mintAddress = await createMint(feePayer, 6);
    console.log(`✓ Mint created: ${mintAddress}`);

    // Create recipient keypairs (they don't need SOL, just receive tokens)
    recipient1Signer = await generateKeyPairSigner();
    recipient2Signer = await generateKeyPairSigner();
    console.log(`\n✓ Recipient 1: ${recipient1Signer.address}`);
    console.log(`✓ Recipient 2: ${recipient2Signer.address}`);

    // Create recipient ATAs
    console.log("\nCreating recipient token accounts...");
    recipient1AtaAddress = await createATA(feePayer, mintAddress, recipient1Signer.address);
    recipient2AtaAddress = await createATA(feePayer, mintAddress, recipient2Signer.address);
    console.log(`✓ Recipient 1 ATA: ${recipient1AtaAddress}`);
    console.log(`✓ Recipient 2 ATA: ${recipient2AtaAddress}`);

    // Create protocol wallet ATA
    protocolAtaAddress = await createATA(feePayer, mintAddress, PROTOCOL_WALLET);
    console.log(`✓ Protocol ATA: ${protocolAtaAddress}`);

    // Derive split config PDA (using Anchor)
    const authorityPubkey = provider.wallet.publicKey;
    const mintPubkey = toPublicKey(mintAddress);

    [splitConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("split_config"),
        authorityPubkey.toBuffer(),
        mintPubkey.toBuffer(),
      ],
      program.programId
    );
    console.log(`✓ Split Config PDA: ${splitConfigPda.toBase58()}`);

    // Derive vault ATA
    [vaultAtaAddress] = await findAssociatedTokenPda({
      mint: mintAddress,
      owner: toAddress(splitConfigPda),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    console.log(`✓ Vault ATA: ${vaultAtaAddress}`);

    console.log("\n✅ Test environment setup complete!\n");
  });

  it("Test 1: Create split configuration", async () => {
    console.log("🧪 Test 1: Creating split configuration...\n");

    const recipients = [
      {
        address: toPublicKey(recipient1Signer.address),
        percentageBps: 4950, // 49.5%
      },
      {
        address: toPublicKey(recipient2Signer.address),
        percentageBps: 4950, // 49.5%
      },
    ];

    console.log("Recipients configuration:");
    console.log(`  - Recipient 1: 49.5% (4950 bps)`);
    console.log(`  - Recipient 2: 49.5% (4950 bps)`);
    console.log(`  - Total: 99% (9900 bps) ✓`);
    console.log(`  - Protocol will receive: 1% + dust\n`);

    try {
      const tx = await program.methods
        .createSplitConfig(toPublicKey(mintAddress), recipients)
        .accounts({
          splitConfig: splitConfigPda,
          vault: toPublicKey(vaultAtaAddress),
          mint: toPublicKey(mintAddress),
          authority: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: toPublicKey(recipient1AtaAddress), isSigner: false, isWritable: false },
          { pubkey: toPublicKey(recipient2AtaAddress), isSigner: false, isWritable: false },
        ])
        .rpc();

      console.log(`✅ Split configuration created!`);
      console.log(`   Transaction: ${tx}\n`);

      // Verify split config account
      const config = await program.account.splitConfig.fetch(splitConfigPda);
      assert.equal(config.authority.toBase58(), provider.wallet.publicKey.toBase58());
      assert.equal(config.mint.toBase58(), toPublicKey(mintAddress).toBase58());
      assert.equal(config.vault.toBase58(), toPublicKey(vaultAtaAddress).toBase58());
      assert.equal(config.recipients.length, 2);
      assert.equal(config.version, 1);
      console.log("✓ Split config account verified");
      console.log(`  - Authority: ${config.authority.toBase58()}`);
      console.log(`  - Mint: ${config.mint.toBase58()}`);
      console.log(`  - Vault: ${config.vault.toBase58()}`);
      console.log(`  - Recipients: ${config.recipients.length}`);
      console.log(`  - Version: ${config.version}\n`);
    } catch (error) {
      console.error("❌ Test 1 failed:", error);
      throw error;
    }
  });

  it("Test 2: Fund vault and execute split", async () => {
    console.log("🧪 Test 2: Funding vault and executing split...\n");

    const amount = 1_000_000_000n; // 1000 tokens (with 6 decimals)

    // Use the same fee payer from setup (deployer wallet)
    const authorityAddress = toAddress(provider.wallet.publicKey);
    let authorityAta: Address;
    try {
      [authorityAta] = await findAssociatedTokenPda({
        mint: mintAddress,
        owner: authorityAddress,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await fetchToken(rpc, authorityAta);
    } catch {
      authorityAta = await createATA(feePayer, mintAddress, authorityAddress);
    }

    // Mint tokens to authority
    console.log(`Minting 1000 tokens to authority...`);
    await mintTokens(feePayer, mintAddress, authorityAta, amount);
    console.log("✓ Tokens minted\n");

    // Transfer tokens to vault
    console.log("Transferring tokens to vault...");
    await transferTokens(authorityAta, vaultAtaAddress, amount);
    console.log("✓ Tokens transferred to vault\n");

    // Check vault balance
    const vaultBefore = await getTokenBalance(vaultAtaAddress);
    console.log(`Vault balance before: ${vaultBefore} tokens\n`);

    // Execute split
    console.log("Executing split (permissionless)...");
    try {
      const tx = await program.methods
        .executeSplit()
        .accounts({
          splitConfig: splitConfigPda,
          vault: toPublicKey(vaultAtaAddress),
          mint: toPublicKey(mintAddress),
          protocolFeeRecipient: toPublicKey(protocolAtaAddress),
          executor: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: toPublicKey(recipient1AtaAddress), isSigner: false, isWritable: true },
          { pubkey: toPublicKey(recipient2AtaAddress), isSigner: false, isWritable: true },
        ])
        .rpc();

      console.log(`✅ Split executed!`);
      console.log(`   Transaction: ${tx}\n`);
    } catch (error) {
      console.error("❌ Split execution failed:", error);
      throw error;
    }

    // Verify balances
    console.log("Verifying token distribution...");
    const recipient1Balance = await getTokenBalance(recipient1AtaAddress);
    const recipient2Balance = await getTokenBalance(recipient2AtaAddress);
    const protocolBalance = await getTokenBalance(protocolAtaAddress);
    const vaultAfter = await getTokenBalance(vaultAtaAddress);

    console.log(`\n📊 Distribution Results:`);
    console.log(`  - Recipient 1: ${recipient1Balance} tokens (expected: ~495,000,000)`);
    console.log(`  - Recipient 2: ${recipient2Balance} tokens (expected: ~495,000,000)`);
    console.log(`  - Protocol: ${protocolBalance} tokens (expected: ~10,000,000 + dust)`);
    console.log(`  - Vault remaining: ${vaultAfter} tokens (expected: 0)\n`);

    // Assertions
    assert.equal(Number(vaultAfter), 0, "Vault should be empty");
    assert.isAbove(Number(recipient1Balance), 490_000_000, "Recipient 1 should receive ~49.5%");
    assert.isAbove(Number(recipient2Balance), 490_000_000, "Recipient 2 should receive ~49.5%");
    assert.isAbove(Number(protocolBalance), 9_000_000, "Protocol should receive ~1%");

    console.log("✅ All balances verified correctly!\n");
  });

  it("Test 3: View final state", async () => {
    console.log("🧪 Test 3: Final state verification...\n");

    const config = await program.account.splitConfig.fetch(splitConfigPda);
    const r1Final = await getTokenBalance(recipient1AtaAddress);
    const r2Final = await getTokenBalance(recipient2AtaAddress);
    const protocolFinal = await getTokenBalance(protocolAtaAddress);
    const vaultFinal = await getTokenBalance(vaultAtaAddress);

    console.log("📊 Final State:");
    console.log(`\nSplit Configuration:`);
    console.log(`  - PDA: ${splitConfigPda.toBase58()}`);
    console.log(`  - Authority: ${config.authority.toBase58()}`);
    console.log(`  - Mint: ${config.mint.toBase58()}`);
    console.log(`  - Vault: ${config.vault.toBase58()}`);
    console.log(`  - Recipients: ${config.recipients.length}`);
    console.log(`  - Unclaimed entries: ${config.unclaimedAmounts.length}`);

    console.log(`\nFinal Balances:`);
    console.log(`  - Recipient 1: ${r1Final} tokens`);
    console.log(`  - Recipient 2: ${r2Final} tokens`);
    console.log(`  - Protocol: ${protocolFinal} tokens`);
    console.log(`  - Vault: ${vaultFinal} tokens (should be 0)\n`);

    const total = Number(r1Final) + Number(r2Final) + Number(protocolFinal);
    console.log(`Total distributed: ${total} tokens`);
    console.log(`Expected: 1,000,000,000 tokens\n`);

    assert.equal(Number(vaultFinal), 0, "Vault should be empty");
    assert.equal(config.unclaimedAmounts.length, 0, "No unclaimed funds expected");

    console.log("✅ All tests passed successfully!\n");
  });
});
