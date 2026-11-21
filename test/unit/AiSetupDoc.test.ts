/**
 * AI_SETUP.md is read by the user's Claude Code / Codex, which follows it
 * literally. A command id, config key or shipped path that stops existing turns
 * into a setup that fails on a stranger's machine where nobody from this repo is
 * watching — so every name the file uses is checked against the source of truth.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { JobSchema } from '../../src/jobs/jobSchema';
import { agentSetupPrompt } from '../../src/vscode/agentSetupCommand';
import { isPartialExample, validateConfigExample, yamlBlocks } from '../support/docConfigExamples';

const root = path.resolve(__dirname, '..', '..');
const doc = fs.readFileSync(path.join(root, 'AI_SETUP.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};

describe('AI_SETUP.md', () => {
  it('requests one plan confirmation and automates the rest of the chosen setup', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(doc.match(/Proceed with this setup plan/g)).toHaveLength(1);
    expect(text).toContain('offer only the features listed in Step 0 questions 6-8');
    expect(text).toContain('do not ask the user to choose');
    expect(text).toContain('every model file and release archive');
    expect(text).toContain('the selected llama.cpp build');
    expect(text).toContain('any missing selected CLI and its prerequisites');
    expect(text).toContain('Never ask the user to install it');
    expect(text).not.toContain('the user installs the CLI');
    expect(text).toContain('Stop for the login only');
    expect(text).toContain('winget install --id Git.Git -e');
    expect(text).toContain('permissions.agents.delegate');
    expect(text).toContain('crossSessionInbound');
    expect(text).toContain('the exact config file path to write');
    expect(text).toContain('resources/instructions/FORGE.starter.md');
    expect(text).toContain('`FORGE.md` files are left untouched.');
    expect(text).toContain('not ask them to run **Forge: Validate Config**');
    expect(text).toContain('do not ask the user to send one');
    expect(text).toContain('Take the port from its `url` field');
    expect(text).toContain('`~/.forge/control-server.json` where `LOCALAPPDATA` is unset');
  });

  // The Step 0 questions are the one confirmation, so they have to be asked in
  // a fixed order and a fixed wording: an agent that cannot ask a second
  // question would otherwise set up only what the user happened to name in
  // their first message. A picker is easier to answer than a typed
  // "yes, no, yes...", and three calls (1-4, 5-8, then 9-12)
  // keep the tool's cap without dropping any of the twelve.
  it('asks the Step 0 questions with a picker when the harness has one', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'Write the plan summary in your reply first, and add this line to it: "Reverse ' +
        'image search uploads your image to litterbox.catbox.moe for one hour, and asks ' +
        'you every time." Then ask the questions below. Together they are the one ' +
        'confirmation: after it, do not ask again about a listed download, install, ' +
        'switch, config path, optional section or extra.',
    );
    expect(text).toContain(
      'With a multiple-choice question tool (Claude Code: `AskUserQuestion`, at most four ' +
        'questions per call and four choices per question), ask questions 1-4 in one call, ' +
        '5-8 in a second call straight after it, and 9-12 in a third call. Without such a ' +
        'tool, ask the same questions in one text message, in the same order and with the ' +
        'same wording. "No, change nothing" means stop without changing files, installing ' +
        'software, or downloading models.',
    );
    // The Git question and the two new ones share a third call, and a feature
    // whose files are all on disk gets the (Recommended) mark while an
    // impossible one is cut.
    expect(text).toContain(
      'Ask question 9 only when the survey found `user.name` or `user.email` empty. ' +
        'Ask question 11 only when the survey found servers under `mcp_servers` and no ' +
        '`~/.forge/policy.yaml`. In questions 7 and 8, mark a feature (Recommended) when ' +
        'the survey found all of its files, and leave out a feature the Features table ' +
        'marks "not possible here".',
    );
  });

  // The code defaults are the safe ones: terminal capture is off, and an MCP
  // tool missing from its server's `tool_permissions` asks before each call.
  // So this setup is the only place a user turns either one on, and both
  // questions plus what a yes writes are pinned here — including that the
  // trusted-MCP step sits between Step 7 (which it needs) and Step 8.
  it('asks about terminal capture and trusted MCP tools, and writes only what was picked', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      '10. **Your terminal** (one choice): "Should Forge\'s agent see the commands you run ' +
        'in your own VS Code terminals, and their output? That text goes to the model you ' +
        'chat with, which may be a cloud model." with "No, keep my terminal private ' +
        '(Recommended)" and "Yes, let it see them".',
    );
    expect(text).toContain(
      '11. **MCP tools** (multi-select): "Which MCP servers do you trust to run their tools ' +
        'without asking each time?" One choice per server the survey found (its `name`), up ' +
        'to four; the user can type more names in Other. Each choice\'s description: "Its ' +
        'tools run without a card, except in a chat that has read a secret file." Picking ' +
        'none keeps every MCP tool asking before each call.',
    );
    expect(text).toContain(
      '- "Yes, let it see them" (question 10): merge ' +
        '`"forge.terminal.watchUserCommands": true` into VS Code\'s user ' +
        '`settings.json` (Windows `%APPDATA%\\Code\\User\\settings.json`, macOS ' +
        '`~/Library/Application Support/Code/User/settings.json`, Linux ' +
        '`~/.config/Code/User/settings.json`; `Code - Insiders` in place of `Code` ' +
        'for VS Code Insiders), keeping its other settings and comments. "No" changes ' +
        'nothing: the setting is off by default.',
    );
    expect(text).toContain('## Step 7a — Trusted MCP tools');
    expect(text.indexOf('## Step 7a')).toBeGreaterThan(text.indexOf('## Step 7 '));
    expect(text.indexOf('## Step 7a')).toBeLessThan(text.indexOf('## Step 8 '));
  });

  // Step 0 questions 6-8 are the only place the user can say yes to an extra,
  // so the offers have to be in those questions: an agent that cannot ask a
  // second question would otherwise set up only what the user happened to name
  // in their first message.
  it('offers the four extras in the Step 0 question', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      '1. **Plan** (one choice): "Proceed with this setup plan?" with "Yes, proceed" and ' +
        '"No, change nothing".',
    );
    expect(text).toContain(
      '6. **Extras** (multi-select): "Set up any of these now?" - **Web search**: ' +
        'DuckDuckGo, no key, no account. - **Telegram**: chat with Forge from your phone. ' +
        'Needs your own bot from @BotFather; pairing code required. - **Other computer**: ' +
        "use models from another computer of yours, or share this one's (Tailscale). - " +
        '**Daily chat retitle**: rename idle chats each morning to say what they were ' +
        'about.',
    );
    // Web search was never offered, so a fresh install had none (laptop run 3,
    // 0.17.192), though DuckDuckGo needs no key.
    expect(text).toContain('- **Web search**: DuckDuckGo, no key, no account.');
    expect(text).toContain(
      'Run this section only when the user\'s setup request names web search or the ' +
        'user said yes to "Web search" in Step 0. Add this block to the config and set ' +
        '`permissions.net.search: true`; DuckDuckGo needs no key and no account:',
    );
    expect(text).toContain(
      '# partial: the search block only, not a whole config search: provider: duckduckgo max_results: 20',
    );
    expect(text).toContain(
      'Web search — not requested or declined; name it to follow Step 9 (DuckDuckGo, no key).',
    );
    // Added after the policy move, `search` in config.yaml stopped Forge
    // loading at all (laptop, 0.17.192).
    expect(text).toContain(
      '`search` and `permissions` are policy keys. Before Step 14 they go in the config, ' +
        'and the move carries them over. When `~/.forge/policy.yaml` already exists (a ' +
        'later run of this step), Forge refuses to load a config that holds them, and ' +
        "that file is the user's to edit: show the user the block and the " +
        '`net: { search: true, … }` line to add to `policy.yaml` themselves, then have ' +
        'them run **Developer: Reload Window**.',
    );
    // The switch that replaced the old "User files" optional item.
    expect(text).toContain(
      "- **Global note**: Add Forge's note to your global CLAUDE.md / AGENTS.md so your " +
        'agents can reach Forge from any folder.',
    );
    expect(text).toContain(
      'tell the user to run **Forge: Add Agent Note to My User Files** ' +
        '(`forge.agentMesh.installUserNote`)',
    );
    expect(text).toContain(
      'a missing `CLAUDE.md` is created holding only that import line',
    );
    expect(text).toContain(
      '9. **Git name and email** (one choice): "Name and email for your commits?" with ' +
        '"Skip" and "Set it now (type `Name <email>` in Other)".',
    );
  });

  // A fresh setup on the owner's laptop never offered image, video or music
  // generation at all: Steps 10-11 ran only when the first message named them,
  // and Step 0's questions never mentioned them. Every feature Forge can set up
  // now has a label line in question 7 or 8. Each line is pinned whole against
  // the raw doc, so it stays on one line the way a picker copies it (the same
  // rule `TrustSwitches.test.ts` holds the switch table to).
  it('offers every optional feature in Step 0 questions 7 and 8', () => {
    const labels = [
      '- **Image generation**: Make and edit pictures: locally with stable-diffusion.cpp (free, needs a GPU) or with a cloud key (billed per image).',
      '- **Video**: Short clips with LTX-2.5 through ComfyUI. Needs a large GPU.',
      '- **Music**: Songs with ACE-Step 1.5 through ComfyUI.',
      '- **Voice notes**: Talk to Forge on Telegram: voice notes are transcribed on this PC with whisper.cpp, and `/voice` reads replies aloud with Piper. Needs Telegram.',
      '- **Codebase index**: Search your code by meaning (`search_codebase`). A small embedding model runs on the CPU.',
      '- **Reverse image search**: Find where a picture appears online, with Yandex (fast, the default) and Google Lens. One SerpApi key covers both, and SerpApi has a free plan; each search uploads the image to litterbox.catbox.moe for one hour.',
      '- **Cloud models**: Add OpenRouter or OpenAI models next to the local ones. Needs your key; the provider bills you.',
      '- **Chats may start chats**: A chat may open a new chat or interrupt a running one (`message_chat` new / steer).',
    ];
    for (const line of labels) expect(doc, line).toContain(line);
    expect(doc).toContain('7. **Media** (multi-select): "Set up media generation?"');
    expect(doc).toContain('8. **More tools** (multi-select): "Add any of these?"');
    // "Voice notes" reaches Forge only over Telegram, so the pick has to say so.
    expect(doc.replace(/\s+/gu, ' ')).toContain(
      '"Voice notes" needs Telegram: picking it runs Step 8 too, and the plan summary ' +
        'says so.',
    );
  });

  // Codex followed the guide on the owner's laptop and never offered the Strata
  // or Maya engine, because no line in the guide named one. It also called video
  // and music "Not possible here": the 11 GB it measured against is Forge's own
  // `min_free_vram_mb` startup check, not the engine's minimum, and ACE-Step is
  // configured with CPU offload on. Each string below sits on one line in the
  // doc, so an agent or a picker copies it whole.
  it('asks whether to install Strata or Maya, and does not call a smaller GPU "not possible"', () => {
    for (const line of [
      '12. **Model engine** (one choice): "Install a local model engine on this PC?"',
      '- "llama.cpp" (question 12): Step 2, with a model that fits this PC.',
      '  - llama.cpp on this PC — not picked in question 12; name it to follow Step 2.',
      '## Step 12a — Optional: Strata or Maya engine',
      '- "Strata" or "Maya" (question 12): Step 12a.',
      "Forge's config, not the engine's own minimum.",
      '- Strata or Maya — not picked in question 12; name it to follow Step 12a.',
    ])
      expect(doc, line).toContain(line);
  });

  // The two media steps used to open only for a request that named them, and
  // Step 11 told the agent not to ask. A Step 0 pick now opens them too, and
  // the survey lists what each would download before anything is fetched.
  it('runs the media steps on a pick, not only when named', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).not.toContain('Do not ask whether to add it');
    expect(text).not.toContain(
      'Run this section only when the user\'s setup request names image generation',
    );
    expect(text).toContain(
      'Run this section when the user picked "Image generation" in Step 0 question 7, or ' +
        'the setup request names it.',
    );
    expect(text).toContain(
      'Run this section when the user picked "Video" or "Music" in Step 0 question 7, or ' +
        'the setup request names them.',
    );
    expect(text).toContain(
      'a **Features** table, one row per feature in questions 7 and 8: what is already on ' +
        'disk (paths), what is missing (exact filenames and sizes)',
    );
  });

  // The audited 4 GB laptop had no reason to pick a local backend: its desktop
  // already served 28 models over one read-only GET, and the guide never looked.
  // A host name is refused by the model starter, so the paragraph has to say IP.
  // That GET reaches computers other than this one, so it waits for the user's
  // yes: the survey itself may only check that the `tailscale` command exists.
  it('asks before it reads the other computer\u2019s model list, and never prints the git identity', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      '- Is Tailscale installed? Check only that the `tailscale` command exists ' +
        '(`tailscale version`); do not run `tailscale status` and do not contact any ' +
        'other machine during the survey.',
    );
    expect(text).toContain(
      '**Other computer, asked first.** When Tailscale is installed, ask one question ' +
        'before you choose the backend: "Use models from another of your computers over ' +
        'Tailscale?" with "Yes, look for them" and "No". Only after a yes, run ' +
        '`tailscale status` (it reads and changes nothing). For each other machine it ' +
        'lists, read `GET http://<its Tailscale IP>:8798/models` (read-only; use the ' +
        'IP, because Forge refuses a host name). Note every model whose `remote` is ' +
        '`true`, by `name`. A yes here is a yes to "Other computer" in question 6. ' +
        'After a no, or without Tailscale, do not contact any other machine.',
    );
    // The probe has to come after the ask. The bare needle "run `tailscale status`"
    // also matches the survey bullet's "do not run `tailscale status`", which sits
    // earlier in Step 0, so the affirmative instruction is pinned by its comma.
    const step0Start = text.indexOf('## Step 0');
    const step0End = text.indexOf('## Step 1');
    expect(step0Start).toBeGreaterThanOrEqual(0);
    expect(step0End).toBeGreaterThan(step0Start);
    const step0 = text.slice(step0Start, step0End);
    const askAt = step0.indexOf('"Yes, look for them"');
    expect(askAt).toBeGreaterThanOrEqual(0);
    expect(step0.indexOf(', run `tailscale status`')).toBeGreaterThan(askAt);
    expect(text).not.toContain('When Tailscale is installed, run `tailscale status`');
    // A privacy hook refused the printed value, so the survey reads exit status.
    expect(text).toContain(
      'Check whether `git config --global user.name` and ' +
        '`git config --global user.email` are set, from their exit status only; never ' +
        'print either value.',
    );
    expect(text).not.toContain('note whether either is empty');
  });

  // "Do not ask the user to choose" is what cost the laptop its default model:
  // the backend was still not the user's call, but the default model is.
  it('offers the other computer as a backend and asks only for the default model', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'Then choose the backend from the survey and state why; do not ask the user to ' +
        'choose the backend. The one thing you ask is which model is the default, in the ' +
        'Step 0 question:',
    );
    expect(text).toContain(
      `- **Other computer** \u2014 the user said yes to the question above and another ` +
        'of their computers serves models: this machine uses them through **Forge: ' +
        'Connect to my desktop** (Step 12), so a small GPU here does not matter. CLI ' +
        'models are added beside them when `claude` or `codex` is installed.',
    );
    expect(text).not.toContain('do not ask the user to choose:');
    expect(text).not.toContain('**one** backend');
  });

  // The ask must not cost the audited laptop its backend: a 4 GB machine whose
  // desktop serves models still reaches them, and Step 12 still reads Tailscale.
  it('keeps the small machine its path to the other computer after the ask', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      '**Forge: Connect to my desktop** (Step 12), so a small GPU here does not matter',
    );
    const step12Start = text.indexOf('## Step 12');
    const step12End = text.indexOf('## Step 13');
    expect(step12Start).toBeGreaterThanOrEqual(0);
    expect(step12End).toBeGreaterThan(step12Start);
    expect(text.slice(step12Start, step12End)).toContain('You may run only `tailscale status`');
  });

  it('recommends a default model in the plan summary, from either computer', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'the default model (`active_model`): your recommendation and up to three ' +
        'alternatives, chosen from the models the survey found here and on the other ' +
        'computer;',
    );
  });

  // Laptop setup run 4 (2026-11-20): GitHub's "latest" llama.cpp and
  // whisper.cpp releases carried no binaries, Piper's last release publishes no
  // `digest` at all so its install could not be checked, and image generation
  // was marked "not possible here" on a laptop whose desktop renders images
  // over the relay. The Piper rows and the yaml slot are pinned on the raw doc
  // (one line each); the rest is pinned after collapsing line wraps, as the
  // other pins here do. The source needle keeps the doc's quote of Connect's
  // message and `desktopConnectPlan.ts` from drifting apart.
  it('pins the run-4 setup fixes', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'take the newest one that carries the asset you need, not ' +
        '`/releases/latest`: a project\'s "latest" release can carry no binaries at all. ' +
        'This applies to every GitHub download in this file.',
    );
    for (const row of [
      '| `piper_windows_amd64.zip` | 22477236 | `f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea` |',
      '| `piper_linux_x86_64.tar.gz` | 26460462 | `a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992` |',
      '| `piper_linux_aarch64.tar.gz` | 26004717 | `fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb` |',
      '| `piper_macos_x64.tar.gz` | 19146927 | `ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b` |',
      '| `piper_macos_aarch64.tar.gz` | 19146957 | `6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc` |',
    ])
      expect(doc, row).toContain(row);
    expect(doc).toContain('voice_el: el_GR-rapunzelina-low');
    expect(text).toContain(
      'Image generation is "not possible here" only when this machine has no suitable GPU, ' +
        'no cloud image provider is configured, and "Other computer" is not in the plan.',
    );
    expect(text).toContain(
      '"turned on remote_media, so this laptop asks the desktop to render images"',
    );
    const connectSource = fs.readFileSync(
      path.join(root, 'src', 'vscode', 'desktopConnectPlan.ts'),
      'utf8',
    );
    expect(connectSource).toContain(
      'turned on remote_media, so this laptop asks the desktop to render images',
    );
  });

  // `servable: false` is what GET /models reports for a `provider: cli` or cloud
  // model (src/backend/ControlModelCatalog.ts), and /ensure and /chat refuse it.
  it('keeps the control-server model checks away from a model they cannot serve', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'Run `/ensure` only when `/models` lists the active model with `"servable": true`. ' +
        'Run `/chat` when the row has `"servable": true`, or `"route": "chat"` with ' +
        '`"availability": "ready"`: a cloud model or a desktop model from Step 12 is ' +
        'served elsewhere, so there is nothing here to load and `/chat` alone is its ' +
        'live test. Skip whichever does not apply and say so: a `provider: cli` model ' +
        "runs only inside a Forge chat, and Step 7's chat is its live test.",
    );
  });

  // Commit 2de15180: every model route refuses a request without the bearer
  // token that sits in the discovery record, and that record is written on every
  // platform. /ensure holds the model until /release drops its ref count, so the
  // checks have to release what they held.
  it('checks the control server with its token and releases the hold', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      "Read the control server's discovery record: " +
        '`%LOCALAPPDATA%\\forge-llm\\control-server.json` on Windows, ' +
        '`~/.forge/control-server.json` where `LOCALAPPDATA` is unset. Take the port ' +
        'from its `url` field instead of assuming the configured port or asking, and ' +
        'its `token` field for the `Authorization: Bearer <token>` header that every ' +
        'check below except `/healthz` needs. The token changes each time Forge ' +
        'starts, so read the file again after a reload. Never print the token or write ' +
        'it to a file.',
    );
    expect(text).toContain('GET http://127.0.0.1:<port>/healthz → {"ok":true}, no token needed');
    expect(text).toContain(
      'POST http://127.0.0.1:<port>/release {"model":"<active_model>"} → after /chat, only when /ensure ran',
    );
    expect(text).toContain(
      'A 401 means the token is missing or stale: read the file again and retry once. ' +
        '`/ensure` holds the model loaded until `/release` lets it go, so always send ' +
        'the `/release` after an `/ensure`, also when `/chat` failed.',
    );
    // A doc that still tells the agent the record may be missing asks for a port
    // it can just read, so the old wording has to stay out.
    expect(text).not.toContain('the registry path is `null`');
    expect(text).not.toContain('port question');
    expect(text).not.toContain('ask which port');
  });

  // Connect is registered only once a config is loaded, so it runs right after
  // the first reload and before Step 6's checks, for the chosen default to exist
  // when Step 6 checks it; and a survey that already read the list means the
  // user should not be walked through setup they already did.
  it('connects to the other computer before the first check and reuses the survey', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      "Run it right after Step 6's reload and before Step 6's checks: Forge registers " +
        '**Connect to my desktop** only once it has loaded a config, and its models must ' +
        'be in the config when Step 6 checks it.',
    );
    expect(text).toContain(
      'When the user said yes to "Other computer" in Step 0, run Step 12 now, after ' +
        'this reload and before the checks below.',
    );
    expect(text).toContain(
      'When Step 0 already read the other computer\'s list after the user\'s yes, ' +
        'skip items 1-3: that computer is shared and its access rule already lets this ' +
        'one in.',
    );
    expect(text).toContain(
      '5. When the user chose a model from the other computer as the default, set ' +
        '`active_model` to its name exactly as `GET /models` listed it, after ' +
        "Connect's message says it was added. Until then write `active_model: null` " +
        '(never `""`, which fails validation and leaves Forge in setup mode, where ' +
        '**Connect to my desktop** does not exist).',
    );
  });

  // A `provider: cli` chat has no Forge tools, so the manage_jobs request that
  // went there had nobody to answer it.
  it('sends the retitle job request to a chat whose model has Forge tools', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'A `provider: cli` model in a Forge chat has no `manage_jobs`, so open a new ' +
        'chat on a model that is not `provider: cli` with ' +
        '`forge.sh say <name> --new --model <that model>` and the message on stdin.',
    );
    expect(text).toContain(
      'When every configured model is `provider: cli`, skip this step and say so in ' +
        '**Finish**.',
    );
    expect(text).toContain("`forge.sh view <name> --to <the new chat's conversationId>`");
    expect(text).not.toContain('Send this to the chat Step 7 opened');
  });

  // The mesh is off by default (commit 2d663a06), so the step that used to
  // depend on Step 7 and on `forge.sh` has to work without either: it turns
  // scheduled jobs on in Step 5, and hands the request to the user to paste.
  it('creates the retitle job without the mesh when Talk to Forge was not picked', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      '- "Daily chat retitle" (question 6): `jobs.enabled: true`; Step 13 creates the job.',
    );
    expect(text).toContain(
      'Run this section only when the user said yes to "Daily chat retitle" in Step 0, ' +
        "after Step 6's checks passed (and Step 7's, when it ran).",
    );
    expect(text).toContain(
      'When the user did not pick "Talk to Forge", `forge.sh` cannot reach Forge: ' +
        'give the user the message below to paste into a new Forge chat on such a ' +
        'model, and ask them for the job name and id it reports.',
    );
    expect(text).toContain(
      "`forge.sh view <name> --to <the new chat's conversationId>`; it names the " +
        'created job and its id. Without the mesh, the user reports them.',
    );
  });

  // The control server is the only switch the starter turns on; the browser and
  // desktop tools follow the user's Step 0 picks, so Finish has to say which
  // ones are on rather than promise they all were.
  it('tells the truth about the browser and desktop tools in Finish', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'The browser tool and desktop control are on only if the user picked them in Step 0 ' +
        "(each new website is approved once per session, and VS Code's own window stays " +
        'off limits); `permissions.browser.enabled` and `permissions.desktop.enabled` ' +
        'change either.',
    );
    expect(text).not.toContain('browser tool stays off');
    expect(text).not.toContain('desktop control start on');
  });

  it('gates each optional step on the Step 0 answer and keeps the agent out of the user\u2019s network', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'Run this section only when the user\'s setup request names Telegram or the user ' +
        'said yes to Telegram in Step 0. Do not ask about it again.',
    );
    expect(text).toContain(
      'You may run only `tailscale status`, which reads and changes nothing.',
    );
    expect(text).toContain(
      '{"action": "accept", "src": ["<this computer or your user>"], "dst": ["<main computer>:8797,8798"]}',
    );
    // The policy move must be the last step: once policy.yaml exists, a
    // config.yaml still holding a security key is refused, so any later config
    // edit would break the setup it just checked.
    expect(text).toContain('Move the security settings into policy.yaml');
    expect(text).toContain('(`forge.movePolicy`)');
  });

  it('runs the policy move as the last step, before Finish', () => {
    const headings = [...doc.matchAll(/^## (Step \d+|Finish)\b/gm)].map((m) => ({
      title: m[1],
      at: m.index ?? -1,
    }));
    const step14 = headings.find((h) => h.title === 'Step 14');
    const finish = headings.find((h) => h.title === 'Finish');
    expect(step14).toBeDefined();
    expect(finish).toBeDefined();
    const others = headings.filter((h) => h.title.startsWith('Step') && h.title !== 'Step 14');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((h) => h.at < step14!.at)).toBe(true);
    expect(step14!.at).toBeLessThan(finish!.at);
  });

  it('sends manage_jobs a definition it can create, with no id of its own', () => {
    const marker = 'Create this job with manage_jobs: ';
    const at = doc.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const rest = doc.slice(at + marker.length);
    const definition = JSON.parse(rest.slice(0, rest.indexOf('\n'))) as Record<string, unknown>;
    // `manage_jobs create` derives the id from the name and adds version and
    // the timestamps (src/tools/jobTools.ts): a doc that sends them would be
    // pinning values the tool owns.
    expect(Object.keys(definition)).not.toContain('id');
    expect(
      JobSchema.safeParse({
        version: 1,
        id: 'daily-chat-retitle',
        created_at: 0,
        updated_at: 0,
        ...definition,
      }).success,
    ).toBe(true);
  });

  it('names only commands the extension contributes', () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    // Written as **Title** (`forge.id`); the parentheses keep `forge.sh` out.
    const named = [...doc.matchAll(/\(`(forge\.[A-Za-z.]+)`\)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((id) => !contributed.has(id))).toEqual([]);
  });

  it('names only config files that ship with the extension', () => {
    const named = [...doc.matchAll(/`(config\/[\w./-]+\.ya?ml)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((file) => !fs.existsSync(path.join(root, file)))).toEqual([]);
  });

  it('uses only top-level keys the config schema knows, and shows examples that parse', () => {
    const known = new Set(Object.keys(ForgeConfigSchema.shape));
    const blocks = yamlBlocks(doc);
    expect(blocks.length).toBeGreaterThan(0);
    const keys = blocks
      .map((block) => parse(block.content))
      .filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      )
      .flatMap((value) => Object.keys(value));
    expect(keys.filter((key) => !known.has(key))).toEqual([]);
    // The keys being legal is not the check: four README examples once had
    // every key right and the shape of `models:` wrong.
    const failures = blocks
      .filter((block) => block.content.trim().length > 0)
      .flatMap((block) =>
        validateConfigExample(block.content).map(
          (error) => `AI_SETUP.md:${String(block.fenceLine)} ${error}`,
        ),
      );
    expect(failures).toEqual([]);
  });

  it('marks every fragment as partial', () => {
    const unmarked = yamlBlocks(doc)
      .filter((block) => !isPartialExample(block.content))
      .filter((block) => validateConfigExample(block.content).length > 0)
      .map((block) => `AI_SETUP.md:${String(block.fenceLine)}`);
    expect(unmarked).toEqual([]);
  });

  it('has the setup agent look for Git Bash on Windows instead of assuming it', () => {
    // The audited laptop had no Git for Windows, so the client it sent the
    // agent to run could not run, and the file assumed
    // `C:\\Program Files\\Git\\bin\\bash.exe` existed. An agent that follows
    // this file literally has to be told to look first, where a per-user Git
    // puts its bash, and what to say when there is no Git at all.
    const step7 = doc.slice(doc.indexOf('## Step 7'), doc.indexOf('## Step 8'));
    expect(step7.length).toBeGreaterThan(0);
    expect(step7).toContain('Get-Command git.exe');
    expect(step7).toContain('Git for Windows');
    expect(step7).toContain('winget install --id Git.Git -e');
    expect(step7).toMatch(/LOCALAPPDATA.*Git|per-user/i);
    // The plan confirmation authorizes the listed install; only OS prompts
    // return to the user.
    expect(step7).toContain('After the confirmation');
    expect(step7).toContain('stop only for any Windows prompt');
    expect(step7).not.toMatch(/ask first[^.]*never install unasked/i);
    // The check comes before the run: an agent that runs the example first
    // fails on a machine with no Git and has nothing to tell the user.
    const checkAt = step7.indexOf('git --exec-path');
    const runAt = step7.indexOf('bash.exe>" ~/.forge/agent-bus/forge.sh');
    expect(checkAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(checkAt);
    // WSL is why bare `bash` is not a fallback, and this file has to give the
    // reason, not just the rule: WSL's home is not the Windows profile that
    // holds `~/.forge/agent-bus`.
    expect(step7).toContain('WSL');
    expect(step7).toMatch(/WSL[^"]*\$HOME|whose [^"]*home|WSL.s home/i);
    expect(step7).not.toMatch(/(^|\s)bash ~\/\.forge/u);
  });

  it('ships in the VSIX', () => {
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n');
    expect(ignore).toContain('!AI_SETUP.md');
  });

  // The state × lifecycle ledger row for config.yaml (docs/plans/AI_SETUP_HANDOFF_PLAN.md):
  // a crashed agent must leave either the old config or its backup behind.
  it('tells the agent to back up an existing config before replacing it', () => {
    expect(doc).toContain('config.yaml.bak');
  });
});

describe('agentSetupPrompt', () => {
  it('pins the entire setup prompt for a workspace config', () => {
    expect(agentSetupPrompt('/ext', '/global/config.yaml', '/ws/.forge/config.yaml')).toBe(
      [
        'Set up the Forge LLM VS Code extension on this machine.',
        `Follow the instructions in ${path.join('/ext', 'AI_SETUP.md')} step by step.`,
        'The extension is installed at /ext.',
        'Forge reads its config from one of: global config: /global/config.yaml; workspace config: /ws/.forge/config.yaml.',
        "Follow AI_SETUP.md's single confirmation and human-only stops; complete the named setup sections without further questions.",
      ].join('\n'),
    );
  });

  it('pins the entire setup prompt when no workspace is open', () => {
    expect(agentSetupPrompt('/ext', '/global/config.yaml', undefined)).toBe(
      [
        'Set up the Forge LLM VS Code extension on this machine.',
        `Follow the instructions in ${path.join('/ext', 'AI_SETUP.md')} step by step.`,
        'The extension is installed at /ext.',
        'Forge reads its config from one of: global config: /global/config.yaml; workspace config: none (no folder is open in VS Code).',
        "Follow AI_SETUP.md's single confirmation and human-only stops; complete the named setup sections without further questions.",
      ].join('\n'),
    );
  });
});
