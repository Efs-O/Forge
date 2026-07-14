import * as path from 'path';
import {
  MAX_WORKER_FIND_RESULTS,
  MAX_WORKER_GLOB_CHARS,
  MAX_WORKER_QUERY_CHARS,
  MAX_WORKER_SEARCH_RESULTS,
} from './limits';

const DISCOVERY_TOOL_NAMES = new Set([
  'find_files',
  'search_code',
  'get_document_symbols',
  'get_diagnostics',
]);

export function isWorkerDiscoveryTool(name: string): boolean {
  return DISCOVERY_TOOL_NAMES.has(name);
}

export function validateWorkerDiscoveryArgs(name: string, args: Record<string, unknown>): void {
  if (name === 'find_files') {
    validateGlob(args['pattern'], 'find_files pattern');
    validateMaxResults(args['max_results'], MAX_WORKER_FIND_RESULTS, 'find_files');
    return;
  }
  if (name === 'search_code') {
    const query = requireNonEmptyString(args['query'], 'search_code query');
    if (query.length > MAX_WORKER_QUERY_CHARS) {
      throw new Error(`search_code query exceeds ${MAX_WORKER_QUERY_CHARS} characters`);
    }
    if (args['include'] !== undefined) validateGlob(args['include'], 'search_code include');
    validateMaxResults(args['max_results'], MAX_WORKER_SEARCH_RESULTS, 'search_code');
    return;
  }
  if (name === 'get_document_symbols' || name === 'get_diagnostics') {
    requireNonEmptyString(args['path'], `${name} path`);
    return;
  }
  throw new Error(`Unsupported worker discovery tool: ${name}`);
}

function validateGlob(value: unknown, label: string): void {
  const glob = requireNonEmptyString(value, label);
  if (glob.length > MAX_WORKER_GLOB_CHARS) {
    throw new Error(`${label} exceeds ${MAX_WORKER_GLOB_CHARS} characters`);
  }
  if (path.isAbsolute(glob) || glob.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(glob)) {
    throw new Error(`${label} must be workspace-relative`);
  }
  if (glob.split(/[\\/]+/u).includes('..')) {
    throw new Error(`${label} must not traverse outside the workspace`);
  }
}

function validateMaxResults(value: unknown, maximum: number, toolName: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${toolName} max_results must be an integer from 1 to ${maximum}`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
