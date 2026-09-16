import { computed } from "vue";
import type { useBoard } from "./useBoard";

export function useBoardExtras(
  board: ReturnType<typeof useBoard>,
  cardName: string,
) {
  const fullPath = computed(() => `${board.boardName.value}/${cardName}`);
  const clipboardPath = computed(() => {
    const root = board.rootPath.value;
    if (!root) return fullPath.value;

    const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    return [root.replace(/[\\/]+$/, ""), cardName].join(separator);
  });
  return {
    fullPath,
    clipboardPath,
  };
}
