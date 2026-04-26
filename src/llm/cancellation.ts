export class CancellationToken {
  private _controller = new AbortController();

  get signal(): AbortSignal {
    return this._controller.signal;
  }

  get isCancelled(): boolean {
    return this._controller.signal.aborted;
  }

  cancel(): void {
    this._controller.abort();
  }
}
