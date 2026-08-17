/**
 * Loads the built bundle under a stubbed `vscode` module.
 *
 * This is the check a type-check structurally cannot do: circular-import TDZ
 * errors ("Cannot access 'X' before initialization") and module-scope failures
 * only surface when the bundle is actually evaluated. Both are the standing
 * risk of moving modules around, and both type-check clean.
 *
 * esbuild's __toESM interop copies the module's OWN keys onto the namespace
 * object, so the top-level stub needs real own properties — a bare get trap is
 * invisible to it and every namespace would read back undefined. It must also
 * be a plain object, not a function: a function target has non-configurable
 * own `arguments`/`caller`, which an ownKeys trap is not allowed to hide.
 */
const Module = require('module');
const path = require('path');

const NAMESPACES = [
  'window',
  'workspace',
  'commands',
  'languages',
  'env',
  'extensions',
  'debug',
  'tasks',
  'scm',
  'notebooks',
  'l10n',
  'tests',
  'authentication',
  'Uri',
  'Range',
  'Position',
  'Selection',
  'EventEmitter',
  'Disposable',
  'CancellationTokenSource',
  'ThemeIcon',
  'ThemeColor',
  'MarkdownString',
  'CodeAction',
  'CodeActionKind',
  'Diagnostic',
  'DiagnosticSeverity',
  'StatusBarAlignment',
  'ViewColumn',
  'ConfigurationTarget',
  'TreeItem',
  'TreeItemCollapsibleState',
  'RelativePattern',
  'FileType',
  'ExtensionMode',
  'ProgressLocation',
  'QuickPickItemKind',
  'DecorationRangeBehavior',
  'OverviewRulerLane',
  'TextEditorRevealType',
  'EndOfLine',
  'version',
];

/** Anything reachable below a namespace: callable, constructable, endless. */
function anyStub() {
  return new Proxy(function () {}, {
    get(_target, key) {
      if (key === 'then') return undefined; // must never look thenable
      if (key === 'toString' || key === Symbol.toPrimitive) return () => 'stub';
      if (key === Symbol.iterator) return undefined;
      return anyStub();
    },
    apply: () => anyStub(),
    construct: () => anyStub(),
  });
}

const vscodeStub = {};
for (const key of NAMESPACES) {
  Object.defineProperty(vscodeStub, key, { configurable: true, enumerable: true, get: anyStub });
}

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.apply(this, arguments);
};

const bundle = path.resolve(__dirname, '..', 'dist', 'extension.js');
const ext = require(bundle);

if (typeof ext.activate !== 'function') throw new Error('bundle does not export activate()');
if (typeof ext.deactivate !== 'function') throw new Error('bundle does not export deactivate()');
ext.deactivate();

console.log('bundle-load: module scope OK, activate/deactivate exported, deactivate() clean');
