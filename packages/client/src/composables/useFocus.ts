import { ref, watch } from 'vue';

const MODE_KEY = 'mdello:focus-mode';
const CARDS_KEY = 'mdello:focused-cards';

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

// Browser-local on purpose: focus never touches the board files.
const enabled = ref<boolean>(load<boolean>(MODE_KEY, false) === true);
const focused = ref<Set<string>>(new Set(load<string[]>(CARDS_KEY, [])));

watch(enabled, (value) => localStorage.setItem(MODE_KEY, JSON.stringify(value)));
watch(focused, (value) => localStorage.setItem(CARDS_KEY, JSON.stringify([...value])), {
  deep: true,
});

export function setCardFocused(id: string, value: boolean): void {
  if (value) focused.value.add(id);
  else focused.value.delete(id);
}

export function useFocus() {
  return {
    enabled,
    isFocused: (id: string) => focused.value.has(id),
    /** Hidden = focus mode is on and the card is not focused. */
    isHidden: (id: string) => enabled.value && !focused.value.has(id),
    toggleCard: (id: string) => setCardFocused(id, !focused.value.has(id)),
    toggleMode: () => {
      enabled.value = !enabled.value;
    },
  };
}
