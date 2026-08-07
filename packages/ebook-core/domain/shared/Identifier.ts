/** Base for strongly-typed ids. Prevents passing a ChannelId where a VideoId is expected. */
export abstract class Identifier<T extends string = string> {
  protected constructor(public readonly value: T) {}

  equals(other?: Identifier<T>): boolean {
    return other !== undefined && other !== null && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}
