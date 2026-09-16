import { rewrite } from '@vercel/functions';
import { gatewayRequest } from './gateway.mjs';

export default function middleware(request) {
  try {
    const { destination, headers } = gatewayRequest(request, process.env);
    // Native external rewrite keeps request/response bodies out of this function.
    // This is deliberately not fetch() or a function that buffers uploads.
    return rewrite(destination, { request: { headers } });
  } catch {
    return new Response('Nova Dream is not available at this address yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }
}
export const config = { matcher: '/:path*' };
