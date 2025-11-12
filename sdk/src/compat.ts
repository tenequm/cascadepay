/**
 * Compatibility layer for dual-format support
 * Allows SDK to accept both Web3.js/Anchor and @solana/kit formats
 */

import * as anchor from "@coral-xyz/anchor";
import type { Address } from "@solana/kit";

/**
 * Union type - accepts PublicKey, Address (from @solana/kit), or base58 string
 */
export type AddressLike = anchor.web3.PublicKey | Address | string;

/**
 * Union type - accepts Connection instance or RPC URL string
 */
export type ConnectionLike = anchor.web3.Connection | string;

/**
 * Normalize any address-like input to PublicKey
 *
 * @param input - PublicKey instance, Address from @solana/kit, or base58 string
 * @returns Anchor PublicKey instance
 *
 * @example
 * ```typescript
 * // All three work:
 * toPublicKey(new PublicKey("11111..."))
 * toPublicKey(address("11111..."))
 * toPublicKey("11111...")
 * ```
 */
export function toPublicKey(input: AddressLike): anchor.web3.PublicKey {
  if (input instanceof anchor.web3.PublicKey) {
    return input;
  }
  // Both Address (branded string) and plain string work with PublicKey constructor
  return new anchor.web3.PublicKey(input);
}

/**
 * Normalize connection input to Anchor Connection
 *
 * @param input - Connection instance or RPC URL string
 * @returns Anchor Connection instance
 * @throws Error if input is invalid
 *
 * @example
 * ```typescript
 * // Both work:
 * toConnection(new Connection("https://api.mainnet-beta.solana.com"))
 * toConnection("https://api.mainnet-beta.solana.com")
 * ```
 */
export function toConnection(input: ConnectionLike): anchor.web3.Connection {
  if (!input) {
    throw new Error("Connection or RPC URL required");
  }

  if (input instanceof anchor.web3.Connection) {
    return input;
  }

  if (typeof input !== "string") {
    throw new Error(
      "Connection must be Connection instance or RPC URL string"
    );
  }

  // Create Connection from URL string
  return new anchor.web3.Connection(input, "confirmed");
}

/**
 * Normalize array of address-like inputs to PublicKeys
 *
 * @param inputs - Array of address-like inputs
 * @returns Array of PublicKey instances
 */
export function toPublicKeys(inputs: AddressLike[]): anchor.web3.PublicKey[] {
  return inputs.map(toPublicKey);
}
