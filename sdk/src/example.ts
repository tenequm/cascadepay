/**
 * Example usage of cascadepay SDK
 * Demonstrates creating split configurations and executing payment distributions
 */

import * as anchor from "@coral-xyz/anchor";
import { createCascadepayClient, Cascadepay, detectSplitVault } from "./index";
import { readFileSync } from "fs";
import { join } from "path";

// Use Anchor types
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;
type Connection = anchor.web3.Connection;

async function main() {
  console.log("🚀 cascadepay SDK Example\n");

  // Setup
  const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(anchor.web3.Keypair.generate()); // Replace with actual wallet

  // Load program ID and IDL
  const programId = new anchor.web3.PublicKey("Bi1y2G3hteJwbeQk7QAW9Uk7Qq2h9bPbDYhPCKSuE2W2"); // cascadepay devnet
  const idlPath = join(__dirname, "../../target/idl/cascadepay.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf-8"));

  const sdk = await createCascadepayClient(
    connection,
    wallet,
    idl
  );

  console.log("✅ SDK initialized");
  console.log(`   Program ID: ${programId.toString()}`);
  console.log(`   Wallet: ${wallet.publicKey.toString()}\n`);

  // Example mint (Devnet USDC)
  const USDC_MINT = new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

  // ============================================================================
  // Example 1: Create split configuration (99% total for recipients)
  // ============================================================================

  console.log("📝 Example 1: Creating split configuration\n");

  const recipients = [
    { address: new anchor.web3.PublicKey("Alice..."), percentageBps: 5900 }, // 59%
    { address: new anchor.web3.PublicKey("Bob..."), percentageBps: 3000 },   // 30%
    { address: new anchor.web3.PublicKey("Charlie..."), percentageBps: 1000 }, // 10%
  ]; // Total: 9900 bps = 99% (protocol gets 1%)

  console.log("Recipients:");
  recipients.forEach((r, i) => {
    const pct = (r.percentageBps / 100).toFixed(1);
    console.log(`  ${i + 1}. ${r.address.toString().slice(0, 8)}... - ${pct}%`);
  });
  console.log(`  + Protocol: 1%\n`);

  try {
    const configPDA = await sdk.createSplitConfig({
      mint: USDC_MINT,
      recipients,
    });

    console.log("✅ Split config created!");
    console.log(`   PDA: ${configPDA.toString()}\n`);

    // Get vault address (where users send payments)
    const config = await sdk.getSplitConfig(configPDA);
    console.log("📍 Payment destination (vault):");
    console.log(`   ${config.vault.toString()}`);
    console.log("   ⬆️  Give this address to your users\n");

    // ============================================================================
    // Example 2: Execute split (permissionless - anyone can call)
    // ============================================================================

    console.log("📊 Example 2: Executing payment split\n");
    console.log("   Waiting for funds in vault...");
    console.log("   (In production, wait for actual payment before executing)\n");

    // Drains vault and distributes to recipients
    const tx = await sdk.executeSplit(configPDA);
    console.log("✅ Split executed!");
    console.log(`   Transaction: ${tx}\n`);

    // ============================================================================
    // Example 3: Claim unclaimed funds
    // ============================================================================

    console.log("💰 Example 3: Claiming unclaimed funds\n");

    const recipientKeypair = anchor.web3.Keypair.generate(); // Recipient's keypair
    try {
      const claimTx = await sdk.claimUnclaimed(configPDA, recipientKeypair);
      console.log("✅ Unclaimed funds claimed!");
      console.log(`   Transaction: ${claimTx}\n`);
    } catch (error) {
      console.log("ℹ️  No unclaimed funds for this recipient\n");
    }

    // ============================================================================
    // Example 4: x402 Facilitator Integration (PayAI, Coinbase CDP)
    // ============================================================================

    console.log("🔍 Example 4: Auto-detecting split vault\n");

    const paymentDestination = config.vault; // User wants to pay this address

    const detection = await detectSplitVault(
      paymentDestination,
      connection,
      programId
    );

    if (detection.isSplitVault) {
      console.log("✅ Detected cascadepay vault!");
      console.log(`   Split config: ${detection.splitConfig?.toString()}`);
      console.log("\n   💡 Facilitator can now bundle:");
      console.log("      1. Transfer tokens to vault");
      console.log("      2. Execute split distribution");
      console.log("      → User signs once, both happen atomically\n");
    } else {
      console.log("ℹ️  Regular payment address, no split\n");
    }

    // ============================================================================
    // Example 5: Using percentage helper
    // ============================================================================

    console.log("🧮 Example 5: Converting percentages to basis points\n");

    const percentages = [59, 30, 10]; // Must total 99%
    const bpsShares = Cascadepay.percentagesToShares(percentages);

    console.log("Input percentages:", percentages);
    console.log("Output basis points:", bpsShares);
    console.log("   → Use these values in createSplitConfig()\n");

    // ============================================================================
    // Example 6: Update split configuration
    // ============================================================================

    console.log("🔄 Example 6: Updating split configuration\n");

    const newRecipients = [
      { address: new anchor.web3.PublicKey("Alice..."), percentageBps: 4950 }, // 49.5%
      { address: new anchor.web3.PublicKey("Bob..."), percentageBps: 4950 },   // 49.5%
    ]; // Total: 9900 bps = 99%

    try {
      const updateTx = await sdk.updateSplitConfig(configPDA, newRecipients);
      console.log("✅ Split config updated!");
      console.log(`   Transaction: ${updateTx}\n`);
    } catch (error: any) {
      console.log("⚠️  Update failed:", error.message);
      console.log("   (Vault must be empty to update)\n");
    }

    // ============================================================================
    // Example 7: Close split configuration
    // ============================================================================

    console.log("🗑️  Example 7: Closing split configuration\n");

    try {
      const closeTx = await sdk.closeSplitConfig(configPDA);
      console.log("✅ Split config closed!");
      console.log(`   Transaction: ${closeTx}`);
      console.log("   Rent reclaimed to authority\n");
    } catch (error: any) {
      console.log("⚠️  Close failed:", error.message);
      console.log("   (Vault must be empty and no unclaimed funds)\n");
    }

  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
    if (error.logs) {
      console.error("\nProgram logs:");
      error.logs.forEach((log: string) => console.error(`   ${log}`));
    }
  }

  console.log("✨ Example complete!\n");
}

// Run example
if (require.main === module) {
  main().catch(console.error);
}
