import pino from 'pino';

export type Logger = pino.Logger;

/** Never log coordinates, emails or tokens (AGENTS.md rule 9). The redact list is a safety net. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        '*.password',
        '*.refreshToken',
        '*.accessToken',
        '*.email',
        '*.lat',
        '*.lng',
        '*.fix',
        '*.samples',
      ],
      remove: true,
    },
  });
}
