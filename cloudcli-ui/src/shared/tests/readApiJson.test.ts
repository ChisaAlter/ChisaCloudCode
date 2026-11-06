import { describe, expect, it } from 'vitest';

import { ApiRequestError, readApiJson } from '@/shared/api';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const failure = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected readApiJson to reject');
    },
    (error: unknown) => error,
  );

describe('readApiJson', () => {
  it('resolves the payload for successful envelopes', async () => {
    const data = await readApiJson<{ data: { ok: boolean } }>(
      jsonResponse({ success: true, data: { ok: true } }),
    );
    expect(data.data.ok).toBe(true);
  });

  it('throws an ApiRequestError carrying code/details/status for the structured AppError envelope', async () => {
    const error = await failure(
      readApiJson(
        jsonResponse(
          {
            success: false,
            error: { code: 'BROWSER_USE_SESSION_STOP_FAILED', message: 'Failed to stop.', details: 'inner detail' },
          },
          400,
        ),
      ),
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    const apiError = error as ApiRequestError;
    expect(apiError.message).toBe('Failed to stop.');
    expect(apiError.code).toBe('BROWSER_USE_SESSION_STOP_FAILED');
    expect(apiError.details).toBe('inner detail');
    expect(apiError.status).toBe(400);
  });

  it('preserves top-level details on legacy string envelopes', async () => {
    const error = await failure(
      readApiJson(jsonResponse({ success: false, error: 'boom', details: 'legacy detail' }, 500)),
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    const apiError = error as ApiRequestError;
    expect(apiError.message).toBe('boom');
    expect(apiError.details).toBe('legacy detail');
    expect(apiError.code).toBeUndefined();
    expect(apiError.status).toBe(500);
  });

  it.each([
    ['text/plain', 'error code: 502'],
    ['text/html', '<html><body>Bad Gateway</body></html>'],
    ['application/json', ''],
  ])('retains HTTP status for a non-JSON %s gateway response', async (contentType, body) => {
    const error = await failure(readApiJson(new Response(body, { status: 502, headers: { 'Content-Type': contentType } })));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ message: 'Request failed (502)', status: 502 });
    expect((error as Error).message).not.toContain('Unexpected');
    if (body) expect((error as Error).message).not.toContain(body);
  });

  it('rejects malformed successful JSON without leaking the response body', async () => {
    const error = await failure(readApiJson(new Response('<html>upstream failure</html>', { status: 200 })));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ message: 'Invalid JSON response (200)', code: 'INVALID_JSON_RESPONSE', status: 200 });
  });

  it('preserves cancellation during body consumption', async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start(stream) {
      controller.signal.addEventListener('abort', () => stream.error(new DOMException('Cancelled', 'AbortError')));
    } }));
    const result = failure(readApiJson(response));
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
  });

  it('uses the HTTP status text when the envelope has neither error nor details', async () => {
    const error = await failure(readApiJson(jsonResponse({ success: false }, 502)));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).message).toBe('Request failed (502)');
    expect((error as ApiRequestError).code).toBeUndefined();
  });
});
