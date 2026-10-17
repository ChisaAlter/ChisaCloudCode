import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { installFrontendErrorReporting, reportFrontendError } from '@/shared/chisa';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => ({ call: native.call }));

let uninstallReporting: (() => void) | undefined;

function rejectionEvent(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

beforeEach(() => {
  native.call.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('mygo', {});
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

afterEach(() => {
  uninstallReporting?.();
  uninstallReporting = undefined;
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

test('records only redacted diagnostics through the desktop bridge without reading user state', () => {
  window.history.replaceState(null, '', '/session/current?token=url-secret#fragment');
  localStorage.setItem('auth-token', 'saved-auth-secret');
  localStorage.setItem('draft', 'private message');
  const readStorage = vi.spyOn(Storage.prototype, 'getItem');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const failure = new Error('Failure token=message-token api_key: message-key password=message-password Bearer bearer-secret');
  failure.stack = 'Error: Failure\n    at render (http://localhost/app.tsx?token=stack-token&api_key=stack-key)';
  const componentStack = '\n    at SidebarSessionItem (/src/sidebar.tsx:10:2)';

  reportFrontendError('app-render', failure, componentStack);

  expect(native.call.mock.calls).toEqual([[
    'FrontendBridge.ReportFrontendError',
    {
      source: 'app-render',
      path: '/session/current',
      message: 'Error: Failure token=[redacted] api_key: [redacted] password=[redacted] Bearer [redacted]',
      stack: 'Error: Failure\n    at render (http://localhost/app.tsx?token=[redacted]&api_key=[redacted]',
      componentStack,
    },
  ]]);
  expect(readStorage).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('does not forward browser errors or serialize arbitrary rejection data', () => {
  vi.stubGlobal('mygo', undefined);
  reportFrontendError('window-error', new Error('browser failure'));
  expect(native.call).not.toHaveBeenCalled();

  vi.stubGlobal('mygo', {});
  const serializePrivateData = vi.fn(() => ({ token: 'secret', message: 'private message' }));
  const rejection = { request: { authorization: 'private credential' }, toJSON: serializePrivateData };
  const stringify = vi.spyOn(JSON, 'stringify');
  reportFrontendError('unhandled-rejection', rejection);
  reportFrontendError('window-error', 'authorization: string-secret');

  expect(native.call.mock.calls).toEqual([
    ['FrontendBridge.ReportFrontendError', {
      source: 'unhandled-rejection', path: '/', message: 'Unknown frontend error', stack: '', componentStack: '',
    }],
    ['FrontendBridge.ReportFrontendError', {
      source: 'window-error', path: '/', message: 'authorization: [redacted]', stack: '', componentStack: '',
    }],
  ]);
  expect(serializePrivateData).not.toHaveBeenCalled();
  expect(stringify).not.toHaveBeenCalled();
});

test('reports window errors and promise rejections without suppressing events and removes both listeners', () => {
  uninstallReporting = installFrontendErrorReporting();
  const failure = new Error('render failed');
  const error = new ErrorEvent('error', { error: failure, cancelable: true });
  const messageOnlyError = new ErrorEvent('error', { message: 'script failed', cancelable: true });
  const rejection = rejectionEvent('promise failed');

  window.dispatchEvent(error);
  window.dispatchEvent(messageOnlyError);
  window.dispatchEvent(rejection);

  expect(native.call.mock.calls.map(([method, report]) => [method, report.source, report.message])).toEqual([
    ['FrontendBridge.ReportFrontendError', 'window-error', 'Error: render failed'],
    ['FrontendBridge.ReportFrontendError', 'window-error', 'script failed'],
    ['FrontendBridge.ReportFrontendError', 'unhandled-rejection', 'promise failed'],
  ]);
  expect(error.defaultPrevented).toBe(false);
  expect(messageOnlyError.defaultPrevented).toBe(false);
  expect(rejection.defaultPrevented).toBe(false);

  uninstallReporting();
  uninstallReporting = undefined;
  window.dispatchEvent(new ErrorEvent('error', { message: 'after cleanup' }));
  window.dispatchEvent(rejectionEvent('after cleanup'));
  expect(native.call).toHaveBeenCalledTimes(3);
});

test('contains a rejected diagnostic write instead of recursively reporting it', async () => {
  native.call.mockRejectedValue(new Error('app.log unavailable'));
  uninstallReporting = installFrontendErrorReporting();
  const unhandled = vi.fn();
  window.addEventListener('unhandledrejection', unhandled);
  try {
    window.dispatchEvent(new ErrorEvent('error', { message: 'original failure' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(native.call).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('unhandledrejection', unhandled);
  }
});
