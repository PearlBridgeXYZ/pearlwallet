# 05 — Bridge Integration (PearlBridge, native)

## What PearlBridge is

A lock-and-mint bridge between **Pearl L1** (UTXO chain, btcd-fork) and **Ethereum** (WPRL ERC-20).

- **PRL → WPRL:** user sends PRL to a designated lock address on Pearl; relayer detects after N confirmations, signs an EIP-712 mint payload, user (or wallet, gaslessly via meta-tx if supported) submits to the WPRL contract on Eth which mints to the user's Eth address.
- **WPRL → PRL:** user burns WPRL via the bridge contract on Eth; relayer detects burn event, signs a Pearl release tx, broadcasts it to send PRL back to the user's specified Pearl address.

The wallet integrates this **natively** — meaning a "Bridge" button on the dashboard kicks off a flow that runs entirely inside `pearlwallet.xyz`, with no redirect to `pearlbridge.xyz` or any external surface.

## Why native (not just an iframe to PearlBridge frontend)

- Trust unification: user enters one password, signs in one app.
- Address auto-population: bridge defaults to user's own addresses on each side.
- Status persistence: bridge progress survives reload, in the wallet's local DB.
- Single security audit perimeter (the wallet + the bridge contracts; not the wallet + the bridge contracts + the bridge frontend).

## What the build team needs from PearlBridge

The PearlBridge project artifacts are tracked separately by the bridge team. Pull these into `pearl-web-wallet/reference/`:

1. **Mainnet deployment.json** — contract addresses (BridgeRouter, WPRL, lock address per chain).
2. **WPRL ABI** — for ERC-20 ops + bridge-specific methods (`burn(uint256 amount, bytes32 pearlRecipient)` or similar).
3. **BridgeRouter ABI** — if there's a router contract for mint/burn.
4. **EIP-712 domain** — already documented as `("PearlBridge", "2", chainId, verifyingContract)`.
5. **MINT_TYPEHASH structure** — 5 fields per memory; need exact field names + types.
6. **SDI v2 canonical JSON spec** — already documented; build team needs §3.3 conformance hash `f23284f95d099135c80bf151e3ce3892290b68044d523164403eedd29daf5645` to validate their implementation.
7. **Relayer HTTP API** — endpoints to:
   - POST a Pearl-side SDI (deposit intent) for tracking.
   - GET signed mint payload after N confirmations.
   - POST WPRL burn tx hash for Pearl-side release tracking.
   - GET status of any bridge action by id.
8. **Min confirmations** — `minPearlConfirmations()` from the contract (currently 6 per memory; verify).
9. **Fees** — `mintFeeBps()` and `burnFeeBps()` from the contract.
10. **Daily limits** — `dailyMintLimit()` and `dailyBurnLimit()`.
11. **TVL cap** — for warning the user if bridge near capacity.

> **Build-team note:** if the relayer HTTP API doesn't expose a "GET status by id" endpoint, this needs to be added BEFORE the wallet ships. Otherwise the wallet has to poll for events on both chains directly, which is slower and chattier.

## Wallet-side bridge flows

### PRL → WPRL (lock & mint)

```
┌──────┐                                                                       
│ User │ 1. Picks amount, recipient (default: own Eth address)                
└──┬───┘                                                                       
   │                                                                           
   ▼                                                                           
┌──────────┐ 2. Build SDI v2: { amount, recipient, nonce, pearl_lock_addr }   
│ Wallet   │    Sign with BIP-322 using user's Pearl key (in worker)          
└────┬─────┘                                                                   
     │                                                                         
     ▼                                                                         
┌──────────┐ 3. POST SDI to relayer /intents (for tracking only,              
│ Relayer  │    relayer doesn't act until on-chain deposit confirms)          
└────┬─────┘                                                                   
     │ 4. Wallet broadcasts Pearl-side deposit tx to lock address              
     │    (with the SDI commitment hash as OP_RETURN or as part of            
     │    Taproot script-path commit — TBD by PearlBridge spec)               
     ▼                                                                         
┌────────────┐                                                                 
│ Pearl L1   │ 5. Tx enters mempool                                            
└──────┬─────┘                                                                 
       │ 6. Wallet polls RPC for confirmation count                           
       │    Relayer ALSO watches for tx                                       
       ▼                                                                       
┌──────────┐ 7. After minPearlConfirmations, relayer:                         
│ Relayer  │    a) verifies SDI matches on-chain commitment                   
│          │    b) signs EIP-712 mint payload                                 
│          │    c) returns signed payload + r,s,v,nonce to wallet             
└────┬─────┘                                                                   
     │                                                                         
     ▼                                                                         
┌──────────┐ 8. Wallet submits mint tx to BridgeRouter on Eth                 
│ Wallet   │    (user signs + broadcasts; user pays gas)                      
└────┬─────┘                                                                   
     │                                                                         
     ▼                                                                         
┌────────────┐ 9. WPRL minted to recipient                                    
│ Ethereum   │                                                                 
└────────────┘                                                                 
```

### WPRL → PRL (burn & release)

```
┌──────┐                                                                       
│ User │ 1. Picks amount, recipient (default: own Pearl address)              
└──┬───┘                                                                       
   │                                                                           
   ▼                                                                           
┌──────────┐ 2. If allowance < amount: wallet builds approve tx               
│ Wallet   │    (skip if BridgeRouter is wallet's WPRL or burn-from is        
│          │     allowance-aware via permit)                                  
└────┬─────┘                                                                   
     │                                                                         
     ▼                                                                         
┌──────────┐ 3. Build burn tx: bridge.burn(amount, pearlRecipient)            
│ Wallet   │    User signs + broadcasts                                        
└────┬─────┘                                                                   
     │                                                                         
     ▼                                                                         
┌────────────┐ 4. Burn event emitted                                          
│ Ethereum   │                                                                 
└──────┬─────┘                                                                 
       │ 5. Relayer watches for Burn event                                    
       ▼                                                                       
┌──────────┐ 6. Relayer signs + broadcasts Pearl release tx                   
│ Relayer  │    to pearlRecipient                                              
└────┬─────┘                                                                   
     │                                                                         
     ▼                                                                         
┌────────────┐ 7. Wallet polls for tx confirmation                            
│ Pearl L1   │                                                                 
└────────────┘                                                                 
```

## SDI v2 (Signed Deposit Intent)

The user signs a canonical JSON intent before broadcasting the Pearl deposit. The intent commits the user to a specific (recipient, amount, nonce). Relayer verifies the intent's BIP-322 signature against the depositor's Pearl address before signing the mint.

Canonical JSON serialization rules:
- Keys sorted lex.
- No whitespace.
- Numbers as integers (grains for amounts, not floats).
- UTF-8.
- Conformance hash `f23284f95d099135c80bf151e3ce3892290b68044d523164403eedd29daf5645` — wallet's serializer MUST reproduce this hash for the reference test vector.

Wallet imports `sdi-v2` lib from PearlBridge repo if published, otherwise re-implements with the conformance hash as the regression gate.

## EIP-712 mint signature verification

The wallet locally verifies the relayer's signed mint payload before submitting:

```ts
const domain = {
  name: "PearlBridge",
  version: "2",
  chainId: 1, // or 11155111 sepolia
  verifyingContract: BRIDGE_ROUTER_ADDRESS,
};
const types = {
  Mint: [
    { name: "recipient",  type: "address" },
    { name: "amount",     type: "uint256" },
    { name: "sdiHash",    type: "bytes32" },
    { name: "nonce",      type: "uint256" },
    { name: "deadline",   type: "uint256" },
  ],
};
// recover signer; must match a known RELAYER role address.
```

If recovery doesn't match a known relayer address (loaded from contract via `hasRole`), the wallet refuses to broadcast — protects against rogue relayer-impersonating MITM.

## Status tracking

Stored in IndexedDB:
```ts
interface BridgeAction {
  id: string;              // uuid
  direction: "prl-to-wprl" | "wprl-to-prl";
  amount: bigint;          // grains or wei
  recipient: string;       // dest address
  status: 
    | "draft"
    | "user-signing"
    | "broadcast-pending"
    | "source-confirming"   // waiting for N confirmations on source chain
    | "relayer-signing"
    | "dest-pending"
    | "dest-confirming"
    | "done"
    | "failed";
  sourceTxHash?: string;
  destTxHash?: string;
  sdi?: SdiV2Doc;
  relayerSig?: RelayerMintSig;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
```

Status updates pushed via:
- Polling Pearl/Eth RPC for tx state.
- Polling relayer for signed mint payload availability.
- WebSocket subscription to bridge events (if relayer supports).

Status persists across reloads. User can navigate away and come back to `/bridge/status/:id`.

## Fee disclosure

Always show, in this order, before the user signs anything:

| Line | Value | Source |
|------|-------|--------|
| You send | X PRL or X WPRL | user input |
| Bridge fee (X%) | Y | `mintFeeBps()` / `burnFeeBps()` |
| Network fee (source) | Z | fee estimator for source chain |
| Network fee (dest) | W | fee estimator for dest chain (user pays this on mint side) |
| **You'll receive** | **X − Y** (on dest chain) | computed |
| Estimated time | minutes | min confirmations × block time + relayer SLA |

All values in native + USD-equivalent.

## Daily limits & TVL caps

Pre-flight checks before quoting:
- `dailyMintLimit() - dailyMintUsedToday() ≥ amount` → else error E_BRIDGE_DAILY_LIMIT.
- `dailyBurnLimit() - dailyBurnUsedToday() ≥ amount` → else error.
- `tvlCap() - currentTvl() ≥ amount` (mint side only) → else error.

Show "X / Y daily mint capacity remaining" as a info row on the bridge screen.

## Failure modes

| Failure | Wallet behavior |
|---------|-----------------|
| User loses connection mid-broadcast | Tx may have hit chain; show status as "unknown — refresh to check"; re-poll on reconnect |
| Pearl tx confirms but relayer doesn't sign within SLA | Status stays at "relayer-signing" with elapsed counter; after 1hr show banner "Bridge relayer is slow; your deposit is safe and will be processed" |
| Relayer signs but Eth gas spike makes mint expensive | User sees mint cost in preview; can wait + retry later (signed payload has deadline) |
| Burn tx reverts | User retries with adjusted gas |
| Pearl release tx fails (very rare; relayer issue) | Surface to user with relayer contact; funds are recoverable via relayer escalation per bridge protocol |

## Reference contract addresses

To be filled by build team from PearlBridge `deployment*.json`:

```ts
// MAINNET (Ethereum chainId 1)
export const MAINNET = {
  bridgeRouter: "0x_TBD",
  wprl:         "0x_TBD",
  pearlLockAddr: "prl1p_TBD",
  minConfirmations: 6,  // verify from contract at runtime
  // limits + fees read from contract at runtime, not hardcoded
};

// SEPOLIA (Ethereum chainId 11155111)
export const SEPOLIA = {
  bridgeRouter: "0x_TBD",
  wprl:         "0x_TBD",
  pearlLockAddr: "prl1q_TBD_testnet",
  minConfirmations: 2,
};
```

Runtime check: on app boot, fetch contract state and compare to constants. Warn user if addresses don't match expected (defends against compile-time tampering).
