/**
 * Skills as a surface you can read.
 *
 * Deliberately the Memory screen's shape, down to the preview disclosure at
 * the bottom, because it answers the same question: what is the model actually
 * being told? A skill you cannot inspect is a skill you stop trusting.
 *
 * There is no create form. A skill is a folder, so the empty state names the
 * two places folders go and gets out of the way. That costs one manual step
 * and buys two things: ModelDock never writes into someone's repository, and a
 * skill cloned from a colleague behaves exactly like one written by hand.
 */

import { useCallback, useEffect, useState } from "react";

import { api, type SkillView } from "../lib/api";

interface SkillsPanelProps {
  projectId?: string | null;
  onChanged?: () => void;
}

export function SkillsPanel({ projectId = null, onChanged }: SkillsPanelProps) {
  const [items, setItems] = useState<SkillView[]>([]);
  const [roots, setRoots] = useState<{ global: string; project: string | null } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Listing rescans disk first, so opening this screen is also how you
      // pick up a skill you just added in an editor.
      const [{ skills, roots: found }, { block }] = await Promise.all([
        api.skills(projectId),
        api.skillPreview(projectId),
      ]);
      setItems(skills);
      setRoots(found);
      setPreview(block);
      setFailure(null);
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reveal = async (skill: SkillView) => {
    if (open === skill.id) return setOpen(null);
    setOpen(skill.id);
    if (body[skill.id] !== undefined) return;

    const { instructions } = await api.skill(skill.id);
    setBody((current) => ({ ...current, [skill.id]: instructions ?? "Could not read SKILL.md." }));
  };

  const rescan = async () => {
    await api.scanSkills(projectId);
    await load();
    onChanged?.();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-[1.25rem] font-semibold tracking-tight">Skills</h1>
        <p className="mt-1 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
          {projectId
            ? "Instructions for specific tasks, available in this project and everywhere."
            : "Instructions for specific tasks, available in every conversation."}
        </p>
      </header>

      {failure && (
        <p className="mb-4 text-[0.8125rem]" style={{ color: "var(--danger)" }}>
          {failure}
        </p>
      )}

      {items.length === 0 ? (
        <div className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
          <p>Nothing installed yet. A skill is a folder with a SKILL.md in it.</p>
          {roots && (
            <ul className="mt-3 flex flex-col gap-1">
              <li>
                <span className="font-mono">{roots.global}</span> — available everywhere
              </li>
              {roots.project ? (
                <li>
                  <span className="font-mono">{roots.project}</span> — travels with the repository
                </li>
              ) : (
                projectId && (
                  <li>Set this project&rsquo;s directory to keep skills alongside it.</li>
                )
              )}
            </ul>
          )}
        </div>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.id} className="border-b py-2.5" style={{ borderColor: "var(--line)" }}>
              <div className="group flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[0.875rem]">
                    {item.name}
                    {item.problem && (
                      <span className="ml-2 text-[0.75rem]" style={{ color: "var(--danger)" }}>
                        not usable
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
                    {item.problem ?? item.description}
                  </p>
                  <p className="mt-1 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
                    <span className="font-mono">{item.slug}</span>
                    {" · "}
                    {item.scope === "global" ? "Everywhere" : "This project"}
                    {item.triggers && item.triggers.length > 0
                      ? ` · ${item.triggers.join(", ")}`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void reveal(item)}
                  className="text-[0.6875rem] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                  style={{ color: "var(--ink-3)" }}
                >
                  {open === item.id ? "Hide" : "Read"}
                </button>
              </div>

              {open === item.id && (
                <pre
                  className="scroll-x mt-2 whitespace-pre-wrap rounded-[var(--radius)] border p-3 font-mono text-[0.75rem]"
                  style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
                >
                  {body[item.id] ?? "Reading…"}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex items-center gap-4">
        <button
          type="button"
          onClick={() => void rescan()}
          className="text-[0.75rem] transition-colors hover:text-[var(--ink)]"
          style={{ color: "var(--ink-3)" }}
        >
          Rescan
        </button>

        {preview && (
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview)}
            className="text-[0.75rem] transition-colors hover:text-[var(--ink)]"
            style={{ color: "var(--ink-3)" }}
          >
            {showPreview ? "Hide" : "Show"} what the model is told
          </button>
        )}
      </div>

      {showPreview && preview && (
        <pre
          className="scroll-x mt-2 whitespace-pre-wrap rounded-[var(--radius)] border p-3 font-mono text-[0.75rem]"
          style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
        >
          {preview}
        </pre>
      )}
    </div>
  );
}
