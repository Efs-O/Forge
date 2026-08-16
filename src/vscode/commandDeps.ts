/**
 * What every Forge command needs from the extension host.
 *
 * Its own module so the command files can be split by concern without one
 * importing another purely for this type.
 */

import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import type { BackendStatusBar } from './BackendStatusBar';

export interface NativeCommandDeps {
  backend: IBackendPool;
  sidebar: SidebarProvider;
  statusBar: BackendStatusBar;
  getConfig: () => ForgeConfig;
  getConfigPath: () => string;
  setConfig: (config: ForgeConfig) => void;
}
