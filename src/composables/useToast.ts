import { ref } from 'vue';

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  /** Bumped per toast so the timing bar animation restarts. */
  id: number;
  message: string;
  duration: number;
  action?: ToastAction;
}

export const toast = ref<Toast | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;
let count = 0;

export function showToast(message: string, duration = 2000, action?: ToastAction): void {
  toast.value = { id: ++count, message, duration, action };
  clearTimeout(timer);
  timer = setTimeout(dismissToast, duration);
}

export function dismissToast(): void {
  clearTimeout(timer);
  toast.value = null;
}
