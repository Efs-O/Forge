# ADR: experimental WhatsApp remote adapter

- Status: accepted, experimental
- Date: 2026-08-29

## Decision

Forge uses the official community-maintained
[`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys)
package, pinned to `7.0.0-rc14`, for the optional WhatsApp linked-device transport.
The [upstream repository](https://github.com/WhiskeySockets/Baileys) describes
Baileys as a WebSocket client for WhatsApp Web. It is not affiliated with or
endorsed by WhatsApp.

The package is MIT licensed, ESM, and requires Node.js 20 or newer. Forge's
VS Code 1.90 minimum runs on Electron with Node 20, and the production adapter
is bundled into Forge's CommonJS extension output by esbuild. The phase gate
must always include a production build, bundle-load smoke test, VSIX package,
and packaged-file review because Baileys 7 is currently a release candidate
with documented breaking changes.

## Boundaries

- The adapter is disabled unless both `remote.enabled` and
  `remote.whatsapp.enabled` are true.
- It opens only an outbound linked-device WebSocket. Forge exposes no webhook,
  HTTP listener, or public control API.
- History synchronization, online-presence marking, and own-message emission
  are disabled. Only new text notifications are admitted. This requires a
  dedicated receiving account (or second account); the controlling owner sends
  private messages from a separate WhatsApp identity.
- Group/newsletter classification is preserved so the shared core rejects it;
  only the separately paired private owner can control Forge.
- Forge-native approvals use exact `APPROVE <id>` / `DENY <id>` replies.
  The shared approval service remains the single first-resolution-wins owner.
- All admission, deduplication, queue, outbox, audit, and fenced-lease semantics
  remain in the transport-independent remote core.

## Authentication persistence

Baileys credentials and Signal key records can exceed practical single-secret
sizes. Forge therefore stores one random 256-bit encryption key in VS Code
SecretStorage and writes only AES-256-GCM ciphertext to extension global
storage. Writes use a temporary file plus rename. A missing key, invalid key,
or authentication failure fails closed. No linked-device state is written to
the workspace, config YAML, transcript, log, or Git.

`Forge: Unlink WhatsApp Device` logs out when possible, deletes the encrypted
auth file and encryption key, releases the remote owner binding, and restarts
an enabled adapter in an unlinked state.

## Consequences and rollback

This is an unofficial protocol integration and can break when WhatsApp changes
its Web protocol or policy. Users must comply with WhatsApp's terms and must not
use Forge for unsolicited or bulk messaging. Disable the WhatsApp config flag
to stop it; use the unlink command to revoke and erase linked-device state.

The dependency is exactly pinned. Upgrades require repeating this ADR's
license/engine/API review and all release gates rather than accepting a floating
release-candidate update.
