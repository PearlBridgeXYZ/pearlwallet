// R5 L-b / L-c — copy for an unreadable ETH send record, and for a vault
// transaction that spends more coins than this wallet signs.
//
// L-b before: an unreadable record (fail-closed stand-in, often carrying
// the zero hash) was shown as "Broadcast status unknown" with the zero hash
// and an Etherscan link to it. Now it has its own copy, and no hash or link
// when the hash is the zero hash.
// L-c before: the cosign and pending-tx sign paths showed the raw
// "E_MULTISIG_TOO_MANY_INPUTS".
import { describe, expect, it } from "vitest";
import {
  ETH_UNREADABLE_RECORD_COPY,
  ethUnknownCopy,
  ethUnresolvedMessage,
} from "../src/ui/components/EthBroadcastUnknown";
import { ETH_UNKNOWN_UNREADABLE, ETH_UNKNOWN_ZERO_HASH } from "../src/state/eth-unknown";
import { vaultSignErrorMessage } from "../src/ui/vault-messages";

const H = `0x${"ab".repeat(32)}`;

describe("L-b — an unreadable record has its own copy", () => {
  it("zero hash: the dedicated copy, no hash, no Etherscan link", () => {
    const c = ethUnknownCopy("mainnet", { hash: ETH_UNKNOWN_ZERO_HASH, what: ETH_UNKNOWN_UNREADABLE });
    expect(c.body).toBe("A saved send record from this address could not be read. Check your recent transactions before sending again.");
    expect(c.body).toBe(ETH_UNREADABLE_RECORD_COPY);
    expect(c.hash).toBeNull();
    expect(c.explorerUrl).toBeNull();
    expect(c.title).not.toMatch(/status unknown/i);
    const m = ethUnresolvedMessage("mainnet", ETH_UNKNOWN_ZERO_HASH, ETH_UNKNOWN_UNREADABLE);
    expect(m).toContain(ETH_UNREADABLE_RECORD_COPY);
    expect(m).not.toContain(ETH_UNKNOWN_ZERO_HASH);
    expect(m).not.toMatch(/etherscan/i);
  });

  it("unreadable with the key's hash: the dedicated copy, with that hash and its link", () => {
    const c = ethUnknownCopy("mainnet", { hash: H, what: ETH_UNKNOWN_UNREADABLE });
    expect(c.body).toBe(ETH_UNREADABLE_RECORD_COPY);
    expect(c.hash).toBe(H);
    expect(c.explorerUrl).toContain(H);
  });

  it("a readable status-unknown record keeps its copy, hash and link", () => {
    const c = ethUnknownCopy("sepolia", { hash: H, what: "burn" });
    expect(c.title).toMatch(/Broadcast status unknown/);
    expect(c.body).toContain("The burn may already be on the network");
    expect(c.hash).toBe(H);
    expect(c.explorerUrl).toContain(H);
    expect(ethUnresolvedMessage("mainnet", H, "ETH transfer")).toContain(H);
    expect(ethUnresolvedMessage("mainnet", H)).toMatch(/Etherscan/);
  });

  it("the card renders through ethUnknownCopy (no hard-coded zero-hash link)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/ui/components/EthBroadcastUnknown.tsx", "utf8");
    const card = src.slice(src.indexOf("export default function EthBroadcastUnknown"));
    expect(card).toMatch(/const copy = ethUnknownCopy\(network, state\);/);
    expect(card).toMatch(/\{copy\.hash && copy\.explorerUrl && \(/);
    // The pages pass the refusal's `what` so an unreadable record gets its copy.
    for (const f of ["src/ui/pages/SendETH.tsx", "src/ui/pages/SendWPRL.tsx", "src/ui/pages/bridge-flows.ts"]) {
      expect(fs.readFileSync(f, "utf8"), f).toMatch(/ethUnresolvedMessage\([^)]*, e\.hash, e\.what\)/);
    }
  });
});

describe("L-c — too many vault coins on the cosign / pending-tx sign paths", () => {
  it("names the count, this wallet's per-transaction limit, and what to ask the sender", () => {
    expect(vaultSignErrorMessage(new Error("E_MULTISIG_TOO_MANY_INPUTS: 300"))).toBe(
      "Nothing was signed: this transaction spends 300 vault coins, and this wallet signs at most 256 per vault transaction. Ask the sender to send less, or to combine the vault's coins first.",
    );
  });

  it("an error without a count uses the PSBT's input count, else says 'more than 256'", () => {
    expect(vaultSignErrorMessage(new Error("E_MULTISIG_TOO_MANY_INPUTS"), 270)).toContain("spends 270 vault coins");
    expect(vaultSignErrorMessage(new Error("E_MULTISIG_TOO_MANY_INPUTS"))).toContain("spends more than 256 vault coins");
    expect(vaultSignErrorMessage("E_MULTISIG_TOO_MANY_INPUTS: 257")).toContain("spends 257 vault coins");
  });

  it("any other error: null (the caller shows it as before)", () => {
    expect(vaultSignErrorMessage(new Error("E_MULTISIG_FOREIGN_SIGNER_PRESENT"))).toBeNull();
    expect(vaultSignErrorMessage(new Error("E_TOO_MANY_INPUTS: this send needs 600 coins"))).toBeNull();
  });

  it("both sign paths map the error", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync("src/ui/pages/SignMultisigPsbt.tsx", "utf8")).toMatch(/setError\(vaultSignErrorMessage\(e\) \?\?/);
    expect(fs.readFileSync("src/ui/pages/VaultPendingTxDetail.tsx", "utf8")).toMatch(/setError\(vaultSignErrorMessage\(e, pending\.preview\.inputCount\) \?\?/);
    const worker = fs.readFileSync("src/crypto/worker.ts", "utf8");
    expect(worker.match(/E_MULTISIG_TOO_MANY_INPUTS: \$\{/g)).toHaveLength(2);
  });
});
