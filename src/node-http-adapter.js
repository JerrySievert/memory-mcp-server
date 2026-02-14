/**
 * Node.js HTTP Adapter
 *
 * Bridges Node.js http.IncomingMessage/ServerResponse with Web Standard
 * Request/Response used by the existing route handlers.
 *
 * @module node-http-adapter
 */

import { createServer as create_http_server } from 'node:http';

/**
 * Convert a Node.js IncomingMessage to a Web Standard Request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Request}
 */
function incoming_to_request(req) {
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host || 'localhost';
  const url = `${protocol}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }

  const has_body = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: has_body ? req : null,
    duplex: has_body ? 'half' : undefined
  });
}

/**
 * Write a Web Standard Response to a Node.js ServerResponse.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} web_response
 */
async function send_response(res, web_response) {
  res.writeHead(web_response.status, Object.fromEntries(web_response.headers));

  if (!web_response.body) {
    res.end();
    return;
  }

  const reader = web_response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

/**
 * Create a Node.js HTTP server that dispatches to a Web Standard fetch handler.
 *
 * @param {function(Request): Promise<Response>} handler - Web Standard request handler
 * @param {Object} options
 * @param {number} options.port
 * @param {string} options.hostname
 * @returns {Promise<import('node:http').Server>}
 */
export function create_server(handler, options = {}) {
  const { port = 3000, hostname = 'localhost' } = options;

  return new Promise((resolve) => {
    const server = create_http_server(async (req, res) => {
      try {
        const web_request = incoming_to_request(req);
        const web_response = await handler(web_request);
        await send_response(res, web_response);
      } catch (error) {
        console.error('HTTP handler error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    server.listen(port, hostname, () => {
      resolve(server);
    });
  });
}
