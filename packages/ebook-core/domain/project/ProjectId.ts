import { Identifier } from '../shared/Identifier';

export class ProjectId extends Identifier {
  static from(value: string): ProjectId {
    return new ProjectId(value);
  }
}
