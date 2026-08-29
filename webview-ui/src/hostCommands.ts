import { useCallback } from 'react';
import type { Action } from './reducer';
import { vscode } from './vscode';

/**
 * Fire-and-forget commands the sidebar sends to the host. They carry no local
 * state beyond the optimistic model switch, so they live here rather than
 * crowding App.tsx with eight near-identical postMessage wrappers.
 */
export function useHostCommands(dispatch: React.Dispatch<Action>): {
  handleCancel: () => void;
  handleModelChange: (name: string | null) => void;
  handleNewConversation: () => void;
  handleSwitchTab: (id: string) => void;
  handleCloseTab: (id: string) => void;
  handleRestoreConversation: (id: string) => void;
  handleDeleteConversation: (id: string) => void;
  handleRenameConversation: (id: string, title: string) => void;
} {
  const handleCancel = useCallback(() => {
    vscode.postMessage({ type: 'cancel' });
  }, []);
  // Dispatched locally as well: the picker must not sit on the old name while
  // the host round-trips the switch.
  const handleModelChange = useCallback(
    (name: string | null) => {
      dispatch({ type: 'SET_MODEL', name });
      vscode.postMessage({ type: 'switchModel', name });
    },
    [dispatch],
  );
  const handleNewConversation = useCallback(() => {
    vscode.postMessage({ type: 'newConversation' });
  }, []);
  const handleSwitchTab = useCallback((id: string) => {
    vscode.postMessage({ type: 'switchConversation', id });
  }, []);
  const handleCloseTab = useCallback((id: string) => {
    vscode.postMessage({ type: 'closeConversation', id });
  }, []);
  const handleRestoreConversation = useCallback((id: string) => {
    vscode.postMessage({ type: 'restoreConversation', id });
  }, []);
  const handleDeleteConversation = useCallback((id: string) => {
    vscode.postMessage({ type: 'deleteConversation', id });
  }, []);
  const handleRenameConversation = useCallback((id: string, title: string) => {
    vscode.postMessage({ type: 'renameConversation', id, title });
  }, []);
  return {
    handleCancel,
    handleModelChange,
    handleNewConversation,
    handleSwitchTab,
    handleCloseTab,
    handleRestoreConversation,
    handleDeleteConversation,
    handleRenameConversation,
  };
}
