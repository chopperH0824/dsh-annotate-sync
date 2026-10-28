/**
 * dsh-annotate-sync — browser/UI half (v2).
 *
 * The client half is a classic (non-ESM) script loaded by the DeepSeek Harness
 * client `ModuleLoader`; it is not imported by consumers. These declarations
 * document its public surface for editors and tooling that reads the package.
 *
 * v2 replaces the old right-sidebar panel/composer-dock plugin with an HTML
 * document-preview renderer: `apply()` registers
 * `dsh-annotate-sync/html` with the `documentPreviews` registry and a matching
 * `sidebar.right.tab.document` slot body that renders the builtin-style packed
 * blob iframe plus the annotation overlay.
 */

/**
 * Services the client resolves with `ctx.get(...)`. All four are guarded: when
 * one is missing the renderer degrades (warns once) instead of throwing.
 */
export declare const inject: readonly ['documentPreviews', 'slots', 'sessions', 'timer'];

/** Minimal shape of the Cordis client context used by this plugin. */
export interface AnnotateSyncClientContext {
  /** Resolve an injected service; may return `undefined`. */
  get(name: string): unknown;
  /** Register a disposer that runs when the client plugin unloads. */
  effect(setup: () => void | (() => void)): unknown;
  /** Workspace Remote carrying `workspaceFiles.readBytes` (lazy, optional). */
  remote?: {
    workspaceFiles?: {
      readBytes(
        sessionId: string,
        relativePath: string,
        options: { baseFile?: string },
        signal?: AbortSignal,
      ): Promise<unknown>;
    };
  };
}

/** Document-preview renderer metadata registered with `documentPreviews`. */
export interface AnnotatedHtmlRendererDefinition {
  id: 'dsh-annotate-sync/html';
  extensions: readonly ['html', 'htm'];
  priority: 'external';
  title(): string;
  loading: 'bytes-complete';
  wrap: false;
}

/**
 * Register the HTML document renderer and its document-slot body.
 * Safe to call with any subset of the optional services present; never throws.
 */
export declare function apply(ctx: AnnotateSyncClientContext): void;
