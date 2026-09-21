# Telegram Contact Reply and Reminder Plan

**Status:** future enhancement; not implemented

## Current behavior

- A contact uses `/owner <message>` in the linked group to mark a request for
  the owner.
- The request and the acknowledgement remain in the shared group. Forge does
  not duplicate the group message in the owner's private bot chat.
- The contact can continue normal conversation in the group.
- Owner-only commands remain separate from contact commands.

## Future feature A: owner reply button

Add an owner-only reply action for an owner-request message in the group.

Proposed flow:

1. The contact sends `/owner Please contact me after 20:00.`
2. Forge posts a concise acknowledgement in the group and attaches an
   owner-only `Reply` button.
3. Only the authenticated owner can activate the button.
4. Forge opens a short owner reply flow or accepts the next owner reply and
   previews the exact text before posting it to the linked group.
5. The contact sees the final reply in the group; no private contact channel is
   created.

Required safeguards:

- Bind the callback to the contact ID, group chat ID, and owner Telegram ID.
- Reject callbacks after expiry, unbinding, disabling, or group replacement.
- Never let the contact activate the owner action.
- Preserve the existing privacy policy and output guard.
- Keep the current direct group conversation available as a fallback.

## Future feature B: reminders and scheduled contact actions

Support an owner-confirmed reminder when a contact requests a future action.

Example:

```text
Contact: /owner Please contact me after 20:00.
Owner: /remind Maria 19:59 Europe/Athens: contact her at 20:00.
```

The first version should create an owner-only reminder. Automatically sending a
future message to the contact is a separate, explicit capability and must not
be implied by a contact request.

Required design decisions and safeguards:

- Require an explicit date, time, and timezone; reject ambiguous phrases such
  as “after 8” until clarified.
- Persist the reminder durably and recover it after VS Code or Forge restarts.
- Deduplicate delivery and record sent, failed, cancelled, and expired states.
- Provide owner-only cancel and list commands.
- Use the existing job scheduler rather than a process-local timer.
- Rate-limit reminders and prevent a contact from creating owner jobs directly.
- Make the target group/contact immutable after creation and verify it before
  delivery.
- Keep automatic contact messaging behind a separate owner confirmation.

## Acceptance criteria

- A contact can request owner attention without receiving private owner data.
- An owner-only reply action cannot be activated by the contact.
- Restarting Forge does not lose a confirmed reminder.
- Duplicate polling, retry, expiry, cancellation, and group unbinding are
  covered by tests.
- The shared group remains the canonical conversation surface.
