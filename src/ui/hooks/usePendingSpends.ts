// Re-renders the caller whenever the pending-spend list changes (this tab
// or another one): reservations, releases, payment intents, in-flight
// submissions and status checks.

import { useSyncExternalStore } from "react";
import { pendingSpendsVersion, subscribePendingSpends } from "../../services/pending-spends";

export function usePendingSpendsVersion(): number {
  return useSyncExternalStore(subscribePendingSpends, pendingSpendsVersion, pendingSpendsVersion);
}
