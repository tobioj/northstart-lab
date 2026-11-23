// Vercel adapter (Node.js runtime, Web-standard handler signature).
// vercel.json rewrites every path here and passes the original path as __ns_path; the query
// string and the incoming Host header are preserved, so routing by role origin still works.
import { handleRequest } from '../functions/handler.js';

async function restoreOriginalRequest(request) {
  const url = new URL(request.url);
  const original = url.searchParams.get('__ns_path');
  if (original !== null) {
    url.pathname = original.startsWith('/') ? original : `/${original}`;
    url.searchParams.delete('__ns_path');
  }
  const host = request.headers.get('host');
  if (host) url.host = host;
  url.protocol = 'https:';
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
  return new Request(url, { method, headers: request.headers, body });
}

const handle = async (request) => handleRequest(await restoreOriginalRequest(request), process.env);
export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
