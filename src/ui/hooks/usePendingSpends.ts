// Re-renders the caller whenever the broadcast records change (this tab or
// another one).

import { useSyncExternalStore } from "react";
import { pendingSpendsVersion, subscribePendingSpends } from "../../services/pending-spends";

export function usePendingSpendsVersion(): number {
  return useSyncExternalStore(subscribePendingSpends, pendingSpendsVersion, pendingSpendsVersion);
}
