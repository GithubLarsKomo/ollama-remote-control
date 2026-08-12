import {
  useEffect,
  useState,
} from 'react';
import type { TargetCatalogEntry } from './api.js';
import ContainerUpdatePanel from './ContainerUpdatePanel.js';
import ManualRollbackPanel from './ManualRollbackPanel.js';

interface UpdatePanelProps {
  readonly target: TargetCatalogEntry;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onSignedOut: () => void;
  readonly onUpdated: () => Promise<void> | void;
}

export default function UpdatePanel({ target, onBusyChange, onSignedOut, onUpdated }: UpdatePanelProps) {
  const [updateBusy, setUpdateBusy] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const busy = updateBusy || rollbackBusy;

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  return (
    <>
      <section className="update-panel" aria-label="0.1 beta update scope">
        <div className="update-warning" role="note">
          <strong>0.1 beta update boundary</strong>
          <p>Managed update execution is limited to a server-validated Docker Compose target. Standalone container updates are intentionally unsupported and fail closed in 0.1 beta.</p>
        </div>
      </section>
      {!rollbackBusy ? (
        <ContainerUpdatePanel
          onBusyChange={setUpdateBusy}
          onSignedOut={onSignedOut}
          onUpdated={onUpdated}
          target={target}
        />
      ) : null}
      {!updateBusy ? (
        <ManualRollbackPanel
          disabled={updateBusy}
          onBusyChange={setRollbackBusy}
          onRolledBack={onUpdated}
          onSignedOut={onSignedOut}
          target={target}
        />
      ) : null}
    </>
  );
}
