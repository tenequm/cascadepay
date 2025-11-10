import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Cascadepay } from "../target/types/cascadepay";
import { assert } from "chai";

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
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
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

  // Convert modern Address constants to Anchor PublicKey for .accounts() calls
  const TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(TOKEN_PROGRAM_ADDRESS);
  const ASSOCIATED_TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS
  );

  // Modern Solana RPC clients
  const rpcUrl = provider.connection.rpcEndpoint;
  const wsUrl = rpcUrl
    .replace("https://", "wss://")
    .replace("http://", "ws://");
  const rpc = createSolanaRpc(rpcUrl);

  // Create these lazily to avoid WebSocket connection issues during module load
  let rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;
  let airdrop: ReturnType<typeof airdropFactory>;
  let sendAndConfirmTransaction: ReturnType<
    typeof sendAndConfirmTransactionFactory
  >;

  function ensureRpcSubscriptions() {
    if (!rpcSubscriptions) {
      rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
      airdrop = airdropFactory({ rpc, rpcSubscriptions });
      sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
        rpc,
        rpcSubscriptions,
      });
    }
    return { rpcSubscriptions, airdrop, sendAndConfirmTransaction };
  }

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

  const PROTOCOL_WALLET = address(
    "2zMEvEkyQKTRjiGkwYPXjPsJUp8eR1rVjoYQ7PzVVZnP"
  );

  // Helper: Create mint with modern API
  async function createMint(feePayer: any, decimals: number): Promise<Address> {
    const mint = await generateKeyPairSigner();

    const space = BigInt(getMintSize());
    const rentResponse = await rpc
      .getMinimumBalanceForRentExemption(space)
      .send();
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
      (tx) =>
        appendTransactionMessageInstructions(
          [createAccountIx, initializeMintIx],
          tx
        )
    );

    const signedTransaction = await signTransactionMessageWithSigners(
      transactionMessage
    );
    const { sendAndConfirmTransaction: confirmTx } = ensureRpcSubscriptions();
    await confirmTx(signedTransaction, { commitment: "confirmed" });

    return mint.address;
  }

  // Helper: Create ATA
  async function createATA(
    feePayer: any,
    mint: Address,
    owner: Address
  ): Promise<Address> {
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

    const signedTransaction = await signTransactionMessageWithSigners(
      transactionMessage
    );
    const { sendAndConfirmTransaction: confirmTx } = ensureRpcSubscriptions();
    await confirmTx(signedTransaction, { commitment: "confirmed" });

    return ataAddress;
  }

  // Helper: Mint tokens
  async function mintTokens(
    feePayer: any,
    mint: Address,
    destination: Address,
    amount: bigint
  ) {
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

    const signedTransaction = await signTransactionMessageWithSigners(
      transactionMessage
    );
    const { sendAndConfirmTransaction: confirmTx } = ensureRpcSubscriptions();
    await confirmTx(signedTransaction, { commitment: "confirmed" });
  }

  // Helper: Transfer tokens using modern @solana-program/token
  async function transferTokens(
    source: Address,
    destination: Address,
    amount: bigint
  ) {
    const transferIxKit = getTransferInstruction({
      source,
      destination,
      authority: toAddress(provider.wallet.publicKey),
      amount,
    });

    // Convert Kit instruction to Anchor TransactionInstruction
    const transferIx = new anchor.web3.TransactionInstruction({
      keys: transferIxKit.accounts.map((acc) => ({
        pubkey: toPublicKey(acc.address),
        isSigner: acc.role === 2 || acc.role === 3,
        isWritable: acc.role === 1 || acc.role === 3,
      })),
      programId: toPublicKey(transferIxKit.programAddress),
      data: Buffer.from(transferIxKit.data),
    });

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
    recipient1AtaAddress = await createATA(
      feePayer,
      mintAddress,
      recipient1Signer.address
    );
    recipient2AtaAddress = await createATA(
      feePayer,
      mintAddress,
      recipient2Signer.address
    );
    console.log(`✓ Recipient 1 ATA: ${recipient1AtaAddress}`);
    console.log(`✓ Recipient 2 ATA: ${recipient2AtaAddress}`);

    // Create protocol wallet ATA
    protocolAtaAddress = await createATA(
      feePayer,
      mintAddress,
      PROTOCOL_WALLET
    );
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
          {
            pubkey: toPublicKey(recipient1AtaAddress),
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: toPublicKey(recipient2AtaAddress),
            isSigner: false,
            isWritable: false,
          },
        ])
        .rpc();

      console.log(`✅ Split configuration created!`);
      console.log(`   Transaction: ${tx}\n`);

      // Verify split config account
      const config = await program.account.splitConfig.fetch(splitConfigPda);
      assert.equal(
        config.authority.toBase58(),
        provider.wallet.publicKey.toBase58()
      );
      assert.equal(config.mint.toBase58(), toPublicKey(mintAddress).toBase58());
      assert.equal(
        config.vault.toBase58(),
        toPublicKey(vaultAtaAddress).toBase58()
      );
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
          executor: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          {
            pubkey: toPublicKey(recipient1AtaAddress),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: toPublicKey(recipient2AtaAddress),
            isSigner: false,
            isWritable: true,
          },
          // Protocol ATA as LAST remaining account
          {
            pubkey: toPublicKey(protocolAtaAddress),
            isSigner: false,
            isWritable: true,
          },
        ])
        .rpc();

      console.log(`✅ Split executed!`);
      console.log(`   Transaction: ${tx}\n`);
    } catch (error) {
      console.error("❌ Split execution failed:", error);
      throw error;
    }

    // Wait for balance updates to propagate
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify balances
    console.log("Verifying token distribution...");
    const recipient1Balance = await getTokenBalance(recipient1AtaAddress);
    const recipient2Balance = await getTokenBalance(recipient2AtaAddress);
    const protocolBalance = await getTokenBalance(protocolAtaAddress);
    const vaultAfter = await getTokenBalance(vaultAtaAddress);

    console.log(`\n📊 Distribution Results:`);
    console.log(
      `  - Recipient 1: ${recipient1Balance} tokens (expected: ~495,000,000)`
    );
    console.log(
      `  - Recipient 2: ${recipient2Balance} tokens (expected: ~495,000,000)`
    );
    console.log(
      `  - Protocol: ${protocolBalance} tokens (expected: ~10,000,000 + dust)`
    );
    console.log(`  - Vault remaining: ${vaultAfter} tokens (expected: 0)\n`);

    // Assertions
    assert.equal(Number(vaultAfter), 0, "Vault should be empty");
    assert.isAbove(
      Number(recipient1Balance),
      490_000_000,
      "Recipient 1 should receive ~49.5%"
    );
    assert.isAbove(
      Number(recipient2Balance),
      490_000_000,
      "Recipient 2 should receive ~49.5%"
    );
    assert.isAbove(
      Number(protocolBalance),
      9_000_000,
      "Protocol should receive ~1%"
    );

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
    assert.equal(
      config.unclaimedAmounts.length,
      0,
      "No unclaimed funds expected"
    );

    console.log("✅ All tests passed successfully!\n");
  });

  it("Test 4: Build execute split instruction (SDK)", async () => {
    console.log("🧪 Test 4: Testing buildExecuteSplitInstruction()...\n");

    // Import SDK
    const { createCascadepayClient } = await import("../sdk/dist/index.mjs");

    // Load IDL
    const idl = program.idl;
    const sdk = await createCascadepayClient(
      provider.connection,
      provider.wallet as anchor.Wallet,
      idl
    );

    console.log("Building execute split instruction...");
    const instruction = await sdk.buildExecuteSplitInstruction(
      splitConfigPda,
      provider.wallet.publicKey
    );

    console.log("\n📋 Instruction Details:");
    console.log(`  - Program ID: ${instruction.programId.toString()}`);
    console.log(`  - Accounts: ${instruction.keys.length}`);
    console.log(`  - Data length: ${instruction.data.length} bytes`);

    // Verify instruction structure
    assert.equal(
      instruction.programId.toString(),
      program.programId.toString(),
      "Program ID should match"
    );
    assert.isAbove(instruction.keys.length, 0, "Should have accounts");
    assert.isAbove(instruction.data.length, 0, "Should have instruction data");

    console.log("\n✅ buildExecuteSplitInstruction() works correctly!\n");
  });

  it("Test 5: Atomic bundled transaction (CRITICAL)", async () => {
    console.log("🧪 Test 5: Testing atomic bundled transaction...\n");
    console.log("This is THE KEY TEST for facilitator integration!\n");

    // Import SDK
    const { createCascadepayClient } = await import("../sdk/dist/index.mjs");

    const idl = program.idl;
    const sdk = await createCascadepayClient(
      provider.connection,
      provider.wallet as anchor.Wallet,
      idl
    );

    // Fund authority with more tokens for this test
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

    const testAmount = 500_000_000n; // 500 tokens
    console.log(`Minting ${testAmount} tokens for bundled test...`);
    await mintTokens(feePayer, mintAddress, authorityAta, testAmount);
    console.log("✓ Tokens minted\n");

    // Get balances before
    const r1Before = await getTokenBalance(recipient1AtaAddress);
    const r2Before = await getTokenBalance(recipient2AtaAddress);
    const protocolBefore = await getTokenBalance(protocolAtaAddress);

    console.log("Balances before bundled transaction:");
    console.log(`  - Recipient 1: ${r1Before}`);
    console.log(`  - Recipient 2: ${r2Before}`);
    console.log(`  - Protocol: ${protocolBefore}\n`);

    // Build bundled transaction
    console.log("🎯 Building bundled transaction...");
    const bundledTx = await sdk.buildBundledTransaction(
      splitConfigPda,
      testAmount,
      provider.wallet.publicKey
    );

    console.log("Bundled transaction created!");
    console.log(`  - Instructions: ${bundledTx.instructions.length}`);
    assert.equal(
      bundledTx.instructions.length,
      2,
      "Should have exactly 2 instructions"
    );
    console.log("  - Instruction 1: Transfer tokens to vault");
    console.log("  - Instruction 2: Execute split distribution\n");

    // Set recent blockhash and send
    console.log("Sending bundled transaction (atomic execution)...");
    bundledTx.recentBlockhash = (
      await provider.connection.getLatestBlockhash()
    ).blockhash;
    bundledTx.feePayer = provider.wallet.publicKey;

    const signature = await provider.sendAndConfirm(bundledTx);
    console.log(`✅ Bundled transaction confirmed!`);
    console.log(`   Signature: ${signature}\n`);

    // Verify balances after
    console.log("Verifying atomic execution results...");
    const r1After = await getTokenBalance(recipient1AtaAddress);
    const r2After = await getTokenBalance(recipient2AtaAddress);
    const protocolAfter = await getTokenBalance(protocolAtaAddress);
    const vaultAfter = await getTokenBalance(vaultAtaAddress);

    const r1Received = Number(r1After) - Number(r1Before);
    const r2Received = Number(r2After) - Number(r2Before);
    const protocolReceived = Number(protocolAfter) - Number(protocolBefore);

    console.log("\n📊 Atomic Distribution Results:");
    console.log(
      `  - Recipient 1 received: ${r1Received} tokens (~247.5M expected)`
    );
    console.log(
      `  - Recipient 2 received: ${r2Received} tokens (~247.5M expected)`
    );
    console.log(
      `  - Protocol received: ${protocolReceived} tokens (~5M + dust expected)`
    );
    console.log(`  - Vault remaining: ${vaultAfter} (should be 0)\n`);

    // Assertions
    assert.equal(Number(vaultAfter), 0, "Vault should be completely drained");
    assert.isAbove(
      r1Received,
      240_000_000,
      "Recipient 1 should receive ~49.5%"
    );
    assert.isAbove(
      r2Received,
      240_000_000,
      "Recipient 2 should receive ~49.5%"
    );
    assert.isAbove(protocolReceived, 4_000_000, "Protocol should receive ~1%");

    const totalDistributed = r1Received + r2Received + protocolReceived;
    assert.equal(
      totalDistributed,
      Number(testAmount),
      "Total should match input amount"
    );

    console.log("✅ ATOMIC BUNDLING WORKS!");
    console.log("   Both transfer and split executed in ONE transaction\n");
  });

  it("Test 6: Build claim unclaimed instruction (SDK)", async () => {
    console.log("🧪 Test 6: Testing buildClaimUnclaimedInstruction()...\n");

    const { createCascadepayClient } = await import("../sdk/dist/index.mjs");

    const idl = program.idl;
    const sdk = await createCascadepayClient(
      provider.connection,
      provider.wallet as anchor.Wallet,
      idl
    );

    console.log("Building claim unclaimed instruction...");
    const instruction = await sdk.buildClaimUnclaimedInstruction(
      splitConfigPda,
      toPublicKey(recipient1Signer.address)
    );

    console.log("\n📋 Instruction Details:");
    console.log(`  - Program ID: ${instruction.programId.toString()}`);
    console.log(`  - Accounts: ${instruction.keys.length}`);
    console.log(`  - Data length: ${instruction.data.length} bytes`);

    // Verify instruction structure
    assert.equal(
      instruction.programId.toString(),
      program.programId.toString(),
      "Program ID should match"
    );
    assert.isAbove(instruction.keys.length, 0, "Should have accounts");
    assert.isAbove(instruction.data.length, 0, "Should have instruction data");

    console.log("\n✅ buildClaimUnclaimedInstruction() works correctly!\n");
  });

  it("Test 7: Final verification - All SDK methods", async () => {
    console.log("🧪 Test 7: Final SDK verification...\n");

    const { createCascadepayClient } = await import("../sdk/dist/index.mjs");

    const idl = program.idl;
    const sdk = await createCascadepayClient(
      provider.connection,
      provider.wallet as anchor.Wallet,
      idl
    );

    // Test getSplitConfig
    console.log("Testing getSplitConfig()...");
    const config = await sdk.getSplitConfig(splitConfigPda);
    assert.equal(config.recipients.length, 2, "Should have 2 recipients");
    assert.equal(config.version, 1, "Version should be 1");
    console.log("✓ getSplitConfig() works\n");

    // Test deriveSplitConfigPDA
    console.log("Testing deriveSplitConfigPDA()...");
    const derivedPDA = sdk.deriveSplitConfigPDA(
      provider.wallet.publicKey,
      toPublicKey(mintAddress)
    );
    assert.equal(
      derivedPDA.toString(),
      splitConfigPda.toString(),
      "Derived PDA should match"
    );
    console.log("✓ deriveSplitConfigPDA() works\n");

    // Test percentagesToShares
    console.log("Testing percentagesToShares()...");
    const { Cascadepay } = await import("../sdk/dist/index.mjs");
    const shares = Cascadepay.percentagesToShares([49.5, 49.5]);
    assert.equal(shares[0], 4950, "First share should be 4950 bps");
    assert.equal(shares[1], 4950, "Second share should be 4950 bps");
    console.log("✓ percentagesToShares() works\n");

    console.log("✅ All SDK methods verified!\n");
    console.log("🎉 TRANSACTION BUNDLING FULLY TESTED AND WORKING!\n");
  });

  it("Test 8: Security - Reject malicious protocol ATA", async () => {
    console.log(
      "\n🔒 Testing security: Malicious protocol ATA should be rejected\n"
    );

    // Create attacker's ATA for the same mint
    const attackerKeypair = await generateKeyPairSigner();
    const attackerAddress = address(attackerKeypair.address);
    console.log(`Attacker address: ${attackerAddress}`);

    const attackerAta = await createATA(feePayer, mintAddress, attackerAddress);
    console.log(`Attacker ATA: ${attackerAta}`);
    console.log(`Legitimate protocol ATA: ${protocolAtaAddress}\n`);

    // Fund vault
    console.log("Funding vault with 1,000,000 tokens...");
    await mintTokens(feePayer, mintAddress, vaultAtaAddress, 1000000n);
    console.log("✓ Vault funded\n");

    // Try to execute split with WRONG protocol ATA (attacker's ATA)
    console.log("Attempting to execute split with malicious protocol ATA...");
    try {
      await program.methods
        .executeSplit()
        .accounts({
          splitConfig: splitConfigPda,
          vault: toPublicKey(vaultAtaAddress),
          mint: toPublicKey(mintAddress),
          executor: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          {
            pubkey: toPublicKey(recipient1AtaAddress),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: toPublicKey(recipient2AtaAddress),
            isSigner: false,
            isWritable: true,
          },
          // MALICIOUS: Pass attacker's ATA instead of protocol ATA
          {
            pubkey: toPublicKey(attackerAta),
            isSigner: false,
            isWritable: true,
          },
        ])
        .rpc();

      // If we reach here, the test failed
      assert.fail("❌ SECURITY FAILURE: Malicious protocol ATA was accepted!");
    } catch (error) {
      // Verify it's the correct error
      const errorString = error.toString();
      console.log(`Error received: ${errorString}\n`);

      assert.ok(
        errorString.includes("InvalidProtocolFeeRecipient"),
        `Expected InvalidProtocolFeeRecipient error, got: ${errorString}`
      );

      console.log(
        "✅ Security test passed: Malicious protocol ATA correctly rejected!"
      );
      console.log("🔒 Protocol fees are secure - cannot be stolen!\n");
    }

    // Verify attacker ATA balance is still 0
    const attackerBalance = await getTokenBalance(attackerAta);
    assert.equal(attackerBalance, 0, "Attacker should have received 0 tokens");
    console.log("✓ Attacker balance: 0 tokens (no theft occurred)\n");
  });

  it("Test 9: Protocol ATA missing - graceful degradation", async () => {
    console.log("\n🧪 Test 9: Protocol ATA doesn't exist - graceful handling\n");

    // Create a NEW token mint (fresh token without protocol ATA)
    console.log("Creating new test token...");
    const newMintAddress = await createMint(feePayer, 6);
    console.log(`✓ New mint created: ${newMintAddress}\n`);

    // Create recipient ATAs for new token
    console.log("Creating recipient ATAs for new token...");
    const newR1Ata = await createATA(
      feePayer,
      newMintAddress,
      recipient1Signer.address
    );
    const newR2Ata = await createATA(
      feePayer,
      newMintAddress,
      recipient2Signer.address
    );
    console.log(`✓ Recipient ATAs created\n`);

    // Create split config for new token
    console.log("Creating split config for new token...");
    const recipients = [
      {
        address: toPublicKey(recipient1Signer.address),
        percentageBps: 4950,
      },
      {
        address: toPublicKey(recipient2Signer.address),
        percentageBps: 4950,
      },
    ];

    const newMintPubkey = toPublicKey(newMintAddress);
    const [newConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("split_config"),
        provider.wallet.publicKey.toBuffer(),
        newMintPubkey.toBuffer(),
      ],
      program.programId
    );

    const [newVaultAta] = await findAssociatedTokenPda({
      mint: newMintAddress,
      owner: toAddress(newConfigPda),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    await program.methods
      .createSplitConfig(newMintPubkey, recipients)
      .accounts({
        splitConfig: newConfigPda,
        vault: toPublicKey(newVaultAta),
        mint: newMintPubkey,
        authority: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: toPublicKey(newR1Ata),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: toPublicKey(newR2Ata),
          isSigner: false,
          isWritable: false,
        },
      ])
      .rpc();
    console.log("✓ Split config created\n");

    // Derive protocol ATA address (but DON'T create it yet)
    const [newProtocolAta] = await findAssociatedTokenPda({
      mint: newMintAddress,
      owner: PROTOCOL_WALLET,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    console.log(`Protocol ATA address: ${newProtocolAta}`);
    console.log("⚠️  Protocol ATA does NOT exist yet\n");

    // Fund vault
    console.log("Funding vault with 1,000 tokens...");
    await mintTokens(feePayer, newMintAddress, newVaultAta, 1000000000n);
    const vaultBefore = await getTokenBalance(newVaultAta);
    console.log(`✓ Vault funded: ${vaultBefore} tokens\n`);

    // Execute split WITHOUT protocol ATA existing
    console.log(
      "Executing split (protocol ATA doesn't exist - should be graceful)..."
    );
    await program.methods
      .executeSplit()
      .accounts({
        splitConfig: newConfigPda,
        vault: toPublicKey(newVaultAta),
        mint: newMintPubkey,
        executor: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        {
          pubkey: toPublicKey(newR1Ata),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: toPublicKey(newR2Ata),
          isSigner: false,
          isWritable: true,
        },
        // Pass non-existent protocol ATA
        {
          pubkey: toPublicKey(newProtocolAta),
          isSigner: false,
          isWritable: true,
        },
      ])
      .rpc();
    console.log("✅ Split executed successfully (graceful degradation)\n");

    // Wait for balance updates
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify balances
    const r1Balance = await getTokenBalance(newR1Ata);
    const r2Balance = await getTokenBalance(newR2Ata);
    const vaultAfter = await getTokenBalance(newVaultAta);

    console.log("📊 Results after first split:");
    console.log(`  - Recipient 1: ${r1Balance} tokens (expected: ~495M)`);
    console.log(`  - Recipient 2: ${r2Balance} tokens (expected: ~495M)`);
    console.log(`  - Vault: ${vaultAfter} tokens (expected: ~10M protocol fee)`);

    // Assertions: recipients got their shares
    assert.isAbove(
      Number(r1Balance),
      490_000_000,
      "Recipient 1 should receive ~49.5%"
    );
    assert.isAbove(
      Number(r2Balance),
      490_000_000,
      "Recipient 2 should receive ~49.5%"
    );
    // Protocol fee should remain in vault
    assert.isAbove(
      Number(vaultAfter),
      9_000_000,
      "Protocol fee should remain in vault"
    );
    console.log(
      "✅ Recipients received shares, protocol fee stayed in vault\n"
    );

    // Now create the protocol ATA
    console.log("Creating protocol ATA...");
    await createATA(feePayer, newMintAddress, PROTOCOL_WALLET);
    console.log("✓ Protocol ATA created\n");

    // Execute split again - protocol should receive fees now
    console.log("Re-executing split (protocol ATA now exists)...");
    await program.methods
      .executeSplit()
      .accounts({
        splitConfig: newConfigPda,
        vault: toPublicKey(newVaultAta),
        mint: newMintPubkey,
        executor: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        {
          pubkey: toPublicKey(newR1Ata),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: toPublicKey(newR2Ata),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: toPublicKey(newProtocolAta),
          isSigner: false,
          isWritable: true,
        },
      ])
      .rpc();
    console.log("✅ Split executed\n");

    // Wait for balance updates
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify protocol received the accumulated fees
    const protocolBalance = await getTokenBalance(newProtocolAta);
    const vaultFinal = await getTokenBalance(newVaultAta);

    console.log("📊 Final results:");
    console.log(`  - Protocol: ${protocolBalance} tokens`);
    console.log(`  - Vault: ${vaultFinal} tokens (should be 0)\n`);

    // Second split distributes the ~10M that was in vault:
    // 99% goes to recipients again, 1% to protocol
    // So protocol gets ~100K (1% of 10M)
    assert.isAbove(
      Number(protocolBalance),
      90_000,
      "Protocol should have received ~1% of remaining vault"
    );
    assert.equal(Number(vaultFinal), 0, "Vault should be empty");

    console.log(
      "✅ GRACEFUL DEGRADATION WORKS! Protocol claimed fees after ATA creation\n"
    );
  });
});
