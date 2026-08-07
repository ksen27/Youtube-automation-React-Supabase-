import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { JobQueue } from '../ports/services/JobQueue';
import type { ProjectJob } from '../dto/jobs.dto';

/**
 * Phase 12 controller. The project is already in POLISHING_BOOK (the orchestrator
 * advanced it from GENERATING_CHAPTERS). This sets the per-chapter fan-in barrier
 * and enqueues one polish-chapter job per chapter, turning the old serial
 * per-chapter loop into parallel work. The barrier (decremented by each
 * polish-chapter job) advances POLISHING_BOOK → ASSEMBLING once every chapter is
 * polished — mirrors StartChapterGenerationUseCase.
 */
export class StartBookPolishUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly books: BookRepository,
    private readonly queue: JobQueue,
  ) {}

  async execute(cmd: ProjectJob): Promise<Result<{ chapters: number }>> {
    const projectId = ProjectId.from(cmd.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');

    // Barrier counts every chapter; jobs decrement once each (even when a chapter
    // is skipped), so the count must match book.chapters.length exactly.
    project.setPending('POLISHING_BOOK', book.chapters.length);
    await this.projects.save(project);

    for (const chapter of book.chapters) {
      await this.queue.enqueue(
        'polish-chapter',
        { projectId: projectId.value, chapterId: chapter.id.value },
        { jobId: `polish-chapter:${projectId.value}:${chapter.id.value}` },
      );
    }
    return Result.ok({ chapters: book.chapters.length });
  }
}
