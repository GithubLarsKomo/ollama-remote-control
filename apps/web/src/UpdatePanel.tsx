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
