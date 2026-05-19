import { createPublicClient, http, fallback } from "viem";
import { ethChain, ETH_RPC_PRIMARY, ETH_RPC_FALLBACK } from "./network";
export function ethClient(net) {
    return createPublicClient({
        chain: ethChain(net),
        transport: fallback([http(ETH_RPC_PRIMARY[net]), http(ETH_RPC_FALLBACK[net])], {
            rank: false,
            retryCount: 2,
        }),
    });
}
