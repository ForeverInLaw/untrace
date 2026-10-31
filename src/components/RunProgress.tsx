import { type CSSProperties, useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useRunStore } from "../stores/runStore";

/// Live counter. High-frequency value updates animate via gsap.quickTo.
export function RunProgress() {
  const deleted = useRunStore((s) => s.deleted);
  const total = useRunStore((s) => s.total);
  const status = useRunStore((s) => s.status);
  const failed = useRunStore((s) => s.failed);

  const valueRef = useRef<HTMLSpanElement>(null);
  const quickTo = useRef<gsap.QuickToFunc | null>(null);
  const tween = useRef({ v: 0 });
  const progress = total > 0 ? Math.min(100, Math.round((deleted / total) * 100)) : 0;

  useGSAP(() => {
    quickTo.current = gsap.quickTo(tween.current, "v", {
      duration: 0.3,
      ease: "power2.out",
      onUpdate: () => {
        if (valueRef.current) {
          valueRef.current.textContent = Math.round(tween.current.v).toString();
        }
      },
    });
  }, []);

  useGSAP(() => {
    quickTo.current?.(deleted);
  }, { dependencies: [deleted] });

  return (
    <section className="progress-readout" aria-label="Run progress">
      <div className="progress-readout__top">
        <div>
          <strong ref={valueRef}>0</strong>
          <span> / {total}</span>
        </div>
        <small>{status} · {failed} failed</small>
      </div>
      <div className="progress-meter" aria-hidden="true">
        <div className="progress-meter__fill" style={{ "--progress": `${progress}%` } as CSSProperties} />
      </div>
    </section>
  );
}
