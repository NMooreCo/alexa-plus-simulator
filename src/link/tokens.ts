import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError, isObject, type RefreshOutcome, type TokenSource } from "../check/rpc.ts";
import { CLIENT_AUTHS, tokenRequest, type ClientAuth, type TokenAnswer } from "./oauth.ts";

/**
 * The token file link saves and --token-file reads: the tokens, and what
 * refreshing them takes (the token endpoint and the client), but never a
 * client secret you made yourself. TokenFile keeps it current: it refreshes
 * the access token before it expires and once more when the server refuses
 * it, and saves rotated tokens back.
 */

export const DEFAULT_TOKEN_FILE = ".alexa-plus-simulator/tokens.json";
/** An access token this close to expiring is refreshed before it's sent. */
export const REFRESH_MARGIN_MS = 60_000;
/** A token refused this soon after a refresh brought it is refused for some other reason, so refreshing again won't help. */
export const RENEWAL_GRACE_MS = 30_000;

export interface SavedTokens {
  version: 1;
  /** The MCP server the tokens are for. */
  mcpUrl: string;
  tokenEndpoint: string;
  clientId: string;
  clientAuth: ClientAuth;
  /** Only for a client link registered itself, whose secret exists nowhere else; a client you made keeps its secret in ALEXA_SIM_CLIENT_SECRET. */
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  /** When the access token expires, as an ISO time; missing when the server didn't say. */
  expiresAt?: string;
  scope?: string;
}

const GITIGNORE = "# Written by alexa-plus-simulator: this folder holds sign-in tokens, which never belong in git.\n*\n";

/** The tokens as saved after a token endpoint's answer, keeping what the answer leaves out. */
export function withAnswer(saved: Omit<SavedTokens, "accessToken"> & { accessToken?: string }, answer: TokenAnswer, now: number): SavedTokens {
  // The old expiry goes either way: a new answer brings its own, or leaves it unknown.
  const { expiresAt: _old, ...rest } = saved;
  return {
    ...rest,
    accessToken: answer.accessToken,
    ...(answer.refreshToken ? { refreshToken: answer.refreshToken } : {}),
    ...(answer.expiresIn ? { expiresAt: new Date(now + answer.expiresIn * 1000).toISOString() } : {}),
    ...(answer.scope ? { scope: answer.scope } : {}),
  };
}

/**
 * Writes the token file readable only by its owner (mode 0600 where the OS
 * has modes), by way of a temporary file so a crash can't leave half of one.
 * A folder this creates gets a .gitignore, so the tokens never get committed.
 */
export async function saveTokens(path: string, tokens: SavedTokens): Promise<{ createdFolder: boolean }> {
  const folder = dirname(path);
  let createdFolder = false;
  try {
    await stat(folder);
  } catch (error) {
    // Only a folder this makes gets a .gitignore: one in a folder of yours could hide your own files from git.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, ".gitignore"), GITIGNORE);
    createdFolder = true;
  }
  const text = `${JSON.stringify(tokens, null, 2)}\n`;
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch {
    // Windows can refuse to replace a file another program holds open (a virus scanner, say); write it in place instead.
    await rm(temporary, { force: true });
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }
  return { createdFolder };
}

/** Reads a token file, saying plainly what's wrong with one that isn't link's. */
export async function loadTokens(path: string): Promise<SavedTokens> {
  const text = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} isn't JSON (${(error as Error).message}), so it isn't a token file from link.`);
  }
  const problem = (what: string) => new Error(`${path} isn't a token file from link: ${what}.`);
  if (!isObject(value)) throw problem("it isn't a JSON object");
  if (value.version !== 1) throw problem(`its version is ${JSON.stringify(value.version)}, not 1`);
  for (const key of ["mcpUrl", "tokenEndpoint", "clientId", "accessToken"]) {
    if (typeof value[key] !== "string" || !value[key]) throw problem(`it has no ${key}`);
  }
  if (!CLIENT_AUTHS.includes(value.clientAuth as ClientAuth)) throw problem(`its clientAuth isn't one of ${CLIENT_AUTHS.join(", ")}`);
  for (const key of ["clientSecret", "refreshToken", "expiresAt", "scope"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw problem(`its ${key} isn't text`);
  }
  if (typeof value.expiresAt === "string" && Number.isNaN(Date.parse(value.expiresAt))) throw problem("its expiresAt isn't a time");
  return value as unknown as SavedTokens;
}

export interface TokenFileOptions {
  /** Where ALEXA_SIM_CLIENT_SECRET comes from, for a client you made yourself. */
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; tests move it. */
  now?: () => number;
  /** Told once when refreshing goes wrong in a way that doesn't stop the request at hand. */
  warn?: (line: string) => void;
}

/** A token file in use: the token to send, refreshed when it's due, for the check and the simulator's proxy alike. */
export class TokenFile implements TokenSource {
  private saved: SavedTokens;
  private refreshing: Promise<RefreshOutcome> | undefined;
  /** The first refresh's outcome, for AU-09. */
  private first: RefreshOutcome | undefined;
  /** The first refresh that didn't work; after it, nothing tries again, since the fix is on the person (link again, or set the secret). */
  private failure: Exclude<RefreshOutcome, { status: "refreshed" }> | undefined;
  /** When each access token that came from refreshing after a 401 arrived, so a server refusing every token can't set off a refresh per request. */
  private readonly renewedAt = new Map<string, number>();
  private warned = false;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  private constructor(
    readonly path: string,
    saved: SavedTokens,
    private readonly options: TokenFileOptions,
  ) {
    this.saved = saved;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  static async load(path: string, options: TokenFileOptions): Promise<TokenFile> {
    return new TokenFile(path, await loadTokens(path), options);
  }

  get mcpUrl(): string {
    return this.saved.mcpUrl;
  }

  /** The access token to send, refreshed first when it expires within a minute. */
  async token(): Promise<string> {
    if (this.due() && !this.failure) {
      const outcome = await this.refreshOnce();
      if (outcome.status !== "refreshed" && !this.expired()) {
        this.warnOnce(`${this.couldnt(outcome)} The saved access token still works until ${this.saved.expiresAt}.`);
      }
    }
    if (this.failure && this.expired()) {
      throw new Error(`The sign-in saved in ${this.path} has expired and couldn't be refreshed: ${this.why(this.failure)}.${this.fix(this.failure)}`);
    }
    return this.saved.accessToken;
  }

  /** After the server refused `rejected` with 401: refreshes once and returns the new token, or undefined when that can't help. */
  async renew(rejected: string): Promise<string | undefined> {
    // A refresh for another request already replaced it.
    if (rejected !== this.saved.accessToken) return this.saved.accessToken;
    if (this.failure) {
      this.warnOnce(`The MCP server refused the saved access token. ${this.couldnt(this.failure)}`);
      return undefined;
    }
    const renewed = this.renewedAt.get(rejected);
    if (renewed !== undefined && this.now() - renewed < RENEWAL_GRACE_MS) {
      this.warnOnce(
        `The MCP server refused an access token refreshed moments ago, so refreshing again won't help; check that it accepts tokens from ${this.saved.tokenEndpoint} for ${this.saved.mcpUrl}.`,
      );
      return undefined;
    }
    const outcome = await this.refreshOnce();
    if (outcome.status !== "refreshed") {
      this.warnOnce(`The MCP server refused the saved access token. ${this.couldnt(outcome)}`);
      return undefined;
    }
    this.renewedAt.set(this.saved.accessToken, this.now());
    return this.saved.accessToken;
  }

  /** For AU-09: the first refresh that didn't work, or else the first one that did, refreshing now when none has run. */
  async confirmRefresh(): Promise<RefreshOutcome> {
    return this.failure ?? this.first ?? (await this.refreshOnce());
  }

  private due(): boolean {
    return this.saved.expiresAt !== undefined && this.now() >= Date.parse(this.saved.expiresAt) - REFRESH_MARGIN_MS;
  }

  private expired(): boolean {
    return this.saved.expiresAt !== undefined && this.now() >= Date.parse(this.saved.expiresAt);
  }

  /** One refresh at a time: with rotating refresh tokens, a second one at once would spend a token the first just replaced. */
  private refreshOnce(): Promise<RefreshOutcome> {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<RefreshOutcome> {
    const outcome = await this.attempt();
    this.first ??= outcome;
    if (outcome.status !== "refreshed") this.failure ??= outcome;
    return outcome;
  }

  private async attempt(): Promise<RefreshOutcome> {
    const saved = this.saved;
    if (!saved.refreshToken) return { status: "missing" };
    const secret = saved.clientSecret ?? this.options.env.ALEXA_SIM_CLIENT_SECRET;
    if (saved.clientAuth !== "none" && !secret) {
      return { status: "untried", reason: "refreshing needs the client's secret, so set ALEXA_SIM_CLIENT_SECRET (the token file never holds a secret you made)" };
    }
    let answer: TokenAnswer;
    try {
      // No resource parameter: Alexa+ sends it "in both the authorization request and the token exchange request but not in the token refresh request".
      answer = await tokenRequest(
        this.fetch,
        saved.tokenEndpoint,
        { grant_type: "refresh_token", refresh_token: saved.refreshToken },
        { id: saved.clientId, ...(secret ? { secret } : {}), auth: saved.clientAuth },
      );
    } catch (error) {
      return { status: "failed", problem: describeError(error) };
    }
    this.saved = withAnswer(saved, answer, this.now());
    try {
      await saveTokens(this.path, this.saved);
    } catch (error) {
      this.warnOnce(`Refreshed the sign-in, but couldn't save the new tokens to ${this.path} (${describeError(error)}), so they last only while this runs.`);
    }
    return {
      status: "refreshed",
      sameAccessToken: answer.accessToken === saved.accessToken,
      newRefreshToken: Boolean(answer.refreshToken && answer.refreshToken !== saved.refreshToken),
    };
  }

  private why(outcome: Exclude<RefreshOutcome, { status: "refreshed" }>): string {
    if (outcome.status === "missing") return "it has no refresh token, since the token endpoint didn't return one";
    return outcome.status === "failed" ? outcome.problem : outcome.reason;
  }

  /** What to do about it: set the secret when that's what's missing, and otherwise sign in again. */
  private fix(outcome: Exclude<RefreshOutcome, { status: "refreshed" }>): string {
    return outcome.status === "untried" ? "" : ` Run alexa-plus-simulator link ${this.saved.mcpUrl} to sign in again.`;
  }

  private couldnt(outcome: Exclude<RefreshOutcome, { status: "refreshed" }>): string {
    return `Couldn't refresh the sign-in saved in ${this.path}: ${this.why(outcome)}.${this.fix(outcome)}`;
  }

  private warnOnce(line: string): void {
    if (this.warned) return;
    this.warned = true;
    this.options.warn?.(line);
  }
}
