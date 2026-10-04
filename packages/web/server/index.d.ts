import type { Express } from "express";
import type { IncomingMessage, Server } from "http";

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  isReady: () => boolean;
  restartOpenCode: () => Promise<void>;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export declare const HTTP_RESPONSE_POLICY_VERSION: 1;

export interface ResponsePolicyHumanSession {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ResponsePolicyContext {
  readonly signal: AbortSignal;
  getHumanSession(): Promise<ResponsePolicyHumanSession | null>;
}

export type HttpResponsePolicy = (
  request: IncomingMessage,
  context: ResponsePolicyContext
) => readonly (readonly [string, string])[] | Promise<readonly (readonly [string, string])[]>;

export interface DesktopUpdateInfo {
  available: boolean;
  currentVersion?: string;
  version?: string | null;
  body?: string | null;
  date?: string | null;
}

export interface DesktopUpdater {
  check: () => Promise<DesktopUpdateInfo>;
  install: () => Promise<DesktopUpdateInfo>;
  restart: () => Promise<void> | void;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  responsePolicy?: HttpResponsePolicy;
  desktopUpdater?: DesktopUpdater;
  /** App-owned built-in resources outside Electron's ASAR archive. */
  builtInExtensionsDir?: string;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export interface ServeCliParserOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  defaultPort?: number;
  cloudflareProvider?: string;
  managedLocalMode?: string;
}

/** Same options-object contract used by the stock Node CLI. */
export declare function parseArgs(options: ServeCliParserOptions): {
  port: number | undefined;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
  apiOnly: boolean;
};
