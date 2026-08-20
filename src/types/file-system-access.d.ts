// Parts of the File System Access API that lib.dom.d.ts still omits.
// Chrome-only surface: directory picker, async iteration, handle.move().

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

interface Window {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemChangeRecord {
  type: string;
  relativePathComponents: string[];
  relativePathMovedFrom?: string[] | null;
}

interface FileSystemObserver {
  observe: (
    handle: FileSystemHandle,
    options?: { recursive?: boolean },
  ) => Promise<void>;
  disconnect: () => void;
}

declare var FileSystemObserver:
  | {
      new (
        callback: (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void,
      ): FileSystemObserver;
    }
  | undefined;

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  values: () => AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
}

interface FileSystemFileHandle {
  move?: (destination: FileSystemDirectoryHandle | string, name?: string) => Promise<void>;
}
