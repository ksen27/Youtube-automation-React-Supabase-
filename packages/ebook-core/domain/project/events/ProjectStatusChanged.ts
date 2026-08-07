import { BaseDomainEvent } from '../../shared/DomainEvent';
import type { ProjectState } from '../ProjectStatus';

export class ProjectStatusChanged extends BaseDomainEvent {
  readonly name = 'project.status.changed';
  constructor(
    aggregateId: string,
    public readonly from: ProjectState,
    public readonly to: ProjectState,
    occurredAt: Date,
  ) {
    super(aggregateId, occurredAt);
  }
}
