/**
 * Live hardware sampling for the Settings gauges: host CPU %, process CPU %, RSS, load average.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let lastCpus = os.cpus().map((c) => c.times);
let lastProc = process.cpuUsage();
let lastAt = process.hrtime.bigint();

export function sampleCpu(): { host_percent: number; process_percent: number } {
  const cpus = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  cpus.forEach((t, i) => {
    const p = lastCpus[i] ?? t;
    const dIdle = t.idle - p.idle;
    const dTotal = t.user - p.user + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + dIdle;
    idle += dIdle;
    total += dTotal;
  });
  lastCpus = cpus;
  const now = process.hrtime.bigint();
  const elapsedUs = Number(now - lastAt) / 1000;
  const proc = process.cpuUsage(lastProc);
  lastProc = process.cpuUsage();
  lastAt = now;
  const procPct = elapsedUs > 0 ? ((proc.user + proc.system) / elapsedUs) * 100 / cpus.length : 0;
  return { host_percent: total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : 0, process_percent: Math.max(0, Math.min(100, procPct)) };
}

export function dirUsage(dir: string, maxEntries = 20_000): number {
  let total = 0;
  let n = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (n++ > maxEntries) return;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return total;
}
