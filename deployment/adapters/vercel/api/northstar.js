// Vercel adapter (Node.js runtime, Web-standard handler signature).
// vercel.json rewrites every path here and passes the original path as __ns_path.
import { handleRequest } from '../functions/handler.js';

function restoreOriginalUrl(request) {
  const url = new URL(request.url);
  const original = url.searchParams.get('__ns_path');
  if (original !== null) {
    url.pathname = original.startsWith('/') ? original : `/${original}`;
    url.searchParams.delete('__ns_path');
  }
  const host = request.headers.get('host');
  if (host) url.host = host;
  url.protocol = 'https:';
  return new Request(url, { method: request.method, headers: request.headers });
}

const handle = (request) => handleRequest(restoreOriginalUrl(request), process.env);
export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
