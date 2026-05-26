import { describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  decodePayload,
  encodePayload,
  validatePayload,
  type EthSignedPayload,
  type EthUnsignedPayload,
  type PearlSignedPayload,
  type PearlUnsignedPayload,
} from "../src/lib/offline-signing/payload";
import {
  FRAME_CHUNK_BYTES,
  FrameReassembler,
  parseFrame,
  reassembleFrames,
  splitIntoFrames,
} from "../src/lib/offline-signing/qr-frames";
import {
  parseManualUtxos,
  sumManualUtxoValue,
} from "../src/lib/offline-signing/manual-utxo";

// ── Payload roundtrip ────────────────────────────────────────────────────

describe("base64url codec", () => {
  it("roundtrips ASCII", () => {
    const s = "hello world";
    expect(base64urlDecode(base64urlEncode(s))).toBe(s);
  });

  it("roundtrips UTF-8", () => {
    const s = "Pearl → WPRL: 1.5 PRL ✓";
    expect(base64urlDecode(base64urlEncode(s))).toBe(s);
  });

  it("emits url-safe alphabet (no +, /, =)", () => {
    const s = "0".repeat(100) + "{" + "}".repeat(50);
    const enc = base64urlEncode(s);
    expect(enc).not.toMatch(/[+/=]/);
  });

  it("handles empty string", () => {
    expect(base64urlEncode("")).toBe("");
    expect(base64urlDecode("")).toBe("");
  });
});

const VALID_PEARL_UNSIGNED: PearlUnsignedPayload = {
  v: 1,
  k: "pearl-unsigned",
  network: "mainnet",
  utxos: [
    {
      txid: "a".repeat(64),
      vout: 0,
      valueGrains: "100000000",
      scriptHex: "5120" + "b".repeat(64),
      poolIndex: 0,
    },
    {
      txid: "c".repeat(64),
      vout: 1,
      valueGrains: "50000000",
      scriptHex: "5120" + "d".repeat(64),
      poolIndex: 2,
    },
  ],
  outputs: [
    { address: "prl1qexample0000000000000000000000000000000000", amountGrains: "120000000" },
    { address: "prl1qchange00000000000000000000000000000000000", amountGrains: "29800000" },
  ],
  meta: {
    composedAt: 1716000000000,
    summary: "Send 1.2 PRL to prl1q…ample, change to prl1q…hange",
    feeGrains: "200000",
  },
};

const VALID_PEARL_SIGNED: PearlSignedPayload = {
  v: 1,
  k: "pearl-signed",
  network: "mainnet",
  raw: "02000000" + "01".repeat(150),
  txid: "f".repeat(64),
};

const VALID_ETH_UNSIGNED: EthUnsignedPayload = {
  v: 1,
  k: "eth-unsigned",
  chainId: 1,
  nonce: 7,
  to: "0x" + "ab".repeat(20),
  value: "1000000000000000000",
  gas: "21000",
  maxFeePerGas: "30000000000",
  maxPriorityFeePerGas: "1500000000",
  meta: { summary: "Send 1 ETH", from: "0x" + "cd".repeat(20) },
};

const VALID_ETH_SIGNED: EthSignedPayload = {
  v: 1,
  k: "eth-signed",
  chainId: 1,
  raw: "0x" + "02".repeat(120),
};

describe("payload encode/decode roundtrip", () => {
  it("roundtrips a pearl-unsigned payload", () => {
    const enc = encodePayload(VALID_PEARL_UNSIGNED);
    const dec = decodePayload(enc);
    expect(dec).toEqual(VALID_PEARL_UNSIGNED);
  });

  it("roundtrips a pearl-signed payload", () => {
    expect(decodePayload(encodePayload(VALID_PEARL_SIGNED))).toEqual(VALID_PEARL_SIGNED);
  });

  it("roundtrips an eth-unsigned payload", () => {
    expect(decodePayload(encodePayload(VALID_ETH_UNSIGNED))).toEqual(VALID_ETH_UNSIGNED);
  });

  it("roundtrips an eth-signed payload", () => {
    expect(decodePayload(encodePayload(VALID_ETH_SIGNED))).toEqual(VALID_ETH_SIGNED);
  });

  it("normalizes uppercase hex on decode", () => {
    const upper = { ...VALID_PEARL_UNSIGNED, utxos: [{ ...VALID_PEARL_UNSIGNED.utxos[0]!, txid: "A".repeat(64) }] };
    const enc = encodePayload(upper as PearlUnsignedPayload);
    const dec = decodePayload(enc) as PearlUnsignedPayload;
    expect(dec.utxos[0]!.txid).toBe("a".repeat(64));
  });

  it("trims whitespace on decode", () => {
    const enc = encodePayload(VALID_PEARL_SIGNED);
    expect(decodePayload(`   ${enc}\n`)).toEqual(VALID_PEARL_SIGNED);
  });
});

describe("payload validation", () => {
  it("rejects garbage text", () => {
    expect(() => decodePayload("not base64 not json")).toThrow(/E_PAYLOAD_DECODE|E_PAYLOAD_SHAPE/);
  });

  it("rejects wrong version", () => {
    const enc = base64urlEncode(JSON.stringify({ v: 99, k: "pearl-unsigned" }));
    expect(() => decodePayload(enc)).toThrow(/E_PAYLOAD_VERSION/);
  });

  it("rejects unknown kind", () => {
    const enc = base64urlEncode(JSON.stringify({ v: 1, k: "btc-unsigned" }));
    expect(() => decodePayload(enc)).toThrow(/E_PAYLOAD_KIND/);
  });

  it("rejects empty utxos", () => {
    expect(() => validatePayload({ ...VALID_PEARL_UNSIGNED, utxos: [] })).toThrow(/utxos/);
  });

  it("rejects empty outputs", () => {
    expect(() => validatePayload({ ...VALID_PEARL_UNSIGNED, outputs: [] })).toThrow(/outputs/);
  });

  it("rejects malformed txid (not 64 hex)", () => {
    const bad = {
      ...VALID_PEARL_UNSIGNED,
      utxos: [{ ...VALID_PEARL_UNSIGNED.utxos[0]!, txid: "abcd" }],
    };
    expect(() => validatePayload(bad)).toThrow(/txid/);
  });

  it("rejects negative vout", () => {
    const bad = {
      ...VALID_PEARL_UNSIGNED,
      utxos: [{ ...VALID_PEARL_UNSIGNED.utxos[0]!, vout: -1 }],
    };
    expect(() => validatePayload(bad)).toThrow(/vout/);
  });

  it("rejects non-decimal valueGrains", () => {
    const bad = {
      ...VALID_PEARL_UNSIGNED,
      utxos: [{ ...VALID_PEARL_UNSIGNED.utxos[0]!, valueGrains: "1.5" }],
    };
    expect(() => validatePayload(bad)).toThrow(/valueGrains/);
  });

  it("rejects bad eth address", () => {
    expect(() =>
      validatePayload({ ...VALID_ETH_UNSIGNED, to: "0x123" }),
    ).toThrow(/E_PAYLOAD_FIELD: to/);
  });

  it("rejects bad chainId", () => {
    expect(() => validatePayload({ ...VALID_ETH_UNSIGNED, chainId: 0 })).toThrow(/chainId/);
  });

  it("rejects bad signed eth raw", () => {
    expect(() =>
      validatePayload({ ...VALID_ETH_SIGNED, raw: "deadbeef" }),
    ).toThrow(/E_PAYLOAD_FIELD: raw/);
  });

  it("drops unknown meta keys silently", () => {
    const enc = base64urlEncode(
      JSON.stringify({
        ...VALID_PEARL_UNSIGNED,
        meta: { summary: "ok", composedAt: 1, unknown_key: "ignored" },
      }),
    );
    const dec = decodePayload(enc) as PearlUnsignedPayload;
    expect(dec.meta?.summary).toBe("ok");
    expect((dec.meta as Record<string, unknown> | undefined)?.["unknown_key"]).toBeUndefined();
  });

  it("treats invalid bech32m address as a string field (signer's worker checks the rest)", () => {
    // Address validation is delegated to the worker; the payload format
    // only requires a non-empty string. This is intentional — the
    // payload layer shouldn't need to know how to validate every chain.
    expect(() =>
      validatePayload({
        ...VALID_PEARL_UNSIGNED,
        outputs: [{ address: "not-a-real-address", amountGrains: "1" }],
      }),
    ).not.toThrow();
  });

  it("rejects an outputs entry with empty address", () => {
    expect(() =>
      validatePayload({
        ...VALID_PEARL_UNSIGNED,
        outputs: [{ address: "", amountGrains: "1" }],
      }),
    ).toThrow(/address/);
  });
});

// ── QR multi-frame chunking ──────────────────────────────────────────────

describe("splitIntoFrames + reassembleFrames", () => {
  it("returns a single frame for short payloads", () => {
    const { frames } = splitIntoFrames("hello", 1100, "sess01");
    expect(frames.length).toBe(1);
    expect(frames[0]).toBe("PWQR/v1/sess01/0/1/hello");
  });

  it("chunks by chunk size", () => {
    const { frames } = splitIntoFrames("ABCDEFGHIJ", 3, "sess02");
    // ceil(10/3) = 4 chunks: "ABC", "DEF", "GHI", "J"
    expect(frames.length).toBe(4);
    expect(frames[0]).toBe("PWQR/v1/sess02/0/4/ABC");
    expect(frames[1]).toBe("PWQR/v1/sess02/1/4/DEF");
    expect(frames[2]).toBe("PWQR/v1/sess02/2/4/GHI");
    expect(frames[3]).toBe("PWQR/v1/sess02/3/4/J");
  });

  it("reassembles in-order frames", () => {
    const payload = "abcdefghij".repeat(500);
    const { frames } = splitIntoFrames(payload, 200);
    expect(reassembleFrames(frames)).toBe(payload);
  });

  it("reassembles out-of-order frames", () => {
    const payload = "ABCDEFGHIJ".repeat(100);
    const { frames } = splitIntoFrames(payload, 50);
    const shuffled = [...frames];
    // Reverse + interleave for an obviously-disordered shuffle.
    shuffled.reverse();
    expect(reassembleFrames(shuffled)).toBe(payload);
  });

  it("deduplicates frames silently", () => {
    const payload = "0123456789".repeat(20);
    const { frames } = splitIntoFrames(payload, 30);
    // Triple every frame to simulate a camera locking on the same one
    // multiple times before moving to the next.
    const noisy = frames.flatMap((f) => [f, f, f]);
    expect(reassembleFrames(noisy)).toBe(payload);
  });

  it("uses given sessionId when supplied", () => {
    const { sessionId, frames } = splitIntoFrames("x", 10, "myId99");
    expect(sessionId).toBe("myId99");
    expect(frames[0]).toContain("/myId99/");
  });

  it("generates a sessionId when not supplied", () => {
    const { sessionId } = splitIntoFrames("x");
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{6}$/);
  });

  it("rejects an invalid sessionId", () => {
    expect(() => splitIntoFrames("x", 1100, "has/slash")).toThrow(/E_QR_SESSION_ID/);
    expect(() => splitIntoFrames("x", 1100, "")).toThrow(/E_QR_SESSION_ID/);
    expect(() => splitIntoFrames("x", 1100, "x".repeat(17))).toThrow(/E_QR_SESSION_ID/);
  });

  it("rejects an invalid chunk size", () => {
    expect(() => splitIntoFrames("x", 0)).toThrow(/E_QR_CHUNK_SIZE/);
    expect(() => splitIntoFrames("x", -1)).toThrow(/E_QR_CHUNK_SIZE/);
  });

  it("handles payload length exactly divisible by chunk size", () => {
    const payload = "abc".repeat(10); // 30 chars
    const { frames } = splitIntoFrames(payload, 10);
    expect(frames.length).toBe(3);
    expect(reassembleFrames(frames)).toBe(payload);
  });
});

describe("parseFrame", () => {
  it("parses a valid frame", () => {
    const p = parseFrame("PWQR/v1/abc123/3/10/hello");
    expect(p).toEqual({ sessionId: "abc123", idx: 3, total: 10, data: "hello" });
  });

  it("returns null for non-PWQR text", () => {
    expect(parseFrame("not a frame")).toBeNull();
    expect(parseFrame("https://example.com")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("returns null for malformed frame", () => {
    expect(parseFrame("PWQR/v1/abc")).toBeNull();
    expect(parseFrame("PWQR/v1/abc/0")).toBeNull();
    expect(parseFrame("PWQR/v1/abc/x/10/data")).toBeNull();
    expect(parseFrame("PWQR/v1/abc/0/0/data")).toBeNull(); // total=0
    expect(parseFrame("PWQR/v1/abc/5/3/data")).toBeNull(); // idx >= total
    expect(parseFrame("PWQR/v1/abc/-1/3/data")).toBeNull(); // negative idx
    expect(parseFrame("PWQR/v1/has space/0/1/data")).toBeNull(); // bad sessionId
    expect(parseFrame("PWQR/v1//0/1/data")).toBeNull(); // empty sessionId
  });
});

describe("FrameReassembler state machine", () => {
  it("tracks progress correctly across frames", () => {
    const { frames } = splitIntoFrames("hello world!", 4, "sess03");
    const r = new FrameReassembler();
    const p1 = r.accept(parseFrame(frames[0]!)!);
    expect(p1.complete).toBe(false);
    expect(p1.progress.received).toBe(1);
    expect(p1.progress.total).toBe(3);
    r.accept(parseFrame(frames[1]!)!);
    const p3 = r.accept(parseFrame(frames[2]!)!);
    expect(p3.complete).toBe(true);
    expect(r.result()).toBe("hello world!");
  });

  it("rejects a frame from a different session", () => {
    const r = new FrameReassembler();
    r.accept(parseFrame("PWQR/v1/sess04/0/2/hello")!);
    expect(() => r.accept(parseFrame("PWQR/v1/OTHER1/1/2/world")!)).toThrow(/E_QR_SESSION_MISMATCH/);
  });

  it("rejects a frame with mismatched total", () => {
    const r = new FrameReassembler();
    r.accept(parseFrame("PWQR/v1/sess05/0/2/hello")!);
    expect(() => r.accept(parseFrame("PWQR/v1/sess05/1/9/world")!)).toThrow(/E_QR_TOTAL_MISMATCH/);
  });

  it("result() throws if no frames received", () => {
    const r = new FrameReassembler();
    expect(() => r.result()).toThrow(/E_QR_NO_FRAMES/);
  });

  it("result() throws if some frames missing", () => {
    const r = new FrameReassembler();
    r.accept(parseFrame("PWQR/v1/sess06/0/3/A")!);
    r.accept(parseFrame("PWQR/v1/sess06/2/3/C")!);
    expect(() => r.result()).toThrow(/E_QR_INCOMPLETE/);
  });

  it("reset() allows a new session", () => {
    const r = new FrameReassembler();
    r.accept(parseFrame("PWQR/v1/sess07/0/1/A")!);
    expect(r.result()).toBe("A");
    r.reset();
    r.accept(parseFrame("PWQR/v1/sess08/0/1/B")!);
    expect(r.result()).toBe("B");
  });

  it("FRAME_CHUNK_BYTES default is reasonable for QR", () => {
    // Sanity: don't accidentally pick a value that would make every
    // single-input tx need 5+ frames.
    expect(FRAME_CHUNK_BYTES).toBeGreaterThanOrEqual(500);
    expect(FRAME_CHUNK_BYTES).toBeLessThanOrEqual(2000);
  });
});

// ── Manual UTXO entry ────────────────────────────────────────────────────

describe("parseManualUtxos", () => {
  it("parses a simple 4-field line", () => {
    const r = parseManualUtxos("abcd".repeat(16) + ":0:100000:1");
    expect(r.errors).toEqual([]);
    expect(r.utxos).toEqual([
      {
        txid: "abcd".repeat(16),
        vout: 0,
        valueGrains: "100000",
        poolIndex: 1,
      },
    ]);
  });

  it("parses a 5-field line with scriptHex", () => {
    const r = parseManualUtxos(
      `${"a".repeat(64)}:1:200:0:5120${"b".repeat(64)}`,
    );
    expect(r.errors).toEqual([]);
    expect(r.utxos[0]).toEqual({
      txid: "a".repeat(64),
      vout: 1,
      valueGrains: "200",
      poolIndex: 0,
      scriptHex: "5120" + "b".repeat(64),
    });
  });

  it("ignores blank lines and # comments", () => {
    const input = [
      "# this is the change UTXO",
      "",
      `${"a".repeat(64)}:0:100:0`,
      "  # blank-padded comment",
      `${"b".repeat(64)}:1:200:1   # second one`,
      "",
    ].join("\n");
    const r = parseManualUtxos(input);
    expect(r.errors).toEqual([]);
    expect(r.utxos.length).toBe(2);
  });

  it("reports per-line errors without dropping subsequent valid rows", () => {
    const input = [
      `${"a".repeat(64)}:0:100:0`, // ok
      "not-a-utxo-line", // err
      `${"b".repeat(64)}:1:200:1`, // ok
    ].join("\n");
    const r = parseManualUtxos(input);
    expect(r.utxos.length).toBe(2);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.line).toBe(2);
  });

  it("rejects too-few or too-many fields", () => {
    const r = parseManualUtxos(
      [`${"a".repeat(64)}:0`, `${"b".repeat(64)}:0:1:2:3:4`].join("\n"),
    );
    expect(r.utxos).toEqual([]);
    expect(r.errors.length).toBe(2);
  });

  it("rejects non-hex txid", () => {
    const r = parseManualUtxos("xyz:0:100:0");
    expect(r.utxos).toEqual([]);
    expect(r.errors[0]!.message).toMatch(/txid/);
  });

  it("rejects bad vout", () => {
    const r = parseManualUtxos(`${"a".repeat(64)}:-1:100:0`);
    expect(r.errors[0]!.message).toMatch(/vout/);
  });

  it("rejects bad amount (decimal)", () => {
    const r = parseManualUtxos(`${"a".repeat(64)}:0:1.5:0`);
    expect(r.errors[0]!.message).toMatch(/amount/);
  });

  it("rejects zero-value UTXO", () => {
    const r = parseManualUtxos(`${"a".repeat(64)}:0:0:0`);
    expect(r.errors[0]!.message).toMatch(/zero-value/);
  });

  it("rejects out-of-range poolIndex", () => {
    const r = parseManualUtxos(`${"a".repeat(64)}:0:1:9999`);
    expect(r.errors[0]!.message).toMatch(/poolIndex/);
  });

  it("rejects bad scriptHex", () => {
    const r = parseManualUtxos(`${"a".repeat(64)}:0:1:0:ZZ`);
    expect(r.errors[0]!.message).toMatch(/scriptHex/);
  });

  it("rejects duplicate txid:vout", () => {
    const txid = "a".repeat(64);
    const r = parseManualUtxos([`${txid}:0:1:0`, `${txid}:0:1:0`].join("\n"));
    expect(r.utxos.length).toBe(1);
    expect(r.errors[0]!.message).toMatch(/duplicate/);
  });

  it("normalizes uppercase hex", () => {
    const r = parseManualUtxos(`${"A".repeat(64)}:0:100:0:5120${"B".repeat(64)}`);
    expect(r.utxos[0]!.txid).toBe("a".repeat(64));
    expect(r.utxos[0]!.scriptHex).toBe("5120" + "b".repeat(64));
  });
});

describe("sumManualUtxoValue", () => {
  it("sums correctly with bigint precision", () => {
    expect(
      sumManualUtxoValue([
        { txid: "a".repeat(64), vout: 0, valueGrains: "100000000000000000", poolIndex: 0 },
        { txid: "b".repeat(64), vout: 0, valueGrains: "200000000000000000", poolIndex: 0 },
      ]),
    ).toBe(300000000000000000n);
  });

  it("returns 0n for empty array", () => {
    expect(sumManualUtxoValue([])).toBe(0n);
  });
});

// ── End-to-end Armory-style flow simulation ──────────────────────────────

describe("end-to-end offline-signing flow simulation", () => {
  it("watcher → signer → broadcaster: pearl-unsigned roundtrip via multi-frame QR", () => {
    // 1. WATCHER composes an unsigned tx from live UTXOs + outputs.
    const watcherPayload: PearlUnsignedPayload = {
      v: 1,
      k: "pearl-unsigned",
      network: "mainnet",
      utxos: Array.from({ length: 6 }, (_, i) => ({
        txid: i.toString(16).padStart(64, "0"),
        vout: i % 3,
        valueGrains: ((i + 1) * 1_000_000).toString(),
        scriptHex: "5120" + i.toString(16).padStart(64, "0"),
        poolIndex: i % 4,
      })),
      outputs: [
        {
          address: "prl1qtarget000000000000000000000000000000000000",
          amountGrains: "15000000",
        },
        {
          address: "prl1qchange000000000000000000000000000000000000",
          amountGrains: "5500000",
        },
      ],
      meta: {
        composedAt: 1716200000000,
        summary: "Send 0.15 PRL to prl1q…rget, change 0.055 PRL to pool[0]",
        feeGrains: "500000",
      },
    };

    // 2. Watcher encodes + chunks for animated QR display.
    const watcherEnvelope = encodePayload(watcherPayload);
    const { frames: watcherFrames } = splitIntoFrames(watcherEnvelope, 400);
    expect(watcherFrames.length).toBeGreaterThan(1); // proves we exercised chunking

    // 3. SIGNER scans frames in arbitrary order, with duplicates
    //    (simulating a phone camera locking on the same frame several times).
    const noisy = [
      watcherFrames[2]!,
      watcherFrames[2]!,
      watcherFrames[0]!,
      watcherFrames[1]!,
      watcherFrames[2]!,
      ...(watcherFrames.length > 3 ? [watcherFrames[3]!] : []),
    ];
    const r = new FrameReassembler();
    for (let i = 0; i < noisy.length; i++) {
      const parsed = parseFrame(noisy[i]!);
      expect(parsed).not.toBeNull();
      r.accept(parsed!);
    }
    // Top up any remaining frames the noisy list didn't include.
    for (let i = 4; i < watcherFrames.length; i++) {
      r.accept(parseFrame(watcherFrames[i]!)!);
    }
    const reassembled = r.result();
    expect(reassembled).toBe(watcherEnvelope);

    // 4. Signer decodes the payload, reviews it, and (in real life)
    //    feeds it to the crypto worker to sign. Here we only verify
    //    that the decoded payload matches the watcher's original.
    const decoded = decodePayload(reassembled) as PearlUnsignedPayload;
    expect(decoded).toEqual(watcherPayload);

    // 5. SIGNER produces a signed payload and ships it back via QR.
    const signed: PearlSignedPayload = {
      v: 1,
      k: "pearl-signed",
      network: decoded.network,
      raw: "02000000" + "01".repeat(200),
      txid: "9".repeat(64),
    };
    const signedEnvelope = encodePayload(signed);
    const { frames: signerFrames } = splitIntoFrames(signedEnvelope, 400);

    // 6. BROADCASTER reassembles + decodes the signed payload.
    const broadcasterReassembled = reassembleFrames(signerFrames);
    const broadcasterDecoded = decodePayload(broadcasterReassembled) as PearlSignedPayload;
    expect(broadcasterDecoded).toEqual(signed);
  });

  it("rejects a signer who switches sessions mid-scan", () => {
    const payloadA = encodePayload(VALID_PEARL_SIGNED);
    const payloadB = encodePayload({ ...VALID_PEARL_SIGNED, raw: "00" });
    const { frames: framesA } = splitIntoFrames(payloadA, 50, "sessAA");
    const { frames: framesB } = splitIntoFrames(payloadB, 50, "sessBB");
    const r = new FrameReassembler();
    r.accept(parseFrame(framesA[0]!)!);
    expect(() => r.accept(parseFrame(framesB[0]!)!)).toThrow(/E_QR_SESSION_MISMATCH/);
  });

  it("fully-offline composer path: manual UTXOs → unsigned payload encodes", () => {
    const manualText = [
      "# UTXOs as of 2026-05-26",
      `${"a".repeat(64)}:0:50000000:0:5120${"a".repeat(64)}`,
      `${"b".repeat(64)}:1:30000000:1:5120${"b".repeat(64)}`,
    ].join("\n");
    const parsed = parseManualUtxos(manualText);
    expect(parsed.errors).toEqual([]);
    expect(parsed.utxos.length).toBe(2);
    expect(sumManualUtxoValue(parsed.utxos)).toBe(80000000n);

    // Compose the payload from the manual entries.
    const payload: PearlUnsignedPayload = {
      v: 1,
      k: "pearl-unsigned",
      network: "mainnet",
      utxos: parsed.utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        valueGrains: u.valueGrains,
        scriptHex: u.scriptHex!,
        poolIndex: u.poolIndex,
      })),
      outputs: [
        { address: "prl1qoffline00000000000000000000000000000000000", amountGrains: "70000000" },
        { address: "prl1qchange00000000000000000000000000000000000", amountGrains: "9500000" },
      ],
      meta: { feeGrains: "500000", summary: "fully-offline composed" },
    };
    const encoded = encodePayload(payload);
    const decoded = decodePayload(encoded);
    expect(decoded).toEqual(payload);
  });
});
