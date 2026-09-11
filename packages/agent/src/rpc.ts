/**
 * Transport-agnostic JSON-RPC-ish dispatcher: given a raw line of text, parse
 * it, validate the envelope, route to a handler, and return the serialized
 * response line. Knows nothing about stdio — main.ts owns that.
 */
import type { z } from 'zod';
import { ErrorCode, requestSchema } from './protocol.ts';

export interface RpcContext {
  notify: (method: string, params: unknown) => void;
  /**
   * Which connection this request arrived on. Present so a handler can tell
   * two simultaneous clients apart — ptyResize is the one that must, since a
   * desktop and a browser watching the same terminal report different sizes
   * and last-writer-wins makes it reflow on every fit. Absent means "the only
   * client", which is how every existing handler behaves.
   */
  clientId?: string;
}

export type Handler = (params: unknown, ctx: RpcContext) => unknown | Promise<unknown>;

export interface MethodSpec {
  params: z.ZodType<unknown>;
}

export interface Dispatcher {
  /** Handle one raw line of input; always resolves to a response line (never null). */
  handleLine(line: string): Promise<string>;
}

function serialize(response: unknown): string {
  return JSON.stringify(response);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * zod 4's own `ZodError.message` is a pretty-printed JSON dump of the issue
 * array — readable in a debugger, not in an error toast. `path: message`,
 * semicolon-joined, is what every RPC method's invalid-params error uses
 * instead, `updateWorkflow` included.
 */
function formatZodError(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * `methodSpecs` maps method name -> params schema; `handlers` maps method
 * name -> implementation. Both are required to route a call — a method
 * present in one but not the other is treated as not found.
 */
export function createDispatcher(
  methodSpecs: Record<string, MethodSpec>,
  handlers: Record<string, Handler>,
  notify: (method: string, params: unknown) => void,
  clientId?: string,
): Dispatcher {
  const ctx: RpcContext = { notify, ...(clientId === undefined ? {} : { clientId }) };

  async function handleLine(line: string): Promise<string> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      return serialize({
        id: null,
        error: { code: ErrorCode.ParseError, message: `parse error: ${errorMessage(e)}` },
      });
    }

    const envelope = requestSchema.safeParse(raw);
    if (!envelope.success) {
      const maybeId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
      const id = typeof maybeId === 'number' ? maybeId : null;
      return serialize({
        id,
        error: { code: ErrorCode.ParseError, message: 'invalid request envelope' },
      });
    }

    const { id, method, params } = envelope.data;
    const spec = methodSpecs[method];
    const handler = handlers[method];
    if (!spec || !handler) {
      return serialize({ id, error: { code: ErrorCode.MethodNotFound, message: `method not found: ${method}` } });
    }

    const parsedParams = spec.params.safeParse(params);
    if (!parsedParams.success) {
      return serialize({
        id,
        error: {
          code: ErrorCode.InvalidParams,
          message: `invalid params: ${formatZodError(parsedParams.error)}`,
        },
      });
    }

    try {
      const result = await handler(parsedParams.data, ctx);
      return serialize({ id, result });
    } catch (e) {
      return serialize({ id, error: { code: ErrorCode.ServerError, message: errorMessage(e) } });
    }
  }

  return { handleLine };
}
