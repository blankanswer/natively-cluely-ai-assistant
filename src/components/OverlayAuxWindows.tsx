import { useEffect, useMemo, useRef, useState } from 'react';
import TopPill from './ui/TopPill';
import ResizeToggle from './ui/ResizeToggle';
import { getGlassOverlayAppearance, getOverlayAppearance } from '../lib/overlayAppearance';

// ── Overlay auxiliary window roots ──────────────────────────────────────────
// The TopPill and the resize toggle each live in their OWN tiny BrowserWindow.
// The main process owns geometry/OS visibility; these roots own rendering and
// user actions. Lite intentionally keeps TopPill visible when the shell is
// collapsed so the same control can always reverse Hide -> Show.

export interface OverlayUiState {
  /** Vertical show/hide — mirrors NativelyInterface's isExpanded. */
  expanded?: boolean;
  /** Whether the shell is at its wide width — drives the toggle's icon. */
  shellWide?: boolean;
  /** messages.length > 0 — main-process side gates toggle-window visibility. */
  hasContent?: boolean;
  overlayOpacity?: number;
  themeMode?: 'light' | 'dark';
  interfaceTheme?: 'default' | 'liquid-glass' | 'modern';
}

const DEFAULT_STATE: Required<Omit<OverlayUiState, 'hasContent'>> & OverlayUiState = {
  expanded: true,
  shellWide: false,
  overlayOpacity: 1,
  themeMode: 'dark',
  interfaceTheme: 'default',
};

function useOverlayUiState(): OverlayUiState {
  const [state, setState] = useState<OverlayUiState>(DEFAULT_STATE);
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onOverlayUiState?.((next) =>
      setState((prev) => ({ ...prev, ...(next as OverlayUiState) })),
    );
    return () => unsubscribe?.();
  }, []);
  return state;
}

function useOverlayAuxAppearance(state: OverlayUiState) {
  const { interfaceTheme, overlayOpacity, themeMode } = state;
  return useMemo(
    () =>
      interfaceTheme === 'liquid-glass'
        ? getGlassOverlayAppearance()
        : getOverlayAppearance(overlayOpacity ?? 1, themeMode === 'light' ? 'light' : 'dark'),
    [interfaceTheme, overlayOpacity, themeMode],
  );
}

const sendAction = (type: string) => {
  window.electronAPI?.sendOverlayUiAction?.({ type }).catch(() => {});
};

function useDismissPopoversOnMouseDown() {
  useEffect(() => {
    const onMouseDown = () => {
      window.electronAPI?.dismissOverlayPopovers?.().catch(() => {});
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, []);
}

function useManagedGroupDrag(rootRef: React.RefObject<HTMLDivElement | null>): boolean {
  const [managed, setManaged] = useState(false);

  useEffect(() => {
    let alive = true;
    window.electronAPI
      ?.isOverlayGroupDragManaged?.()
      .then((v) => {
        if (alive) setManaged(!!v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!managed || !el) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let pending: { dx: number; dy: number } | null = null;
    let frame = 0;

    const flush = () => {
      frame = 0;
      const next = pending;
      pending = null;
      if (!next) return;
      window.electronAPI?.sendOverlayGroupDrag?.({ ...next, phase: 'move' }).catch(() => {});
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
      dragging = true;
      startX = e.screenX;
      startY = e.screenY;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is an optimisation only.
      }
      window.electronAPI?.sendOverlayGroupDrag?.({ phase: 'start' }).catch(() => {});
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      pending = { dx: e.screenX - startX, dy: e.screenY - startY };
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Already released.
      }
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      flush();
      window.electronAPI?.sendOverlayGroupDrag?.({ phase: 'end' }).catch(() => {});
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerEnd);
    el.addEventListener('pointercancel', onPointerEnd);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [managed, rootRef]);

  return managed;
}

export function OverlayPillWindow() {
  const state = useOverlayUiState();
  const appearance = useOverlayAuxAppearance(state);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragManaged = useManagedGroupDrag(rootRef);
  useDismissPopoversOnMouseDown();

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const report = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width > 0 && height > 0) {
        window.electronAPI?.updateContentDimensions({ width, height }).catch?.(() => {});
      }
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      data-interface-theme={state.interfaceTheme ?? 'default'}
      data-overlay-group-drag-managed={dragManaged ? 'true' : undefined}
      className="w-fit h-fit bg-transparent select-none"
      style={{
        ['--overlay-opacity' as '--overlay-opacity']: String(state.overlayOpacity ?? 1),
      } as React.CSSProperties}
    >
      {/*
        Recovery contract: the pill NEVER fades merely because the shell is
        collapsed. `expanded` only changes the control from Hide to Show. Full
        app/window hiding is still owned by the main process and hides this tiny
        BrowserWindow too; tray/global-shortcut recovery handles that separate
        operation.
      */}
      <TopPill
        expanded={state.expanded !== false}
        onToggle={() => sendAction('toggle-expand')}
        onQuit={() => sendAction('end-meeting')}
        appearance={appearance}
        onLogoClick={() => window.electronAPI?.setWindowMode?.('launcher')}
      />
    </div>
  );
}

export function OverlayToggleWindow() {
  const state = useOverlayUiState();
  const appearance = useOverlayAuxAppearance(state);
  const themeAttr = state.interfaceTheme ?? 'default';
  useDismissPopoversOnMouseDown();

  return (
    <div
      data-interface-theme={themeAttr}
      className="w-full h-full bg-transparent select-none"
      style={{
        ['--overlay-opacity' as '--overlay-opacity']: String(state.overlayOpacity ?? 1),
      } as React.CSSProperties}
    >
      <ResizeToggle
        expanded={!!state.shellWide}
        onToggle={() => sendAction('toggle-width')}
        appearance={appearance}
        interfaceTheme={themeAttr === 'default' ? undefined : themeAttr}
        topOffset={4}
        rightOffset={4}
      />
    </div>
  );
}
