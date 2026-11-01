import { useTranslation } from "react-i18next";
import { Sidebar } from "./components/Sidebar";
import { StepBar } from "./components/StepBar";
import { AccountStep } from "./screens/AccountStep";
import { AccountsView } from "./screens/AccountsView";
import { BackupStep } from "./screens/BackupStep";
import { PreviewStep } from "./screens/PreviewStep";
import { ReceiptDetail } from "./screens/ReceiptDetail";
import { ReceiptsView } from "./screens/ReceiptsView";
import { RunStep } from "./screens/RunStep";
import { ScopeStep } from "./screens/ScopeStep";
import { useFlowStore } from "./stores/flowStore";
import { useRunStore } from "./stores/runStore";

function ReceiptStep() {
  const { t } = useTranslation();
  const runId = useFlowStore((s) => s.runId) ?? "";
  const startOver = useFlowStore((s) => s.startOver);
  const resetRun = useRunStore((s) => s.reset);
  const newCleanup = () => {
    resetRun();
    startOver();
  };
  return <ReceiptDetail exit={{ label: t("receipt.newCleanup"), onClick: newCleanup }} runId={runId} />;
}

function CleanupFlow() {
  const step = useFlowStore((s) => s.step);
  return (
    <>
      <StepBar />
      {step === "account" && <AccountStep />}
      {step === "scope" && <ScopeStep />}
      {step === "preview" && <PreviewStep />}
      {step === "backup" && <BackupStep />}
      {step === "run" && <RunStep />}
      {step === "receipt" && <ReceiptStep />}
    </>
  );
}

export default function App() {
  const view = useFlowStore((s) => s.view);
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view === "cleanup" && <CleanupFlow />}
        {view === "receipts" && <ReceiptsView />}
        {view === "accounts" && <AccountsView />}
      </main>
    </div>
  );
}
