import React from 'react';
import { webviewDiagnostics } from './WebviewDiagnostics';

interface Props {
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

export class WebviewErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    webviewDiagnostics.capture('react-error', error, info.componentStack ?? undefined);
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div className="msg error" role="alert">
          Forge webview crashed. The diagnostic snapshot was written to the Forge output log. Reload
          the window to resume this conversation.
        </div>
      );
    }
    return this.props.children;
  }
}
