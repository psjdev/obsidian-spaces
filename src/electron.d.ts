/**
 * The sliver of Electron this plugin uses.
 *
 * Obsidian provides `electron` to the renderer and the build externalises
 * it, but no type package is installed and taking one on would be the first
 * dependency this plugin has ever had. Declaring the one call used here
 * keeps `dependencies` empty and keeps the call typed.
 *
 * `remote` was removed from Electron core and lives in `@electron/remote`;
 * Obsidian re-exposes it on the `electron` module, which is why this is
 * declared here rather than imported from somewhere. Verified present at
 * runtime in 1.14.4 before anything was built on it.
 */
declare module "electron" {
  interface OpenDialogOptions {
    title?: string;
    defaultPath?: string;
    properties?: ("openDirectory" | "createDirectory" | "openFile")[];
  }

  interface OpenDialogReturnValue {
    canceled: boolean;
    filePaths: string[];
  }

  export const remote: {
    dialog: {
      showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
    };
  };
}
