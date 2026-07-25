const isWin = process.platform === 'win32';

/**
 * Build the shell invocation. On Windows we wrap in PowerShell and explicitly propagate the
 * inner command's exit code (`exit $LASTEXITCODE`) with `$ErrorActionPreference='Stop'`, so a
 * failing build/test cannot silently surface as exit 0 → a false "CHECKED" in the report.
 *
 * The wrapped script is passed via `-EncodedCommand` (base64 UTF-16LE), not `-Command`: it is
 * immune to all shell quoting, and — critically — it survives the sandbox host's argv→command-line
 * round-trip (PowerShell's `-Command` re-parsing does not, so a sandboxed command would mangle).
 *
 * Shared by `run_command` (model-authored command strings) and the typed check runner
 * (harness-composed command strings): exit-code fidelity is the verdict in both, so there must be
 * exactly one wrapper.
 */
export function shellInvocation(command: string): { file: string; args: string[] } {
  if (isWin) {
    const wrapped = `$ErrorActionPreference='Stop'; ${command}; exit $LASTEXITCODE`;
    const enc = Buffer.from(wrapped, 'utf16le').toString('base64');
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}
