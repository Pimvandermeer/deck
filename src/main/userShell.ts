import os from "node:os";

/** The user's login shell: $SHELL, else the account's shell, else the platform default. */
export function userShell(): string {
  return process.env.SHELL || os.userInfo().shell || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}
