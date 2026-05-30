// Vault-relay client — fetches a one-time proposal artifact by token.
//
// The relay sits at /api/vault/tx/:token on the same origin as the
// wallet. GET consumes the artifact exactly once; subsequent fetches
// for the same token return 410. The wallet never POSTs — only the
// proposer CLI does, with HMAC auth.

export interface RelayArtifact {
  kind: "psbt-base64" | "tx-intent";
  payload: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  expiresAt: number;
}

export class VaultRelayError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "already_consumed" | "network" | "malformed",
    public consumedAt?: number,
  ) {
    super(message);
    this.name = "VaultRelayError";
  }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function fetchVaultProposal(token: string): Promise<RelayArtifact> {
  if (!TOKEN_RE.test(token)) {
    throw new VaultRelayError("invalid token format", "not_found");
  }

  let res: Response;
  try {
    res = await fetch(`/api/vault/tx/${token}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
    });
  } catch (e) {
    throw new VaultRelayError(
      e instanceof Error ? e.message : "network error",
      "network",
    );
  }

  if (res.status === 404) {
    throw new VaultRelayError("proposal not found or expired", "not_found");
  }
  if (res.status === 410) {
    let consumedAt: number | undefined;
    try {
      const body = (await res.json()) as { consumedAt?: number };
      if (typeof body.consumedAt === "number") consumedAt = body.consumedAt;
    } catch {
      // ignore
    }
    throw new VaultRelayError(
      "proposal was already consumed",
      "already_consumed",
      consumedAt,
    );
  }
  if (!res.ok) {
    throw new VaultRelayError(`relay error ${res.status}`, "network");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VaultRelayError("relay returned non-JSON", "malformed");
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("kind" in body) ||
    !("payload" in body)
  ) {
    throw new VaultRelayError("relay response missing fields", "malformed");
  }
  const b = body as Record<string, unknown>;
  if (b.kind !== "psbt-base64" && b.kind !== "tx-intent") {
    throw new VaultRelayError("unknown artifact kind", "malformed");
  }
  if (typeof b.payload !== "string") {
    throw new VaultRelayError("payload not a string", "malformed");
  }

  return {
    kind: b.kind,
    payload: b.payload,
    metadata: (b.metadata as Record<string, unknown> | null) ?? null,
    createdAt: typeof b.createdAt === "number" ? b.createdAt : 0,
    expiresAt: typeof b.expiresAt === "number" ? b.expiresAt : 0,
  };
}

// ── Phase 1 sig-return: post a partial sig back to the relay ───────────────
//
// The wallet POSTs to /api/vault/tx/:token/sig with:
//   { psbtBase64, signerPubkey, signedAt, hmacProof }
// The relay verifies the BIP 340 Schnorr proof against the claimed signer
// pubkey and the proposal's whitelist, then records the partial sig.
//
// The proof itself is computed inside the crypto Worker (worker.ts
// signSigProofForVault) — the main thread NEVER sees the cosigner privkey.
// This service just shuttles the JSON over the wire.

export interface PostPartialSigInput {
  token: string;
  psbtBase64: string;
  signerPubkeyHex: string; // 32-byte x-only hex, lowercase
  signedAt: number;        // unix seconds
  hmacProofHex: string;    // 64-byte Schnorr sig hex
}

export interface PostPartialSigResult {
  status: "inserted" | "idempotent";
  sigsCollected: number;
  threshold: number;
  thresholdMet: boolean;
}

export class PostPartialSigError extends Error {
  constructor(
    message: string,
    public code:
      | "not_found"          // 404 — token expired or never existed
      | "unauthorized"       // 401 — bad proof / pubkey not on whitelist
      | "conflict"           // 409 — same signer already posted a different PSBT
      | "bad_request"        // 400 — malformed body
      | "too_large"          // 413
      | "network"            // fetch failed
      | "malformed",         // server returned non-JSON
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "PostPartialSigError";
  }
}

export async function postPartialSig(
  input: PostPartialSigInput,
): Promise<PostPartialSigResult> {
  if (!TOKEN_RE.test(input.token)) {
    throw new PostPartialSigError("invalid token format", "not_found");
  }
  const body = JSON.stringify({
    psbtBase64: input.psbtBase64,
    signerPubkey: input.signerPubkeyHex,
    signedAt: input.signedAt,
    hmacProof: input.hmacProofHex,
  });

  let res: Response;
  try {
    res = await fetch(`/api/vault/tx/${input.token}/sig`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      credentials: "omit",
      cache: "no-store",
    });
  } catch (e) {
    throw new PostPartialSigError(
      e instanceof Error ? e.message : "network error",
      "network",
    );
  }

  if (res.status === 404) {
    throw new PostPartialSigError("proposal not found or expired", "not_found", 404);
  }
  if (res.status === 401) {
    throw new PostPartialSigError("sig proof rejected by relay", "unauthorized", 401);
  }
  if (res.status === 409) {
    throw new PostPartialSigError(
      "a different sig from this cosigner is already recorded",
      "conflict",
      409,
    );
  }
  if (res.status === 400) {
    throw new PostPartialSigError("relay rejected request shape", "bad_request", 400);
  }
  if (res.status === 413) {
    throw new PostPartialSigError("payload too large", "too_large", 413);
  }
  if (!res.ok) {
    throw new PostPartialSigError(`relay error ${res.status}`, "network", res.status);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new PostPartialSigError("relay returned non-JSON", "malformed");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("status" in parsed) ||
    !("sigsCollected" in parsed)
  ) {
    throw new PostPartialSigError("relay response missing fields", "malformed");
  }
  const p = parsed as Record<string, unknown>;
  const status = p.status === "inserted" || p.status === "idempotent" ? p.status : null;
  if (!status) {
    throw new PostPartialSigError("relay returned unknown status", "malformed");
  }
  return {
    status,
    sigsCollected: Number(p.sigsCollected ?? 0),
    threshold: Number(p.threshold ?? 0),
    thresholdMet: Boolean(p.thresholdMet),
  };
}

// ── Phase 1 status polling: read sig-collection state without consuming ───
//
// GET /api/vault/tx/:token/status — unauth, idempotent, safe to poll on a
// 5s interval. Returns the whitelist of cosigners with each one's
// signedAt (or null if they haven't posted yet) plus threshold-met flag.

export interface ProposalStatusSigner {
  pubkey: string;
  signedAt: number | null;
}

export interface ProposalStatus {
  token: string;
  kind: "psbt-base64" | "tx-intent";
  threshold: number;
  signers: ProposalStatusSigner[];
  thresholdMet: boolean;
  expiresAt: number;
}

export async function fetchProposalStatus(
  token: string,
): Promise<ProposalStatus> {
  if (!TOKEN_RE.test(token)) {
    throw new VaultRelayError("invalid token format", "not_found");
  }
  let res: Response;
  try {
    res = await fetch(`/api/vault/tx/${token}/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
    });
  } catch (e) {
    throw new VaultRelayError(
      e instanceof Error ? e.message : "network error",
      "network",
    );
  }
  if (res.status === 404) {
    throw new VaultRelayError("proposal not found", "not_found");
  }
  if (!res.ok) {
    throw new VaultRelayError(`relay error ${res.status}`, "network");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VaultRelayError("relay returned non-JSON", "malformed");
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("token" in body) ||
    !("signers" in body)
  ) {
    throw new VaultRelayError("status response missing fields", "malformed");
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.signers)) {
    throw new VaultRelayError("status signers not array", "malformed");
  }
  const signers: ProposalStatusSigner[] = [];
  for (const s of b.signers) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    if (typeof r.pubkey !== "string") continue;
    const signedAt =
      typeof r.signedAt === "number" ? r.signedAt : r.signedAt === null ? null : null;
    signers.push({ pubkey: r.pubkey, signedAt });
  }
  return {
    token: String(b.token),
    kind: b.kind === "tx-intent" ? "tx-intent" : "psbt-base64",
    threshold: Number(b.threshold ?? 0),
    signers,
    thresholdMet: Boolean(b.thresholdMet),
    expiresAt: typeof b.expiresAt === "number" ? b.expiresAt : 0,
  };
}
