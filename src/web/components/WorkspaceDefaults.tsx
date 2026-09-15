/**
 * Where a new chat starts, and which connection draws.
 *
 * Two settings that look the same and are not: the first says which engine
 * answers by default, the second says which one makes pictures — and they are
 * almost never the same connection, because Anthropic publishes no image model
 * at all. Putting them next to each other is what makes that legible rather
 * than surprising.
 *
 * Both lists end with the same way out: an engine for an API none of these
 * connections speak, written as a script. A script that chats appears in the
 * first list, one that draws in the second, and one that does both in both.
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
  onCustom,
}: {
  connections: ConnectionView[];
  /** The berth and the sidebar both read this state, so the shell re-fetches. */
  onChanged: () => void;
  /** Opens the custom-engine editor, for an API none of these connections speak. */
  onCustom?: () => void;
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

  // Re-read when the connections change, because whether a script draws is
  // decided by the script, and editing one can move it in or out of the list.
  useEffect(() => {
    void load();
  }, [load, connections]);

  /**
   * Hoisted above every early return and every conditional branch, because they
   * are hooks. Each is bound to its chosen connection's id so switching provider
   * re-points the model list rather than showing the previous one's — the same
   * arrangement the berth uses.
   */
  const defaultConnectionId = workspace?.defaults.connectionId ?? null;
  const loadModels = useCallback(
    async () => (await api.models(defaultConnectionId!)).models,
    [defaultConnectionId],
  );
  const imageConnectionId = workspace?.images.connectionId ?? null;
  const loadImageModels = useCallback(
    async () => (await api.models(imageConnectionId!)).models,
    [imageConnectionId],
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
  // A script that only draws cannot be where a conversation starts.
  const engines = connections.filter((item) => item.capabilities.chat);
  const chosen = engines.find((item) => item.id === defaults.connectionId) ?? null;
  const imageChoice = images.eligible.find((item) => item.id === images.connectionId) ?? null;
  const imageConnection = connections.find((item) => item.id === imageChoice?.id) ?? null;

  const customLink = (label: string) =>
    onCustom && (
      <button
        type="button"
        onClick={onCustom}
        className="mt-1.5 text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
        style={{ color: "var(--ink-3)" }}
      >
        {label}
      </button>
    );

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
          options={engines.map((item) => ({
            id: item.id,
            name: item.name,
            detail: item.model,
            ready: item.ready,
          }))}
          emptyLabel="First one available"
        />
        {customLink("Not listed? Write a custom engine for any API…")}

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
              load={chosen.capabilities.models ? loadModels : null}
              blocked="This engine has no model list. Type any id it understands."
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
          <>
            <p className="text-[0.8125rem]" style={{ color: "var(--ink-3)" }}>
              None of your connections can generate images. Add an OpenAI or Google connection, an
              OpenAI-compatible endpoint that serves{" "}
              <code className="font-mono">/v1/images/generations</code>, or a custom script with an{" "}
              <code className="font-mono">image()</code> function.
            </p>
            {customLink("Write a script that draws…")}
          </>
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
            {customLink("Draw with something else? Write a script for it…")}

            {imageChoice && (
              <div className="mt-3">
                <p
                  className="pb-1.5 text-[0.6875rem] font-medium uppercase tracking-wider"
                  style={{ color: "var(--ink-3)" }}
                >
                  Image model
                </p>
                <p className="mb-1.5 font-mono text-[0.75rem]" style={{ color: "var(--ink-2)" }}>
                  {images.model ?? (imageChoice.defaultModel || "None chosen yet")}
                </p>
                <ModelPicker
                  compact
                  prefer="image"
                  key={imageChoice.id}
                  value={images.model ?? imageChoice.defaultModel}
                  load={
                    imageChoice.ready && imageConnection?.capabilities.models !== false
                      ? loadImageModels
                      : null
                  }
                  blocked={
                    imageChoice.ready
                      ? "This connection has no model list. Type any id it understands."
                      : "Set that connection up to see what it can draw with."
                  }
                  onPick={(model) => void save({ imageModel: model })}
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

                {images.model && (
                  <button
                    type="button"
                    onClick={() => void save({ imageModel: null })}
                    className="mt-1.5 block text-[0.6875rem] transition-colors hover:text-[var(--ink)]"
                    style={{ color: "var(--ink-3)" }}
                  >
                    {imageChoice.defaultModel
                      ? `Use ${imageChoice.defaultModel} instead`
                      : "Clear the image model"}
                  </button>
                )}

                <p
                  className="mt-1.5 whitespace-pre-wrap text-[0.6875rem]"
                  style={{ color: imageChoice.ready ? "var(--ink-3)" : "var(--danger)" }}
                >
                  {imageChoice.hint}
                </p>
              </div>
            )}

            <p className="mt-3 text-[0.75rem]" style={{ color: "var(--ink-3)" }}>
              {images.active
                ? `The assistant can generate images with ${images.active.name} · ${images.active.model}.`
                : imageChoice
                  ? imageChoice.ready
                    ? "Choose an image model before the tool is offered."
                    : "Set that connection up before the tool is offered."
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
