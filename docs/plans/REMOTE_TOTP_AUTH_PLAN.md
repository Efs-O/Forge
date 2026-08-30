# Remote TOTP Session Authentication Plan

Status: implementation plan
Target baseline: `main` after the remote-control implementation
Primary rollout: Telegram

## 1. Goal

Add a hard Google Authenticator-compatible TOTP gate in front of Forge remote control.

Pairing continues to establish **who the remote owner is**. TOTP establishes **whether that owner is currently allowed to use the remote session**.

The security invariant is intentionally simple:

> Until the paired owner successfully completes TOTP authentication for the current in-memory auth session, no remote message, command, approval action, conversation operation, status query, model action, or agent request may reach Forge's normal remote-control surface.

After successful authentication, the owner receives the **same full remote Forge access that exists today**. This feature does not add a second permission model and does not alter Forge-native, CLI-provider, tool-approval, sandbox, deny-list, checkpoint, or conversation semantics.

## 2. Fixed product decisions

1. Google Authenticator compatibility uses standard RFC 6238 TOTP. There is no Google API, Google account, or network dependency.
2. The TOTP secret is generated locally by Forge and stored only in VS Code `SecretStorage`.
3. TOTP enrollment/reset is a **local VS Code action only**. The secret or QR code is never bootstrapped or recovered through Telegram.
4. Remote authentication state is memory-only. It is never written to `remote-state-v1.json`, config YAML, global state, logs, or SecretStorage.
5. Extension activation/reload/host restart starts remote auth in `LOCKED` state.
6. There is no short fixed authenticated-session lifetime.
7. There is a configurable inactivity timeout. Legitimate authenticated owner activity resets it.
8. Inactivity expiry locks remote control only. It does **not** cancel an agent task that is already running.
9. `/lock` immediately destroys the current remote auth session.
10. While locked, a normal text message from the paired owner causes Forge to ask for the authenticator code.
11. While waiting for the code, the next valid six-digit text is consumed strictly by the auth gate and is never routed to the LLM or command handler.
12. `/auth 123456` remains available as an explicit/fallback authentication form.
13. A successful TOTP authentication may wake/start the normal Forge model runtime as needed by the first accepted agent request. Authentication itself must not create a separate model execution path.
14. After authentication, existing remote access is unchanged and complete.
15. The initial implementation should keep the auth gate transport-independent in core code even if Telegram is the first UX exercised and documented.

## 3. Existing architecture and insertion point

Current ingress in `RemoteController.handle()` is approximately:

```text
provider event
  -> schema validation
  -> private-chat requirement
  -> paired-owner check / pairing exception
  -> rate limit
  -> approval callback OR remote command OR prompt admission
  -> ForgeHostFacade
```

The TOTP gate belongs **after paired-owner verification and before every existing owner-authorized branch**.

New ingress:

```text
provider event
  -> schema validation
  -> private-chat requirement
  -> paired-owner check
       -> if not owner: existing bounded /pair flow only
  -> remote TOTP session gate
       LOCKED / AWAITING_TOTP:
         -> auth protocol only
         -> no command handler
         -> no approval callback
         -> no request store admission
         -> no ForgeHostFacade operation
       AUTHENTICATED:
         -> existing rate limit / callbacks / commands / prompts
  -> existing Forge remote behavior unchanged
```

This placement is the core security boundary. Do not implement TOTP as a command inside `RemoteCommandHandler`; that would leave callbacks and other ingress paths outside the gate.

## 4. Authentication state machine

Use an explicit per-transport/per-owner in-memory session state.

```text
LOCKED
  | paired owner sends ordinary text or /auth
  v
AWAITING_TOTP
  | correct current TOTP
  v
AUTHENTICATED
  | /lock, inactivity expiry, owner change, unpair,
  | extension/runtime restart, security reset
  v
LOCKED
```

Suggested runtime record:

```ts
type RemoteAuthState = 'locked' | 'awaiting_totp' | 'authenticated';

interface RemoteAuthSession {
  channel: 'telegram' | 'whatsapp';
  ownerId: string;
  state: RemoteAuthState;
  authSessionNonce?: string;
  authenticatedAt?: number;
  lastActivityAt?: number;
  acceptedTotpStep?: number;
  failedAttempts: number;
  lockedOutUntil?: number;
}
```

The implementation may key this by channel if only one paired owner exists per channel today. Do not persist this record.

### LOCKED behavior

For a paired owner:

- Ordinary text such as `hello` is consumed locally and Forge replies: `Authentication required. Enter your 6-digit authenticator code.`
- `/auth` with no code may produce the same prompt.
- `/auth 123456` may verify immediately.
- Provider callback/action events are rejected as unauthenticated and must not reach approval resolution.
- Other slash commands are not executed.
- No conversation binding is created.
- No request is admitted or queued.
- No status/session/context information is disclosed.

### AWAITING_TOTP behavior

- A six-digit text message is treated only as a TOTP candidate.
- `/auth 123456` is also accepted.
- Invalid input remains inside the auth protocol; it never falls through to normal routing.
- Correct code creates a fresh authenticated session nonce and enters `AUTHENTICATED`.
- Incorrect code remains unauthenticated and participates in failure throttling.

### AUTHENTICATED behavior

- Existing remote behavior runs unchanged.
- Every legitimate owner interaction refreshes `lastActivityAt`, including prompts, slash commands, status calls, approval/deny callbacks, and other accepted control actions.
- `/lock` is intercepted as an auth command and immediately returns the session to `LOCKED`.

## 5. TOTP enrollment and local management

Extend the existing `Forge: Configure Remote Control` local flow with actions such as:

- `Set up authenticator`
- `Reset authenticator`
- `Disable authenticator` (only if the product intentionally permits disabling it)
- optionally `Remote authentication status`

Recommended hard-security behavior for this rollout:

- TOTP is considered enabled only after a secret has been generated and enrollment explicitly confirmed locally.
- Existing installations are not silently bricked merely because the extension updates before enrollment.
- Once TOTP is enabled for a remote transport/owner, there is **no remote bypass or recovery path**. Reset/re-enrollment is local-only.
- Unpairing an owner invalidates any live auth session immediately.

Enrollment procedure:

1. Local Forge command generates at least 160 bits of cryptographically secure random secret; 256 bits is acceptable.
2. Encode using Base32 without exposing padding requirements to the user.
3. Construct a standard URI, for example conceptually:
   `otpauth://totp/Forge:<label>?secret=<base32>&issuer=Forge&digits=6&period=30`
4. Display a QR code locally and optionally the Base32 secret for manual entry.
5. Ask the user for one current six-digit code locally to prove enrollment before marking TOTP enabled.
6. Store the secret in `SecretStorage` only after, or atomically with, successful enrollment confirmation.

Use the widest-compatible TOTP defaults unless there is a compelling reason otherwise:

- HMAC-SHA1
- 6 digits
- 30-second period

Do not add a third-party network service for QR generation. QR rendering must be local/offline.

## 6. Verification rules

Implement verification in a small testable component, preferably by extending/refactoring `RemoteAuth` rather than scattering auth logic through the controller.

Requirements:

- Constant-time comparison for candidate versus expected code.
- Accept the current 30-second step and optionally `±1` adjacent step for reasonable clock skew. If `±1` is used, replay protection below is mandatory.
- Record the accepted TOTP timestep in the in-memory auth session.
- Reject reuse of a timestep already accepted for that session. A captured code therefore cannot be submitted twice to create/recreate authorization within the same runtime session.
- Never include supplied codes, expected codes, TOTP secret, or otpauth URI in logs/audit records.
- Generic remote failure response such as `Authentication failed.` Do not reveal whether the code was expired, malformed, replayed, or outside the skew window.

## 7. Failed-attempt throttling

Authentication failure throttling is separate from the ordinary remote request rate limiter because it protects a much smaller credential space.

Recommended initial policy:

- Count failed TOTP attempts for the paired owner/session.
- After 5 failed attempts, impose a temporary lockout, e.g. 5 minutes.
- During lockout, no TOTP verification work succeeds and no normal routing occurs.
- Successful authentication resets failure counters.
- Restart must not accidentally turn a failed code into access; however, persistent brute-force counters are optional for the first implementation because the owner ID + Telegram account possession is already the first factor. If counters remain memory-only, document this explicitly.

Do not send verbose diagnostics remotely. Local diagnostic logging may record events such as `auth_failed`, `auth_locked_out`, `auth_succeeded`, and `auth_session_locked`, but never credential material.

## 8. Auth-session nonce and stale callback protection

Successful authentication generates a fresh cryptographically random `authSessionNonce`.

Remote approval prompts created during an authenticated session must be bound to that nonce in addition to their existing approval ID/chat ownership.

Conceptually:

```ts
remoteApprovals.set(approvalId, {
  requestId,
  chatId,
  authSessionNonce,
});
```

An approval callback is valid only when:

1. the sender is still the paired owner;
2. the remote auth session is currently authenticated;
3. the callback belongs to the correct chat;
4. the stored approval nonce equals the current auth-session nonce;
5. the approval is still pending and not resolving.

After `/lock`, inactivity expiry, restart, unpair, re-authentication, or auth reset, old inline approval buttons must not regain authority. They may remain visible if Telegram cannot retract them, but pressing them must fail closed.

Do not cancel the underlying running agent merely because remote auth expires. The local/sidebar approval surface may continue to resolve the tool request according to existing semantics.

## 9. Inactivity timeout

Add one shared remote configuration value, in minutes, used by all relevant surfaces.

Proposed config shape:

```yaml
remote:
  auth:
    inactivity_timeout_minutes: 30
```

`off` may map to `0` or an explicit disabled value internally; schema/config semantics should choose one canonical representation.

Default: **30 minutes**.

Telegram owner commands, available only after authentication:

```text
/timeout        -> show current inactivity timeout
/timeout 30     -> set to 30 minutes
/timeout 60     -> set to 60 minutes
/timeout off    -> disable inactivity locking
```

Do not support ambiguous bare commands such as `/30`.

The same setting must be editable locally through Forge's configuration/settings surface. Telegram and local UI/config are two views of the same durable value, not separate timers.

Validation should define sane bounds, for example 1–1440 minutes when enabled. Exact bounds can follow Forge config conventions.

### Activity definition

Refresh inactivity only for a message/action from the authenticated paired owner that is valid enough to be handled by the authenticated remote surface. Recommended examples:

- agent prompt accepted/queued;
- recognized remote command;
- `/status`;
- approval/deny callback;
- authenticated control action.

Do not refresh activity for messages from other senders, invalid unauthenticated attempts, provider noise, delivery retries, outbound notifications, or background agent output.

### Expiry semantics

When `now - lastActivityAt >= timeout`:

- atomically/fail-closed transition to `LOCKED` before processing the next protected inbound event;
- destroy/replace the auth-session nonce;
- reject stale callbacks;
- require TOTP again;
- do not cancel a running request;
- do not dequeue or replay work merely because auth expired.

A timer may proactively lock the session, but correctness must not depend on timer scheduling. Every protected inbound event must check expiry before authorization.

## 10. Llama-server/runtime behavior

Authentication is an authorization gate, not a new inference path.

Desired user experience:

```text
hello
  -> Forge: Authentication required...
123456
  -> Forge: Authenticated.
next prompt
  -> existing Forge send path
  -> normal model resolution / llama-server start-or-wake if required
```

If the existing runtime has a safe, explicit warm/start hook that can be invoked without creating a turn, implementation may optionally pre-warm after successful auth. Otherwise do **not** add a special server-start mechanism solely for authentication; let the first normal prompt exercise existing model lifecycle code. Security is more important than making authentication itself spawn a server.

A failed/locked authentication must never cause model startup because no normal request reaches `ForgeHostFacade.send()`.

## 11. Pairing interaction

The existing `/pair <8-digit-code>` flow remains the sole pre-owner enrollment exception.

Required ordering:

```text
not paired
  -> only exact existing pairing protocol can establish owner

paired but not TOTP authenticated
  -> only auth protocol can unlock session

authenticated
  -> full existing remote control
```

Pairing success should leave the new owner **LOCKED**, not automatically authenticated.

Owner replacement/unpair must purge the associated in-memory TOTP auth session and invalidate approval nonces.

Whether the TOTP secret is per transport or one Forge-wide authenticator secret should be explicit in implementation. Recommended first implementation: one Forge remote TOTP secret can protect all paired transports, while authenticated session state remains per transport/owner. This keeps Google Authenticator enrollment simple without sharing live authorization between Telegram and WhatsApp.

## 12. Config and command integration

Likely touched areas based on current `main`:

### `src/remote/RemoteAuth.ts`

Refactor/extend from pairing-only responsibilities to include:

- TOTP secret-key naming;
- enrollment lifecycle helpers;
- TOTP verification;
- in-memory auth sessions;
- inactivity expiry;
- auth session nonce;
- failure lockout/replay protection;
- lock/unpair invalidation.

If this becomes too broad, split TOTP/session logic into `RemoteSessionAuth.ts` while keeping `RemoteAuth` as the owner/pairing facade. The security boundary should still expose one clear API to `RemoteController`.

### `src/remote/RemoteController.ts`

- Insert hard auth gate immediately after paired-owner verification and before current rate limiter/action/command/prompt branches.
- Ensure action callbacks cannot bypass the gate.
- Bind remote approval entries to current auth-session nonce.
- Refresh inactivity on valid authenticated owner activity.
- Add `/lock` interception or route it through an auth-aware command context without allowing it to bypass the gate.
- Supply auth/config callbacks needed by `/timeout`.

### `src/remote/RemoteCommandHandler.ts`

- Add authenticated-only `/timeout`, `/timeout <minutes>`, `/timeout off`.
- Update `/help`.
- Do not make TOTP verification depend on reaching this handler.

### `src/remote/RemoteRuntime.ts`

- Pass current auth settings into controller/session auth.
- Expose local authenticator setup/reset/status methods.
- Ensure runtime replacement/reconfiguration locks all sessions.
- Extend validation status with TOTP enrollment/auth configuration information without exposing secrets.

### `src/config/types.ts` and config schema/default/loader files

Add the shared inactivity setting and any explicit TOTP-enabled flag selected by implementation.

Do not store the TOTP secret in YAML.

### `src/vscode/remoteCommands.ts`

Add local enrollment/reset/status actions to `Forge: Configure Remote Control`.

Local enrollment should show the QR/secret and verify one code. Do not expose the secret through a remote command.

### `package.json`

Register any new local VS Code commands.

### `src/remote/TelegramChannel.ts`

Ideally no security logic beyond rendering/sending messages. The core gate belongs above the transport. Change only if Telegram-specific UX (for example removing an old auth prompt) genuinely needs it.

### Tests

Extend current `RemoteCore`, `RemoteHardening`, and Telegram tests; add a focused auth unit suite if cleaner.

## 13. Durable queue and running-work rules

Authentication changes **new remote authority**, not the meaning of already-durably-admitted work.

- A request admitted while authenticated follows the existing durable request lifecycle even if auth later expires.
- Locking does not silently cancel a running request.
- Existing queued work that was already durably accepted must not be duplicated or re-admitted through auth transitions.
- Auth expiry must not mutate request state merely to enforce the UI lock.
- New prompts and new control commands are blocked until re-authentication.

Implementation should review startup recovery of already-queued requests. Recovery is internal execution of previously authorized durable work, not a fresh remote command, so it should preserve the existing crash/recovery semantics rather than becoming dependent on a newly authenticated Telegram session.

## 14. Audit/privacy rules

The current audit path records inbound events before owner authorization. TOTP introduces sensitive message content, so this must be reviewed carefully.

**Hard requirement:** raw TOTP candidate text must not be written to `RemoteAuditLog`.

The safest change is to classify/redact auth-protocol events before audit persistence, recording only metadata/outcome such as:

```text
auth_challenge
auth_success
auth_failure
auth_lockout
auth_locked
auth_expired
```

Never persist:

- six-digit supplied code;
- expected code;
- TOTP secret;
- Base32 enrollment secret;
- otpauth URI;
- QR payload;
- auth-session nonce.

This audit ordering issue is an implementation blocker: simply inserting verification after the existing `audit.record(event, 'inbound')` would leak authenticator codes into audit storage.

## 15. Security regression matrix

Implementation is not complete until automated tests demonstrate at least the following:

1. Unpaired sender cannot trigger TOTP challenge or any Forge operation.
2. Existing exact `/pair` path still works and pairing leaves session locked.
3. Paired+locked `hello` returns challenge and creates no conversation/request.
4. Paired+locked `/status`, `/new`, `/compact`, `/clanker`, `/stop`, `/timeout`, normal prompts are blocked from their handlers.
5. Paired+locked approval callback cannot call `resolveApproval`.
6. Six-digit code while awaiting auth is never admitted as an LLM prompt.
7. Wrong code leaves session locked.
8. Correct current TOTP authenticates.
9. Adjacent-step behavior matches the chosen skew policy.
10. Reuse of an already accepted TOTP timestep is rejected where replay protection applies.
11. Five failed attempts cause configured temporary lockout.
12. Auth codes do not appear in remote audit records.
13. Auth secret never appears in config or durable request store.
14. Successful auth creates a new nonce.
15. Normal prompt after auth follows unchanged request admission/send path.
16. Existing remote commands work after auth.
17. Existing approval callback works after auth when nonce matches.
18. `/lock` immediately blocks subsequent prompts/commands/callbacks.
19. Old approval callback fails after `/lock` and re-auth.
20. Old approval callback fails after inactivity expiry.
21. Old approval callback fails after runtime restart/reconfigure.
22. Expired session checks expiry on ingress even if a scheduled timer did not fire.
23. Valid owner activity refreshes inactivity timestamp.
24. Outbound notifications/background model output do not refresh inactivity.
25. Inactivity expiry does not cancel an already-running agent request.
26. Already-durable queued work keeps existing recovery semantics across auth expiry/restart.
27. `/timeout` reports current value only while authenticated.
28. `/timeout 30` updates the same config value visible locally.
29. `/timeout off` disables inactivity expiry without disabling TOTP at restart/manual lock.
30. Invalid timeout values fail without changing configuration.
31. Extension/runtime restart always starts locked even if previous session was authenticated.
32. Unpair invalidates live auth and stale approval authority.
33. A Telegram provider action event cannot masquerade as an auth response.
34. Authentication failure never starts/wakes a model through the normal send path.
35. CLI and Forge-native providers retain exactly their existing post-auth permission behavior.

## 16. Implementation sequence

1. Add TOTP primitive + deterministic RFC test vectors.
2. Add local secret enrollment/storage API.
3. Add in-memory auth-session state machine and failure/replay logic.
4. Add inactivity configuration/default/schema support.
5. Put the auth gate at `RemoteController` ingress before callbacks/commands/prompts.
6. Redact/reorder audit handling so auth candidates are never persisted.
7. Bind approvals to auth-session nonce.
8. Add `/lock` and authenticated-only `/timeout` commands.
9. Add local VS Code enrollment/reset/status UX and QR rendering.
10. Add runtime validation/status fields.
11. Land bypass/regression tests.
12. Perform real-device Telegram validation with Google Authenticator on iOS/Android-compatible standard TOTP.

## 17. Real-device acceptance flow

Expected normal use:

```text
User -> Telegram bot: hello
Forge -> User: Authentication required. Enter your 6-digit authenticator code.
User -> Google Authenticator: reads current code
User -> Telegram bot: 583214
Forge -> User: Forge authenticated.
User -> Telegram bot: inspect the failing tests and fix them
Forge -> existing full remote agent path
```

Expected inactivity flow:

```text
... no authenticated owner interaction for configured timeout ...
Forge auth session -> LOCKED
running task, if any -> continues
next owner interaction -> receives TOTP challenge
correct code -> full remote access restored
```

## 18. Non-goals

This change does not:

- create a new Forge permission system;
- make Telegram a generic shell endpoint;
- weaken or strengthen CLI provider permissions beyond their current local behavior;
- cancel agent work merely because the phone session locks;
- depend on Google servers;
- store TOTP codes or secrets in the remote request store;
- implement remote credential recovery;
- treat Telegram account ownership alone as sufficient once TOTP is enabled.

## 19. Review gate before implementation

Before coding, review this plan specifically for **authentication bypasses**, not general style. The reviewer should answer these questions:

1. Is there any inbound path in current `main` that can reach `ForgeHostFacade`, `RemoteCommandHandler`, approval resolution, durable request admission, or sensitive status before TOTP succeeds?
2. Can Telegram callback/action events bypass the text-auth state machine?
3. Can audit/logging persist a supplied TOTP candidate?
4. Can a stale approval created under an old auth session be resolved after lock/re-auth/restart?
5. Can inactivity expiry race with ingress and accidentally authorize one more action?
6. Can pairing, reconfiguration, crash recovery, queue draining, or runtime startup create an unintended auth bypass?
7. Is local enrollment/reset the only path that can reveal/change the TOTP secret?

Implementation should begin only after these invariants are answered cleanly.
