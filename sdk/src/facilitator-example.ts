/**
 * Facilitator Integration Example
 *
 * Shows how x402 facilitators (PayAI, Coinbase CDP, etc.) can integrate
 * cascadepay for atomic payment bundling:
 *
 * User flow:
 * 1. User wants to pay a vault address
 * 2. Facilitator detects it's a split vault
 * 3. Facilitator bundles: [transfer to vault, execute split]
 * 4. User signs once → Both execute atomically
 */

import * as anchor from "@coral-xyz/anchor";
import { createCascadepayClient, detectSplitVault } from "./index";
import { readFileSync } from "fs";
import { join } from "path";

// Anchor types
type PublicKey = anchor.web3.PublicKey;
type Connection = anchor.web3.Connection;

/**
 * Simulates a PayAI-style facilitator processing a payment request
 */
async function facilitatorFlow() {
  console.log("🤖 Facilitator Integration Example\n");
  console.log("Simulating PayAI / Coinbase CDP / x402 facilitator\n");

  // Setup connection (facilitator's RPC)
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // Load program info
  const programId = new anchor.web3.PublicKey("Bi1y2G3hteJwbeQk7QAW9Uk7Qq2h9bPbDYhPCKSuE2W2");
  const idlPath = join(__dirname, "../../target/idl/cascadepay.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf-8"));

  // Simulate user wallet
  const userWallet = new anchor.Wallet(anchor.web3.Keypair.generate());

  // Initialize SDK
  const sdk = await createCascadepayClient(connection, userWallet, idl);

  console.log("✅ Facilitator SDK initialized\n");

  // ============================================================================
  // STEP 1: User requests payment
  // ============================================================================

  console.log("📋 STEP 1: User requests payment\n");

  const paymentRequest = {
    destination: new anchor.web3.PublicKey("VAULT_ADDRESS_HERE"), // User wants to pay this
    amount: 5_000_000n, // 5 USDC (6 decimals)
    token: new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), // USDC devnet
  };

  console.log("Payment request:");
  console.log(`  To: ${paymentRequest.destination.toString()}`);
  console.log(`  Amount: ${paymentRequest.amount} (5 USDC)`);
  console.log(`  Token: ${paymentRequest.token.toString()}\n`);

  // ============================================================================
  // STEP 2: Detect if destination is a split vault
  // ============================================================================

  console.log("🔍 STEP 2: Detecting if destination is cascadepay vault\n");

  const detection = await detectSplitVault(
    paymentRequest.destination,
    connection,
    programId
  );

  if (!detection.isSplitVault) {
    console.log("ℹ️  Regular payment address");
    console.log("   → Processing as standard transfer\n");
    // Facilitator would do regular transfer here
    return;
  }

  console.log("✅ Detected cascadepay split vault!");
  console.log(`   Split config PDA: ${detection.splitConfig?.toString()}\n`);

  // ============================================================================
  // STEP 3: Fetch split configuration
  // ============================================================================

  console.log("📊 STEP 3: Fetching split configuration\n");

  if (!detection.splitConfig) {
    throw new Error("Split config not found");
  }

  const splitConfig = await sdk.getSplitConfig(detection.splitConfig);

  console.log("Split configuration:");
  console.log(`  Recipients: ${splitConfig.recipients.length}`);
  splitConfig.recipients.forEach((r, i) => {
    const pct = (r.percentageBps / 100).toFixed(1);
    console.log(`    ${i + 1}. ${r.address.toString().slice(0, 8)}... - ${pct}%`);
  });
  console.log(`  + Protocol: 1.0%`);
  console.log(`  Total: 100%\n`);

  // ============================================================================
  // STEP 4: Build bundled transaction
  // ============================================================================

  console.log("🎯 STEP 4: Building atomic bundled transaction\n");

  const bundledTransaction = await sdk.buildBundledTransaction(
    detection.splitConfig,
    paymentRequest.amount,
    userWallet.publicKey
  );

  console.log("Bundled transaction created!");
  console.log(`  Instructions: ${bundledTransaction.instructions.length}`);
  console.log("  1. Transfer 5 USDC → vault");
  console.log("  2. Execute split distribution");
  console.log("\n  ✨ Atomic execution: Both succeed or both fail\n");

  // ============================================================================
  // STEP 5: Prepare and sign transaction
  // ============================================================================

  console.log("✍️  STEP 5: Preparing transaction for user signature\n");

  // Set recent blockhash and fee payer
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  bundledTransaction.recentBlockhash = blockhash;
  bundledTransaction.feePayer = userWallet.publicKey;

  console.log("Transaction details:");
  console.log(`  Blockhash: ${blockhash.slice(0, 8)}...`);
  console.log(`  Fee payer: ${userWallet.publicKey.toString().slice(0, 8)}...`);
  console.log(`  Last valid block: ${lastValidBlockHeight}\n`);

  // ============================================================================
  // STEP 6: Send transaction
  // ============================================================================

  console.log("📤 STEP 6: Sending bundled transaction\n");

  try {
    // Sign transaction
    await userWallet.signTransaction(bundled Transaction);
    console.log("✅ Transaction signed by user\n");

    // Send transaction
    const serialized = bundledTransaction.serialize();
    const signature = await connection.sendRawTransaction(serialized, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    console.log("🚀 Transaction sent!");
    console.log(`   Signature: ${signature}\n`);

    // Confirm transaction
    console.log("⏳ Waiting for confirmation...\n");
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }

    console.log("✅ TRANSACTION CONFIRMED!\n");
    console.log("Payment flow completed:");
    console.log("  1. ✅ 5 USDC transferred to vault");
    console.log("  2. ✅ Split executed automatically");
    console.log("  3. ✅ Recipients received their shares");
    console.log("  4. ✅ Protocol fee collected\n");

    console.log(`🔗 View on Solana Explorer:`);
    console.log(`   https://explorer.solana.com/tx/${signature}?cluster=devnet\n`);

  } catch (error) {
    const err = error as Error;
    console.error("❌ Transaction failed:", err.message);
    throw error;
  }
}

/**
 * Alternative: Manual instruction building
 *
 * For facilitators that want more control over instruction composition
 */
async function manualInstructionFlow() {
  console.log("\n" + "=".repeat(80));
  console.log("🛠️  Advanced: Manual instruction building\n");

  const connection = new anchor.web3.Connection("https://api.devnet.solana.com");
  const programId = new anchor.web3.PublicKey("Bi1y2G3hteJwbeQk7QAW9Uk7Qq2h9bPbDYhPCKSuE2W2");
  const idlPath = join(__dirname, "../../target/idl/cascadepay.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf-8"));
  const wallet = new anchor.Wallet(anchor.web3.Keypair.generate());
  const sdk = await createCascadepayClient(connection, wallet, idl);

  const splitConfigPDA = new anchor.web3.PublicKey("SPLIT_CONFIG_PDA_HERE");

  // Build just the execute_split instruction
  const executeSplitIx = await sdk.buildExecuteSplitInstruction(
    splitConfigPDA,
    wallet.publicKey // executor
  );

  console.log("Built execute_split instruction:");
  console.log(`  Program: ${executeSplitIx.programId.toString().slice(0, 8)}...`);
  console.log(`  Accounts: ${executeSplitIx.keys.length}`);
  console.log(`  Data: ${executeSplitIx.data.length} bytes\n`);

  // Facilitator can now add this to their own transaction
  const customTransaction = new anchor.web3.Transaction();

  // Add facilitator's custom instructions here
  // customTransaction.add(facilitatorInstruction1);
  // customTransaction.add(facilitatorInstruction2);

  // Add split execution
  customTransaction.add(executeSplitIx);

  console.log("Custom transaction built with split execution");
  console.log(`  Total instructions: ${customTransaction.instructions.length}\n`);
}

// Run examples
if (require.main === module) {
  (async () => {
    try {
      await facilitatorFlow();
      await manualInstructionFlow();
      console.log("✨ Facilitator examples complete!\n");
    } catch (error) {
      const err = error as Error;
      console.error("\n❌ Error:", err.message);
      process.exit(1);
    }
  })();
}

export { facilitatorFlow, manualInstructionFlow };
