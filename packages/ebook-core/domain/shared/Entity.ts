import type { Identifier } from './Identifier';

/** Entity: identity-based equality, mutable props. */
export abstract class Entity<TProps, TId extends Identifier> {
  protected readonly _id: TId;
  protected props: TProps;

  protected constructor(props: TProps, id: TId) {
    this.props = props;
    this._id = id;
  }

  get id(): TId {
    return this._id;
  }

  equals(other?: Entity<TProps, TId>): boolean {
    return other !== undefined && other !== null && this._id.equals(other._id);
  }
}
