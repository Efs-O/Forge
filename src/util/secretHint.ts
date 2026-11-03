/**
 * The one sentence appended to every "this key is not in SecretStorage" message.
 *
 * VS Code stores secrets on the client: its remote-extension docs say the
 * SecretStorage API "will always store the secrets on the client side", wherever
 * the extension host runs. So a tunnel or SSH window reads the keychain of the
 * machine being typed on, not of the desktop it is connected to, and a user who
 * has just connected cannot tell that difference from a missing key — the plain
 * "run the setup command" advice sends them to the wrong computer.
 *
 * A fact, not an instruction: the owner rule keeps the keys on the main machine,
 * so "set it on the machine you are typing on" would tell people to put keys on
 * the laptop, which is what this setup forbids. A WSL, container or Codespaces
 * window reads this computer's keychain, so the sentence is true there too and
 * says nothing that could mislead.
 *
 * Appended unconditionally, not behind `vscode/remoteWindowKind.ts`: it is true
 * in every window, and threading that decision into four tool call sites would
 * cost more than the sentence says.
 */
export const PER_COMPUTER_SECRET_HINT =
  'Keys are stored per computer: a VS Code tunnel or SSH window reads the keychain of the computer you are typing on, not the one it is connected to.';
