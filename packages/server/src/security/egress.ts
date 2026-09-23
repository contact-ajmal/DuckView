/**
 * Outbound HTTP to user-supplied URLs (notification webhooks), guarded against server-side request forgery: the
 * target must resolve to a public address — never loopback, private, link-local (cloud metadata), CGNAT, multicast
 * or reserved ranges — unless the administrator allows private targets. The check runs inside the socket's DNS
 * lookup, so the address that is checked is the address that is connected to (no DNS-rebinding window).
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class EgressError extends Error {}

/** True for addresses a server should not be tricked into calling. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return /^(fc|fd|fe[89ab]|ff)/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('100::') || v6.startsWith('2001:db8');
}

export interface EgressOptions {
  allowPrivate: boolean;
  timeoutMs: number;
  /** Plain http:// targets (tests, intranets); https is required otherwise. */
  allowHttp?: boolean;
}

export interface EgressResponse {
  status: number;
  body: string;
}

/** POSTs a body to a URL under the egress rules. Redirects are not followed. */
export function egressPost(url: string, body: string | Buffer, headers: Record<string, string>, opts: EgressOptions): Promise<EgressResponse> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new EgressError('Invalid URL'));
  }
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && (opts.allowHttp || opts.allowPrivate))) return Promise.reject(new EgressError('Only https:// targets are allowed'));
  if (target.username || target.password) return Promise.reject(new EgressError('Credentials in the URL are not allowed'));
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      const list = (addresses as dns.LookupAddress[]).filter((a) => opts.allowPrivate || !isPrivateAddress(a.address));
      if (!list.length) return cb(new EgressError(`${hostname} resolves to a private address — not allowed (notifications.allow_private_targets)`), '', 0);
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
  // A literal IP skips DNS: check it here.
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) return Promise.reject(new EgressError(`${host} is a private address — not allowed (notifications.allow_private_targets)`));
  const lib = target.protocol === 'https:' ? https : http;
  const payload = typeof body === 'string' ? Buffer.from(body) : body;
  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method: 'POST', headers: { ...headers, 'content-length': String(payload.length) }, lookup, timeout: opts.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= 64 * 1024) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new EgressError(`No answer from ${target.host} within ${Math.round(opts.timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}
