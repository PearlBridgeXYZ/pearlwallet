import { useEffect, useState } from "react";

export default function UpdatedAgo({ at }: { at: number | null }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (at === null) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [at]);

  if (at === null) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));

  return (
    <p className="mt-2 text-xs tabular-nums text-text-3">
      {seconds < 5
        ? "updated just now"
        : seconds < 60
          ? `updated ${seconds}s ago`
          : `updated ${Math.floor(seconds / 60)}m ago`}
    </p>
  );
}
