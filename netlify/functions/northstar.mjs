// Netlify adapter (Functions v2, Web-standard Request/Response). Handles every path on every
// hostname attached to the site; the handler picks the role from the Host header.
import { handleRequest } from '../../functions/handler.js';

export default async (request) => handleRequest(request, process.env);

export const config = { path: '/*', preferStatic: false };
