import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useReceiptsQuery } from "../queries/runs";
import { STEPS, useFlowStore } from "../stores/flowStore";

const FIRST_LOCKED_STEP = STEPS.indexOf("run");

/// Where the cleanup is. Finished steps can be reopened until deletion starts.
export function StepBar() {
  const { t } = useTranslation();
  const step = useFlowStore((s) => s.step);
  const goTo = useFlowStore((s) => s.goTo);
  const current = STEPS.indexOf(step);
  const cleanupCount = useReceiptsQuery().data?.length ?? 0;
  const number = step === "receipt" ? cleanupCount : cleanupCount + 1;

  return (
    <header className="step-bar">
      <ol aria-label={t("steps.label")} className="step-bar__list">
        {STEPS.map((name, index) => {
          const done = index < current;
          const label = t(`steps.${name}`);
          return (
            <li aria-current={index === current ? "step" : undefined} className="step" key={name}>
              {done && <Check aria-hidden="true" className="step__check" size={14} />}
              {done && current < FIRST_LOCKED_STEP ? (
                <button className="step__link" onClick={() => goTo(name)} type="button">{label}</button>
              ) : (
                <span>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
      <span className="step-bar__number">{t("cleanup.number", { number: Math.max(number, 1) })}</span>
    </header>
  );
}
