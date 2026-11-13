// Tools → Record trace: the recording indicator in the toolbar (elapsed time; click to stop), and
// the bar shown once the traces are saved, with Playwright's Trace Viewer for each engine.
import { ExternalLink, LoaderCircle, Square } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import type { SavedTrace, TracingState } from '../../shared/protocol';
import { ENGINE_LABEL } from './Pane';
import { btn, cx, ENGINE_CLASS, EngineDot, ICON } from './ui';

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Shown while recording: a red dot and the time; a click stops and saves. */
export function TraceIndicator({ tracing, onStop }: { tracing: TracingState; onStop(): void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (tracing.saving) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [tracing.saving]);
  const time = elapsed(now - tracing.startedAt);
  return (
    <button
      type="button"
      class={cx(btn('outline'), 'tabular-nums')}
      disabled={tracing.saving}
      title={tracing.saving ? 'Saving the traces…' : 'Recording a Playwright trace in every engine. Click to stop and save it'}
      aria-label={tracing.saving ? 'Saving the traces' : `Recording a trace, ${time}. Stop`}
      onClick={onStop}
    >
      {tracing.saving ? (
        <>
          <LoaderCircle size={ICON} class="animate-spin text-accent" /> <span class="trim-cap">Saving trace…</span>
        </>
      ) : (
        <>
          <span aria-hidden class="size-2.5 animate-pulse rounded-full bg-danger" />
          <span class="trim-cap">{time}</span>
          <Square size={12} class="fill-current text-muted" />
        </>
      )}
    </button>
  );
}

/** The bar's text once a recording is saved: where, and a Trace Viewer button per engine. */
export function SavedTraces({ dir, traces }: { dir: string; traces: SavedTrace[] }) {
  if (!traces.length) return <>The trace couldn't be saved (no engine was running).</>;
  return (
    <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        Saved {traces.length === 1 ? 'a trace' : `${traces.length} traces`} to <code>{dir}</code>. Open in Trace Viewer:
      </span>
      {traces.map((t) => (
        <button
          key={t.engine}
          type="button"
          class={cx(btn('outline', { small: true }), 'bg-chrome', ENGINE_CLASS[t.engine])}
          title={`Open ${ENGINE_LABEL[t.engine]}'s trace in Playwright's Trace Viewer (a new window)${t.files.length > 1 ? `: ${t.files.length} parts, one per page context` : ''}`}
          onClick={() => window.open(t.viewer, '_blank', 'popup,width=1280,height=800')}
        >
          <EngineDot />
          <span class="trim-cap">{ENGINE_LABEL[t.engine]}</span>
          <ExternalLink size={12} class="text-muted" />
        </button>
      ))}
    </span>
  );
}
