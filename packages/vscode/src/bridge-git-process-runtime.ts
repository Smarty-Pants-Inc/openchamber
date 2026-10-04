// Raw Git execution is unavailable until it has identity-safe process-tree custody.
// VS Code's built-in Git API remains owned by that extension.
export const stopGitProcesses = (): Promise<void> => Promise.resolve();

export const execGit: (
  args: string[], cwd: string, options?: { binary?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }> = async () => {
  throw new Error('GIT_PROCESS_UNSUPPORTED: Raw Git execution is unavailable in this VS Code extension. Use VS Code-owned Git operations.');
};
