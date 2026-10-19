import { AiProviderConfigurationError } from './errors';
import type { AiProvider } from './provider';
import {
  createAnthropicProvider,
  type AnthropicProviderOptions,
} from './providers/anthropic/adapter';

/** Options-in: the composition root supplies everything; this package never reads env. */
export type CreateAiProviderOptions = { provider: 'anthropic' } & AnthropicProviderOptions;

export function createAiProvider(options: CreateAiProviderOptions): AiProvider {
  switch (options.provider) {
    case 'anthropic':
      return createAnthropicProvider(options);
    default:
      throw new AiProviderConfigurationError(
        `Unknown AI provider "${(options as { provider: string }).provider}"`,
      );
  }
}
