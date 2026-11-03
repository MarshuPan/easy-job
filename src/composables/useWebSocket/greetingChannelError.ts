/** Only errors raised before calling the platform send function allow safe fallback. */
export class GreetingChannelUnavailableError extends Error {
  readonly notSubmitted = true
}
