import { ref } from 'vue';

const draggingMarkdown = ref(false);

export function isMarkdownFile(file: Pick<File, 'name'>): boolean {
  return /\.md$/i.test(file.name);
}

export function markdownFile(dataTransfer: DataTransfer | null): File | undefined {
  return [...(dataTransfer?.files ?? [])].find(isMarkdownFile);
}

export function hasMarkdownFile(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer?.types.includes('Files')) return false;
  if (markdownFile(dataTransfer)) return true;

  return [...dataTransfer.items].some((item) => {
    if (item.kind !== 'file') return false;
    const file = item.getAsFile();
    return (
      (file && isMarkdownFile(file)) || /(?:^|\/)markdown$/i.test(item.type) || item.type === ''
    );
  });
}

export function useMarkdownImport() {
  return {
    draggingMarkdown,

    update(dataTransfer: DataTransfer | null): void {
      draggingMarkdown.value = hasMarkdownFile(dataTransfer);
    },

    end(): void {
      draggingMarkdown.value = false;
    },
  };
}
