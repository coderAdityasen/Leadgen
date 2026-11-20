/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Address the Chrome extension pairs with. Set when the dashboard and the server live on different hosts. */
  readonly VITE_EXTENSION_SERVER_URL?: string;
}
