/**
 * The operating system's own folder / file dialog, for a DuckView running on the person's own machine.
 *
 * A browser's file input never reveals a path on disk, and it opens on the viewer's machine, not the server's. When
 * the server IS the viewer's machine — the request comes from localhost and the filesystem is not sandboxed — the
 * server can open the native dialog itself (macOS `osascript`, Linux zenity or kdialog, Windows PowerShell) and
 * return the chosen paths. Everywhere else (remote servers, sandboxed mode, several users) it is not offered.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DuckViewConfig } from '../config/index.js';

export type PickKind = 'folder' | 'files';
export interface PickRequest {
  kind: PickKind;
  multiple?: boolean;
  title?: string;
}
/** Runs a command; resolves with its exit code and output (injectable for tests). */
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Where to find a program on PATH (Linux dialogs). */
function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* not here */
    }
  }
  return null;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export class NativePicker {
  runner: Runner = defaultRunner;
  platform: NodeJS.Platform = process.platform;
  /** Linux: which dialog program exists (null: none). */
  linuxDialog: () => 'zenity' | 'kdialog' | null = () => (which('zenity') ? 'zenity' : which('kdialog') ? 'kdialog' : null);

  constructor(private readonly cfg: DuckViewConfig) {}

  /** Whether the native dialog can be offered for this request, and if not, why. */
  availability(req: { ip: string; host?: string | null }): { available: boolean; reason: string | null } {
    if (this.cfg.security.filesystem_mode !== 'full') return { available: false, reason: 'The server is sandboxed: folders come from its data directory.' };
    if (this.cfg.cluster.enabled) return { available: false, reason: 'In a cluster the dialog would open on a server, not on your screen.' };
    if (!LOOPBACK.has(req.ip) || (req.host && !LOCAL_HOSTS.test(req.host))) return { available: false, reason: 'The system dialog opens on the server, so it is offered only when DuckView runs on this computer.' };
    if (this.platform === 'darwin' || this.platform === 'win32') return { available: true, reason: null };
    if (this.platform === 'linux') {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { available: false, reason: 'No desktop session on the server.' };
      return this.linuxDialog() ? { available: true, reason: null } : { available: false, reason: 'Install zenity or kdialog for the system dialog.' };
    }
    return { available: false, reason: `No system dialog on ${this.platform}.` };
  }

  /** The command that opens the dialog. */
  command(r: PickRequest): { cmd: string; args: string[] } {
    const title = (r.title ?? (r.kind === 'folder' ? 'Choose a folder for DuckView' : 'Choose files for DuckView')).slice(0, 120);
    if (this.platform === 'darwin') {
      const script =
        r.kind === 'folder'
          ? ['tell application "System Events"', 'activate', `set f to choose folder with prompt "${esc(title)}"`, 'end tell', 'return POSIX path of f']
          : ['tell application "System Events"', 'activate', `set l to choose file with prompt "${esc(title)}"${r.multiple ? ' with multiple selections allowed' : ''}`, 'end tell', 'if class of l is not list then set l to {l}', 'set out to ""', 'repeat with f in l', 'set out to out & POSIX path of f & linefeed', 'end repeat', 'return out'];
      return { cmd: 'osascript', args: script.flatMap((line) => ['-e', line]) };
    }
    if (this.platform === 'win32') {
      const ps =
        r.kind === 'folder'
          ? `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${title.replace(/'/g, "''")}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`
          : `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '${title.replace(/'/g, "''")}'; $d.Multiselect = $${r.multiple ? 'true' : 'false'}; if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join "\`n" }`;
      return { cmd: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', ps] };
    }
    const tool = this.linuxDialog();
    if (tool === 'kdialog') return { cmd: 'kdialog', args: r.kind === 'folder' ? ['--title', title, '--getexistingdirectory', process.env.HOME ?? '/'] : ['--title', title, '--getopenfilename', process.env.HOME ?? '/', ...(r.multiple ? ['--multiple', '--separate-output'] : [])] };
    return { cmd: 'zenity', args: ['--file-selection', `--title=${title}`, ...(r.kind === 'folder' ? ['--directory'] : []), ...(r.multiple && r.kind === 'files' ? ['--multiple', '--separator=\n'] : [])] };
  }

  /** Opens the dialog and waits; null when the person cancels. */
  async pick(r: PickRequest): Promise<string[] | null> {
    const { cmd, args } = this.command(r);
    const out = await this.runner(cmd, args, 5 * 60_000);
    if (out.code !== 0) {
      // Cancelling is not an error: osascript says "User canceled" (-128), zenity and kdialog exit 1.
      if (/cancel|-128/i.test(out.stderr) || out.code === 1) return null;
      throw new Error(`The system dialog failed: ${(out.stderr || `exit ${out.code}`).trim().split('\n')[0]}`);
    }
    const paths = out.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => (p.length > 1 && /[\\/]$/.test(p) ? p.slice(0, -1) : p));
    return paths.length ? paths : null;
  }
}
