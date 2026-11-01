/// The cleanup seal: lathe curves (hypotrochoids) whose shape comes from the run id.
/// It is an identity mark only. The receipt's signature is what proves anything.

const LARGE_SEAL_MIN = 100;

/// FNV-1a: a stable, well-spread number from a run id.
function hashRunId(runId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < runId.length; i += 1) {
    hash ^= runId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

interface Curve {
  outer: number;
  inner: number;
  arm: number;
  phase: number;
  /// Radius in pixels the curve is scaled to.
  reach: number;
}

function curvePath({ outer, inner, arm, phase, reach }: Curve, size: number, steps: number): string {
  const span = outer - inner;
  const scale = reach / (span + arm);
  const turns = inner / greatestCommonDivisor(outer, inner);
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * 2 * Math.PI * turns;
    const x = span * Math.cos(t + phase) + arm * Math.cos((span / inner) * t + phase);
    const y = span * Math.sin(t + phase) - arm * Math.sin((span / inner) * t + phase);
    points.push(`${(size / 2 + x * scale).toFixed(2)} ${(size / 2 + y * scale).toFixed(2)}`);
  }
  return `M${points.join("L")}`;
}

/// One looped rosette at list size, where fine rings would turn into a blob;
/// three nested lathe rings at display size. Both come from the same run hash.
export function sealPaths(runId: string, size: number): string[] {
  const hash = hashRunId(runId);
  const phase = ((hash >>> 8) % 628) / 100;
  const radius = size / 2;
  if (size < LARGE_SEAL_MIN) {
    const inner = 12;
    const lobes = 5 + (hash % 8);
    const arm = inner * (1.2 + ((hash >>> 4) % 8) * 0.1);
    return [curvePath({ outer: inner * lobes, inner, arm, phase, reach: radius * 0.96 }, size, 360)];
  }
  const inner = [9, 11, 13][hash % 3];
  return [0, 1, 2].map((ring) =>
    curvePath(
      {
        outer: 76 - ring * 8,
        inner,
        arm: 22 + ((hash >>> 4) % 8) + ring * 4,
        phase: phase + ring * 0.14,
        reach: radius * (0.92 - ring * 0.04),
      },
      size,
      1500,
    ),
  );
}
