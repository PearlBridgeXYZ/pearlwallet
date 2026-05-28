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
