// =============================================================================
// v0.0.9 demo panel — exercises every new v0.0.9 package in real Chromium
// so the Playwright suite can verify visible behavior (theme switch, gestures,
// i18n message, worker invocation, SSR ARIA shadow, plugin compartment swap).
//
// Renders as an aside next to the main grid; behavior gated by a toolbar
// toggle so the existing benchmark suite is unaffected unless explicitly
// opened. Every interactive affordance carries a data-testid so the new
// spec file can drive it deterministically.
// =============================================================================

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  PluginState,
  Compartment,
  themeRegistry,
  i18nCatalogRegistry,
  INTERFACE_VERSION,
} from '@onegrid/plugin-kit';
import { compileTheme, registerTheme } from '@onegrid/tokens';
import { lightTheme } from '@onegrid/tokens/themes/light';
import { darkTheme } from '@onegrid/tokens/themes/dark';
import comfortableDtcg from '@onegrid/tokens/density/comfortable';
import compactDtcg from '@onegrid/tokens/density/compact';
import spaciousDtcg from '@onegrid/tokens/density/spacious';
import {
  loadCatalog,
  registerCatalog,
  t,
  formatNumber,
  parseLocalizedNumber,
} from '@onegrid/intl';
import { bindGestures, touchCss, inputmodeForColumn } from '@onegrid/touch';
import { HeadlessGrid } from '@onegrid/headless';
import {
  WorkerPluginHost,
  type WorkerLike,
} from '@onegrid/worker-plugins';
import { definePluginWorker, type WorkerSelfLike } from '@onegrid/worker-plugins/worker';

// -----------------------------------------------------------------------------
// In-process worker stand-in — keeps the playground side-effect-free, while
// proving the WorkerPluginHost / definePluginWorker contract works end-to-end.
// In production you'd swap this for `new Worker(...)`.
// -----------------------------------------------------------------------------

function inProcessWorkerPair(): {
  hostSide: WorkerLike;
  startWorker: () => () => void;
} {
  const hostListeners = new Map<string, Set<(e: unknown) => void>>();
  const workerListeners = new Map<string, Set<(e: unknown) => void>>();
  const emit = (
    m: Map<string, Set<(e: unknown) => void>>,
    type: string,
    e: unknown,
  ): void => {
    m.get(type)?.forEach((fn) => fn(e));
  };
  const hostSide = {
    postMessage: (msg: unknown) => emit(workerListeners, 'message', { data: msg }),
    addEventListener: (type: string, listener: (e: unknown) => void) => {
      let set = hostListeners.get(type);
      if (!set) hostListeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener: (type: string, listener: unknown) =>
      hostListeners.get(type)?.delete(listener as (e: unknown) => void),
    terminate: () => {
      hostListeners.clear();
      workerListeners.clear();
    },
  } as unknown as WorkerLike;
  const workerSide = {
    postMessage: (msg: unknown) => emit(hostListeners, 'message', { data: msg }),
    addEventListener: (type: string, listener: (e: unknown) => void) => {
      let set = workerListeners.get(type);
      if (!set) workerListeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener: (type: string, listener: unknown) =>
      workerListeners.get(type)?.delete(listener as (e: unknown) => void),
  } as unknown as WorkerSelfLike;
  return {
    hostSide,
    // Defer worker boot until the host is constructed so the `ready`
    // handshake doesn't race the host's message-listener attach.
    startWorker: () =>
      definePluginWorker({
        self: workerSide,
        handlers: {
          sumColumn: (xs: number[]) => xs.reduce((a, b) => a + b, 0),
          doubleEach: (xs: number[]) => xs.map((x) => x * 2),
        },
      }),
  };
}

// -----------------------------------------------------------------------------
// V009Demo
// -----------------------------------------------------------------------------

const SAMPLE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Catalogs must be registered before the first render. `t()` reads a
// module-level map and does not subscribe to later `loadCatalog` calls,
// so putting this in useEffect left the title as the raw message id.
loadCatalog({
  locale: 'en',
  messages: {
    'demo.title': 'v0.0.9 Demo',
    'demo.gestureHint': 'Tap, double-tap, or long-press the box',
    'demo.itemCount':
      '{count, plural, =0 {no items} one {# item} other {# items}}',
  },
});
loadCatalog({
  locale: 'es',
  messages: {
    'demo.title': 'Demostración v0.0.9',
    'demo.gestureHint': 'Toca, doble toca o mantén pulsado el cuadro',
    'demo.itemCount':
      '{count, plural, =0 {sin elementos} one {# elemento} other {# elementos}}',
  },
});

export function V009Demo(): JSX.Element {
  const [themeName, setThemeName] = useState<'light' | 'dark'>('light');
  const [densityName, setDensityName] = useState<'compact' | 'comfortable' | 'spacious'>('comfortable');
  const [locale, setLocale] = useState<'en' | 'es'>('en');
  const [gestureLog, setGestureLog] = useState<string[]>([]);
  const [sumResult, setSumResult] = useState<number | null>(null);
  const [ssrHtml, setSsrHtml] = useState<string | null>(null);
  const [parseInput, setParseInput] = useState<string>('1,234.5');
  const [parseLocale, setParseLocale] = useState<'en-US' | 'de-DE'>('en-US');

  const gestureTarget = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<WorkerPluginHost | null>(null);
  const interfaceVersion = INTERFACE_VERSION;

  // -- Tokens: compile theme + density JSON to CSS once per change --
  const themeBundle = themeName === 'dark' ? darkTheme : lightTheme;
  const densityDtcg =
    densityName === 'compact'
      ? compactDtcg
      : densityName === 'spacious'
        ? spaciousDtcg
        : comfortableDtcg;

  const themeCss = useMemo(
    () =>
      [
        compileTheme(themeBundle.dtcg, { themeName }),
        compileTheme(densityDtcg, { densityName }),
        touchCss('[data-og-v009-demo]'),
      ].join('\n'),
    [themeBundle, themeName, densityDtcg, densityName],
  );

  // -- plugin-kit: build a PluginState that registers theme + catalog --
  const pluginState = useMemo(() => {
    return PluginState.create({
      extensions: [
        registerTheme(themeBundle),
        registerCatalog({
          locale: 'en',
          messages: { 'demo.title': 'v0.0.9 Demo' },
        }),
      ],
    });
  }, [themeBundle]);
  const themeResolved = themeRegistry.resolve(pluginState, themeName);
  const i18nResolved = i18nCatalogRegistry.resolve(pluginState, 'en');

  // -- plugin-kit Compartment: hot-swap demo (theme compartment) --
  const themeCompartmentRef = useRef<Compartment | null>(null);
  if (!themeCompartmentRef.current) themeCompartmentRef.current = new Compartment();

  // -- Touch: bind gestures to the demo box --
  useEffect(() => {
    const el = gestureTarget.current;
    if (!el) return;
    const cleanup = bindGestures(el, (e) => {
      setGestureLog((log) => [
        `${e.kind}@(${Math.round(e.x)},${Math.round(e.y)})`,
        ...log,
      ].slice(0, 5));
    });
    return cleanup;
  }, []);

  // -- Worker plugins: spawn an in-process worker pair --
  useEffect(() => {
    const { hostSide, startWorker } = inProcessWorkerPair();
    // Construct host (registers its 'message' listener) BEFORE starting
    // the worker so the worker's ready handshake reaches us.
    const host = new WorkerPluginHost({ worker: hostSide, timeoutMs: 5_000 });
    hostRef.current = host;
    const teardownWorker = startWorker();
    return () => {
      host.dispose();
      teardownWorker();
    };
  }, []);

  const handleSumClick = async (): Promise<void> => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    await host.ready;
    const value = await host.invoke<number>('sumColumn', [SAMPLE]);
    setSumResult(value);
  };

  // -- Headless: SSR-style accessibility shadow HTML --
  const handleSsrClick = (): void => {
    const fakeHost = document.createElement('div');
    const headless = new HeadlessGrid({
      options: {
        host: fakeHost,
        columns: [
          { id: 'id', width: 80, displayName: 'ID' },
          { id: 'name', width: 200, displayName: 'Name' },
        ],
        // SSR-only rowSource — the headless serializer only reads
        // totalRowCount + a sample. The shape mismatch is irrelevant.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rowSource: {
          readBlock: (startRow: number, blockSize: number) => ({
            rows: Array.from({ length: blockSize }, (_, i) => [
              startRow + i,
              `row-${startRow + i}`,
            ]),
            totalRowCount: 3,
          }),
        } as unknown as any,
        rowHeight: 32,
      },
    });
    setSsrHtml(headless.renderAccessibilityShadowHTML());
  };

  // -- Intl: parse a localized number live --
  const parsedNumber = parseLocalizedNumber(parseInput, parseLocale);
  const parsedFormatted = Number.isFinite(parsedNumber)
    ? formatNumber(parsedNumber, parseLocale)
    : 'NaN';

  return (
    <aside
      data-og-v009-demo
      data-og-root
      data-og-theme={themeName}
      data-og-density={densityName}
      data-testid="v009-demo"
      style={{
        background: 'var(--og-color-background, #fff)',
        color: 'var(--og-color-text, #1f2328)',
        border: `1px solid var(--og-color-border, #d0d7de)`,
        borderRadius: 6,
        padding: 'var(--og-size-padding-cell-x, 10px)',
        fontSize: 'var(--og-size-font-base, 13px)',
        lineHeight: 'var(--og-size-line-height, 1.4)',
        display: 'grid',
        gap: 8,
        minWidth: 340,
        maxWidth: 420,
      }}
    >
      <style>{themeCss}</style>

      <h2 style={{ margin: 0, fontSize: 16 }} data-testid="v009-title">
        {t('demo.title', {}, locale)}
      </h2>

      <div style={{ fontSize: 11, opacity: 0.7 }} data-testid="v009-iface-version">
        plugin-kit interfaceVersion = {interfaceVersion}
      </div>

      {/* Theme + density toggles */}
      <div role="group" aria-label="theme + density">
        <button
          type="button"
          data-testid="v009-theme-toggle"
          onClick={() => setThemeName((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          Theme: {themeName}
        </button>{' '}
        <button
          type="button"
          data-testid="v009-density-cycle"
          onClick={() =>
            setDensityName((d) =>
              d === 'compact' ? 'comfortable' : d === 'comfortable' ? 'spacious' : 'compact',
            )
          }
        >
          Density: {densityName}
        </button>{' '}
        <button
          type="button"
          data-testid="v009-locale-toggle"
          onClick={() => setLocale((l) => (l === 'en' ? 'es' : 'en'))}
        >
          Locale: {locale}
        </button>
      </div>

      {/* Theme + i18n registry inspection */}
      <div
        data-testid="v009-theme-resolved"
        style={{ fontSize: 11, opacity: 0.7 }}
      >
        themeRegistry → {themeResolved ? themeName : 'unresolved'}
        {' · '}
        i18nCatalogRegistry → {i18nResolved ? 'en' : 'unresolved'}
      </div>

      {/* Touch — gesture log */}
      <div data-testid="v009-gesture-hint" style={{ fontSize: 12 }}>
        {t('demo.gestureHint', {}, locale)}
      </div>
      <div
        ref={gestureTarget}
        data-testid="v009-gesture-target"
        className="og-tap"
        style={{
          height: 80,
          background: 'var(--og-color-hover-background, #f3f4f6)',
          border: '1px dashed var(--og-color-border, #d0d7de)',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          userSelect: 'none',
          touchAction: 'manipulation',
        }}
      >
        gesture zone
      </div>
      <ul
        data-testid="v009-gesture-log"
        style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 11, opacity: 0.8 }}
      >
        {gestureLog.map((g, i) => (
          <li key={`${i}-${g}`}>{g}</li>
        ))}
      </ul>

      {/* Plural i18n */}
      <div data-testid="v009-plural-zero" style={{ fontSize: 12 }}>
        {t('demo.itemCount', { count: 0 }, locale)}
      </div>
      <div data-testid="v009-plural-one" style={{ fontSize: 12 }}>
        {t('demo.itemCount', { count: 1 }, locale)}
      </div>
      <div data-testid="v009-plural-many" style={{ fontSize: 12 }}>
        {t('demo.itemCount', { count: 1234 }, locale)}
      </div>

      {/* Parse localized number */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          data-testid="v009-parse-input"
          value={parseInput}
          inputMode={inputmodeForColumn('float64')}
          onChange={(e) => setParseInput(e.target.value)}
          style={{ width: 120, fontSize: 12 }}
        />
        <button
          type="button"
          data-testid="v009-parse-locale"
          onClick={() =>
            setParseLocale((l) => (l === 'en-US' ? 'de-DE' : 'en-US'))
          }
        >
          {parseLocale}
        </button>
        <span data-testid="v009-parse-result" style={{ fontSize: 12 }}>
          → {parsedFormatted}
        </span>
      </div>

      {/* Worker-plugins — sum invocation */}
      <div>
        <button
          type="button"
          data-testid="v009-worker-sum"
          onClick={handleSumClick}
        >
          Worker: sumColumn(1..10)
        </button>{' '}
        <span data-testid="v009-worker-sum-result" style={{ fontSize: 12 }}>
          {sumResult === null ? 'pending' : `= ${sumResult}`}
        </span>
      </div>

      {/* Headless SSR */}
      <div>
        <button
          type="button"
          data-testid="v009-ssr-render"
          onClick={handleSsrClick}
        >
          Headless: renderAccessibilityShadowHTML()
        </button>
        <pre
          data-testid="v009-ssr-output"
          style={{
            margin: '6px 0 0',
            padding: 6,
            background: 'var(--og-color-background-alt, #fafafa)',
            border: '1px solid var(--og-color-border, #d0d7de)',
            borderRadius: 4,
            fontSize: 10,
            maxHeight: 120,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {ssrHtml ?? '(click to render)'}
        </pre>
      </div>
    </aside>
  );
}
