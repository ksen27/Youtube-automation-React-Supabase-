import type { Result } from '../../../domain/shared/Result';
import type { BindValues } from '../../landing/bindTemplate';

/**
 * Assembles a parameterised template into the finished document.
 *
 * The port exists for the same reason `LandingPageAssembler` did — to keep the
 * use case free of markup construction — but the job is far smaller. There is
 * no document shell to build, no component stylesheet, no palette: the document
 * already exists. This replaces its stylesheet links with the bundled copy,
 * restores the identity that cleaning stripped, and fills the tokens.
 */
export interface LandingPageBinder {
  assemble(input: {
    templateHtml: string;
    css: string;
    themeOverrideCss: string;
    /** Set only when the template writes its accent as a literal colour. */
    accentLiteral: { from: string; to: string } | null;
    values: BindValues;
    required: readonly string[];
    documentTitle: string;
    metaDescription: string;
  }): Result<{ html: string; unresolved: string[]; removedOptional: string[] }, string[]>;
}
