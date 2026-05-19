// Balances service. In MOCK mode, returns stable mocked balances so the UI is
// fully functional pre-mainnet. In live mode (toggle in Settings), calls the
// chain RPCs. Live mode is gated until docs/11 Q3 + Q4 resolve.
import { useUI } from "../state/ui-store";
const MOCK_BALANCES = {
    prl: 10000000000n, // 100 PRL
    wprl: 100000000000000000000n, // 100 WPRL
    prlUsd: 6.20,
    wprlUsd: 6.15,
};
export async function fetchBalances(_pearlAddr, _ethAddr) {
    const mock = useUI.getState().mockMode;
    if (mock) {
        // Simulate small network jitter so the UI feels real.
        await new Promise((r) => setTimeout(r, 250));
        return MOCK_BALANCES;
    }
    // Live: not yet wired. Falls back to zero with a friendly message.
    return { prl: 0n, wprl: 0n, prlUsd: 0, wprlUsd: 0 };
}
