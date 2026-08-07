import { Entity } from '../shared/Entity';
import { IllustrationId } from './ids';

interface IllustrationProps {
  chapterId: string;
  /** 0-based slot within the chapter; the renderer spreads slots across paragraphs. */
  orderInChapter: number;
  /** Path in the 'exports' bucket where the generated PNG lives. */
  storagePath: string;
  /** The (textless) prompt used to generate it — kept for debugging/regeneration. */
  prompt: string | null;
}

/**
 * One AI-generated, full-color editorial illustration placed inside a chapter.
 * Illustrations are spaced roughly every five finished pages across the whole
 * book and each is generated from the passage it sits beside, so the art matches
 * the surrounding content.
 */
export class Illustration extends Entity<IllustrationProps, IllustrationId> {
  static create(input: IllustrationProps & { id: IllustrationId }): Illustration {
    const { id, ...props } = input;
    return new Illustration(props, id);
  }
  static rehydrate(props: IllustrationProps, id: IllustrationId): Illustration {
    return new Illustration(props, id);
  }

  get chapterId() {
    return this.props.chapterId;
  }
  get orderInChapter() {
    return this.props.orderInChapter;
  }
  get storagePath() {
    return this.props.storagePath;
  }
  get prompt() {
    return this.props.prompt;
  }
}
