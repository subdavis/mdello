export type DebugLogger = (message: string, details?: Record<string, unknown>) => void;

export function createDebugLogger(
  environment: Pick<NodeJS.ProcessEnv, 'DEBUG'> = process.env,
  write: (message: string) => void = console.error,
): DebugLogger {
  if (environment.DEBUG !== '1') return () => {};

  return (message, details) => {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    write(`[mdello-companion] ${message}${suffix}`);
  };
}
