/** Serializes queue scans and requests a fresh pass when events arrive mid-scan. */

export class AgentInboxScanScheduler {
  private scanning = false;
  private rescanRequested = false;

  constructor(
    private readonly isDisposed: () => boolean,
    private readonly scan: () => void,
  ) {}

  schedule(): void {
    if (this.isDisposed()) return;
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    try {
      this.scan();
    } finally {
      this.scanning = false;
    }
    if (this.rescanRequested) {
      this.rescanRequested = false;
      this.schedule();
    }
  }
}
