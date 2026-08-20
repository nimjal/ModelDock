/**
 * Memory as a surface you can read and edit.
 *
 * The important affordance here is the preview: it shows the exact block that
 * gets prepended to every turn. Memory you cannot inspect is memory you end
 * up not trusting, and the gap between "what I saved" and "what the model was
 * told" is where that trust usually breaks.
 */

import { useCallback, useEffect, useState } from "react";

import { api, type MemoryView, type ProjectView } from "../lib/api";

interface MemoryPanelProps {
  projects: ProjectView[];
  projectId?: string | null;
  onChanged?: () => void;
}

export function MemoryPanel({ projects, projectId = null, onChanged }: MemoryPanelProps) {
  const [items, setItems] = useState<MemoryView[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ memories }, { block }] = await Promise.all([
        api.memories(projectId ? { projectId } : undefined),
        api.memoryPreview(projectId),
      ]);
      setItems(memories);
      setPreview(block);
      setFailure(null);
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!title.trim()) return;
    try {
      await api.createMemory({
        title: title.trim(),
        body: body.trim(),
        scope: projectId ? "project" : "global",
        projectId,
      });
      setTitle("");
      setBody("");
      await load();
      onChanged?.();
    } catch (error) {
      setFailure((error as Error).message);
    }
  };

  const drop = async (id: string) => {
    await api.deleteMemory(id);
    await load();
    onChanged?.();
  };

  const togglePin = async (item: MemoryView) => {
    await api.updateMemory(item.id, { pinned: !item.pinned });
    await load();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-[1.25rem] font-semibold tracking-tight">Memory</h1>
        <p className="mt-1 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
          {projectId
            ? "What the assistant knows in this project, on top of everything global."
            : "What the assistant knows in every conversation, whichever model is docked."}
        </p>
      </header>

      <div
        className="mb-6 rounded-[var(--radius)] border p-3.5"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Something worth keeping"
          className="w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-[var(--ink-3)]"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) void add();
          }}
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={2}
          placeholder="Detail, if the line above needs it"
          className="mt-2 w-full resize-none bg-transparent text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
          style={{ color: "var(--ink-2)" }}
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void add()}
            disabled={!title.trim()}
            className="rounded-[var(--radius-sm)] px-3 py-1 text-[0.75rem] font-medium transition-opacity disabled:opacity-30"
            style={{ background: "var(--ink)", color: "var(--paper)" }}
          >
            Remember
          </button>
        </div>
      </div>

      {failure && (
        <p className="mb-4 text-[0.8125rem]" style={{ color: "var(--danger)" }}>
          {failure}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
          Nothing saved yet. Anything you add here reaches every conversation in scope — and the
          assistant can save things itself as they come up.
        </p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li
              key={item.id}
              className="group flex items-start gap-3 border-b py-2.5"
              style={{ borderColor: "var(--line)" }}
            >
              <button
                type="button"
                onClick={() => void togglePin(item)}
                aria-label={item.pinned ? "Unpin" : "Pin"}
                className="mt-1 text-[0.75rem] transition-colors"
                style={{ color: item.pinned ? "var(--focus)" : "var(--ink-3)" }}
              >
                {item.pinned ? "★" : "☆"}
              </button>

              <div className="min-w-0 flex-1">
                <p className="text-[0.875rem]">{item.title}</p>
                {item.body && (
                  <p className="mt-0.5 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
                    {item.body}
                  </p>
                )}
                <p className="mt-1 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
                  {item.scope === "global"
                    ? "Everywhere"
                    : (projects.find((p) => p.id === item.projectId)?.name ?? "This project")}
                  {item.sourceThreadId ? " · saved from a conversation" : ""}
                </p>
              </div>

              <button
                type="button"
                onClick={() => void drop(item.id)}
                className="text-[0.6875rem] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                style={{ color: "var(--ink-3)" }}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setShowPreview((value) => !value)}
            className="text-[0.75rem] transition-colors hover:text-[var(--ink)]"
            style={{ color: "var(--ink-3)" }}
          >
            {showPreview ? "Hide" : "Show"} what the model is told
          </button>
          {showPreview && (
            <pre
              className="scroll-x mt-2 whitespace-pre-wrap rounded-[var(--radius)] border p-3 font-mono text-[0.75rem]"
              style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
            >
              {preview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
