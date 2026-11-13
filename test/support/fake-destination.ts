import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Wait this long before answering (to provoke timeouts). */
  readonly delayMs?: number;
}

export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * A real HTTP server that plays a webhook receiver and fails on purpose: each request takes the
 * next scripted response (then 200 once the script runs out), and every request is recorded.
 */
export class FakeDestination {
  readonly requests: ReceivedRequest[] = [];
  private script: ScriptedResponse[] = [];
  private waiters: { count: number; resolve: () => void }[] = [];

  private readonly server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      this.handle(request, (response) => {
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(response.status, response.headers);
          res.end(response.body ?? '');
        };
        if (response.delayMs) setTimeout(send, response.delayMs);
        else send();
      });
    });
  });

  static async start(): Promise<FakeDestination> {
    const destination = new FakeDestination();
    await new Promise<void>((resolve) => destination.server.listen(0, '127.0.0.1', resolve));
    return destination;
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hooks`;
  }

  respondWith(...responses: ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  reset(): void {
    this.requests.length = 0;
    this.script = [];
  }

  /** Resolves once `count` requests in total have arrived. */
  waitForRequests(count: number, timeoutMs = 10_000): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Expected ${count} requests, got ${this.requests.length}`));
      }, timeoutMs);
      this.waiters.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private handle(request: ReceivedRequest, reply: (response: ScriptedResponse) => void): void {
    this.requests.push(request);
    reply(this.script.shift() ?? { status: 200, body: 'ok' });
    this.waiters = this.waiters.filter((waiter) => {
      if (this.requests.length < waiter.count) return true;
      waiter.resolve();
      return false;
    });
  }
}
