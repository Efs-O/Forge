# image_search delivery budget — plan

**Status: DRAFT — not implemented.**
Written 2026-10-03. Found by Codex while reviewing Phase 1 of
`docs/plans/SEND_FILE_AND_RENDER_HTML_PLAN.md`; recorded there as follow-up 4 and
in `src/sidebar/UserNotificationService.ts` as a "KNOWN GAP, not a rule".

Implementation prerequisite: a base containing `deliverFile` and
`FILE_DELIVERY_TURN_LIMIT` (`2e9304d` onward, present on the current
`feat/send-file-and-render-html` branch). Verify that commit is in the chosen
base before implementation; this plan does not assume `main` has merged it.

---

## The defect

`UserNotificationService` has two delivery paths and the difference is two lines:

```ts
// src/sidebar/UserNotificationService.ts:230  — budgeted
async deliverFile(event) {
  const spent = this.filesSpent(key);
  if (spent >= FILE_DELIVERY_TURN_LIMIT) return { kind: 'refused', … };
  this.filesSent.set(key, spent + 1);
  return { kind: 'queued', chats: await this.fanOut(event) };
}

// src/sidebar/UserNotificationService.ts:208  — unbudgeted
async deliverImage(event) {
  return this.fanOut(event);          // no check, no counter
}
```

`deliverImage` is described as exempt because `generate_image` confirms each
call (`UserNotificationService.ts:192-206`). That premise is conditional:
`generate_image` can use `confirm_each: false` — opt-in, since the schema
defaults it to **true** (`imageGenerationSchema.ts:29`) — which makes its
approval non-dangerous unless a local backend needs startup confirmation
(`generateImageTool.ts:95-115`; `imageGenerationSchema.ts:25-29,55-56`).
A non-dangerous approval still prompts in normal mode, but `/clanker` and
unattended conversations auto-approve it (`ToolApprovalService.ts:110-122`) —
that is the unprompted route.
`image_search` also uses this unbudgeted path in its default config:

```ts
// src/tools/imageSearch/imageSearchTool.ts:99
approval: (args) => {
  if (!config?.confirm_upload || args['image_url'] !== undefined) return undefined;
  return { dangerous: false, detail: 'Upload attached image #… to Litterbox …' };
}
```

`src/config/imageSearchSchema.ts:22` defaults `confirm_upload` to **false**, so
`approval` returns `undefined` and `ToolDispatch` never prompts. And the tool
sends once **per thumbnail in a loop**:

```ts
// src/tools/imageSearch/imageSearchTool.ts:221-236
for (const [index, thumbnail] of saved.entries()) {
  … await deps.notifications.deliverImage({ …, imagePath: thumbnail.absolutePath });
}
```

So: **one `image_search` call queues up to `thumbnails` photos (default 4,
schema allows 8) with no approval and no cap.** Ten calls can queue 40 photos
in one turn. A configured `generate_image` backend with `confirm_each: false`
has the same uncapped route under `/clanker` or in an unattended conversation.

Two secondary facts about the same gate, both worth stating so the fix is not
mistaken for "just turn the approval on":

- `confirm_upload` guards a **different** thing: a *local attachment leaving the
  machine* to Litterbox for the reverse search. It says nothing about the
  thumbnails coming *back* to the phone.
- It is skipped entirely when the caller passes `image_url` (a public URL is
  already public). So even with `confirm_upload: true`, a URL-based search
  delivers its thumbnails unbudgeted and unapproved.

## The invariant this plan restores

> Every photo or file queued without approval for that call spends one slot
> from the conversation's per-turn file budget.

`image_search` always counts. `generate_image` counts when its selected backend
has `confirm_each: false`; when true, its per-call approval is the brake.
The exemption must be explicit at each call site.

## Headline finding: the cap and the thumbnail count disagree

`FILE_DELIVERY_TURN_LIMIT` is 5 (`UserNotificationService.ts:24`, aliased to
`NOTIFY_TURN_LIMIT`). `image_search.thumbnails` is `0..8`
(`src/config/imageSearchSchema.ts:27`).

**A search with `thumbnails: 6, 7 or 8` can never deliver every thumbnail in a
fresh turn.** An all-or-nothing reservation would deliver none. The design
below atomically grants the prefix that fits and reports what was withheld.

## Why the naive fix is wrong

Routing the loop through `deliverFile` looks like two lines and produces three
defects:

1. **Silent truncation of an atomic result set.** Captions are numbered
   `🔎 1/4`, `2/4`, … A 4-thumbnail search with 2 slots left sends `1/4` and
   `2/4` and stops. The user cannot tell whether 3 and 4 failed, were withheld,
   or do not exist.
2. **Wrong refusal text.** `deliverFile`'s reason is *"give the user that path
   instead of sending it"* — singular, written for one file an agent chose. It is
   nonsense for a result set.
3. **N independent decisions instead of one.** Each loop iteration consults the
   budget separately, so partial delivery becomes the normal outcome rather than
   a named edge case.

---

## State × lifecycle ledger

The budget is in memory and resets at turn start (`extension.ts:248-257`).
The thumbnails are durable workspace files (`imageThumbnails.ts:17-21,88-112`).
This plan changes when they are *sent*, not how they are written or pruned; their
rows record existing behaviour so a later storage change has cells to update.

| Artifact | create | delete | pause / disable | crash mid-write | owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| Per-conversation budget and leases | `reserveFileDeliveries` charges only the granted count synchronously; `deliverFile` uses the same owner | `resetTurn` deletes that turn's budget object and invalidates its leases, including the `\0no-conversation` bucket | `thumbnails: 0` makes no reservation; turning off the tool starts no new work | In-memory update has no file tear | Counter and unsent leases vanish; a queued remote task may also be lost, with no retry across restart | Turn start only; no idle refill (`UserNotificationService.ts:136-145,249-250`) |
| Denied or partially granted request | Charge exactly the granted prefix, including zero; no speculative slots | Unsent grants expire at `resetTurn`; no refund after a send attempt | Abort before reservation charges zero; abort after reservation stops further sends | No disk write | No durable retry marker; repeat only in a new turn | Same turn as its lease |
| Queued photo or failed transport | Charge at grant, before fan-out; each lease allows at most its grant; a zero-chat attempt stays charged, as `deliverFile` does today (`UserNotification.test.ts:178-188`) | Never refund an attempted send | Cancellation stops further lease sends | No file write here | `RemoteAgentProgress` may have queued a task on `state.tail`; crash loses the task, so a nonzero queue count is not receipt (`RemoteAgentProgress.ts:258-270`) | No replay; retry is a new user turn |
| Thumbnail files under `.forge/image-search/<stamp>/` (unchanged by this plan) | `downloadThumbnails` saves before reservation with a direct `fs.writeFile` (`imageThumbnails.ts:95-111`) | `pruneOld` removes all-digit folders older than 7 days, best-effort, on the next download (`imageThumbnails.ts:131-146`) | `thumbnails: 0` skips download (`imageSearchTool.ts:157-159`); disabled tool starts no new downloads | Existing gap: a crash mid-write can leave a torn file the next prune removes; reservation runs only after the write resolves, so this plan never sends a file mid-write | Complete files remain until a later search triggers pruning; no startup cleanup | 7 days after stamp, **only when another download runs**; 512 KB maximum per saved file (`imageThumbnails.ts:20-21,105-112`) |
| Same-millisecond search folder (unchanged by this plan) | Existing gap: two searches in one millisecond share `<stamp>/` and can overwrite each other's numbered files (`imageThumbnails.ts:95-96`) | Same retention pass | No new folder when thumbnails disabled | Same torn-write gap as the row above | A photo queued on `state.tail` reads its path at send time, so a colliding later search can change its bytes (`RemoteAgentProgress.ts:263-266`) | Same 7-day on-next-download policy |
| Litterbox upload of a local attachment | Existing `uploadAttachment` path (`imageSearchTool.ts:142-149,312-343`) | Provider expiry | `confirm_upload: true` gates local attachment upload only (`imageSearchTool.ts:99-109`) | Provider-owned; no local file write added | Existing 50-minute in-memory reuse cache is lost (`imageSearchTool.ts:23-24,54-58`) | Provider says 1 hour; Forge reuses for under 50 minutes |
| Config | No new key; retain `thumbnails` range 0..8 | No migration | Existing `thumbnails: 0` disables thumbnail saves and sends | N/A | Config survives in existing `config.yaml` | N/A |

The torn write and the same-millisecond collision are real, pre-existing, and
independent of the budget: they exist today with no budget at all, and fixing
them changes the folder format `pruneOld` matches (`/^\d+$/`). They
are a separate follow-up (see Non-goals), not a precondition of this plan.

---

## Design

### 1. `UserNotificationService` gains an atomic bounded lease

Keep the existing design principle — check and charge fused into one call, *"so a
caller cannot forget the check or race its own budget"*
(`UserNotificationService.ts:221-223`) — and extend it to `n`:

```ts
type FileLeaseSendResult =
  | { readonly kind: 'queued'; readonly chats: number }
  | { readonly kind: 'exhausted' | 'stale' };

interface FileDeliveryLease {
  readonly granted: number;
  readonly remaining: number; // shared budget immediately after this grant
  deliver(event: { text: string; imagePath: string }): Promise<FileLeaseSendResult>;
}

reserveFileDeliveries(conversationId: string | undefined, requested: number): FileDeliveryLease;
```

Rules, each one testable on its own:

- Validate `requested` as a nonnegative integer. Grant
  `min(requested, remainingFileDeliveries(conversationId))` and charge that count
  synchronously, with no `await` between check and charge. Zero is valid and
  charges nothing. An 8-photo request in a fresh turn grants 5, not zero.
- **The lease's `deliver` is the send half and charges nothing.** It binds the
  conversation ID, tracks attempts, rejects a call beyond `granted`, and sends
  through the existing `fanOut` path. `deliverFile` must reserve one and use the
  same send half, retaining its current refusal wording and return type. Never
  call `deliverFile` after a batch grant: that would charge twice.
- Keep a per-conversation budget object. `resetTurn` deletes it; a lease checks
  that its object is still current before each send. A stale lease cannot
  *start* a send after the reset, so it cannot spend the new turn's allowance.
  A photo already handed to `fanOut` before the reset is the transport's: it is
  queued on `state.tail` and still goes out unless the turn's progress state was
  replaced, which `RemoteAgentProgress.ts:263-264` checks at send time.
- Grant only after files exist. An aborted batch may leave unused granted slots
  charged until the next turn; no refund API is needed. Attempts stay charged
  even if `fanOut` returns zero or a transport later fails — the rule
  `deliverFile` already ships with (`UserNotification.test.ts:178-188`: "no chat
  is watching" must not be farmable). `fanOut` catches sink errors and returns a
  count (`UserNotificationService.ts:176-190,253-265`).
- **No `reach()` pre-check.** `reach` is `RemoteNotificationFanout.countOn`:
  bound, *unmuted* chats (`RemoteNotificationFanout.ts:137-146`). Photos go
  through a different gate — a live, unclosed progress state for the
  conversation (`RemoteAgentProgress.ts:258-262`). The two disagree both ways:
  a muted chat driving the turn gets photos today but has `reach` 0, so the
  guard would silently stop its thumbnails; a bound chat with no live turn has
  `reach` > 0 yet receives nothing. Charging an unwatched search costs nothing
  real: a later `send_file` in that turn goes through the same sink and reaches
  the same zero chats.
- The lease must make exhaustion/staleness explicit in `FileLeaseSendResult`,
  so a caller cannot report those images as queued. Two concurrent reservations
  share one counter and never exceed 5.

### 2. `image_search` reserves after download, before the first send

In `saveAndDeliverThumbnails` (`imageSearchTool.ts:193-243`):

1. `downloadThumbnails` runs first. Reserve `saved.length`, **not**
   `config.thumbnails`; failed downloads never earn slots. Check
   `signal.aborted` after the download and before reservation, and before each
   subsequent send. When every granted send returns zero chats, keep the existing
   "no remote chat is watching" footer (`imageSearchTool.ts:237-241`).
2. Use the lease's `granted` count as the single delivery decision. Send that
   prefix through `lease.deliver`, with no intervening budget probe or second
   reservation. `deliverImageUnbudgeted` and `deliverFile` are not used here.
3. If `granted < saved.length`, captions use the granted count, e.g.
   `🔎 1/2 (of 4 saved; 2 withheld by the per-turn limit)`. The result footer
   names the workspace-relative search folder and withheld count. If granted
   zero, report that no photos were queued. The parseable `formatThumbnailLine`
   must still list **all** saved files for the sidebar (`toolResultView.ts:127-136`).
4. `lease.deliver` may return zero chats, `stale`, or `exhausted`. Report only
   actual queued counts; never claim a send because a slot was granted. On
   cancellation or a stale lease, stop and report the unsent count if a result
   can still be returned. Do not retry a queued photo inside this turn.
5. `deps.notifications` is optional (`imageSearchTool.ts:26-36`): preserve the
   existing `!saved.length || !deps.notifications` early return at line 218.
   Update the cast test fake in the same commit; optional chaining on a new
   service method would silently restore unbudgeted delivery. The fake at
   `ImageSearchTool.test.ts:138` (`{ deliverImage } as unknown as
   UserNotificationService`) must also gain the lease methods — a
   cast fake missing them compiles and fails at runtime, which is the exact
   failure mode this note exists to prevent.

### 3. Make the exemption impossible to take quietly

Rename `UserNotificationService.deliverImage` to
`deliverImageUnbudgeted(brake: 'confirm_each', event)`. Type `brake` as the
literal union `'confirm_each'`, not `string`, so the name is a checked label
rather than free text; the real brake is still the call-site condition, not the
argument. The literal identifies the tested per-call config gate; it is not a
substitute for the budget check:

```ts
// generateImageTool.ts:177, only when the selected backend's confirm_each is
// true. The in-scope local is `backend` from pickBackend (line 138) — there is
// no `selectedBackend` symbol in this file.
await deps.notifications.deliverImageUnbudgeted('confirm_each', { … });
```

**Rename scope, verified by `rg deliverImage`:**

| Name | Location | In scope? |
|---|---|---|
| `UserNotificationService.deliverImage` | `UserNotificationService.ts:208` | **Yes** — this is the unbudgeted door |
| `generateImageTool` call site | `generateImageTool.ts:177` | Yes — call-site rename |
| `imageSearchTool` call site | `imageSearchTool.ts:230` | Yes — replaced by the reserved path |
| `RemoteAgentProgress.deliverImage(conversationId, filePath, caption)` | `RemoteAgentProgress.ts:258` | No. Different class and transport signature; `RemoteController.ts:213-215` delegates to it |
| `UserNotification.test.ts:240-246` | test | Yes — service method assertion changes |
| `RemoteImageDelivery.test.ts:86-94` | test | Yes — service method test changes; its `RemoteAgentProgress` tests do not |
| `ImageSearchTool.test.ts:130,138,368-397` | test | Replace fake with a real budgeted service or a complete lease fake |
| `SymlinkEscape.test.ts:145` | test | Update the cast fake or remove the unused notification member. `notifications` is **required** on `GenerateImageDeps` (`generateImageTool.ts:33`) — unlike `imageSearchTool`, no optional guard belongs here |
| `ToolResultView.test.ts:173` | test | Asserts the exact footer `'Sent 3 thumbnail(s) to 1 remote chat(s).'` inside a persisted-transcript fixture. Changing the footer wording breaks this file, which is otherwise unrelated to image search |

`generate_image` with `confirm_each: false` uses `deliverFile` for the send only,
after the image is written. No `remainingFileDeliveries` precheck: the image's
primary destination is the workspace, so a spent phone budget must not block a
generation the user approved (or `/clanker` allowed). A refusal is reported as
"saved to <path>, not sent: per-turn file limit", replacing the "Queued for" /
"No remote chat" line (`generateImageTool.ts:189-191`). The
selected backend is the local `backend` from `pickBackend` in `runGenerateImage`
(`generateImageTool.ts:138`, used at 151-154 and 175-176) — there is no
`selectedBackend` symbol in this file. A startup approval alone does not exempt
subsequent warm calls.
Keep the remote `deliverImage` transport name and `imagePath` chain unchanged.

### 4. `image_search` no longer needs a special case in the docs

Delete the `KNOWN GAP` paragraph at `UserNotificationService.ts:202-206` and
update the surrounding comment: the unbudgeted route is used only for
`generate_image` with `confirm_each: true`.

---

## Non-goals

- No idle refill: `notify` has a five-minute reset, while file delivery resets
  only at turn start (`UserNotificationService.ts:136-145,147-174`).
- No new config field and no lower `thumbnails` maximum. The current 0..8 range
  stays valid; `ConfigLoader.ts:25-30` throws on a Zod failure, so lowering the
  schema maximum would break existing 6..8 configs rather than clamp them.
- No change to `confirm_upload` or to the remote `imagePath`/
  `deliverHostImage` transport chain.
- No thumbnail storage change. Unique per-search folders (`fs.mkdtemp`), atomic
  file publication (`writeFileAtomicSync`, `atomicWrite.ts:88-123`) and a
  `pruneOld` that accepts both folder forms are a separate follow-up plan with
  its own ledger; this plan neither needs nor blocks them.

---

## Files

| File | Change |
|---|---|
| `src/sidebar/UserNotificationService.ts` | Bounded lease, turn invalidation, `deliverFile` integration, explicit unbudgeted method; currently 266 lines. |
| `src/tools/imageSearch/imageSearchTool.ts` | Reserve after download, deliver granted prefix, accurate captions/result; currently 343 lines. Extract `src/tools/imageSearch/thumbnailDelivery.ts` before crossing 500. |
| `src/tools/imageGeneration/generateImageTool.ts` | Budget the selected backend when `confirm_each: false`; explicit unbudgeted call when true. Currently 344 lines; extract before crossing 500. |
| `test/unit/UserNotification.test.ts` | Service lease and reset tests; currently 439 lines. Put the new lease suite in `test/unit/UserNotificationFileLease.test.ts` rather than growing this file. |
| `test/unit/ImageSearchTool.test.ts` | Move the thumbnail delivery tests and fake (currently lines 360 onward) into `test/unit/ImageSearchDelivery.test.ts`; current file is already 538 lines. Add budget tests to focused new files, each under 500. |
| `test/unit/RemoteImageDelivery.test.ts`, `test/unit/SymlinkEscape.test.ts` | Update only service-method calls/fakes; keep `RemoteAgentProgress.deliverImage` unchanged. |
| `test/unit/GenerateImageTool.test.ts` and new `test/unit/GenerateImageBudget.test.ts` | Keep existing cases green; put new approved/unapproved budget rows in the new suite. Existing file is 485 lines and must not grow past 500. |
| `docs/OWNERS.md` | Register any extracted source owner. |
| `CHANGES.md` | Add the entry for the implementation release, not hardcoded 0.16.78 (already in `package.json:5`); `CHANGELOG.md` is generated. |
| `docs/plans/SEND_FILE_AND_RENDER_HTML_PLAN.md` | Follow-up 4 marked resolved; the "KNOWN GAP" reference removed. |

**Line-count gate, stated exactly.** `max-lines` (`error`, `max: 500`,
`.eslintrc.json:37`) is global, but `npm run lint` only walks `src` and
`webview-ui`, and `test/` is not in `parserOptions.project` — so it is a hard
stop for `src/` and an unenforced convention for `test/`. `ImageSearchTool.test.ts`
is already 538 lines and CI is green. Keep new test suites in new focused files
anyway; do not treat a test file's length as a CI failure.

---

## Phases

1. **Service and call sites.** Add bounded leases, integrate `deliverFile`,
   budget `generate_image` when approval is off, and rename the approved path.
   Update all affected fakes/tests in this commit. `npm run ci` green.
2. **image_search.** Reserve after download, deliver the granted prefix, and
   test partial grant, failed download, abort, stale lease, and reset paths.
   `npm run ci` green.
3. **Docs and changelog.** Resolve follow-up 4 in the prior plan and record
   the actual release version. Final gate after the last edit.

Each phase ends with `npm run ci` green, `git diff --check` clean, and no touched
**`src/`** `.ts` file over 500 physical lines (`max-lines` is enforced on `src`
and `webview-ui` only — see the Files table note). Run `npm run package` at final
handoff.

---

## Design decisions

1. **Partial fit is required.** The schema allows 6..8 thumbnails
   (`imageSearchSchema.ts:27`) against a five-slot cap
   (`UserNotificationService.ts:13,24`). Keep the cap and schema; a lowered
   Zod maximum would make existing configs fail to load
   (`ConfigLoader.ts:25-30`).
2. **One shared file counter.** Search photos, `send_file`, renders, and
   unapproved generated images all consume it. `notify_user` keeps its
   separate counter (`UserNotificationService.ts:80-85`).
3. **No refund API.** Downloads finish before reservation. If cancellation
   lands after reservation, unused slots last only until the next turn.
   This preserves the existing no-refund policy for attempted delivery
   (`UserNotificationService.ts:225-246`).

---

## Acceptance criteria

Each row maps to a named test or validation step.

### Service and turn lifetime

- [ ] In `UserNotificationFileLease.test.ts`, reserve 4 and send 4: exactly
      four slots charged, never eight; a fifth lease send is refused.
- [ ] In the same suite, requested 0 grants 0; requested 8 in a fresh turn
      grants 5; requested 4 with 2 remaining grants 2. The counter never
      exceeds 5 under concurrent calls, including a competing `deliverFile`.
- [ ] In the same suite, `deliverFile` retains its current refusal text and
      `FileDeliveryResult` shape; `send_file` and render tests remain green.
- [ ] In the same suite, an attempted send returning zero chats or a throwing
      sink stays charged; no retry occurs automatically.
- [ ] In the same suite, `resetTurn(c1)` restores c1's allowance and makes an
      old lease stale, while c2 and the no-conversation bucket remain separate.
      An old lease's `deliver` called after the reset returns `stale` without
      calling any sink.
- [ ] In the same suite, an abort before reservation charges zero; cancellation
      between lease sends stops the rest without a refund or later replay.

### Thumbnail files and delivery

- [ ] In `ImageSearchDelivery.test.ts`, `thumbnails: 0` performs no
      download/reservation; missing `deps.notifications` takes the current
      line-218 return; both existing thumbnail cases and the updated fake pass.
- [ ] In the same suite, 4 saved with 4 left queues all 4 with captions
      `1/4`…`4/4`; 4 saved with 2 left queues 2 with `1/2`…`2/2`,
      names 2 withheld and the folder, and keeps all 4 sidebar entries.
- [ ] In the same suite, zero left queues none with an explicit folder/count;
      8 saved in a fresh turn queues 5 and labels 3 withheld. No result says
      “sent” when the sink returns zero or a lease goes stale.
- [ ] In the same suite, 4 requested with 2 failed downloads charges 2,
      not 4. A download abort charges zero.
- [ ] In the same suite, a search in a conversation whose sinks all return 0
      charges its grant and keeps the existing "No remote chat is watching"
      footer; the sidebar line still lists every saved file.
- [ ] In `ImageSearchDelivery.test.ts`, repeated search calls in one turn
      never exceed five queued photos; each queued photo is attempted once.
      A later turn can search again after reset.
- [ ] In the image-search approval tests, public `image_url` skips upload
      approval yet budgets thumbnails; a local attachment with
      `confirm_upload: true` still prompts.

### Other senders and integration

- [ ] In a generate-image budget suite, `confirm_each: true` uses the
      explicit unbudgeted method; `confirm_each: false` uses `deliverFile`.
      With the budget already spent, `confirm_each: false` still generates and
      writes the image, and the result names the saved path and says it was not
      sent. Cover cloud and warm local backends; cold-start approval does not
      exempt later unapproved calls.
- [ ] In a real-service integration test, 2 renders + 1 `send_file` + a
      2-thumbnail search consume all 5 slots; the sixth file/photo is refused.
- [ ] Run `rg -n '\.deliverImage\(' src test/unit`: only the
      `RemoteAgentProgress` transport calls remain; grep
      `deliverImageUnbudgeted` separately to verify its sole production caller
      is the approved `generate_image` branch. `RemoteImageDelivery` service
      tests are updated and its transport tests still pass.
- [ ] Review `UserNotificationService.ts:192-210`: remove the KNOWN GAP
      paragraph and describe the conditional generate-image exemption.
      Mark follow-up 4 resolved in `SEND_FILE_AND_RENDER_HTML_PLAN.md`.
- [ ] Check every touched/created **`src/`** `.ts` file has at most 500 physical
      lines — that is the enforced `max-lines` gate — and run ESLint (which
      includes Prettier) on each touched `src/` file. Do **not** run ESLint on
      test files: `npm run lint` is `eslint src webview-ui --ext .ts,.tsx`, and
      `test/` is absent from `parserOptions.project`, so `npx eslint
      test/unit/<file>.ts` fails with a parsing error rather than reporting
      findings. For `test/`, the 500-line target is a convention only (27
      existing `test/unit` files already exceed it, up to 1571), so record the
      count instead of claiming a gate. Confirm `docs/OWNERS.md` for any
      extracted source owner.
- [ ] After the final source/test/doc/changelog edit, run `npm run ci`,
      `npm run package`, `git diff --check`, and inspect `git status`.
      Record exact command results and test counts; add the matching
      `CHANGES.md` entry for the implementation version.
- [ ] Live bound-chat validation: search an attachment with four thumbnails,
      confirm four sidebar entries and four phone photos; then ask for two
      renders in the same turn and confirm the first arrives (slot 5) and the
      shared cap refuses the second. A queue count
      alone is insufficient proof of handset receipt.
