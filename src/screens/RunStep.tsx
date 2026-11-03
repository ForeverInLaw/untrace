import { useEffect } from "react";
import { Clock, WifiOff } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Seal } from "../components/Seal";
import { Button, Notice, Screen } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { useByteFormat } from "../lib/format";
import { usePlatformsQuery } from "../queries/platforms";
import { usePauseRunMutation, useResumeRunMutation, useStopRunMutation } from "../queries/runs";
import { useFlowStore } from "../stores/flowStore";
import { useRunStore } from "../stores/runStore";
import { RunChatResults } from "./ChatCounts";

const SEAL_SIZE = 240;

function Counters() {
  const { t } = useTranslation();
  const deleted = useRunStore((s) => s.deleted);
  const skipped = useRunStore((s) => s.skipped);
  const failed = useRunStore((s) => s.failed);
  const total = useRunStore((s) => s.total);
  const left = total - deleted - skipped - failed;
  const counters = [
    { label: t("run.left"), value: left, className: "" },
    { label: t("run.skipped"), value: skipped, className: "" },
    { label: t("run.failed"), value: failed, className: failed > 0 ? "counter__value--fault" : "" },
  ];
  return (
    <dl className="counters">
      {counters.map(({ label, value, className }) => (
        <div className="counter" key={label}>
          <dd className={`counter__value ${className}`}>{t("cleanup.plainNumber", { value })}</dd>
          <dt>{label}</dt>
        </div>
      ))}
    </dl>
  );
}

/// Large files take a while to download, so this keeps a long batch from looking stuck.
function ArchiveProgress() {
  const { t } = useTranslation();
  const formatBytes = useByteFormat();
  const done = useRunStore((s) => s.archivedBytes);
  const total = useRunStore((s) => s.archiveTotalBytes);
  if (total === 0 || done >= total) {
    return null;
  }
  return <p className="help">{t("run.archiving", { done: formatBytes(done), total: formatBytes(total) })}</p>;
}

function RunHeading() {
  const { t } = useTranslation();
  const status = useRunStore((s) => s.status);
  const deleted = useRunStore((s) => s.deleted);
  const total = useRunStore((s) => s.total);
  const paused = useRunStore((s) => s.paused);
  if (status === "error") {
    return t("run.failedHeading");
  }
  if (status !== "deleting") {
    return t("run.preparing");
  }
  return (
    <Trans
      components={{ n: <em className="count" /> }}
      i18nKey={paused ? "run.paused" : "run.heading"}
      values={{ deleted, total }}
    />
  );
}

export function RunStep() {
  const { t } = useTranslation();
  const runId = useFlowStore((s) => s.runId) ?? "";
  const platformId = useFlowStore((s) => s.platformId);
  const goTo = useFlowStore((s) => s.goTo);
  const startOver = useFlowStore((s) => s.startOver);
  const status = useRunStore((s) => s.status);
  const message = useRunStore((s) => s.message);
  const deleted = useRunStore((s) => s.deleted);
  const skipped = useRunStore((s) => s.skipped);
  const failed = useRunStore((s) => s.failed);
  const total = useRunStore((s) => s.total);
  const paused = useRunStore((s) => s.paused);
  const setPaused = useRunStore((s) => s.setPaused);
  const waitSecs = useRunStore((s) => s.throttleWaitSecs);
  const offline = useRunStore((s) => s.offline);
  const reset = useRunStore((s) => s.reset);
  const platform = usePlatformsQuery().data?.find((item) => item.id === platformId)?.display_name ?? platformId;
  const pause = usePauseRunMutation();
  const resume = useResumeRunMutation();
  const stop = useStopRunMutation();
  const handled = deleted + skipped + failed;
  // The seal only grows with what is really gone, so a failing run leaves it unfinished.
  const sealDrawn = total > 0 ? Math.min(deleted / total, 1) : 0;
  const failure = status === "error" ? message : errorMessage(pause.error ?? resume.error ?? stop.error);

  useEffect(() => {
    if (status === "done") {
      goTo("receipt");
    }
  }, [goTo, status]);

  const togglePause = async () => {
    await (paused ? resume : pause).mutateAsync(runId);
    setPaused(!paused);
  };

  const finish = () => {
    reset();
    startOver();
  };

  return (
    <Screen
      actions={
        status === "error" ? (
          <Button kind="primary" onClick={finish}>{t("receipt.newCleanup")}</Button>
        ) : (
          <>
            <Button disabled={pause.isPending || resume.isPending} onClick={togglePause}>
              {t(paused ? "run.resume" : "run.pause")}
            </Button>
            <Button disabled={stop.isPending} onClick={() => stop.mutate(runId)}>{t("run.stop")}</Button>
          </>
        )
      }
      heading={<RunHeading />}
      note={t(status === "error" ? "run.failedNote" : "run.note")}
    >
      <progress aria-label={t("run.progressLabel")} className="meter" max={Math.max(total, 1)} value={handled} />
      <Counters />
      <ArchiveProgress />
      {waitSecs !== null && (
        <Notice icon={<Clock aria-hidden="true" size={16} />} tone="caution">
          {t("run.throttled", { platform, seconds: waitSecs })}
        </Notice>
      )}
      {offline && (
        <Notice icon={<WifiOff aria-hidden="true" size={16} />} tone="caution">
          {t("run.offline", { platform })}
        </Notice>
      )}
      {failure && <Notice tone="fault">{failure}</Notice>}
      <RunChatResults ended={status === "error"} runId={runId} />
      <figure className="run-seal">
        <Seal drawn={sealDrawn} runId={runId} size={SEAL_SIZE} />
      </figure>
    </Screen>
  );
}
