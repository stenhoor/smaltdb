// A host that compresses responses, like GitHub Pages (issue #32): requests without `Range` whose
// Accept-Encoding includes gzip get a gzipped body, HEAD included (its Content-Length is then the
// compressed size); Range requests get the uncompressed bytes with `Content-Range`.
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * A request handler serving `dir` under `prefix`. `cors` (an origin) adds CORS headers that expose
 * only Content-Length and ETag, as many hosts do: Content-Range and Content-Encoding stay hidden.
 * Every request is logged as { method, path, range, gzip }. Returns false for other paths.
 */
export function compressingHandler(prefix, dir, { log = [], cors } = {}) {
  return async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(prefix)) return false;
    const headers = { 'cache-control': 'no-store', 'accept-ranges': 'bytes', vary: 'Accept-Encoding' };
    if (cors) {
      headers['access-control-allow-origin'] = cors;
      headers['access-control-expose-headers'] = 'Content-Length, ETag';
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range' });
      res.end();
      return true;
    }
    const file = normalize(join(dir, path.slice(prefix.length)));
    let body;
    try {
      if (!file.startsWith(normalize(dir))) throw new Error('outside');
      body = await readFile(file);
    } catch {
      res.writeHead(404, headers);
      res.end();
      return true;
    }
    headers.etag = `"${body.length}"`;
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    if (m) {
      const [s, e] = [Number(m[1]), Math.min(Number(m[2]), body.length - 1)];
      log.push({ method: req.method, path, range: req.headers.range, gzip: false });
      res.writeHead(206, { ...headers, 'content-range': `bytes ${s}-${e}/${body.length}`, 'content-length': e - s + 1 });
      res.end(req.method === 'HEAD' ? undefined : body.subarray(s, e + 1));
      return true;
    }
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const sent = gzip ? gzipSync(body) : body;
    log.push({ method: req.method, path, range: null, gzip });
    res.writeHead(200, { ...headers, 'content-length': sent.length, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : sent);
    return true;
  };
}
