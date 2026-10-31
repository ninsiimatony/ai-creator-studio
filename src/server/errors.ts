/** An error whose message is safe to show to the user. Anything else is logged and masked. */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}
