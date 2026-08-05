/**
 * ⌘K.
 *
 * One index over everything addressable: conversations, projects, the
 * settings surfaces, and the actions worth reaching without the mouse. In a
 * workspace people live in all day this ends up being the primary way to
 * navigate, so it opens on the keyboard and closes on Escape without
 * exception.
 */

import { Command } from "cmdk";
import { useEffect } from "react";

import type { ProjectView, ThreadView } from "../lib/api";
import type { Surface } from "./Sidebar";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: ThreadView[];
  projects: ProjectView[];
  onSelect: (surface: Surface) => void;
  onNewChat: () => void;
  onNewProject: () => void;
  /** Absent when no agent is installed, or no project has a directory. */
  onNewCodeSession?: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  threads,
  projects,
  onSelect,
  onNewChat,
  onNewProject,
  onNewCodeSession,
}: CommandPaletteProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const go = (surface: Surface) => {
    onSelect(surface);
    onOpenChange(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search ModelDock"
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
    >
      <div
        aria-hidden
        onClick={() => onOpenChange(false)}
        className="fixed inset-0"
        style={{ background: "color-mix(in srgb, var(--ink) 22%, transparent)" }}
      />

      <div
        className="relative w-full max-w-lg overflow-hidden rounded-[var(--radius)] border shadow-2xl"
        style={{ background: "var(--surface)", borderColor: "var(--line)" }}
      >
        <Command.Input
          placeholder="Search conversations, projects, settings…"
          className="w-full border-b bg-transparent px-4 py-3 text-[0.9375rem] outline-none placeholder:text-[var(--ink-3)]"
          style={{ borderColor: "var(--line)" }}
        />

        <Command.List className="max-h-[22rem] overflow-y-auto p-1.5">
          <Command.Empty
            className="px-3 py-6 text-center text-[0.8125rem]"
            style={{ color: "var(--ink-3)" }}
          >
            Nothing matches.
          </Command.Empty>

          <Group heading="Actions">
            <Item
              onSelect={() => {
                onNewChat();
                onOpenChange(false);
              }}
            >
              New chat
            </Item>
            <Item
              onSelect={() => {
                onNewProject();
                onOpenChange(false);
              }}
            >
              New project
            </Item>
            {onNewCodeSession && (
              <Item
                onSelect={() => {
                  onNewCodeSession();
                  onOpenChange(false);
                }}
              >
                New code session
              </Item>
            )}
            <Item onSelect={() => go({ kind: "memory" })}>Open memory</Item>
            <Item onSelect={() => go({ kind: "skills" })}>Open skills</Item>
            <Item onSelect={() => go({ kind: "connections" })}>Open connections</Item>
            <Item onSelect={() => go({ kind: "settings" })}>Open settings</Item>
          </Group>

          {projects.length > 0 && (
            <Group heading="Projects">
              {projects.map((project) => (
                <Item key={project.id} onSelect={() => go({ kind: "project", id: project.id })}>
                  {project.name}
                </Item>
              ))}
            </Group>
          )}

          {threads.length > 0 && (
            <Group heading="Conversations">
              {threads.map((thread) => (
                <Item key={thread.id} onSelect={() => go({ kind: "thread", id: thread.id })}>
                  {thread.title ?? "New chat"}
                </Item>
              ))}
            </Group>
          )}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--ink-3)]"
    >
      {children}
    </Command.Group>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="cursor-pointer truncate rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[0.8125rem] data-[selected=true]:bg-[var(--wash)]"
    >
      {children}
    </Command.Item>
  );
}
