import { Response } from 'express';

interface SuccessPayload<T = unknown> {
  res: Response;
  data?: T;
  message?: string;
  statusCode?: number;
}

interface ErrorPayload {
  res: Response;
  error: string;
  code?: string | number;
  statusCode?: number;
  /**
   * TRANSITION ONLY — mirrors the human text into a legacy `message` key for
   * consumers built against the old hand-rolled admin error shape
   * `{ success: false, message }` (deployed admin-panel builds may predate the
   * envelope migration). New endpoints must never set this; drop it once the
   * admin panel is confirmed reading `error`.
   */
  message?: string;
}

/**
 * Send a successful JSON response.
 *
 * Shape: { success: true, data, message }
 */
export const sendSuccess = <T = unknown>({
  res,
  data = {} as T,
  message = 'OK',
  statusCode = 200,
}: SuccessPayload<T>): void => {
  res.status(statusCode).json({ success: true, data, message });
};

/**
 * Send an error JSON response.
 *
 * Shape: { success: false, error, code } — plus a legacy `message` mirror when
 * the transition-only `message` field is set (see ErrorPayload).
 */
export const sendError = ({
  res,
  error,
  code,
  statusCode = 500,
  message,
}: ErrorPayload): void => {
  res.status(statusCode).json(
    message === undefined
      ? { success: false, error, code }
      : { success: false, error, code, message },
  );
};
