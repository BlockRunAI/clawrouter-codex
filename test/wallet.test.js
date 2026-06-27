import test from "node:test";
import assert from "node:assert/strict";
import { walletAddressFromKey } from "../src/wallet.js";

test("walletAddressFromKey derives the EVM funding address", () => {
  assert.equal(
    walletAddressFromKey("0x0000000000000000000000000000000000000000000000000000000000000001"),
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  );
});

test("walletAddressFromKey rejects invalid keys", () => {
  assert.throws(() => walletAddressFromKey("not-a-key"), /0x-prefixed 32-byte private key/);
});
