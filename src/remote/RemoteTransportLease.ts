/**
 * Re-export shim. The lease implementation moved to `src/util/FileLease.ts`
 * (Phase B1) so the job scheduler can hold its own lease without importing
 * from the remote subsystem. Existing remote callers keep using these names.
 */
export {
  FileLease as RemoteTransportLease,
  FileLeaseError as RemoteLeaseError,
} from '../util/FileLease';
