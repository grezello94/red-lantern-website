declare global {
  interface Window {
    RED_LANTERN_CONFIG?: {
      printBridgeOrigin?: string;
    };
  }

  interface Error {
    status?: number;
  }
}

export {};
