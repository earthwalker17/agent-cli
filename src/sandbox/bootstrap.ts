/**
 * The Windows Low-IL sandbox host: a small, versioned PowerShell + inline-C# (Add-Type P/Invoke)
 * payload that Node spawns in place of the real shell. It runs the target command at LOW integrity
 * (Mandatory Integrity Control denies writes to Medium+ objects) inside a Job Object
 * (KILL_ON_JOB_CLOSE reaps the whole subtree — including detached grandchildren that `taskkill /T`
 * misses — when Node kills this host).
 *
 * Why a PowerShell host at all: there is no maintained Node binding for CreateProcessAsUser /
 * CreateJobObject, and this project ships no compiled native addon. `Add-Type -MemberDefinition`
 * lets us P/Invoke Win32 from a stock install with NO admin and NO special privilege — a
 * lowered/restricted copy of the caller's OWN token needs no SeAssignPrimaryTokenPrivilege.
 *
 * The mechanics here were verified by direct probe on the target platform before this code was
 * written: Low-IL spawn works non-admin, the child's writes to the workspace are OS-denied, its
 * stdout/stderr stream back through the host's inherited std handles, and reads are NOT blocked
 * (an honest, documented limitation — this is a write/lifecycle boundary, not a read/network one).
 *
 * HONEST LIMITS baked into the design: Low IL confines WRITES and process lifecycle only. It does
 * NOT stop the child from READING files (including secrets) or reaching the NETWORK, and the child
 * may still write Low-labeled locations (its scratch TEMP, %USERPROFILE%\AppData\LocalLow). Service-
 * reparented work (schtasks/sc/wmic Win32_Process.Create/BITS) escapes the Job Object.
 */

/** Bump when the host script changes; the file name and the DLL/probe cache key derive from it. */
export const SANDBOX_HOST_VERSION = 2;

/** Sentinel exit code the host uses when it could NOT establish the boundary (fail-closed marker). */
export const HOST_FAIL_EXIT = 250;
export const HOST_FAIL_MARKER = 'AGENTSBX_HOSTFAIL';
export const SELFTEST_OK_MARKER = 'AGENTSBX_SELFTEST_OK';
export const SELFTEST_FAIL_MARKER = 'AGENTSBX_SELFTEST_FAIL';

/**
 * The host script. Parameters:
 *   -TargetB64 <base64(JSON {file, args[]})>   the real command to run at Low IL
 *   -ScratchDir <dir>                          a Low-labeled dir handed to the child as TEMP/TMP
 *   -SelfTest                                  run the enforcement probe instead of a command
 *
 * Note for maintainers: this string is embedded (single source of truth) and written to the state
 * dir at runtime. Avoid backticks and the sequence `${` so the TypeScript template stays literal.
 */
export const SANDBOX_HOST_SCRIPT = String.raw`
[CmdletBinding()]
param(
  [string] $TargetB64,
  [string] $ScratchDir,
  [switch] $SelfTest
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class AgentSbx {
  const uint TOKEN_ALL = 0xF01FF;
  const int  SecurityImpersonation = 2, TokenPrimary = 1, TokenIntegrityLevel = 25;
  const uint CREATE_NO_WINDOW = 0x08000000, CREATE_SUSPENDED = 0x4, NORMAL_PRIORITY = 0x20;
  const int  STARTF_USESTDHANDLES = 0x100, STD_INPUT = -10, STD_OUTPUT = -11, STD_ERROR = -12;
  const uint HANDLE_FLAG_INHERIT = 0x1, INFINITE = 0xFFFFFFFF;
  // JobObjectExtendedLimitInformation = 9 ; JobObjectBasicUIRestrictions = 4
  const int  JobExtendedLimit = 9, JobUIRestrictions = 4;
  const uint JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_LIMIT_ACTIVE_PROCESS = 0x8, JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
  const uint UILIMIT_DESKTOP=0x40, UILIMIT_DISPLAYSETTINGS=0x10, UILIMIT_GLOBALATOMS=0x20, UILIMIT_HANDLES=0x1, UILIMIT_READCLIPBOARD=0x2, UILIMIT_WRITECLIPBOARD=0x4, UILIMIT_SYSTEMPARAMETERS=0x8, UILIMIT_EXITWINDOWS=0x80;

  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSD; public int bInherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string res; public string desktop; public string title;
    public int x,y,xs,ys,xcc,ycc,fill,flags; public short showWindow, res2; public IntPtr res3, si, so, se; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public IntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public IntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public IntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_UI_RESTRICTIONS { public uint UIRestrictionsClass; }

  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int n);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr h, uint acc, IntPtr sa, int imp, int type, out IntPtr dup);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr h, int cls, ref TOKEN_MANDATORY_LABEL info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_BASIC_UI_RESTRICTIONS info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr rd, out IntPtr wr, ref SECURITY_ATTRIBUTES sa, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr tok, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, byte[] buf, int n, out int read, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  // Build a Low-integrity primary token from the caller's own token (no admin / no privilege).
  static IntPtr LowToken() {
    IntPtr cur, dup;
    if(!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL, out cur)) throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error());
    if(!DuplicateTokenEx(cur, TOKEN_ALL, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out dup)) throw new Exception("DuplicateTokenEx " + Marshal.GetLastWin32Error());
    var low = new SecurityIdentifier("S-1-16-4096"); // SECURITY_MANDATORY_LOW_RID
    byte[] sidb = new byte[low.BinaryLength]; low.GetBinaryForm(sidb, 0);
    IntPtr psid = Marshal.AllocHGlobal(sidb.Length); Marshal.Copy(sidb, 0, psid, sidb.Length);
    var lbl = new TOKEN_MANDATORY_LABEL(); lbl.Label.Sid = psid; lbl.Label.Attributes = 0x20; // SE_GROUP_INTEGRITY
    int len = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) + sidb.Length;
    if(!SetTokenInformation(dup, TokenIntegrityLevel, ref lbl, len)) throw new Exception("SetTokenInformation(IL) " + Marshal.GetLastWin32Error());
    return dup;
  }

  // A Job Object that reaps its whole subtree when the LAST handle (held by this host) closes.
  static IntPtr MakeJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if(job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    ext.BasicLimitInformation.LimitFlags = JOB_LIMIT_KILL_ON_JOB_CLOSE | JOB_LIMIT_ACTIVE_PROCESS | JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    ext.BasicLimitInformation.ActiveProcessLimit = 512; // fork-bomb guard; generous for real builds
    SetInformationJobObject(job, JobExtendedLimit, ref ext, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    var ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS();
    ui.UIRestrictionsClass = UILIMIT_DESKTOP|UILIMIT_DISPLAYSETTINGS|UILIMIT_GLOBALATOMS|UILIMIT_HANDLES|UILIMIT_READCLIPBOARD|UILIMIT_WRITECLIPBOARD|UILIMIT_SYSTEMPARAMETERS|UILIMIT_EXITWINDOWS;
    SetInformationJobObject(job, JobUIRestrictions, ref ui, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_UI_RESTRICTIONS)));
    return job;
  }

  static PROCESS_INFORMATION SpawnLow(string cmdLine, IntPtr so, IntPtr se, IntPtr si, out IntPtr job) {
    IntPtr tok = LowToken();
    job = MakeJob();
    var stinfo = new STARTUPINFO(); stinfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    stinfo.flags = STARTF_USESTDHANDLES; stinfo.so = so; stinfo.se = se; stinfo.si = si;
    PROCESS_INFORMATION pi;
    // env NULL => child inherits THIS host's environment (Node already filtered it; TEMP points at scratch);
    // cwd NULL => child inherits this host's current directory (Node set it to the workspace root).
    if(!CreateProcessAsUser(tok, null, cmdLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED|CREATE_NO_WINDOW|NORMAL_PRIORITY, IntPtr.Zero, null, ref stinfo, out pi))
      throw new Exception("CreateProcessAsUser " + Marshal.GetLastWin32Error());
    if(!AssignProcessToJobObject(job, pi.hProcess)) throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error());
    ResumeThread(pi.hThread);
    return pi;
  }

  // Real execution: stream the child's stdout/stderr straight to the host's inherited std handles
  // (which are Node's pipes), relay the exit code. The job handle is intentionally NOT closed here
  // so that if Node kills THIS host mid-run, the closing handle reaps the child subtree.
  public static uint Launch(string cmdLine) {
    IntPtr job;
    var pi = SpawnLow(cmdLine, GetStdHandle(STD_OUTPUT), GetStdHandle(STD_ERROR), GetStdHandle(STD_INPUT), out job);
    WaitForSingleObject(pi.hProcess, INFINITE);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    GC.KeepAlive(job);
    return code;
  }

  // Self-test / probe: run a command at Low IL, CAPTURING its output through an internal pipe so
  // the host can inspect the child's integrity and a deliberate write-deny probe.
  public static string LaunchCapture(string cmdLine, out uint code) {
    code = 0xFFFFFFFF;
    var sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.bInherit = 1;
    IntPtr rd, wr; CreatePipe(out rd, out wr, ref sa, 0);
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0); // the read end stays with the host
    IntPtr job;
    var pi = SpawnLow(cmdLine, wr, wr, GetStdHandle(STD_INPUT), out job);
    CloseHandle(wr);
    var sb = new StringBuilder(); byte[] buf = new byte[4096]; int got;
    while(ReadFile(rd, buf, buf.Length, out got, IntPtr.Zero) && got > 0) sb.Append(Encoding.UTF8.GetString(buf, 0, got));
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(rd); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(job);
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp | Out-Null

# Standard Win32 argv quoting (CommandLineToArgvW-compatible), so an arbitrary command re-parses
# exactly. General-purpose: works for any file+args, not just powershell.exe.
function Get-ArgvString([string[]] $parts) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($p in $parts) {
    if ($sb.Length -gt 0) { [void]$sb.Append(' ') }
    if ($p.Length -gt 0 -and $p -notmatch '[\s"]') { [void]$sb.Append($p); continue }
    [void]$sb.Append('"'); $bs = 0
    foreach ($ch in $p.ToCharArray()) {
      if ($ch -eq '\') { $bs++ }
      elseif ($ch -eq '"') { [void]$sb.Append('\' * ($bs * 2 + 1)); [void]$sb.Append('"'); $bs = 0 }
      else { if ($bs -gt 0) { [void]$sb.Append('\' * $bs); $bs = 0 }; [void]$sb.Append($ch) }
    }
    [void]$sb.Append('\' * ($bs * 2)); [void]$sb.Append('"')
  }
  $sb.ToString()
}

function Fail([string] $reason) {
  [Console]::Error.WriteLine('AGENTSBX_HOSTFAIL:' + $reason)
  exit 250
}

# Point the child's scratch temp at a Low-labeled dir (Low IL cannot write the normal Medium TEMP).
if ($ScratchDir) { $env:TEMP = $ScratchDir; $env:TMP = $ScratchDir }

try {
  if ($SelfTest) {
    # Probe real enforcement: run a Low-IL child that reports its integrity and attempts a write to
    # a Medium-labeled path. SANDBOX is proven only if the child is Low AND the write is denied.
    # The probe child is powershell -EncodedCommand so no shell-quoting can distort it.
    $probeDir = if ($ScratchDir) { Split-Path $ScratchDir -Parent } else { $env:TEMP }
    if (-not (Test-Path $probeDir)) { $probeDir = $env:TEMP }
    $medTarget = Join-Path $probeDir ('agentsbx-selftest-' + [guid]::NewGuid().ToString('N') + '.txt')
    if (Test-Path -LiteralPath $medTarget) { Remove-Item -Force -LiteralPath $medTarget }
    # Use the FULL Windows whoami path (never a msys/Git whoami earlier on PATH) so the integrity
    # marker is PATH-independent — it is diagnostic only; the DEFINITIVE proof is the write-deny.
    $whoami = Join-Path $env:SystemRoot 'System32\whoami.exe'
    $inner = "& '" + $whoami + "' /groups | Select-String 'S-1-16-4096' | ForEach-Object { 'AGENTSBX_ISLOW' }; try { Set-Content -LiteralPath '" + $medTarget + "' -Value 'X' -ErrorAction Stop; 'AGENTSBX_WROTE' } catch { 'AGENTSBX_DENIED' }"
    $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $probe = Get-ArgvString @('powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',$b64)
    $code = 0
    $out = [AgentSbx]::LaunchCapture($probe, [ref]$code)
    $isLow = $out -match 'AGENTSBX_ISLOW'
    $denied = $out -match 'AGENTSBX_DENIED'
    $wrote = Test-Path -LiteralPath $medTarget
    if (Test-Path -LiteralPath $medTarget) { Remove-Item -Force -LiteralPath $medTarget -ErrorAction SilentlyContinue }
    # Enforcement is PROVEN by the write-deny: a fresh, owned, Medium-labeled temp file can only be
    # write-denied because the child runs at reduced integrity (a Medium child would succeed). The
    # low marker is reported for diagnostics but does not gate (it is PATH/whoami-fragile).
    if ($denied -and -not $wrote) { Write-Output 'AGENTSBX_SELFTEST_OK'; exit 0 }
    Write-Output ('AGENTSBX_SELFTEST_FAIL:low=' + $isLow + ';denied=' + $denied + ';wroteMedium=' + $wrote)
    exit 1
  }

  if (-not $TargetB64) { Fail 'no target' }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetB64))
  $target = $json | ConvertFrom-Json
  $parts = @($target.file) + @($target.args)
  $cmdLine = Get-ArgvString $parts
  $code = [AgentSbx]::Launch($cmdLine)
  exit [int]$code
} catch {
  Fail ($_.Exception.Message)
}
`;
