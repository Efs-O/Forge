import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const fixturePath = process.env.FORGE_REPLAY_FIXTURE;
const bundlePath = process.env.FORGE_WEBVIEW_BUNDLE;
if (!fixturePath || !bundlePath) {
  throw new Error('FORGE_REPLAY_FIXTURE and FORGE_WEBVIEW_BUNDLE are required');
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const conversation = fixture.conversation;
const displayed = conversation.messages
  .filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      (typeof message.content === 'string' ||
        (message.role === 'assistant' && typeof message.reasoning === 'string')),
  )
  .map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    ...(typeof message.reasoning === 'string' && message.reasoning.length > 0
      ? { reasoning: message.reasoning }
      : {}),
  }));

const failures = [];
const posted = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => failures.push(error));
virtualConsole.on('error', (...args) => failures.push(args.map(String).join(' ')));

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  url: 'https://forge-webview.test/',
  virtualConsole,
});
const { window } = dom;
window.acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message) });
window.Element.prototype.scrollIntoView = () => undefined;
window.addEventListener('error', (event) => {
  failures.push(event.error ?? event.message);
  event.preventDefault();
});
window.addEventListener('unhandledrejection', (event) => {
  failures.push(event.reason);
  event.preventDefault();
});

window.eval(fs.readFileSync(bundlePath, 'utf8'));
await settle(window);

function send(message) {
  window.dispatchEvent(new window.MessageEvent('message', { data: message }));
}

function type(textarea, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, value);
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function sync(streaming = false) {
  return {
    type: 'sessionSync',
    activeId: conversation.id,
    tabs: [
      {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: displayed.length,
        ...(conversation.active_model ? { active_model: conversation.active_model } : {}),
        ...(streaming ? { streaming: true } : {}),
      },
    ],
    history: [],
    messagesById: { [conversation.id]: displayed },
  };
}

send(sync());
await settle(window);
const textarea = window.document.querySelector('#prompt');
if (!textarea) throw new Error('Production bundle did not render #prompt');
const followUp = displayed.filter((message) => message.role === 'user').at(-1)?.content || 'replay';
for (let end = 1; end <= followUp.length; end++) {
  type(textarea, followUp.slice(0, end));
  await settle(window);
}
window.document.querySelector('#btn-send').click();
await settle(window);

send({ type: 'generationStarted', conversationId: conversation.id });
await settle(window);
type(textarea, 'queued production-bundle replay');
await settle(window);
window.document.querySelector('#btn-send').click();
send({ type: 'done', finishReason: 'stop', conversationId: conversation.id });
await settle(window);

send({ type: 'generationStarted', conversationId: conversation.id });
for (let index = 0; index < 6_000; index++) {
  send({
    type: index % 4 === 0 ? 'reasoningToken' : 'token',
    text: index % 23 === 0 ? ' chunk\n' : 'x',
    conversationId: conversation.id,
  });
  if (index % 100 === 0) type(textarea, `production prompt edit ${index}`);
  if (index % 50 === 0) await settle(window);
}
await settle(window);

const depthFailures = failures.filter((failure) =>
  String(failure?.stack ?? failure).includes('185') ||
  String(failure?.stack ?? failure).includes('Maximum update depth'),
);
console.log(
  JSON.stringify({
    displayedMessages: displayed.length,
    postedMessages: posted.length,
    failures: failures.length,
    depthFailures: depthFailures.length,
    promptValue: textarea.value,
  }),
);
if (failures.length > 0) {
  for (const failure of failures.slice(0, 5)) console.error(failure?.stack ?? failure);
  process.exitCode = 1;
}
dom.window.close();

async function settle(browserWindow) {
  await new Promise((resolve) => browserWindow.setTimeout(resolve, 0));
}
