import type { Result } from '../../../domain/shared/Result';
import type { Rgb } from '../../../domain/landing/Palette';

/**
 * Extracts the dominant colour of an image. Kept behind a port because the only
 * implementation pulls in sharp (native bindings), which the domain and
 * application layers must stay free of.
 */
export interface ImageColorSampler {
  dominantColor(bytes: Uint8Array): Promise<Result<Rgb>>;
}
