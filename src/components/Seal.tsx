import { useMemo } from "react";
import { sealPaths } from "../lib/seal";

interface SealProps {
  runId: string;
  size: number;
  /// Share of the line that is drawn, 0 to 1. Omit for a finished seal.
  drawn?: number;
}

/// Draws the cleanup seal; `drawn` follows deletion progress during a run.
export function Seal({ runId, size, drawn = 1 }: SealProps) {
  const paths = useMemo(() => sealPaths(runId, size), [runId, size]);

  return (
    <svg
      aria-hidden="true"
      className={`seal ${paths.length > 1 ? "seal--large" : "seal--small"}`}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      {drawn < 1 && paths.map((d) => <path className="seal__guide" d={d} key={d} />)}
      {paths.map((d) => (
        <path
          className="seal__ink"
          d={d}
          key={d}
          pathLength={1}
          strokeDasharray="1"
          style={{ strokeDashoffset: 1 - drawn }}
        />
      ))}
    </svg>
  );
}
