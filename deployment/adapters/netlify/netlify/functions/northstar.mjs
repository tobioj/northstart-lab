// Netlify adapter (Functions v2, Web-standard Request/Response). Handles every path.
import { handleRequest } from '../../functions/handler.js';

export default async (request) => handleRequest(request, process.env);

export const config = { path: '/*', preferStatic: false };
