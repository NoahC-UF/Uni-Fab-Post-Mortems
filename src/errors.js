// An error whose message is safe and useful to show to the user (bad input, not allowed, not found).
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export const notFound = (what = 'That page') => new UserError(`${what} was not found.`, 404);
export const forbidden = (msg = 'You do not have permission to do that.') => new UserError(msg, 403);
