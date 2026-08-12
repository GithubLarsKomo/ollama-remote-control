import { useState } from 'react';
import type { TargetStatusResult } from './api.js';
import type { ModelInventoryView } from './model-inventory.js';
import LocalModelfilesPanel from './LocalModelfilesPanel.js';
import ModelfileLibrarySummaryPanel from './ModelfileLibrarySummaryPanel.js';
import RawModelfileImportPanel from './RawModelfileImportPanel.js';

export default function LocalModelfilesWorkspace({
  status,
  inventory,
  disabled,
  onSignedOut,
}: {
  readonly status: TargetStatusResult;
  readonly inventory: ModelInventoryView;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
}) {
  const [libraryEpoch, setLibraryEpoch] = useState(0);

  return (
    <>
      <RawModelfileImportPanel
        disabled={disabled}
        onImported={() => setLibraryEpoch((value) => value + 1)}
        onSignedOut={onSignedOut}
      />
      <ModelfileLibrarySummaryPanel key={`summary-${libraryEpoch}`} onSignedOut={onSignedOut} />
      <LocalModelfilesPanel
        disabled={disabled}
        inventory={inventory}
        key={`library-${libraryEpoch}`}
        onSignedOut={onSignedOut}
        status={status}
      />
    </>
  );
}
