/**
 * Normalized AI error hierarchy. Every adapter maps its vendor SDK's errors
 * onto these classes so callers never branch on a vendor-specific type.
 *
 * Retryability is classified here (`retryable`) and decided on by the caller
 * (`@devflow/queue`) — this package never retries a failed provider call.
 */
export class AiError extends Error {
  readonly retryable: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid/missing credentials — not retryable. */
export class AiAuthenticationError extends AiError {}

/** Provider rate limit hit — retryable. */
export class AiRateLimitError extends AiError {
  override readonly retryable = true;
}

/** Call exceeded its time budget — retryable. */
export class AiTimeoutError extends AiError {
  override readonly retryable = true;
}

/**
 * Vendor-side failure not classified further. Retryability is
 * provider-specific, so the adapter decides per instance.
 */
export class AiProviderError extends AiError {
  override readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options);
    this.retryable = options?.retryable ?? false;
  }
}

/** Structured output failed schema validation (after the one repair attempt) — not retryable. */
export class AiValidationError extends AiError {}

/** Provider/network unreachable — retryable. */
export class AiUnavailableError extends AiError {
  override readonly retryable = true;
}

/** Requested capability has no configured model, or the provider can't serve it — not retryable, fails fast. */
export class AiProviderConfigurationError extends AiError {}
