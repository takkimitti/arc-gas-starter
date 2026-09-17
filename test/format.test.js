import assert from "node:assert/strict";
import test from "node:test";
import {
  formatNativeUsdc,
  isPositiveBalance,
  shortenAddress,
} from "../src/format.js";
import { ARC_MAINNET } from "../src/config.js";

test("uses the official Arc Mainnet identifiers", () => {
  assert.equal(ARC_MAINNET.chainId, 5042);
  assert.equal(ARC_MAINNET.chainIdHex, "0x13b2");
  assert.equal(ARC_MAINNET.nativeCurrency.decimals, 18);
});

test("shortens a standard EVM address", () =>
  assert.equal(
    shortenAddress("0x867650F5eAe8df91445971f14d89fd84F0C93507"),
    "0x8676...3507",
  ));
test("formats Arc native USDC using 18 decimals", () => {
  assert.equal(formatNativeUsdc("0xde0b6b3a7640000"), "1");
  assert.equal(formatNativeUsdc("0x6a94d74f43000"), "0.001875");
  assert.equal(formatNativeUsdc("0x0"), "0");
});
test("requires a positive native balance for gas readiness", () => {
  assert.equal(isPositiveBalance("0x0"), false);
  assert.equal(isPositiveBalance("0x1"), true);
});
