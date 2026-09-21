process.env.ENCRYPTION_KEY = "test-key-for-crypto-tests";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { encrypt, decrypt } from "../core/crypto-utils.ts";

function flipHexChar(hex: string): string {
  const first = hex[0];
  const replacement = first === "0" ? "1" : "0";
  return replacement + hex.slice(1);
}

describe("crypto decrypt failure semantics", () => {
  it("decrypt returns empty string for empty input", () => {
    assert.equal(decrypt(""), "");
  });

  it("decrypt returns plaintext for non-encrypted value (no colon)", () => {
    assert.equal(decrypt("not-encrypted-value"), "not-encrypted-value");
  });

  it("decrypt returns plaintext for value with wrong part count", () => {
    assert.equal(decrypt("aa:bb"), "aa:bb");
    assert.equal(decrypt("aa:bb:cc:dd"), "aa:bb:cc:dd");
  });

  it("encrypt then decrypt roundtrip returns original", () => {
    const original = "sk-secret-api-key-12345";
    const encrypted = encrypt(original);
    assert.notEqual(encrypted, original);
    assert.equal(decrypt(encrypted), original);
  });

  it("decrypt throws on corrupted ciphertext", () => {
    const encrypted = encrypt("corrupt-me-payload");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const corrupted = `${iv}:${authTag}:${flipHexChar(ciphertext)}`;
    assert.throws(() => decrypt(corrupted));
  });

  it("decrypt throws on wrong auth tag", () => {
    const encrypted = encrypt("tamper-auth-tag-payload");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const corrupted = `${iv}:${flipHexChar(authTag)}:${ciphertext}`;
    assert.throws(() => decrypt(corrupted));
  });

  it("decrypt throws on wrong IV", () => {
    const encrypted = encrypt("tamper-iv-payload");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const corrupted = `${flipHexChar(iv)}:${authTag}:${ciphertext}`;
    assert.throws(() => decrypt(corrupted));
  });
});
