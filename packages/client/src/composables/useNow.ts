import { onMounted, onUnmounted, readonly, ref } from 'vue';

const now = ref(Date.now());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Share one clock across card timestamps and stop it when no views need it. */
export function useNow() {
  onMounted(() => {
    now.value = Date.now();
    if (subscribers++ === 0) {
      timer = setInterval(() => {
        now.value = Date.now();
      }, 15_000);
    }
  });

  onUnmounted(() => {
    if (--subscribers === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  });

  return readonly(now);
}
