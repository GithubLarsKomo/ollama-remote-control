# Manual rollback candidate authority

Issue: #89

This first slice is deliberately read-only. It creates no rollback job and performs no remote mutation.

A rollback candidate is exposed only when the server can prove all of the following from persisted state:

1. the target has a latest successful `container.update` job;
2. the target is still bound to the replacement container recorded by that update;
3. the update result references a successful server-generated update execution intent for the same target;
4. update result and intent agree on snapshot and candidate digest;
5. the intent's exact candidate reference recomputes correctly from the configured image and candidate digest;
6. the referenced encrypted rollback snapshot exists for the same target and authenticates with the external master key;
7. the snapshot's container ID equals the update's recorded previous container;
8. the snapshot image metadata proves the exact pre-update digest;
9. the snapshot is Docker Compose-managed and its service matches the update intent.

If the selected target binding changed after the successful update, the previous update is not silently reused: the endpoint reports no executable candidate. Inconsistent or tampered persisted authority fails closed with `ROLLBACK_AUTHORITY_INVALID` rather than falling back to an older update or accepting browser-supplied image/snapshot authority.

The returned view contains only bounded operational identifiers, exact image/digest references, Compose service and the explicit limitation that model data volumes are not part of the rollback snapshot.

The follow-up slice will bind manual rollback execution to this authority, add explicit confirmation, a persistent target-locked mutation job, fresh Compose revalidation, exact local-only replacement, binding/health verification and recovery handling.
