/**
 * Where a new chat starts, and which connection draws.
 *
 * Two settings that look the same and are not: the first says which engine
 * answers by default, the second says which one makes pictures — and they are
 * almost never the same connection, because Anthropic publishes no image model
 * at all. Putting them next to each other is what makes that legible rather
 * than surprising.
 *
 * No colour is spent here. The berth owns the accent, and a settings form that
 * tinted itself with the provider's colour would be the second saturated thing
 * in the app.
 */

import { useCallback, useEffect, useState } from "react";

import { api, type ConnectionView, type WorkspaceView } from "../lib/api";
import { ModelPicker } from "./ModelPicker";

export function WorkspaceDefaults({
  connections,
  onChanged,
}: {
  connections: ConnectionView[];
  /** The berth and the sidebar both read this state, so the shell re-fetches. */
  onChanged: () => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWorkspace(await api.workspace());
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Hoisted above every early return and every conditional branch, because it
   * is a hook. Bound to the chosen connection's id so switching provider
   * re-points the model list rather than showing the previous one's — the same
   * arrangement the berth uses.
   */
  const defaultConnectionId = workspace?.defaults.connectionId ?? null;
  const loadModels = useCallback(
    async () => (await api.models(defaultConnectionId!)).models,
    [defaultConnectionId],
  );

  const save = async (body: Parameters<typeof api.updateWorkspace>[0]) => {
    setFailure(null);
    try {
      setWorkspace(await api.updateWorkspace(body));
      onChanged();
    } catch (error) {
      setFailure((error as Error).message);
    }
  };

  if (!workspace) {
    return (
      <section className="mb-8">
        <h2 className="mb-2 text-[0.8125rem] font-medium">Default model</h2>
        <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
          {failure ?? "Loading…"}
        </p>
      </section>
    );
  }

  const { defaults, images } = workspace;
  const chosen = connections.find((item) => item.id === defaults.connectionId) ?? null;
  const imageChoice = images.eligible.find((item) => item.id === images.connectionId) ?? null;

  return (
    <>
      <section className="mb-8">
        <h2 className="mb-1 text-[0.8125rem] font-medium">Default model</h2>
        <p className="mb-3 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
          Every new conversation starts here. Changing it does not move chats you have already
          started, and you can still swap engine mid-thread from the chip in the header.
        </p>

        <Choices
          label="Connection"
          value={defaults.connectionId}
          onPick={(id) => void save({ defaultConnectionId: id, defaultModel: null })}
          options={connections.map((item) => ({
            id: item.id,
            name: item.name,
            detail: item.model,
            ready: item.ready,
          }))}
          emptyLabel="First one available"
        />

        {chosen?.ready && (
          <div className="mt-3">
            <p
              className="pb-1.5 text-[0.6875rem] font-medium uppercase tracking-wider"
              style={{ color: "var(--ink-3)" }}
            >
              Model
            </p>
            <ModelPicker
              compact
              value={defaults.model ?? chosen.model}
              load={loadModels}
              onPick={(model) => void save({ defaultModel: model })}
            />
            {defaults.model && (
              <button
                type="button"
                onClick={() => void save({ defaultModel: null })}
                className="mt-1.5 text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
                style={{ color: "var(--ink-3)" }}
              >
                Use {chosen.name}&rsquo;s own default instead
              </button>
            )}
          </div>
        )}

        <p className="mt-3 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
          {defaults.resolvedName
            ? `New chats open on ${defaults.resolvedName}${defaults.model ? ` · ${defaults.model}` : ""}${
                defaults.ready ? "" : " — which has no key set yet"
              }.`
            : "No connection to start on yet. Add one under Connections."}
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-[0.8125rem] font-medium">Image generation</h2>
        <p className="mb-3 text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
          Give the assistant somewhere to draw and it gains a{" "}
          <code className="font-mono text-[0.6875rem]">generate_image</code> tool it can call
          mid-conversation. This does not have to be the model you chat with — Anthropic has no
          image model, so a Claude conversation that makes pictures is the normal case.
        </p>

        {images.eligible.length === 0 ? (
          <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
            None of your connections can generate images. Add an OpenAI or Google connection, or an
            OpenAI-compatible endpoint that serves{" "}
            <code className="font-mono">/v1/images/generations</code>.
          </p>
        ) : (
          <>
            <Choices
              label="Connection"
              value={images.connectionId}
              onPick={(id) => void save({ imageConnectionId: id, imageModel: null })}
              options={images.eligible.map((item) => ({
                id: item.id,
                name: item.name,
                detail: item.defaultModel || item.kind,
                ready: item.ready,
              }))}
              emptyLabel="Off"
            />

            {imageChoice && (
              <div className="mt-3">
                <p
                  className="pb-1.5 text-[0.6875rem] font-medium uppercase tracking-wider"
                  style={{ color: "var(--ink-3)" }}
                >
                  Image model
                </p>
                <input
                  defaultValue={images.model ?? imageChoice.defaultModel}
                  key={imageChoice.id}
                  placeholder={imageChoice.defaultModel || "Model id"}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next !== (images.model ?? imageChoice.defaultModel)) {
                      void save({ imageModel: next || null });
                    }
                  }}
                  className="w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[0.8125rem] outline-none placeholder:text-[var(--ink-3)]"
                  style={{
                    borderColor: "var(--line)",
                    background: "var(--paper)",
                    fontFamily: "var(--font-mono)",
                  }}
                />

                {imageChoice.suggestedModels.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {imageChoice.suggestedModels.map((model) => (
                      <button
                        key={model}
                        type="button"
                        onClick={() => void save({ imageModel: model })}
                        className="rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-[0.6875rem] transition-colors hover:bg-[var(--wash)]"
                        style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
                      >
                        {model}
                      </button>
                    ))}
                  </div>
                )}

                <p className="mt-1.5 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
                  {imageChoice.hint}
                </p>
              </div>
            )}

            <p className="mt-3 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
              {images.active
                ? `The assistant can generate images with ${images.active.name} · ${images.active.model}.`
                : imageChoice
                  ? "Set a key for that connection before the tool is offered."
                  : "Image generation is off — the assistant is not given the tool."}
            </p>
          </>
        )}
      </section>

      {failure && (
        <p className="mb-8 text-[0.75rem]" style={{ color: "var(--danger)" }}>
          {failure}
        </p>
      )}
    </>
  );
}

/**
 * A short list of connections, one of which may be chosen.
 *
 * A row rather than a `<select>`, so a connection with no key can be shown as
 * such — the hollow dot the berth uses for exactly the same condition.
 */
function Choices({
  label,
  value,
  options,
  onPick,
  emptyLabel,
}: {
  label: string;
  value: string | null;
  options: { id: string; name: string; detail: string; ready: boolean }[];
  onPick: (id: string | null) => void;
  emptyLabel: string;
}) {
  return (
    <>
      <p
        className="pb-1.5 text-[0.6875rem] font-medium uppercase tracking-wider"
        style={{ color: "var(--ink-3)" }}
      >
        {label}
      </p>
      <div
        className="overflow-hidden rounded-[var(--radius-sm)] border"
        style={{ borderColor: "var(--line)" }}
      >
        <Option active={value === null} onClick={() => onPick(null)}>
          <span className="text-[0.8125rem]" style={{ color: "var(--ink-2)" }}>
            {emptyLabel}
          </span>
        </Option>

        {options.map((option) => (
          <Option key={option.id} active={value === option.id} onClick={() => onPick(option.id)}>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{
                background: option.ready ? "var(--ink-3)" : "transparent",
                boxShadow: option.ready ? undefined : "inset 0 0 0 1.5px var(--ink-3)",
              }}
            />
            <span className="truncate text-[0.8125rem]">{option.name}</span>
            <span
              className="ml-auto shrink-0 truncate font-mono text-[0.6875rem]"
              style={{ color: "var(--ink-3)" }}
            >
              {option.detail}
            </span>
          </Option>
        ))}
      </div>
    </>
  );
}

function Option({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className="flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left transition-colors last:border-b-0 hover:bg-[var(--wash)]"
      style={{ borderColor: "var(--line)", background: active ? "var(--wash)" : undefined }}
    >
      {children}
      {active && (
        <span className="shrink-0 text-[0.6875rem]" style={{ color: "var(--ink-3)" }}>
          ✓
        </span>
      )}
    </button>
  );
}
