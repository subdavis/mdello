import { computed, type InjectionKey, inject, provide, type Ref } from 'vue';

/**
 * Where modal layers render. `<body>` is right for the full-window app, where a dialog really
 * does own the whole viewport. A board embedded in a larger page — the marketing demo — supplies
 * an element inside its own frame instead, so a dialog dims the board and not the page around it.
 *
 * The host must be a containing block for `position: fixed` (paint containment or a transform),
 * or the scrim will still size itself to the viewport once it lands there.
 */
const OVERLAY_HOST = Symbol('mdello.overlay-host') as InjectionKey<Ref<HTMLElement | null>>;

export function provideOverlayHost(host: Ref<HTMLElement | null>): void {
  provide(OVERLAY_HOST, host);
}

/** The current teleport target. Reactive, because a template ref is null until mount. */
export function useOverlayHost() {
  const host = inject(OVERLAY_HOST, null);
  return computed<HTMLElement | string>(() => host?.value ?? 'body');
}
