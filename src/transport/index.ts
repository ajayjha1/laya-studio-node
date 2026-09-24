export interface TransportRequest {
  /** Path relative to the endpoint, e.g. `/v1/systemone`. */
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
  /** Overrides the transport's configured timeout for this call. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The single seam between the SDK and the network.
 *
 * Everything above this line — classify, decide, route, batch — is transport
 * agnostic, so a hosted Laya, a local server or an in-process fake all satisfy
 * the same contract.
 */
export interface LayaTransport {
  request<T>(request: TransportRequest): Promise<T>;
  /** Base URL, used for error messages and cache scoping. */
  readonly endpoint: string;
}

export { HttpTransport } from './http.js';
