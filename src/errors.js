// An error that is safe to show to the client. Anything that is NOT an
// HttpError is treated as a bug and answered with a generic 500.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new HttpError(400, 'bad_request', message);
export const unauthenticated = (message = 'Log in first') => new HttpError(401, 'unauthenticated', message);
export const forbidden = (message = 'You are not allowed to do this') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
