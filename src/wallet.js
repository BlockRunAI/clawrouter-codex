import { privateKeyToAccount } from "viem/accounts";

export function walletAddressFromKey(key) {
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key.trim())) {
    throw new Error("wallet key must be a 0x-prefixed 32-byte private key");
  }
  return privateKeyToAccount(key.trim()).address;
}
