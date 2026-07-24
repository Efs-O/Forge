import React, { useEffect, useReducer, useRef } from 'react';
import { vscode, type PanelMessage } from './vscode';
import { initialState, reducer, visibleModels } from './reducer';
import { useKeyboardNav } from './useKeyboardNav';
import { Toolbar } from './components/Toolbar';
import { ModelList } from './components/ModelList';
import { OrphansPanel } from './components/OrphansPanel';
import { DetailDrawer } from './components/DetailDrawer';
import { ScanDialog } from './components/ScanDialog';
import { GroupsEditor } from './components/GroupsEditor';
import { PurgeConfirmDialog } from './components/PurgeConfirmDialog';

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [purgeTarget, setPurgeTarget] = React.useState<string | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const msg = event.data as PanelMessage;
      switch (msg.type) {
        case 'state':
          dispatch({
            type: 'STATE',
            models: msg.models,
            groups: msg.groups,
            orphans: msg.orphans,
            totalDiskBytes: msg.totalDiskBytes,
            activeModel: msg.activeModel,
            modelDirs: msg.modelDirs,
          });
          break;
        case 'scanResult':
          dispatch({ type: 'SCAN_RESULT', candidates: msg.candidates });
          break;
        case 'loadResult':
          dispatch({
            type: 'LOAD_RESULT',
            modelName: msg.modelName,
            ok: msg.ok,
            ...(msg.message !== undefined ? { message: msg.message } : {}),
          });
          break;
        case 'error':
          dispatch({
            type: 'ERROR',
            message: msg.message,
            ...(msg.field !== undefined ? { field: msg.field } : {}),
          });
          break;
      }
    }
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const models = visibleModels(state);
  const modelNames = models.map((m) => m.name);
  const focusedModel = state.models.find((m) => m.name === state.focused) ?? null;
  const modalOpen = Boolean(state.scanCandidates || state.groupsEditorOpen || purgeTarget);

  const editField = (modelName: string, field: string, value: unknown): void => {
    vscode.postMessage({ type: 'editField', modelName, field, value });
  };
  const removeModel = (name: string): void =>
    vscode.postMessage({ type: 'removeModel', modelName: name });
  const loadAndTry = (name: string): void => {
    dispatch({ type: 'START_LOADING', name });
    vscode.postMessage({ type: 'loadAndTry', modelName: name });
  };

  useKeyboardNav({
    models: modelNames,
    focused: state.focused,
    onFocus: (name) => dispatch({ type: 'SET_FOCUS', name }),
    onToggleSelect: (name) => dispatch({ type: 'TOGGLE_SELECT', name }),
    onOpenDrawer: (name) => {
      dispatch({ type: 'SET_FOCUS', name });
      dispatch({ type: 'OPEN_DRAWER' });
    },
    onRemove: removeModel,
    onPurge: (name) => setPurgeTarget(name),
    onFocusFilter: () => filterInputRef.current?.focus(),
    onEscape: () => {
      if (state.drawerOpen) dispatch({ type: 'CLOSE_DRAWER' });
      else dispatch({ type: 'SELECT_ONLY', name: null });
    },
    modalOpen,
  });

  return (
    <div className="mm-root">
      {state.error ? (
        <div className="mm-error-banner" onClick={() => dispatch({ type: 'CLEAR_ERROR' })}>
          {state.error} (click to dismiss)
        </div>
      ) : null}
      <Toolbar
        filter={state.filter}
        onFilterChange={(v) => dispatch({ type: 'SET_FILTER', value: v })}
        filterInputRef={filterInputRef}
        count={models.length}
        totalDiskBytes={state.totalDiskBytes}
        sortKey={state.sortKey}
        sortDesc={state.sortDesc}
        onSort={(key) => dispatch({ type: 'SET_SORT', key })}
        unusedOnly={state.unusedOnly}
        onToggleUnusedOnly={() => dispatch({ type: 'TOGGLE_UNUSED_ONLY' })}
        onScan={() => dispatch({ type: 'OPEN_SCAN_DIALOG' })}
        onEditGroups={() => dispatch({ type: 'OPEN_GROUPS_EDITOR' })}
      />
      <div className="mm-body">
        <ModelList
          models={models}
          selected={state.selected}
          focused={state.focused}
          onFocus={(name) => dispatch({ type: 'SET_FOCUS', name })}
          onToggleSelect={(name) => dispatch({ type: 'TOGGLE_SELECT', name })}
          onOpenDrawer={(name) => {
            dispatch({ type: 'SET_FOCUS', name });
            dispatch({ type: 'OPEN_DRAWER' });
          }}
          onLoadAndTry={loadAndTry}
          loadingNames={state.loadingNames}
        />
        {state.drawerOpen && focusedModel ? (
          <DetailDrawer
            model={focusedModel}
            errorField={state.errorField}
            onEdit={(field, value) => editField(focusedModel.name, field, value)}
            onReveal={() =>
              vscode.postMessage({ type: 'revealInExplorer', modelName: focusedModel.name })
            }
            onRemove={() => removeModel(focusedModel.name)}
            onPurge={() => setPurgeTarget(focusedModel.name)}
            onLoadAndTry={() => loadAndTry(focusedModel.name)}
            onClose={() => dispatch({ type: 'CLOSE_DRAWER' })}
          />
        ) : null}
      </div>
      <OrphansPanel
        orphans={state.orphans}
        onPurge={(path) => vscode.postMessage({ type: 'purgeOrphan', path })}
      />

      {state.scanCandidates ? (
        <ScanDialog
          candidates={state.scanCandidates}
          onScanDirectory={() => vscode.postMessage({ type: 'scanDirectory' })}
          onAddSelected={(picks) => {
            vscode.postMessage({ type: 'addScanned', picks });
            dispatch({ type: 'CLOSE_SCAN_DIALOG' });
          }}
          onClose={() => dispatch({ type: 'CLOSE_SCAN_DIALOG' })}
        />
      ) : null}

      {state.groupsEditorOpen ? (
        <GroupsEditor
          groups={state.groups}
          onSetField={(groupName, field, value) =>
            vscode.postMessage({ type: 'setGroupField', groupName, field, value })
          }
          onAddGroup={(groupName) => vscode.postMessage({ type: 'addGroup', groupName })}
          onRemoveGroup={(groupName) => vscode.postMessage({ type: 'removeGroup', groupName })}
          onClose={() => dispatch({ type: 'CLOSE_GROUPS_EDITOR' })}
        />
      ) : null}

      {purgeTarget ? (
        <PurgeConfirmDialog
          modelName={purgeTarget}
          onConfirm={(typedName) => {
            vscode.postMessage({ type: 'purgeModel', modelName: purgeTarget, typedName });
            setPurgeTarget(null);
          }}
          onCancel={() => setPurgeTarget(null)}
        />
      ) : null}
    </div>
  );
}
