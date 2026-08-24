export const APP_ERROR_CODES = [
  'SESSION_EXISTS',
  'AGENT_SESSION_IN_USE',
  'AGENT_EXITED_DURING_STARTUP',
  'AGENT_IDENTITY_TIMEOUT',
  'SESSION_NOT_FOUND',
  'INVALID_SESSION_NAME',
  'NOT_INITIALIZED',
  'INVALID_CWD',
  'BINARY_NOT_FOUND',
  'INVALID_OPTIONS',
  'INVALID_RESUME',
  'START_FAILED',
  'DAEMON_UNAVAILABLE',
  'DAEMON_UNRESPONSIVE',
  'REQUEST_TIMEOUT',
  'UNKNOWN',
] as const;

export type AppErrorCode = typeof APP_ERROR_CODES[number];

export type ErrorContext = Record<string, string | number | boolean | undefined>;

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly context: ErrorContext;

  constructor(
    code: AppErrorCode,
    message: string,
    context: ErrorContext = {},
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.context = context;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && APP_ERROR_CODES.includes(value as AppErrorCode);
}

export function asAppError(
  error: unknown,
  code: AppErrorCode = 'UNKNOWN',
  context: ErrorContext = {},
): AppError {
  if (isAppError(error)) {
    if (Object.keys(context).length === 0) return error;
    return new AppError(error.code, error.message, { ...context, ...error.context }, { cause: error });
  }
  return new AppError(code, errorMessage(error), context, { cause: error });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serializeAppError(error: unknown): {
  error: string;
  errorCode?: AppErrorCode;
  errorContext?: ErrorContext;
} {
  if (!isAppError(error)) return { error: errorMessage(error) };
  const errorContext = Object.fromEntries(
    Object.entries(error.context).filter(([, value]) => value !== undefined),
  );
  return {
    error: error.message,
    errorCode: error.code,
    ...(Object.keys(errorContext).length > 0 ? { errorContext } : {}),
  };
}

export function systemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
