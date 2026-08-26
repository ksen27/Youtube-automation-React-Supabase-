"use client";

import * as React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckSquare, GripVertical, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { BoardChecklist, BoardChecklistItem } from "@/lib/boards/types";
import { InlineText } from "./inline-text";

// Checklists inside the card detail view.
//
// Reordering uses its own DndContext, isolated from the board's: a checklist
// drag must never be interpreted by the board as a card move, and nesting the
// two contexts is exactly how that happens.

export interface ChecklistSectionProps {
  checklists: BoardChecklist[];
  canEdit: boolean;
  onCreate: (title: string) => void;
  onRename: (checklistId: string, title: string) => void;
  onDelete: (checklistId: string) => void;
  onAddItem: (checklistId: string, title: string) => void;
  onUpdateItem: (
    itemId: string,
    patch: { title?: string; completed?: boolean; targetIndex?: number },
  ) => void;
  onDeleteItem: (itemId: string) => void;
}

export function ChecklistSection({
  checklists,
  canEdit,
  onCreate,
  onRename,
  onDelete,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
}: ChecklistSectionProps) {
  const [addingChecklist, setAddingChecklist] = React.useState(false);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          <CheckSquare className="h-3.5 w-3.5" />
          Checklists
        </h3>
        {canEdit && !addingChecklist && (
          <Button size="xs" variant="ghost" onClick={() => setAddingChecklist(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add checklist
          </Button>
        )}
      </div>

      {addingChecklist && (
        <QuickAdd
          placeholder="Checklist title"
          buttonLabel="Add checklist"
          onSubmit={(title) => {
            onCreate(title);
            setAddingChecklist(false);
          }}
          onCancel={() => setAddingChecklist(false)}
        />
      )}

      {checklists.length === 0 && !addingChecklist && (
        <p className="text-xs text-fg-subtle">No checklists yet.</p>
      )}

      {checklists.map((checklist) => (
        <Checklist
          key={checklist.id}
          checklist={checklist}
          canEdit={canEdit}
          onRename={onRename}
          onDelete={onDelete}
          onAddItem={onAddItem}
          onUpdateItem={onUpdateItem}
          onDeleteItem={onDeleteItem}
        />
      ))}
    </section>
  );
}

function Checklist({
  checklist,
  canEdit,
  onRename,
  onDelete,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
}: {
  checklist: BoardChecklist;
} & Omit<ChecklistSectionProps, "checklists" | "onCreate">) {
  const [adding, setAdding] = React.useState(false);
  const done = checklist.items.filter((i) => i.completed).length;
  const total = checklist.items.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const targetIndex = checklist.items.findIndex((i) => i.id === over.id);
    if (targetIndex < 0) return;
    onUpdateItem(String(active.id), { targetIndex });
  };

  return (
    <div className="rounded-[10px] border border-border bg-surface-2/40 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <InlineText
          value={checklist.title}
          disabled={!canEdit}
          onSave={(title) => onRename(checklist.id, title)}
          className="flex-1 text-sm font-medium text-fg"
        />
        <span className="text-[11px] tabular-nums text-fg-muted">
          {done} / {total} completed
        </span>
        {canEdit && (
          <button
            type="button"
            aria-label={`Delete ${checklist.title}`}
            onClick={() => onDelete(checklist.id)}
            className="text-fg-subtle hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <Progress value={percent} className="h-1.5" />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={checklist.items.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="space-y-0.5">
            {checklist.items.map((item) => (
              <ChecklistItemRow
                key={item.id}
                item={item}
                canEdit={canEdit}
                onUpdate={onUpdateItem}
                onDelete={onDeleteItem}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {canEdit &&
        (adding ? (
          <QuickAdd
            placeholder="Add an item"
            buttonLabel="Add item"
            keepOpen
            onSubmit={(title) => onAddItem(checklist.id, title)}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add an item
          </Button>
        ))}
    </div>
  );
}

function ChecklistItemRow({
  item,
  canEdit,
  onUpdate,
  onDelete,
}: {
  item: BoardChecklistItem;
  canEdit: boolean;
  onUpdate: ChecklistSectionProps["onUpdateItem"];
  onDelete: ChecklistSectionProps["onDeleteItem"];
}) {
  // Destructured for the same reason as in list-column.tsx: the React Compiler
  // lint treats member access on this hook result as a ref read during render.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canEdit,
  });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-hover",
        isDragging && "opacity-50",
      )}
    >
      {canEdit && (
        <button
          type="button"
          aria-label={`Reorder ${item.title}`}
          {...attributes}
          {...listeners}
          className="text-fg-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}

      <input
        type="checkbox"
        checked={item.completed}
        disabled={!canEdit}
        aria-label={item.title}
        onChange={(e) => onUpdate(item.id, { completed: e.target.checked })}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand-500)]"
      />

      <InlineText
        value={item.title}
        disabled={!canEdit}
        onSave={(title) => onUpdate(item.id, { title })}
        className={cn("flex-1 text-sm", item.completed && "text-fg-muted line-through")}
      />

      {canEdit && (
        <button
          type="button"
          aria-label={`Delete ${item.title}`}
          onClick={() => onDelete(item.id)}
          className="text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

/** Small inline composer shared by "add checklist" and "add item". */
function QuickAdd({
  placeholder,
  buttonLabel,
  onSubmit,
  onCancel,
  keepOpen = false,
}: {
  placeholder: string;
  buttonLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  keepOpen?: boolean;
}) {
  const [value, setValue] = React.useState("");
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => ref.current?.focus(), []);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
    // Adding items is a burst activity, so the item composer stays open and
    // focused while the checklist composer closes after one use.
    if (keepOpen) ref.current?.focus();
    else onCancel();
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        className={cn(
          "h-8 flex-1 rounded-md border border-brand-500 bg-surface px-2 text-sm text-fg",
          "placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25",
        )}
      />
      <Button size="sm" onClick={submit} disabled={!value.trim()}>
        {buttonLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
