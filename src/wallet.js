// Address derivation — delegated to @blockrun/core so every BlockRun product
// derives addresses the same way. This wrapper keeps the strict throw-on-invalid
// contract the bridge (and its tests) rely on.
import { addressFromKey } from "@blockrun/core";

export function walletAddressFromKey(key) {
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key.trim())) {
    throw new Error("wallet key must be a 0x-prefixed 32-byte private key");
  }
  const address = addressFromKey(key.trim());
  if (!address) throw new Error("wallet key must be a 0x-prefixed 32-byte private key");
  return address;
}
