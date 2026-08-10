export function manualRollbackConfirmationReady(
  targetDisplayName: string,
  typedTargetName: string,
  modelVolumeBoundaryAcknowledged: boolean,
): boolean {
  return modelVolumeBoundaryAcknowledged
    && targetDisplayName.length > 0
    && typedTargetName === targetDisplayName;
}
