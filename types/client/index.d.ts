/**
 * dsh-annotate-sync — browser/UI half.
 *
 * The client half is a classic (non-ESM) script loaded by the DeepSeek Harness
 * client `ModuleLoader`; it is not imported by consumers. These declarations
 * exist so `exports['./client']` in package.json resolves for editors and for
 * tooling that reads the package's public surface.
 */

/**
 * Services the client resolves with `ctx.get(...)`. The first four are
 * optional: when one is missing the panel degrades (logs once) instead of
 * throwing.
 */
export declare const inject: readonly [
  'timer',
  'sessions',
  'slots',
  'sidebarRight',
  'sidebarRightTabs',
];

/** Minimal shape of the Cordis client context used by this plugin. */
export interface AnnotateSyncClientContext {
  /** Resolve an injected optional service; may return `undefined`. */
  get(name: string): unknown;
  /** Register a disposer that runs when the client plugin unloads. */
  effect(setup: () => void | (() => void)): void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

/**
 * Register the right-sidebar tab, the annotation panel and the composer dock
 * chip. Safe to call with any subset of the optional services present.
 */
export declare function apply(ctx: AnnotateSyncClientContext): void;
